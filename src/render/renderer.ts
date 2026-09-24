import { Application, Container, Graphics, Particle, ParticleContainer, RenderTexture, Sprite, Text, Texture } from "pixi.js";
import { luminosityFor, TYPES } from "../sim/catalog";
import { elements, parentOf } from "../sim/orbit";
import type { Body } from "../sim/types";
import type { SimEvent } from "../sim/world";
import type { SimClient } from "../simClient";
import type { Settings } from "../state/settings";
import type { Camera } from "./camera";
import { dominantColor, paintPixelGlobe } from "./surfacePainter";

const BG = 0x0a0e17, INK = 0xe2e8f0, SECONDARY = 0x7c8ba1, SELECT = 0x00f0ff, DANGER = 0xff3366, TIME = 0xffb020;

/**
 * Pixel size: the world renders at 1/PX resolution into a texture that is scaled back up
 * with nearest-neighbour filtering. Everything below is still laid out in CSS pixels; the
 * world container is scaled by 1/PX, so one "art pixel" is PX CSS pixels.
 */
export const PX = 3;
/** One art pixel, as a line width in CSS px. */
const LINE = PX;

export interface Overlay {
  pointer: { x: number; y: number } | null;
  brushPx: number;
  brushColor: number | null;
  laser: { x0: number; y0: number; x1: number; y1: number } | null;
  sling: { x0: number; y0: number; x1: number; y1: number; path: { x: number; y: number }[] } | null;
  ghost: { x: number; y: number; color: number } | null;
}

interface Drawn { b: Body; sx: number; sy: number; rpx: number }

interface Fx extends SimEvent { age: number }

/** Minimum drawn radius in CSS px, by body class, when "Minimum body size" is on (1–2 art pixels). */
const MIN_R = { star: 6, remnant: 4.5, planet: 4.5, small: 3, craft: 3 } as const;

/** Snap a CSS-px coordinate to the art-pixel grid so bodies don't shimmer between pixels. */
const snap = (v: number) => Math.round(v / PX) * PX;

/** Largest globe texture (art pixels across), by quality setting. */
const GLOBE_MAX = { low: 48, med: 96, high: 160 } as const;

