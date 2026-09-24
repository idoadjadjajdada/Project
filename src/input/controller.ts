import { TYPES } from "../sim/catalog";
import { parentOf, strongestAttractor } from "../sim/orbit";
import type { Pt } from "../sim/protocol";
import type { Body } from "../sim/types";
import type { Camera } from "../render/camera";
import type { Overlay, Renderer } from "../render/renderer";
import type { SimClient } from "../simClient";
import { settings } from "../state/settings";
import type { Hud } from "../ui/hud";

const TAP_MOVE = 8;          // px a press may move and still count as a tap
const LONG_PRESS_MS = 500;
const TWO_TAP_MS = 250;
const ERASE_BRUSH = 32;      // px
const ATTRACT_BRUSH = 90;    // px
const LASER_ARM = 12;        // px of swipe before the laser fires

/** Safari's trackpad pinch event (not in the DOM typings). */
interface GestureEvent extends UIEvent { scale: number; clientX: number; clientY: number }

/**
 * Trackpad scroll vs mouse wheel. Chrome and Safari still report the legacy `wheelDeltaY`,
 * which is -3× the pixel delta for trackpads and a multiple of 120 for wheel notches;
 * any sideways movement also gives the trackpad away.
 */
function isTrackpadScroll(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return false;
  if (e.deltaX !== 0) return true; // mouse wheels only scroll vertically
  const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  return !!legacy && Math.abs(legacy) % 120 !== 0 && Math.abs(legacy + 3 * e.deltaY) < 1;
}

interface Ptr {
  id: number;
  type: string;
  x: number; y: number;
  x0: number; y0: number;
  t0: number;
  /** What this pointer is doing. */
  role: "tool" | "camera" | "none";
}

type Stroke =
  | { kind: "pan" }
  | { kind: "grab"; id: number; samples: { t: number; x: number; y: number }[] }
  | { kind: "erase" }
  | { kind: "attract" }
  | { kind: "laser"; armed: boolean }
  | { kind: "place" }
  | { kind: "tap"; bodyId: number | null };

/**
 * Turns pointer input into tool actions and camera moves.
 * Mouse: left = tool, right/middle drag = pan, wheel = zoom.
 * Mac trackpad: two-finger scroll = pan, pinch = zoom.
 * Touch: one finger = tool, two fingers = pan/pinch, two-finger tap = undo, long-press = info.
 * Pencil mode: the Pencil always uses the tool; fingers always move the camera.
 */
export class InputController {
  private ptrs = new Map<number, Ptr>();
  private stroke: Stroke | null = null;
  private strokePtr: number | null = null;
  private longPress = 0;
  private pinch: { d: number; mx: number; my: number } | null = null;
  private twoTap: { t0: number; moved: boolean } | null = null;
  private hover: { x: number; y: number } | null = null;
  /** Body the grabbed body is held relative to (its surroundings as seen on screen). */
  private grabRef = 0;
  readonly overlay: Overlay = { pointer: null, brushPx: 0, brushColor: null, laser: null, sling: null, ghost: null };

