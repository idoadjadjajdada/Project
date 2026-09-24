import { Application, Container, Graphics, Particle, ParticleContainer, Sprite, Text, Texture } from "pixi.js";
import { luminosityFor, TYPES } from "../sim/catalog";
import { elements, parentOf } from "../sim/orbit";
import type { Body } from "../sim/types";
import type { SimEvent } from "../sim/world";
import type { SimClient } from "../simClient";
import type { Settings } from "../state/settings";
import type { Camera } from "./camera";
import { dominantColor, paintGlobe } from "./surfacePainter";

const INK = 0xe2e8f0, SECONDARY = 0x7c8ba1, SELECT = 0x00f0ff, DANGER = 0xff3366, TIME = 0xffb020;

export interface Overlay {
  pointer: { x: number; y: number } | null;
  brushPx: number;
  brushColor: number | null;
  laser: { x0: number; y0: number; x1: number; y1: number } | null;
  sling: { x0: number; y0: number; x1: number; y1: number } | null;
  ghost: { x: number; y: number; color: number } | null;
}

interface Drawn { b: Body; sx: number; sy: number; rpx: number }

interface Fx extends SimEvent { age: number }

/** Minimum drawn radius in px, by body class, when "Minimum body size" is on. */
const MIN_R = { star: 4, remnant: 3, planet: 2.5, small: 2, craft: 2 } as const;

export class Renderer {
  readonly app = new Application();
  private stars = new Sprite();
  private trails = new Graphics();
  private guides = new Graphics();
  private debris!: ParticleContainer;
  private glows = new Container();
  private globes = new Container();
  private dots = new Graphics();
  private labels = new Container();
  private fx = new Graphics();
  private dotTex!: Texture;
  private glowTex!: Texture;
  private glowPool: Sprite[] = [];
  private globePool = new Map<number, { sprite: Sprite; canvas: HTMLCanvasElement; tex: Texture; rev: number; painted: number }>();
  private labelPool: Text[] = [];
  private trailBuf = new Map<number, { x: Float64Array; y: Float64Array; n: number; head: number }>();
  private lastTrailSample = 0;
  /** Trails are stored relative to the body the camera follows (0 = inertial frame). */
  private trailFrame = 0;
  private effects: Fx[] = [];
  private shown: Drawn[] = [];
  private host!: HTMLElement;

  async init(host: HTMLElement): Promise<void> {
    this.host = host;
    await this.app.init({
      resizeTo: host, background: 0x0a0e17, antialias: true, autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2), preference: "webgl",
    });
    host.appendChild(this.app.canvas);
    this.dotTex = circleTexture(16, false);
    this.glowTex = circleTexture(64, true);
    this.debris = new ParticleContainer({ dynamicProperties: { position: true, color: true, vertex: false, rotation: false, uvs: false } });
    this.glows.blendMode = "add";
    this.app.stage.addChild(this.stars, this.trails, this.guides, this.debris, this.glows, this.dots, this.globes, this.fx, this.labels);
    this.buildStarfield();
    window.addEventListener("resize", () => requestAnimationFrame(() => this.buildStarfield()));
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