export class Renderer {
  readonly app = new Application();
  /** Everything in the pixelated world. Not on the stage: rendered into `rt` each frame. */
  private world = new Container();
  private rt!: RenderTexture;
  private screen = new Sprite();
  private stars = new Sprite();
  private trails = new Graphics();
  private guides = new Graphics();
  private debris!: ParticleContainer;
  /** Fragments smaller than an art pixel. */
  private fragDots!: ParticleContainer;
  /** Fragments big enough to draw as discs. */
  private fragDisks = new Graphics();
  private glows = new Graphics();
  private globes = new Container();
  private dots = new Graphics();
  private fx = new Graphics();
  /** Labels stay crisp: drawn at full resolution above the pixel world. */
  private labels = new Container();
  private pixTex!: Texture;
  private globePool = new Map<number, { sprite: Sprite; canvas: HTMLCanvasElement; tex: Texture; rev: number; painted: number }>();
  private labelPool: Text[] = [];
  private trailBuf = new Map<number, { x: Float64Array; y: Float64Array; n: number; head: number }>();
  private lastTrailSample = 0;
  /** Trails are stored relative to the body the camera follows (0 = inertial frame). */
  private trailFrame = 0;
  private effects: Fx[] = [];
  private shown: Drawn[] = [];
  private host!: HTMLElement;
  private size = { w: 0, h: 0 };

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    await this.app.init({
      resizeTo: host, background: BG, antialias: false, autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2), preference: "webgl",
    });
    // Rendering is driven by draw() so the pixel pass and the screen pass happen in order.
    this.app.ticker.stop();
    host.appendChild(this.app.canvas);
    this.pixTex = pixelTexture();
    this.debris = new ParticleContainer({ dynamicProperties: { position: true, color: true, vertex: false, rotation: false, uvs: false } });
    this.fragDots = new ParticleContainer({ dynamicProperties: { position: true, color: true, vertex: false, rotation: false, uvs: false } });
    this.world.scale.set(1 / PX);
    this.world.addChild(this.stars, this.trails, this.guides, this.debris, this.glows, this.fragDots, this.fragDisks, this.dots, this.globes, this.fx);
    this.rt = RenderTexture.create({ width: 1, height: 1, resolution: 1, antialias: false });
    this.rt.source.scaleMode = "nearest";
    this.screen.texture = this.rt;
    this.screen.scale.set(PX);
    this.app.stage.addChild(this.screen, this.labels);
    this.fitTarget();
  }

  get view(): HTMLCanvasElement {
    return this.app.canvas;
  }

  addEvents(events: SimEvent[]): void {
    for (const e of events) this.effects.push({ ...e, age: 0 });
  }

  /** Forget everything keyed by body id (a new world was loaded). */
  reset(): void {
    this.trailBuf.clear();
    for (const gl of this.globePool.values()) { gl.sprite.destroy(); gl.tex.destroy(true); }
    this.globePool.clear();
    this.effects = [];
  }

  /** Bodies currently drawn (after overlap hiding), for hit testing. */
  visible(): readonly Drawn[] {
    return this.shown;
  }

  /** Keep the low-res target matched to the view; rebuild the starfield when it changes. */
  private fitTarget(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    this.rt.resize(Math.max(1, Math.ceil(w / PX)), Math.max(1, Math.ceil(h / PX)));
    this.buildStarfield(Math.ceil(w / PX), Math.ceil(h / PX));
  }

  private buildStarfield(w: number, h: number): void {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d")!;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const n = Math.round((w * h) / 260);
    for (let i = 0; i < n; i++) {
      const s = rnd();
      // Three brightness steps, one pixel each; the brightest few get a plus shape.
      const a = s > 0.97 ? 0.8 : s > 0.8 ? 0.45 : 0.22;
      const tint = rnd();
      ctx.fillStyle = tint > 0.9 ? `rgba(255,200,150,${a})` : tint > 0.75 ? `rgba(160,200,255,${a})` : `rgba(226,232,240,${a})`;
      const x = Math.floor(rnd() * w), y = Math.floor(rnd() * h);
      ctx.fillRect(x, y, 1, 1);
      if (s > 0.985) { ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3); }
    }
    this.stars.texture?.destroy(true);
    const tex = Texture.from(c);
    tex.source.scaleMode = "nearest";
    this.stars.texture = tex;
    this.stars.scale.set(PX);
  }

  draw(sim: SimClient, cam: Camera, opts: { selectedId: number | null; hoverId: number | null; settings: Settings; realDt: number; rate: number; overlay: Overlay }): void {
    this.fitTarget();
    const { settings: st } = opts;
    const bodies = sim.bodies;

    // ---- Screen positions, minimum size, overlap hiding (heaviest wins) ----
    const cand: Drawn[] = [];
    for (const b of bodies) {
      const sx = snap(cam.sx(b.x)), sy = snap(cam.sy(b.y));
      let rpx = b.r / cam.mpp;
      if (st.minSize) rpx = Math.max(rpx, MIN_R[TYPES[b.type].cls]);
      if (sx + rpx < -50 || sx - rpx > cam.w + 50 || sy + rpx < -50 || sy - rpx > cam.h + 50) continue;
      if (rpx < PX / 2 && b.id !== opts.selectedId) continue; // under half an art pixel
      cand.push({ b, sx, sy, rpx: Math.max(PX / 2, snap(rpx * 2) / 2) });
    }
    cand.sort((a, c) => c.b.m - a.b.m);
    const shown: Drawn[] = [];
    for (const d of cand) {
      const hiddenBy = shown.find(s => Math.hypot(s.sx - d.sx, s.sy - d.sy) < s.rpx + d.rpx + PX);
      if (hiddenBy && d.b.id !== opts.selectedId) continue;
      shown.push(d);
    }
    this.shown = shown;

    // ---- Trails ----
    this.trails.clear();
    const now = performance.now();
    const frameId = cam.followId ?? 0;
    if (frameId !== this.trailFrame) { this.trailBuf.clear(); this.trailFrame = frameId; }
    const ref = frameId ? sim.byId.get(frameId) : undefined;
    const rx = ref?.x ?? 0, ry = ref?.y ?? 0;
    if (st.trails) {
      if (now - this.lastTrailSample > 50) {
        this.lastTrailSample = now;
        for (const b of bodies) {
          let t = this.trailBuf.get(b.id);
          if (!t) { t = { x: new Float64Array(160), y: new Float64Array(160), n: 0, head: 0 }; this.trailBuf.set(b.id, t); }
          t.x[t.head] = b.x - rx; t.y[t.head] = b.y - ry;
          t.head = (t.head + 1) % 160; t.n = Math.min(160, t.n + 1);
        }
        for (const id of this.trailBuf.keys()) if (!sim.byId.has(id)) this.trailBuf.delete(id);
      }
      for (const d of shown) {
        const t = this.trailBuf.get(d.b.id);
        if (!t || t.n < 2 || d.b.id === frameId) continue;
        const color = d.b.id === opts.selectedId ? SELECT : SECONDARY;
        // Four chunks, stepping up in brightness toward the body.
        const chunk = Math.ceil(t.n / 4);
        for (let c = 0; c < 4; c++) {
          let started = false;
          for (let k = c * chunk; k <= Math.min(t.n - 1, (c + 1) * chunk); k++) {
            const idx = (t.head - t.n + k + 160 * 2) % 160;
            const x = cam.sx(t.x[idx] + rx), y = cam.sy(t.y[idx] + ry);
            if (!started) { this.trails.moveTo(x, y); started = true; } else this.trails.lineTo(x, y);
          }
          if (started) this.trails.stroke({ width: LINE, color, alpha: 0.12 + c * 0.12 });
        }
      }
    } else if (this.trailBuf.size) this.trailBuf.clear();

    // ---- Guides: planetary rings and the selected body's predicted orbit ----
    const g = this.guides.clear();
    for (const d of shown) {
      if (!d.b.rings) continue;
      const [ri, ro] = d.b.rings;
      if (ro / cam.mpp < PX * 2) continue;
      g.circle(d.sx, d.sy, (ri + ro) / 2 / cam.mpp).stroke({ width: Math.max(LINE, snap((ro - ri) / cam.mpp)), color: 0xd8cfb8, alpha: 0.3 });
    }
    const sel = opts.selectedId !== null ? sim.byId.get(opts.selectedId) : undefined;
    if (sel) {
      const p = parentOf(bodies, sel);
      if (p) this.drawOrbit(g, sel, p, cam);
    }

    // ---- Debris: one art pixel each ----
    const cap = st.quality === "low" ? 1500 : st.quality === "med" ? 3000 : 5000;
    const n = Math.min(sim.debrisCount, cap);
    const parts = this.debris.particleChildren as Particle[];
    if (parts.length !== n) {
      while (parts.length < n) parts.push(new Particle({ texture: this.pixTex, scaleX: PX, scaleY: PX }));
      parts.length = n;
      this.debris.update();
    }
    const step = sim.debrisCount > cap ? sim.debrisCount / cap : 1;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(k * step);
      const p = parts[k];
      p.x = Math.floor(cam.sx(sim.debrisXY[i * 2]) / PX) * PX;
      p.y = Math.floor(cam.sy(sim.debrisXY[i * 2 + 1]) / PX) * PX;
      p.tint = sim.debrisColor[i];
    }

    // ---- Fragments: pixel chunks, glowing while molten ----
    const glows = this.glows.clear();
    const fd = this.fragDisks.clear();
    const fparts = this.fragDots.particleChildren as Particle[];
    let small = 0;
    for (let i = 0; i < sim.fragCount; i++) {
      const sx = snap(cam.sx(sim.fragXY[i * 2])), sy = snap(cam.sy(sim.fragXY[i * 2 + 1]));
      if (sx < -60 || sy < -60 || sx > cam.w + 60 || sy > cam.h + 60) continue;
      const rpx = sim.fragR[i] / cam.mpp;
      const heat = sim.fragHeat[i];
      // A thin molten rim, not a big halo: hundreds of overlapping halos wash out into one blob.
      if (heat > 0.05) glows.circle(sx, sy, snap(Math.max(PX * 1.5, rpx + PX))).fill({ color: 0xff7a2a, alpha: 0.1 * heat });
      if (rpx < PX * 0.75) {
        let p = fparts[small];
        if (!p) { p = new Particle({ texture: this.pixTex, scaleX: PX, scaleY: PX }); fparts.push(p); }
        p.x = sx; p.y = sy; p.tint = sim.fragColor[i];
        small++;
      } else {
        fd.circle(sx, sy, snap(rpx * 2) / 2).fill(sim.fragColor[i]);
      }
    }
    if (fparts.length !== small) { fparts.length = small; this.fragDots.update(); }

    // ---- Bodies ----
    const dots = this.dots.clear();
    const usedGlobes = new Set<number>();
    const lumBodies = bodies.filter(b => luminosityFor(b.type, b.m) > 0);
    for (const d of shown) {
      const { b, sx, sy, rpx } = d;
      const info = TYPES[b.type];
      if (info.cls === "star" || b.type === "whitedwarf" || b.type === "neutron" || b.type === "pulsar") {
        // Stepped glow: three flat rings instead of a smooth gradient.
        const gr = Math.max(rpx * 3, info.cls === "star" ? 21 : 12);
        glows.circle(sx, sy, snap(gr)).fill({ color: info.color, alpha: 0.08 });
        glows.circle(sx, sy, snap(gr * 0.66)).fill({ color: info.color, alpha: 0.12 });
        glows.circle(sx, sy, snap(Math.max(rpx + PX, gr * 0.4))).fill({ color: info.color, alpha: 0.2 });
        dots.circle(sx, sy, rpx).fill(info.color);
        // Pixel sparkle: a plus through the core.
        const arm = snap(Math.max(rpx * 1.8, 9));
        dots.rect(sx - arm, sy - LINE / 2, arm * 2, LINE).fill({ color: info.color, alpha: 0.7 });
        dots.rect(sx - LINE / 2, sy - arm, LINE, arm * 2).fill({ color: info.color, alpha: 0.7 });
        if (b.type === "pulsar") {
          const a = (now / 1000) * Math.PI;
          const L = Math.max(30, rpx * 8);
          for (const s of [1, -1]) dots.moveTo(sx, sy).lineTo(sx + Math.cos(a) * L * s, sy + Math.sin(a) * L * s).stroke({ width: LINE, color: 0xbff1ff, alpha: 0.6 });
        }
        continue;
      }
      if (b.type === "blackhole") {
        const rr = Math.max(rpx, PX * 1.5);
        dots.ellipse(sx, sy, snap(rr * 3.2), snap(rr * 1.1)).stroke({ width: Math.max(LINE, snap(rr * 0.5)), color: 0xff9a4a, alpha: 0.85 });
        dots.circle(sx, sy, rr).fill(0x000000).stroke({ width: LINE, color: 0xffd9a0 });
        continue;
      }
      if (b.type === "spacecraft") {
        dots.rect(sx - PX, sy - PX, PX * 2, PX * 2).fill(INK);
        continue;
      }
      // Molten planets glow: a halo that fades as the magma ocean crusts over.
      if (b.heat > 300) {
        const k = Math.min(1, (b.heat - 300) / 2500);
        glows.circle(sx, sy, snap(rpx * 1.35 + PX * 2)).fill({ color: 0xff6a1a, alpha: 0.12 + 0.2 * k });
      }
      // Planets get a pixel globe once they're 4+ art pixels across; smaller ones are a flat dot.
      if (b.surface && rpx * 2 >= PX * 4) {
        usedGlobes.add(b.id);
        this.drawGlobe(b, sx, sy, rpx, now, lumBodies, st.quality, sim.t, opts.rate * opts.realDt);
      } else {
        dots.circle(sx, sy, rpx).fill(dominantColor(b.surface, info.color));
      }
    }
    for (const [id, gl] of this.globePool) {
      gl.sprite.visible = usedGlobes.has(id);
      if (!sim.byId.has(id)) { gl.sprite.destroy(); gl.tex.destroy(true); this.globePool.delete(id); }
    }

    // Selection and hover rings.
    for (const d of shown) {
      if (d.b.id === opts.selectedId) dots.circle(d.sx, d.sy, d.rpx + PX * 2).stroke({ width: LINE, color: SELECT });
      else if (d.b.id === opts.hoverId) dots.circle(d.sx, d.sy, d.rpx + PX * 2).stroke({ width: LINE, color: SELECT, alpha: 0.5 });
    }

    this.drawFx(cam, opts.realDt, opts.overlay);
    this.drawLabels(shown, opts.selectedId, opts.hoverId);

    // Pixel pass into the low-res target, then the screen pass (scaled-up world + crisp labels).
    this.app.renderer.render({ container: this.world, target: this.rt, clear: true, clearColor: BG });
    this.app.render();
  }

  private drawOrbit(g: Graphics, b: Body, p: Body, cam: Camera): void {
    const el = elements(b, p);
    const px = cam.sx(p.x), py = cam.sy(p.y);
    if (el.bound) {
      const a = el.a / cam.mpp, e = el.e;
      if (a < PX * 2 || a > 1e6) return;
      const bAx = a * Math.sqrt(1 - e * e);
      const cos = Math.cos(el.argPeri), sin = Math.sin(el.argPeri);
      // Dotted, one art pixel per dot: reads as a guide rather than a solid path.
      const segs = Math.min(360, Math.max(48, Math.round(a / 4)));
      for (let k = 0; k < segs; k += 2) {
        const E = (k / segs) * Math.PI * 2;
        const ox = a * (Math.cos(E) - e), oy = bAx * Math.sin(E);
        const x = px + ox * cos - oy * sin, y = py - (ox * sin + oy * cos);
        g.rect(Math.floor(x / PX) * PX, Math.floor(y / PX) * PX, PX, PX);
      }
      g.fill({ color: SELECT, alpha: 0.5 });
    } else {
      // Escape trajectory: a straight guide along the velocity.
      const vx = b.vx - p.vx, vy = b.vy - p.vy, v = Math.hypot(vx, vy) || 1;
      const sx = cam.sx(b.x), sy = cam.sy(b.y);
      g.moveTo(sx, sy).lineTo(sx + (vx / v) * 200, sy - (vy / v) * 200).stroke({ width: LINE, color: TIME, alpha: 0.6 });
    }
  }

  private drawGlobe(b: Body, sx: number, sy: number, rpx: number, now: number, stars: Body[], quality: Settings["quality"], simT: number, simDt: number): void {
    // One canvas pixel per art pixel, so the globe is drawn with the same hard pixels as everything else.
    const size = Math.max(4, Math.min(GLOBE_MAX[quality], Math.round((rpx * 2) / PX)));
    let gl = this.globePool.get(b.id);
    if (!gl || gl.canvas.width !== size) {
      if (gl) { gl.sprite.destroy(); gl.tex.destroy(true); }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const tex = Texture.from(canvas);
      tex.source.scaleMode = "nearest";
      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      this.globes.addChild(sprite);
      gl = { sprite, canvas, tex, rev: -1, painted: 0 };
      this.globePool.set(b.id, gl);
    }
    // Repaint at ~20 fps (spin and lighting change slowly) or immediately when the surface changed.
    if (gl.rev !== b.surfaceRev || now - gl.painted > 50) {
      let light: [number, number] | null = null;
      let best = Infinity;
      for (const s of stars) {
        if (s === b) continue;
        const dx = s.x - b.x, dy = s.y - b.y, d = Math.hypot(dx, dy);
        if (d < best) { best = d; light = [dx / d, dy / d]; }
      }
      // Same rotation the simulation uses to place impacts. When the planet would turn more
      // than a quarter turn per frame it's a blur anyway, so hold a steady orientation instead of strobing.
      const fast = b.spin !== 0 && Math.abs(simDt / b.spin) > 0.25;
      const rot = !b.spin || fast ? 0 : ((simT / b.spin) % 1) * Math.PI * 2;
      paintPixelGlobe(gl.canvas, b.surface!, rot, light);
      gl.tex.source.update();
      gl.rev = b.surfaceRev;
      gl.painted = now;
    }
    gl.sprite.position.set(sx, sy);
    // When the planet is bigger on screen than the texture cap, pixels simply get chunkier.
    gl.sprite.width = gl.sprite.height = Math.max(size * PX, snap(rpx * 2));
  }

  private drawLabels(shown: Drawn[], selectedId: number | null, hoverId: number | null): void {
    const boxes: [number, number, number, number][] = [];
    let used = 0;
    // Selected first, then heaviest. Asteroids, comets and spacecraft only get a label when
    // selected, hovered or large on screen, so belts don't bury the planets in text.
    const order = [...shown]
      .filter(d => {
        const cls = TYPES[d.b.type].cls;
        if (d.b.id === selectedId || d.b.id === hoverId) return true;
        if (d.b.type === "asteroid" || d.b.type === "comet" || cls === "craft") return d.rpx >= 6;
        return true;
      })
      .sort((a, b) => (a.b.id === selectedId ? -1 : b.b.id === selectedId ? 1 : b.b.m - a.b.m));
    for (const d of order) {
      if (used >= 60) break;
      const w = d.b.name.length * 7 + 4, h = 14;
      const x = d.sx - w / 2, y = d.sy + d.rpx + 6;
      if (boxes.some(([bx, by, bw, bh]) => x < bx + bw && x + w > bx && y < by + bh && y + h > by)) continue;
      boxes.push([x, y, w, h]);
      let t = this.labelPool[used];
      if (!t) {
        t = new Text({ text: "", style: { fontFamily: "Share Tech Mono, ui-monospace, monospace", fontSize: 12, fill: SECONDARY } });
        t.anchor.set(0.5, 0);
        this.labels.addChild(t);
        this.labelPool.push(t);
      }
      if (t.text !== d.b.name) t.text = d.b.name;
      t.style.fill = d.b.id === selectedId ? INK : SECONDARY;
      t.position.set(Math.round(d.sx), Math.round(y));
      t.visible = true;
      used++;
    }
    for (let k = used; k < this.labelPool.length; k++) this.labelPool[k].visible = false;
  }

  private drawFx(cam: Camera, realDt: number, o: Overlay): void {
    const g = this.fx.clear();
    this.effects = this.effects.filter(e => (e.age += realDt) < 1.2);
    for (const e of this.effects) {
      const sx = snap(cam.sx(e.x)), sy = snap(cam.sy(e.y));
      const base = Math.max(6, e.r / cam.mpp);
      const k = e.age / 1.2;
      // Step the fade in quarters, like a sprite animation, rather than a smooth ramp.
      const alpha = Math.ceil((1 - k) * 4) / 4;
      if (e.kind === "collapse") {
        g.circle(sx, sy, snap(base + 40 * (1 - k))).stroke({ width: LINE, color: SELECT, alpha });
      } else {
        const color = e.kind === "shock" ? TIME : e.kind === "absorb" ? SECONDARY : INK;
        g.circle(sx, sy, snap(base + (e.kind === "shock" ? 120 : 40) * k)).stroke({ width: LINE, color, alpha });
      }
    }
    if (o.pointer && o.brushPx > 0) {
      g.circle(snap(o.pointer.x), snap(o.pointer.y), o.brushPx).stroke({ width: LINE, color: o.brushColor ?? SELECT, alpha: 0.8 });
    }
    if (o.laser) {
      g.moveTo(o.laser.x0, o.laser.y0).lineTo(o.laser.x1, o.laser.y1).stroke({ width: LINE * 3, color: DANGER, alpha: 0.4 });
      g.moveTo(o.laser.x0, o.laser.y0).lineTo(o.laser.x1, o.laser.y1).stroke({ width: LINE, color: 0xffe0ea });
      g.rect(snap(o.laser.x0) - PX * 2, snap(o.laser.y0) - PX * 2, PX * 4, PX * 4).stroke({ width: LINE, color: DANGER });
    }
    if (o.ghost) g.circle(snap(o.ghost.x), snap(o.ghost.y), PX * 2).fill({ color: o.ghost.color, alpha: 0.7 }).stroke({ width: LINE, color: SELECT });
    if (o.sling) {
      const { x0, y0, x1, y1, path } = o.sling;
      // Predicted path as a row of art pixels, one every few pixels along the curve.
      let carry = 0;
      for (let i = 0; i + 1 < path.length; i++) {
        const a = path[i], b = path[i + 1], seg = Math.hypot(b.x - a.x, b.y - a.y);
        let t = carry;
        for (; t < seg; t += PX * 3) {
          const x = a.x + ((b.x - a.x) * t) / seg, y = a.y + ((b.y - a.y) * t) / seg;
          if (x > -PX && y > -PX && x < this.app.screen.width + PX && y < this.app.screen.height + PX) g.rect(snap(x), snap(y), PX, PX);
        }
        carry = t - seg;
      }
      g.fill({ color: SELECT, alpha: 0.6 });
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: LINE, color: SELECT });
      const ux = dx / L, uy = dy / L;
      g.moveTo(x1, y1).lineTo(x1 - ux * 12 - uy * 7, y1 - uy * 12 + ux * 7).moveTo(x1, y1).lineTo(x1 - ux * 12 + uy * 7, y1 - uy * 12 - ux * 7).stroke({ width: LINE, color: SELECT });
    }
  }
}

/** A single white pixel, tinted per debris particle. */
function pixelTexture(): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1, 1);
  const t = Texture.from(c);
  t.source.scaleMode = "nearest";
  return t;
}