  constructor(private el: HTMLElement, private cam: Camera, private sim: SimClient, private renderer: Renderer, private hud: Hud) {
    el.addEventListener("pointerdown", e => this.down(e));
    el.addEventListener("pointermove", e => this.move(e));
    el.addEventListener("pointerup", e => this.up(e));
    el.addEventListener("pointercancel", e => this.up(e, true));
    el.addEventListener("pointerleave", () => { this.hover = null; this.hud.peek(null); });
    el.addEventListener("contextmenu", e => e.preventDefault());
    el.addEventListener("wheel", e => {
      e.preventDefault();
      const [x, y] = this.local(e);
      // Trackpad pinch arrives as a ctrl+wheel with small deltas (Chrome, Firefox, Edge).
      if (e.ctrlKey) { this.cam.zoomAt(x, y, Math.exp(-e.deltaY * 0.01)); return; }
      // Two-finger trackpad scroll pans; a mouse wheel zooms.
      if (isTrackpadScroll(e)) { this.cam.panPx(-e.deltaX, -e.deltaY); return; }
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.cam.zoomAt(x, y, k);
    }, { passive: false });
    // Safari sends trackpad pinches as gesture events and would zoom the whole page.
    let gScale = 1;
    el.addEventListener("gesturestart", e => { e.preventDefault(); gScale = (e as GestureEvent).scale || 1; });
    el.addEventListener("gesturechange", e => {
      e.preventDefault();
      const g = e as GestureEvent, s = g.scale || 1;
      const [x, y] = this.local(g);
      this.cam.zoomAt(x, y, s / gScale);
      gScale = s;
    });
    el.addEventListener("gestureend", e => e.preventDefault());
    hud.onToolChange = () => this.refreshCursor();
    this.refreshCursor();
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /**
   * A screen point as an offset from a body, so the worker (which runs a frame ahead) puts
   * it in the same place relative to what the player sees. Anchors to the followed body,
   * else to whatever pulls hardest at that point.
   */
  anchor(sx: number, sy: number, ref?: number): Pt {
    const wx = this.cam.wx(sx), wy = this.cam.wy(sy);
    if (ref === 0) return { ref: 0, dx: wx, dy: wy };
    const b = (ref !== undefined ? this.sim.byId.get(ref) : undefined)
      ?? (this.cam.followId !== null ? this.sim.byId.get(this.cam.followId) : undefined)
      ?? strongestAttractor(this.sim.bodies, wx, wy);
    return b ? { ref: b.id, dx: wx - b.x, dy: wy - b.y } : { ref: 0, dx: wx, dy: wy };
  }

  /** Nearest drawn body under a screen point. */
  bodyAt(x: number, y: number, slop: number): Body | null {
    let best: Body | null = null, bd = Infinity;
    for (const d of this.renderer.visible()) {
      const dist = Math.hypot(d.sx - x, d.sy - y);
      if (dist < Math.max(d.rpx + slop, slop + 4) && dist < bd) { bd = dist; best = d.b; }
    }
    return best;
  }

  private isCameraPointer(e: PointerEvent): boolean {
    if (e.pointerType === "mouse") return e.button === 1 || e.button === 2;
    if (settings.get().pencil && e.pointerType === "touch") return true;
    return false;
  }

  private down(e: PointerEvent): void {
    if (e.pointerType === "pen") this.hud.pencilDetected();
    this.el.setPointerCapture(e.pointerId);
    const [x, y] = this.local(e);
    const p: Ptr = { id: e.pointerId, type: e.pointerType, x, y, x0: x, y0: y, t0: performance.now(), role: "none" };
    this.ptrs.set(e.pointerId, p);
    this.hud.closePresets();

    const touches = [...this.ptrs.values()].filter(q => q.type === "touch");
    const pencilMode = settings.get().pencil;

    // Second finger (without Pencil mode): abandon the tool stroke and start a camera gesture.
    if (e.pointerType === "touch" && !pencilMode && touches.length === 2) {
      this.cancelStroke();
      for (const q of touches) q.role = "camera";
      this.startPinch();
      this.twoTap = { t0: performance.now(), moved: false };
      return;
    }
    if (this.isCameraPointer(e)) {
      p.role = "camera";
      const cams = [...this.ptrs.values()].filter(q => q.role === "camera");
      if (cams.length === 2) { this.startPinch(); this.twoTap = { t0: performance.now(), moved: false }; }
      return;
    }
    if (this.stroke) return; // one tool stroke at a time
    p.role = "tool";
    this.strokePtr = p.id;
    this.beginStroke(p, e.pointerType);

    // Long-press a body opens its info panel whatever the tool (touch and Pencil).
    if (e.pointerType !== "mouse") {
      const b = this.bodyAt(x, y, 22);
      if (b) {
        this.longPress = window.setTimeout(() => {
          const q = this.ptrs.get(p.id);
          if (q && Math.hypot(q.x - q.x0, q.y - q.y0) < TAP_MOVE) {
            this.cancelStroke();
            this.hud.select(b.id);
          }
        }, LONG_PRESS_MS);
      }
    }
  }

  private beginStroke(p: Ptr, type: string): void {
    const s = this.hud.state;
    const slop = type === "mouse" ? 8 : 22;
    const hit = this.bodyAt(p.x, p.y, slop);
    if (s.placeType) { this.stroke = { kind: "place" }; return; }
    switch (s.tool) {
      case "select":
        // A tap selects (or deselects on empty space); dragging turns it into a pan.
        this.stroke = { kind: "tap", bodyId: hit?.id ?? null };
        break;
      case "grab":
        if (hit) {
          this.stroke = { kind: "grab", id: hit.id, samples: [] };
          this.grabRef = parentOf(this.sim.bodies, hit)?.id ?? 0;
          this.sim.send({ type: "grab", id: hit.id, at: this.anchor(p.x, p.y, this.grabRef) });
          this.el.classList.add("cursor-grabbing");
        } else this.stroke = { kind: "pan" };
        break;
      case "erase":
        this.sim.send({ type: "snapshot" });
        this.stroke = { kind: "erase" };
        break;
      case "attract":
        this.stroke = { kind: "attract" };
        break;
      case "laser":
        this.stroke = { kind: "laser", armed: false };
        break;
      case "orbitlock": case "collapse": case "explode":
        this.stroke = { kind: "tap", bodyId: hit?.id ?? null };
        break;
    }
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.local(e);
    const p = this.ptrs.get(e.pointerId);
    if (!p) {
      // Hover (mouse, or Pencil hovering above an iPad).
      this.hover = { x, y };
      if (e.pointerType !== "touch") {
        const b = this.bodyAt(x, y, 8);
        this.hud.state.hoverId = b?.id ?? null;
        this.hud.peek(b, x, y);
      }
      return;
    }
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_MOVE) { clearTimeout(this.longPress); if (this.twoTap) this.twoTap.moved = true; }
    this.hover = { x, y };
    this.hud.peek(null);

    if (p.role === "camera") {
      const cams = [...this.ptrs.values()].filter(q => q.role === "camera");
      if (cams.length >= 2 && this.pinch) {
        const [a, b] = cams;
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.cam.panPx(mx - this.pinch.mx, my - this.pinch.my);
        if (this.pinch.d > 0) this.cam.zoomAt(mx, my, d / this.pinch.d);
        this.pinch = { d, mx, my };
      } else if (cams.length === 1) {
        this.cam.panPx(dx, dy);
      }
      return;
    }
    if (p.role !== "tool" || !this.stroke) return;
    const st = this.stroke;
    if (st.kind === "tap" && Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_MOVE && this.hud.state.tool === "select") {
      this.stroke = { kind: "pan" };
    }
    if (this.stroke.kind === "pan") this.cam.panPx(dx, dy);
    if (st.kind === "grab") {
      this.sim.send({ type: "grabMove", at: this.anchor(x, y, this.grabRef) });
      // Throw velocity is measured in screen space (relative to what the player sees moving).
      st.samples.push({ t: performance.now(), x: x * this.cam.mpp, y: -y * this.cam.mpp });
      if (st.samples.length > 8) st.samples.shift();
    }
    if (st.kind === "laser" && !st.armed && Math.hypot(p.x - p.x0, p.y - p.y0) > LASER_ARM) {
      st.armed = true;
      this.sim.send({ type: "snapshot" });
    }
  }