  private buildStarfield(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d")!;
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const n = Math.round((w * h) / 3000);
    for (let i = 0; i < n; i++) {
      const s = rnd();
      ctx.fillStyle = `rgba(226,232,240,${(0.12 + s * 0.4).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(rnd() * w, rnd() * h, s > 0.97 ? 1.2 : 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    this.stars.texture?.destroy(true);
    this.stars.texture = Texture.from(c);
  }

  draw(sim: SimClient, cam: Camera, opts: { selectedId: number | null; hoverId: number | null; settings: Settings; realDt: number; rate: number; overlay: Overlay }): void {
    const { settings: st } = opts;
    const bodies = sim.bodies;

    // ---- Screen positions, minimum size, overlap hiding (heaviest wins) ----
    const cand: Drawn[] = [];
    for (const b of bodies) {
      const sx = cam.sx(b.x), sy = cam.sy(b.y);
      let rpx = b.r / cam.mpp;
      if (st.minSize) rpx = Math.max(rpx, MIN_R[TYPES[b.type].cls]);
      if (sx + rpx < -50 || sx - rpx > cam.w + 50 || sy + rpx < -50 || sy - rpx > cam.h + 50) continue;
      if (rpx < 0.3 && b.id !== opts.selectedId) continue;
      cand.push({ b, sx, sy, rpx });
    }
    cand.sort((a, c) => c.b.m - a.b.m);
    const shown: Drawn[] = [];
    for (const d of cand) {
      const hiddenBy = shown.find(s => Math.hypot(s.sx - d.sx, s.sy - d.sy) < s.rpx + d.rpx + 1.5);
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
        // Four chunks, fading toward the tail.
        const chunk = Math.ceil(t.n / 4);
        for (let c = 0; c < 4; c++) {
          let started = false;
          for (let k = c * chunk; k <= Math.min(t.n - 1, (c + 1) * chunk); k++) {
            const idx = (t.head - t.n + k + 160 * 2) % 160;
            const x = cam.sx(t.x[idx] + rx), y = cam.sy(t.y[idx] + ry);
            if (!started) { this.trails.moveTo(x, y); started = true; } else this.trails.lineTo(x, y);
          }
          if (started) this.trails.stroke({ width: 1, color, alpha: 0.08 + c * 0.1 });
        }
      }
    } else if (this.trailBuf.size) this.trailBuf.clear();

    // ---- Guides: planetary rings and the selected body's predicted orbit ----
    const g = this.guides.clear();
    for (const d of shown) {
      if (!d.b.rings) continue;
      const [ri, ro] = d.b.rings;
      if (ro / cam.mpp < 4) continue;
      g.circle(d.sx, d.sy, (ri + ro) / 2 / cam.mpp).stroke({ width: Math.max(1, (ro - ri) / cam.mpp), color: 0xd8cfb8, alpha: 0.28 });
    }
    const sel = opts.selectedId !== null ? sim.byId.get(opts.selectedId) : undefined;
    if (sel) {
      const p = parentOf(bodies, sel);
      if (p) this.drawOrbit(g, sel, p, cam);
    }

    // ---- Debris ----
    const cap = st.quality === "low" ? 1500 : st.quality === "med" ? 3000 : 5000;
    const n = Math.min(sim.debrisCount, cap);
    const parts = this.debris.particleChildren as Particle[];
    if (parts.length !== n) {
      while (parts.length < n) parts.push(new Particle({ texture: this.dotTex, anchorX: 0.5, anchorY: 0.5, scaleX: 0.1, scaleY: 0.1 }));
      parts.length = n;
      this.debris.update();
    }
    const step = sim.debrisCount > cap ? sim.debrisCount / cap : 1;
    for (let k = 0; k < n; k++) {
      const i = Math.floor(k * step);
      const p = parts[k];
      p.x = cam.sx(sim.debrisXY[i * 2]); p.y = cam.sy(sim.debrisXY[i * 2 + 1]);
      p.tint = sim.debrisColor[i];
    }

    // ---- Bodies ----
    const dots = this.dots.clear();
    let glowUsed = 0;
    const usedGlobes = new Set<number>();
    const lumBodies = bodies.filter(b => luminosityFor(b.type, b.m) > 0);
    for (const d of shown) {
      const { b, sx, sy, rpx } = d;
      const info = TYPES[b.type];
      if (info.cls === "star" || b.type === "whitedwarf" || b.type === "neutron" || b.type === "pulsar") {
        const glow = this.glowSprite(glowUsed++);
        const gr = Math.max(rpx * 3, info.cls === "star" ? 18 : 12);
        glow.position.set(sx, sy); glow.width = glow.height = gr * 2; glow.tint = info.color; glow.alpha = 0.55;
        dots.circle(sx, sy, rpx).fill(info.color);
        if (b.type === "pulsar") {
          const a = (now / 1000) * Math.PI * 2 * 0.5;
          const L = Math.max(30, rpx * 8);
          for (const s of [1, -1]) {
            dots.moveTo(sx, sy).lineTo(sx + Math.cos(a) * L * s, sy + Math.sin(a) * L * s).stroke({ width: 1.5, color: 0xbff1ff, alpha: 0.6 });
          }
        }
        continue;
      }
      if (b.type === "blackhole") {
        const rr = Math.max(rpx, 3);
        dots.ellipse(sx, sy, rr * 3.2, rr * 1.1).stroke({ width: Math.max(1.5, rr * 0.5), color: 0xff9a4a, alpha: 0.8 });
        dots.circle(sx, sy, rr).fill(0x000000).stroke({ width: 1, color: 0xffd9a0 });
        continue;
      }
      if (b.type === "spacecraft") {
        dots.rect(sx - 2, sy - 2, 4, 4).fill(INK);
        continue;
      }
      if (b.surface && rpx >= 8) {
        usedGlobes.add(b.id);
        this.drawGlobe(b, sx, sy, rpx, now, lumBodies, st.quality, sim.t, opts.rate * opts.realDt);
      } else {
        dots.circle(sx, sy, rpx).fill(dominantColor(b.surface, info.color));
      }
    }
    for (let k = glowUsed; k < this.glowPool.length; k++) this.glowPool[k].visible = false;
    for (const [id, gl] of this.globePool) {
      gl.sprite.visible = usedGlobes.has(id);
      if (!sim.byId.has(id)) { gl.sprite.destroy(); gl.tex.destroy(true); this.globePool.delete(id); }
    }

    // Selection and hover rings.
    for (const d of shown) {
      if (d.b.id === opts.selectedId) dots.circle(d.sx, d.sy, d.rpx + 6).stroke({ width: 1, color: SELECT });
      else if (d.b.id === opts.hoverId) dots.circle(d.sx, d.sy, d.rpx + 6).stroke({ width: 1, color: SELECT, alpha: 0.45 });
    }

    this.drawLabels(shown, opts.selectedId, opts.hoverId);
    this.drawFx(cam, opts.realDt, opts.overlay);
  }

  private drawOrbit(g: Graphics, b: Body, p: Body, cam: Camera): void {
    const el = elements(b, p);
    const px = cam.sx(p.x), py = cam.sy(p.y);
    if (el.bound) {
      const a = el.a / cam.mpp, e = el.e;
      if (a < 3 || a > 1e6) return;
      const bAx = a * Math.sqrt(1 - e * e);
      const w = el.argPeri;
      const cos = Math.cos(w), sin = Math.sin(w);
      const segs = 128;
      for (let k = 0; k <= segs; k++) {
        const E = (k / segs) * Math.PI * 2;
        const ox = a * (Math.cos(E) - e), oy = bAx * Math.sin(E);
        const x = px + ox * cos - oy * sin, y = py - (ox * sin + oy * cos);
        if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke({ width: 1, color: SELECT, alpha: 0.35 });
    } else {
      // Escape trajectory: short straight guide along the velocity.
      const vx = b.vx - p.vx, vy = b.vy - p.vy, v = Math.hypot(vx, vy) || 1;
      const sx = cam.sx(b.x), sy = cam.sy(b.y);
      g.moveTo(sx, sy).lineTo(sx + (vx / v) * 200, sy - (vy / v) * 200).stroke({ width: 1, color: TIME, alpha: 0.5 });
    }
  }

  private glowSprite(i: number): Sprite {
    let s = this.glowPool[i];
    if (!s) { s = new Sprite(this.glowTex); s.anchor.set(0.5); this.glows.addChild(s); this.glowPool.push(s); }
    s.visible = true;
    return s;
  }

  private drawGlobe(b: Body, sx: number, sy: number, rpx: number, now: number, stars: Body[], quality: Settings["quality"], simT: number, simDt: number): void {
    const size = quality === "low" ? 64 : quality === "med" ? 96 : 128;
    let gl = this.globePool.get(b.id);
    if (!gl || gl.canvas.width !== size) {
      if (gl) { gl.sprite.destroy(); gl.tex.destroy(true); }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const tex = Texture.from(canvas);
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
      paintGlobe(gl.canvas, b.surface!, rot, light);
      gl.tex.source.update();
      gl.rev = b.surfaceRev;
      gl.painted = now;
    }
    gl.sprite.position.set(sx, sy);
    gl.sprite.width = gl.sprite.height = rpx * 2;
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
      const sx = cam.sx(e.x), sy = cam.sy(e.y);
      const base = Math.max(6, e.r / cam.mpp);
      const k = e.age / 1.2;
      if (e.kind === "collapse") {
        g.circle(sx, sy, base + 40 * (1 - k)).stroke({ width: 1.5, color: SELECT, alpha: 1 - k });
      } else {
        const color = e.kind === "shock" ? TIME : e.kind === "absorb" ? SECONDARY : INK;
        g.circle(sx, sy, base + (e.kind === "shock" ? 120 : 40) * k).stroke({ width: 1.5, color, alpha: 1 - k });
      }
    }
    if (o.pointer && o.brushPx > 0) {
      g.circle(o.pointer.x, o.pointer.y, o.brushPx).stroke({ width: 1, color: o.brushColor ?? SELECT, alpha: 0.7 });
    }
    if (o.laser) {
      g.moveTo(o.laser.x0, o.laser.y0).lineTo(o.laser.x1, o.laser.y1).stroke({ width: 3, color: DANGER, alpha: 0.35 });
      g.moveTo(o.laser.x0, o.laser.y0).lineTo(o.laser.x1, o.laser.y1).stroke({ width: 1, color: 0xffe0ea });
      g.circle(o.laser.x0, o.laser.y0, 4).stroke({ width: 1, color: DANGER });
    }
    if (o.ghost) g.circle(o.ghost.x, o.ghost.y, 5).fill({ color: o.ghost.color, alpha: 0.6 }).stroke({ width: 1, color: SELECT });
    if (o.sling) {
      const { x0, y0, x1, y1 } = o.sling;
      const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
      g.moveTo(x0, y0).lineTo(x1, y1).stroke({ width: 1.5, color: SELECT });
      const ux = dx / L, uy = dy / L;
      g.moveTo(x1, y1).lineTo(x1 - ux * 8 - uy * 5, y1 - uy * 8 + ux * 5).moveTo(x1, y1).lineTo(x1 - ux * 8 + uy * 5, y1 - uy * 8 - ux * 5).stroke({ width: 1.5, color: SELECT });
    }
  }
}

function circleTexture(size: number, soft: boolean): Texture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  if (soft) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
  } else ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  return Texture.from(c);
}