  private up(e: PointerEvent, cancelled = false): void {
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    clearTimeout(this.longPress);
    if (!p) return;

    if (p.role === "camera") {
      // Two-finger tap = undo.
      if (this.twoTap && !this.twoTap.moved && performance.now() - this.twoTap.t0 < TWO_TAP_MS && !cancelled) {
        this.twoTap = null;
        this.hud.notice("Undo");
        this.sim.send({ type: "undo" });
      }
      if ([...this.ptrs.values()].filter(q => q.role === "camera").length < 2) this.pinch = null;
      if (![...this.ptrs.values()].some(q => q.role === "camera")) this.twoTap = null;
      return;
    }
    if (p.role !== "tool" || this.strokePtr !== p.id) return;
    const st = this.stroke;
    this.stroke = null;
    this.strokePtr = null;
    if (!st || cancelled) { this.endEffects(st, true); return; }
    const tapped = Math.hypot(p.x - p.x0, p.y - p.y0) < TAP_MOVE;

    switch (st.kind) {
      case "tap": {
        if (!tapped) break;
        const id = st.bodyId;
        const tool = this.hud.state.tool;
        if (tool === "select") this.hud.select(id);
        else if (id !== null && tool === "orbitlock") this.sim.send({ type: "orbitLock", id });
        else if (id !== null && tool === "collapse") { this.sim.send({ type: "snapshot" }); this.sim.send({ type: "collapse", id }); }
        else if (id !== null && tool === "explode") { this.sim.send({ type: "snapshot" }); this.sim.send({ type: "explode", id }); }
        break;
      }
      case "grab": {
        // Throw velocity from the last ~100 ms of motion, converted from real time to sim time.
        const now = performance.now();
        const recent = st.samples.filter(s => now - s.t < 120);
        let vx = 0, vy = 0;
        if (recent.length >= 2 && !this.hud.state.paused) {
          const a = recent[0], b = recent[recent.length - 1];
          const dt = (b.t - a.t) / 1000;
          if (dt > 0) { vx = (b.x - a.x) / dt / this.hud.state.rate; vy = (b.y - a.y) / dt / this.hud.state.rate; }
        }
        this.sim.send({ type: "grabEnd", vx, vy });
        break;
      }
      case "place": {
        const s = this.hud.state;
        if (!s.placeType) break;
        // Launch speed: 100 px of drag = the local circular orbit speed.
        const dx = p.x - p.x0, dy = p.y - p.y0;
        const launch = tapped ? undefined : { dx: dx / 100, dy: -dy / 100 };
        this.sim.send({ type: "place", body: s.placeType, m: s.placeMass, at: this.anchor(p.x0, p.y0), launch });
        break;
      }
    }
    this.endEffects(st, false);
  }

  /** Release whatever a stroke left running in the sim. */
  private endEffects(st: Stroke | null, cancelled: boolean): void {
    if (!st) return;
    if (st.kind === "attract") this.sim.send({ type: "field", field: null });
    if (st.kind === "laser") this.sim.send({ type: "laserEnd" });
    if (st.kind === "grab" && cancelled) this.sim.send({ type: "grabEnd", vx: 0, vy: 0 });
    this.el.classList.remove("cursor-grabbing");
  }

  private cancelStroke(): void {
    const st = this.stroke;
    this.stroke = null;
    this.strokePtr = null;
    clearTimeout(this.longPress);
    for (const q of this.ptrs.values()) if (q.role === "tool") q.role = "none";
    this.endEffects(st, true);
  }

  private startPinch(): void {
    const cams = [...this.ptrs.values()].filter(q => q.role === "camera");
    if (cams.length < 2) return;
    const [a, b] = cams;
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private refreshCursor(): void {
    const s = this.hud.state;
    this.el.classList.remove("cursor-cross", "cursor-grab", "cursor-none");
    if (s.placeType || s.tool === "laser" || s.tool === "orbitlock" || s.tool === "collapse" || s.tool === "explode") this.el.classList.add("cursor-cross");
    else if (s.tool === "grab") this.el.classList.add("cursor-grab");
    else if (s.tool === "erase" || s.tool === "attract") this.el.classList.add("cursor-none");
  }

  /**
   * Per-frame work for held tools (erase sweeps, attract field, laser beam) and the overlay.
   * Returns the laser request for this frame's tick, if firing.
   */
  frame(): { from: Pt; to: Pt; tol: number } | undefined {
    const o = this.overlay;
    const s = this.hud.state;
    const p = this.strokePtr !== null ? this.ptrs.get(this.strokePtr) : undefined;
    const at = p ?? this.hover;
    o.pointer = at ? { x: at.x, y: at.y } : null;
    o.brushPx = s.tool === "erase" ? ERASE_BRUSH : s.tool === "attract" ? ATTRACT_BRUSH : 0;
    o.brushColor = s.tool === "erase" ? 0xff3366 : null;
    if (s.placeType || !at) o.brushPx = 0;
    o.laser = null; o.sling = null; o.ghost = null;
    if (s.placeType && at) {
      o.ghost = { x: p ? p.x0 : at.x, y: p ? p.y0 : at.y, color: TYPES[s.placeType].color };
      if (p && Math.hypot(p.x - p.x0, p.y - p.y0) > TAP_MOVE) o.sling = { x0: p.x0, y0: p.y0, x1: p.x, y1: p.y };
    }
    const st = this.stroke;
    if (!st || !p) return undefined;
    if (st.kind === "erase") {
      this.sim.send({ type: "erase", at: this.anchor(p.x, p.y), radius: ERASE_BRUSH * this.cam.mpp });
    }
    if (st.kind === "attract") {
      const R = ATTRACT_BRUSH * this.cam.mpp;
      // Pull hard enough that a body crosses the brush in about half a second of real time.
      const tau = 0.5 * s.rate;
      const accel = s.paused ? 0 : (2 * R) / (tau * tau);
      this.sim.send({ type: "field", field: { at: this.anchor(p.x, p.y), radius: R, accel } });
    }
    if (st.kind === "laser" && st.armed) {
      // The hold point is a spot on screen, so it stays put while the camera follows a body.
      const sx0 = p.x0, sy0 = p.y0;
      const from = this.anchor(sx0, sy0);
      const to = this.anchor(p.x, p.y, from.ref);
      // End the beam where it meets the target as drawn this frame (the worker's hit point is a frame ahead).
      const L = Math.hypot(p.x - sx0, p.y - sy0) || 1;
      const ux = (p.x - sx0) / L, uy = (p.y - sy0) / L;
      const far = Math.hypot(this.cam.w, this.cam.h) * 2;
      let ex = sx0 + ux * far, ey = sy0 + uy * far;
      const hitId = this.sim.laserHit?.id;
      const target = hitId !== undefined ? this.renderer.visible().find(d => d.b.id === hitId) : undefined;
      if (target) {
        const cx = target.sx - sx0, cy = target.sy - sy0;
        const along = cx * ux + cy * uy;
        const perp2 = cx * cx + cy * cy - along * along;
        const r = Math.max(target.rpx, 3);
        const into = perp2 < r * r ? Math.sqrt(r * r - perp2) : 0;
        const t = Math.max(0, along - into);
        ex = sx0 + ux * t; ey = sy0 + uy * t;
      }
      o.laser = { x0: sx0, y0: sy0, x1: ex, y1: ey };
      return { from, to, tol: 3 * this.cam.mpp };
    }
    return undefined;
  }
}
