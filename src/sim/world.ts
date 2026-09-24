import { luminosityFor, radiusFor, schwarzschildRadius, TYPES } from "./catalog";
import { G, M_SUN, MAX_BODIES, MAX_DEBRIS, UNDO_DEPTH } from "./constants";
import { materialColor, M } from "./materials";
import { circularVelocity, parentOf, propagateKepler } from "./orbit";
import { rng } from "./rng";
import { composition, fragmentSurface, generateSurface, remix, sampleSurface, splash } from "./surface";
import type { Body, BodyType, DebrisSet } from "./types";
import { SURF_H, SURF_W } from "./types";

export interface SimEvent {
  kind: "flash" | "shock" | "collapse" | "absorb";
  x: number; y: number;
  /** Physical radius the effect scales from, m. */
  r: number;
}

export interface NewBody {
  type: BodyType;
  x: number; y: number;
  vx?: number; vy?: number;
  m?: number;
  r?: number;
  name?: string;
  surface?: Uint8Array | null;
  seed?: number;
  spin?: number;
  greenhouse?: number;
  albedo?: number;
  rings?: [number, number];
}

interface Snapshot {
  t: number;
  nextId: number;
  bodies: Body[];
  debris: DebrisSet;
}

export interface SerializedWorld {
  v: 1;
  t: number;
  nextId: number;
  bodies: (Omit<Body, "surface"> & { surface: string | null })[];
  debris: { x: number[]; y: number[]; vx: number[]; vy: number[]; color: number[]; host: number[] };
}

/** Attract tool's pull, in sim-time units. */
export interface Field { x: number; y: number; radius: number; accel: number }

export interface Grab { id: number; x: number; y: number }

interface HeavyState { x: number; y: number; vx: number; vy: number; m: number; r: number }

export type CollisionOutcome = "merge" | "absorb" | "hit-and-run" | "partial" | "shatter";

const ETA = 0.02;                  // dt = ETA × shortest dynamical time
/** Deepest timestep level: the fastest body can step 2^12 times per block. */
const MAX_LEVEL = 12;
const DEBRIS_ATTRACTORS = 8;

function emptyDebris(): DebrisSet {
  return {
    count: 0,
    x: new Float64Array(MAX_DEBRIS), y: new Float64Array(MAX_DEBRIS),
    vx: new Float64Array(MAX_DEBRIS), vy: new Float64Array(MAX_DEBRIS),
    color: new Uint32Array(MAX_DEBRIS), host: new Uint32Array(MAX_DEBRIS),
  };
}

function cloneDebris(d: DebrisSet): DebrisSet {
  return {
    count: d.count,
    x: d.x.slice(), y: d.y.slice(), vx: d.vx.slice(), vy: d.vy.slice(),
    color: d.color.slice(), host: d.host.slice(),
  };
}

function cloneBody(b: Body): Body {
  return { ...b, surface: b.surface ? b.surface.slice() : null, rings: b.rings ? [...b.rings] as [number, number] : undefined };
}

export class World {
  bodies: Body[] = [];
  debris: DebrisSet = emptyDebris();
  /** Seconds since the preset's epoch. */
  t = 0;
  nextId = 1;
  events: SimEvent[] = [];
  field: Field | null = null;
  grab: Grab | null = null;
  /** True when the last step could not reach the requested time warp. */
  limited = false;
  /** Set whenever bodies are added, removed or change type, so the UI can refresh names. */
  topologyRev = 0;
  private undoStack: Snapshot[] = [];
  private rand = rng(1234);
  private debrisCursor = 0;
  private laserStart = new Map<number, number>();

  // ---------- Bodies ----------

  add(o: NewBody): Body | null {
    if (this.bodies.length >= MAX_BODIES) return null;
    const info = TYPES[o.type];
    const m = o.m ?? info.m0;
    const seed = o.seed ?? Math.floor(this.rand() * 1e9);
    let surface: Uint8Array | null = null;
    if (o.surface !== undefined) surface = o.surface;
    else if (info.surface) surface = generateSurface(info.surface, !!info.bands, seed, o.type === "ocean");
    const b: Body = {
      id: this.nextId++,
      name: o.name ?? `${info.label} ${this.nextId - 1}`,
      type: o.type,
      x: o.x, y: o.y, vx: o.vx ?? 0, vy: o.vy ?? 0,
      m, r: o.r ?? radiusFor(o.type, m),
      spin: o.spin ?? info.spin,
      greenhouse: o.greenhouse ?? info.greenhouse,
      albedo: o.albedo ?? info.albedo,
      surface, surfaceRev: 0,
      rings: o.rings,
    };
    this.bodies.push(b);
    this.topologyRev++;
    return b;
  }

  get(id: number): Body | undefined {
    return this.bodies.find(b => b.id === id);
  }

  remove(id: number): void {
    const i = this.bodies.findIndex(b => b.id === id);
    if (i < 0) return;
    const gone = this.bodies[i];
    this.bodies.splice(i, 1);
    // Ring particles bound to the body become free debris.
    const d = this.debris;
    for (let k = 0; k < d.count; k++) if (d.host[k] === id) this.freeDebris(k, gone);
    if (this.grab?.id === id) this.grab = null;
    this.topologyRev++;
  }

  clear(): void {
    this.bodies = [];
    this.debris = emptyDebris();
    this.t = 0;
    this.nextId = 1;
    this.undoStack = [];
    this.field = null;
    this.grab = null;
    this.topologyRev++;
  }

  /** Set a body's mass, keeping its density (radius follows the type's mass-radius law). */
  setMass(b: Body, m: number): void {
    if (m <= 0) return;
    if (b.type === "blackhole") b.r = schwarzschildRadius(m);
    else if (TYPES[b.type].cls === "star" || TYPES[b.type].cls === "remnant") b.r = radiusFor(b.type, m);
    else b.r *= Math.cbrt(m / b.m);
    b.m = m;
  }

  /** Add a debris particle at an absolute position. With `host`, it stays bound to that body. */
  addDebris(x: number, y: number, vx: number, vy: number, color: number, host = 0): void {
    const d = this.debris;
    const h = host ? this.get(host) : undefined;
    if (h) { x -= h.x; y -= h.y; vx -= h.vx; vy -= h.vy; } else host = 0;
    let i: number;
    if (d.count < MAX_DEBRIS) i = d.count++;
    else { i = this.debrisCursor; this.debrisCursor = (this.debrisCursor + 1) % MAX_DEBRIS; }
    d.x[i] = x; d.y[i] = y; d.vx[i] = vx; d.vy[i] = vy; d.color[i] = color; d.host[i] = host;
  }

  private removeDebris(i: number): void {
    const d = this.debris, last = --d.count;
    d.x[i] = d.x[last]; d.y[i] = d.y[last]; d.vx[i] = d.vx[last]; d.vy[i] = d.vy[last];
    d.color[i] = d.color[last]; d.host[i] = d.host[last];
  }

  // ---------- Integration ----------

  /**
   * Advance by `dt` sim seconds. Uses kick-drift-kick leapfrog with per-body block
   * timesteps: each body steps at a power-of-two fraction of the block length matched to
   * its own dynamical time, so a fast inner moon doesn't force the whole system onto its
   * tiny step. Stops early (and sets `limited`) once `budgetMs` of wall-clock time is
   * spent, so time warp degrades gracefully instead of freezing the worker.
   * Returns the sim time actually advanced.
   */
  step(dt: number, budgetMs = 12): number {
    this.limited = false;
    if (dt <= 0) { this.applyGrab(); return 0; }
    const deadline = performance.now() + budgetMs;
    let done = 0;
    while (done < dt) {
      if (performance.now() > deadline) { this.limited = true; break; }
      done += this.block(dt - done);
    }
    return done;
  }

  private block(maxH: number): number {
    const bs = this.bodies, n = bs.length;
    if (n === 0) { this.t += maxH; this.stepDebris(maxH, []); return maxH; }
    const ax = new Float64Array(n), ay = new Float64Array(n), tau = new Float64Array(n);
    this.forcesAll(ax, ay, tau);

    let tauMax = 0;
    for (let i = 0; i < n; i++) if (tau[i] !== Infinity && tau[i] > tauMax) tauMax = tau[i];
    const H = tauMax > 0 ? Math.min(maxH, ETA * tauMax) : maxH;
    const level = new Int32Array(n);
    let kmax = 0;
    for (let i = 0; i < n; i++) {
      const k = tau[i] === Infinity ? 0 : Math.ceil(Math.log2(H / (ETA * tau[i])));
      level[i] = Math.max(0, Math.min(MAX_LEVEL, k));
      if (level[i] > kmax) kmax = level[i];
    }
    // Heavy bodies as they were at the start of the block: debris integrates against their
    // interpolated positions, not the end-of-block ones (fast planets would swallow it).
    const heavyStart = this.heavySnapshot();
    const fineSteps = 1 << kmax;
    const fine = H / fineSteps;
    const hOf = (i: number) => H / (1 << level[i]);
    const members = bs.slice();

    // Opening half kick for every body's first step.
    for (let i = 0; i < n; i++) { const b = bs[i]; b.vx += ax[i] * hOf(i) * 0.5; b.vy += ay[i] * hOf(i) * 0.5; }

    const due: number[] = [];
    for (let s = 0; s < fineSteps; s++) {
      for (const b of members) { b.x += b.vx * fine; b.y += b.vy * fine; }
      this.t += fine;
      this.applyGrab();
      const last = s === fineSteps - 1;
      due.length = 0;
      for (let i = 0; i < n; i++) if (last || ((s + 1) & ((1 << (kmax - level[i])) - 1)) === 0) due.push(i);

      // Collisions: test every due body against everyone over the interval it just stepped.
      let collided = false;
      for (const i of due) {
        const a = members[i];
        if (!this.bodies.includes(a)) continue;
        for (const b of this.bodies) {
          if (b === a || !this.touching(a, b, hOf(i))) continue;
          this.collide(a, b);
          collided = true;
          break;
        }
      }
      if (collided) {
        // Close everyone's step early with fresh forces. Bodies created by the collision
        // (fragments) start clean and get their first kick in the next block.
        const alive = members.filter(b => this.bodies.includes(b));
        const cax = new Float64Array(this.bodies.length), cay = new Float64Array(this.bodies.length);
        this.forcesAll(cax, cay, new Float64Array(this.bodies.length));
        for (const b of alive) {
          const j = this.bodies.indexOf(b), i = members.indexOf(b);
          b.vx += cax[j] * hOf(i) * 0.5; b.vy += cay[j] * hOf(i) * 0.5;
        }
        this.stepDebris(fine * (s + 1), heavyStart);
        return fine * (s + 1);
      }

      // Due bodies end their step (half kick) and, unless the block is over, start the next (half kick).
      this.forcesOn(members, due, ax, ay);
      for (const i of due) {
        const b = members[i], k = last ? 0.5 : 1;
        b.vx += ax[i] * hOf(i) * k; b.vy += ay[i] * hOf(i) * k;
      }
    }
    this.stepDebris(H, heavyStart);
    return H;
  }

  private heavySnapshot(): HeavyState[] {
    return this.bodies
      .filter(b => b.type !== "spacecraft")
      .sort((a, b) => b.m - a.m)
      .slice(0, DEBRIS_ATTRACTORS)
      .map(b => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, m: b.m, r: b.r }));
  }

  /** Swept contact test: did a and b touch at any point during the last `h` seconds? */
  private touching(a: Body, b: Body, h: number): boolean {
    const rsum = a.r + b.r;
    const rx = b.x - a.x, ry = b.y - a.y;
    const vx = b.vx - a.vx, vy = b.vy - a.vy;
    const v2 = vx * vx + vy * vy;
    let tc = 0;
    if (v2 > 0) tc = Math.min(h, Math.max(0, (rx * vx + ry * vy) / v2));
    const cx = rx - vx * tc, cy = ry - vy * tc;
    return cx * cx + cy * cy < rsum * rsum;
  }

  /** Full N² pass: accelerations plus each body's shortest dynamical time. */
  private forcesAll(ax: Float64Array, ay: Float64Array, tau: Float64Array): void {
    const bs = this.bodies, n = bs.length;
    ax.fill(0); ay.fill(0); tau.fill(Infinity);
    for (let i = 0; i < n; i++) {
      const a = bs[i];
      for (let j = i + 1; j < n; j++) {
        const b = bs[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const soft = (a.r + b.r) * 0.05; // tiny softening: only matters inside touching distance
        const d2 = dx * dx + dy * dy + soft * soft;
        const d = Math.sqrt(d2);
        const inv3 = 1 / (d2 * d);
        const mA = a.type === "spacecraft" ? 0 : a.m, mB = b.type === "spacecraft" ? 0 : b.m;
        const gA = G * mB * inv3, gB = G * mA * inv3;
        ax[i] += dx * gA; ay[i] += dy * gA;
        ax[j] -= dx * gB; ay[j] -= dy * gB;
        const mu = G * (mA + mB);
        if (mu > 0) {
          const t = Math.sqrt((d2 * d) / mu);
          if (t < tau[i]) tau[i] = t;
          if (t < tau[j]) tau[j] = t;
        }
      }
    }
    for (let i = 0; i < n; i++) this.addField(bs[i], i, ax, ay);
  }

  /** Accelerations for a subset of bodies (by index into `members`) from every body. */
  private forcesOn(members: Body[], idx: number[], ax: Float64Array, ay: Float64Array): void {
    const bs = this.bodies;
    for (const i of idx) {
      const a = members[i];
      let sx = 0, sy = 0;
      for (const b of bs) {
        if (b === a || b.type === "spacecraft") continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const soft = (a.r + b.r) * 0.05;
        const d2 = dx * dx + dy * dy + soft * soft;
        const g = (G * b.m) / (d2 * Math.sqrt(d2));
        sx += dx * g; sy += dy * g;
      }
      ax[i] = sx; ay[i] = sy;
      this.addField(a, i, ax, ay);
    }
  }

  private addField(b: Body, i: number, ax: Float64Array, ay: Float64Array): void {
    const f = this.field;
    if (!f) return;
    const dx = f.x - b.x, dy = f.y - b.y, d = Math.hypot(dx, dy);
    const reach = f.radius * 3;
    if (d > reach || d === 0) return;
    const k = f.accel * (1 - d / reach);
    ax[i] += (dx / d) * k; ay[i] += (dy / d) * k;
  }

  /**
   * Debris is massless. Particles bound to a host (planetary rings, impact rings) store
   * their state relative to it and move by exact Kepler propagation; free particles are
   * integrated against the heaviest bodies with a few substeps.
   */
  private stepDebris(h: number, heavy: HeavyState[]): void {
    const d = this.debris;
    if (d.count === 0 || h <= 0) return;
    const byId = new Map(this.bodies.map(b => [b.id, b]));
    for (let i = d.count - 1; i >= 0; i--) {
      if (d.host[i]) {
        const host = byId.get(d.host[i]);
        if (!host) { d.host[i] = 0; continue; }
        const next = propagateKepler(G * host.m, d.x[i], d.y[i], d.vx[i], d.vy[i], h);
        if (next) {
          [d.x[i], d.y[i], d.vx[i], d.vy[i]] = next;
          if (d.x[i] * d.x[i] + d.y[i] * d.y[i] < host.r * host.r) this.removeDebris(i);
          continue;
        }
        // Escaped its host: becomes free debris.
        this.freeDebris(i, host);
      }
      let tau = Infinity;
      for (const b of heavy) {
        const r = Math.hypot(b.x - d.x[i], b.y - d.y[i]);
        tau = Math.min(tau, Math.sqrt((r * r * r) / (G * b.m)));
      }
      const sub = Math.min(32, Math.max(1, Math.ceil(h / (ETA * 4 * tau))));
      const hh = h / sub;
      let absorbed = false;
      for (let k = 0; k < sub && !absorbed; k++) {
        const tm = (k + 0.5) * hh; // mid-substep time for the attractors' positions
        let ax = 0, ay = 0;
        for (const b of heavy) {
          const dx = b.x + b.vx * tm - d.x[i], dy = b.y + b.vy * tm - d.y[i];
          const r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
          if (r < b.r) { absorbed = true; break; }
          const g = (G * b.m) / (r2 * r);
          ax += dx * g; ay += dy * g;
        }
        if (this.field) {
          const f = this.field, dx = f.x - d.x[i], dy = f.y - d.y[i], r = Math.hypot(dx, dy);
          if (r > 0 && r < f.radius * 3) { const q = f.accel * (1 - r / (f.radius * 3)); ax += (dx / r) * q; ay += (dy / r) * q; }
        }
        d.vx[i] += ax * hh; d.vy[i] += ay * hh;
        d.x[i] += d.vx[i] * hh; d.y[i] += d.vy[i] * hh;
      }
      if (absorbed) this.removeDebris(i);
    }
  }

  /** Convert a host-relative particle to free (absolute) coordinates. */
  private freeDebris(i: number, host: Body): void {
    const d = this.debris;
    d.x[i] += host.x; d.y[i] += host.y; d.vx[i] += host.vx; d.vy[i] += host.vy;
    d.host[i] = 0;
  }

  /** Absolute position of debris particle i. */
  debrisPos(i: number, byId?: Map<number, Body>): [number, number] {
    const d = this.debris;
    if (!d.host[i]) return [d.x[i], d.y[i]];
    const h = byId ? byId.get(d.host[i]) : this.get(d.host[i]);
    return h ? [d.x[i] + h.x, d.y[i] + h.y] : [d.x[i], d.y[i]];
  }

  private applyGrab(): void {
    if (!this.grab) return;
    const b = this.get(this.grab.id);
    if (!b) { this.grab = null; return; }
    const p = parentOf(this.bodies, b);
    b.x = this.grab.x; b.y = this.grab.y;
    // Held bodies ride along with their parent so they don't pick up a stray velocity.
    b.vx = p ? p.vx : 0; b.vy = p ? p.vy : 0;
  }

  // ---------- Collisions ----------

  /** Rotation angle of a body's surface at the current time. */
  rotation(b: Body): number {
    return b.spin ? ((this.t / b.spin) % 1) * Math.PI * 2 : 0;
  }

  /** Surface longitude/latitude (as fractions) facing a direction in world space. */
  private surfacePoint(b: Body, angle: number): [number, number] {
    const lon = (angle - this.rotation(b)) / (Math.PI * 2);
    return [((lon % 1) + 1) % 1, 0.5 + (this.rand() - 0.5) * 0.4];
  }

  collide(a: Body, b: Body): CollisionOutcome {
    const big = a.m >= b.m ? a : b, small = big === a ? b : a;
    const M_ = big.m + small.m;
    const rx = small.x - big.x, ry = small.y - big.y;
    const vx = small.vx - big.vx, vy = small.vy - big.vy;
    const v = Math.hypot(vx, vy), r = Math.hypot(rx, ry) || big.r;
    const angle = Math.atan2(ry, rx);
    const bigInfo = TYPES[big.type], smallInfo = TYPES[small.type];

    // Stars, giants, remnants and anything hitting a spacecraft-sized target just swallow the smaller body.
    const absorbs = !bigInfo.terrain || small.type === "spacecraft" || !big.surface;
    if (absorbs) {
      this.mergeInto(big, small);
      this.events.push({ kind: "absorb", x: big.x, y: big.y, r: big.r });
      return "absorb";
    }

    const mu = (big.m * small.m) / M_;
    const Q = (0.5 * mu * v * v) / M_;
    const Rc = Math.cbrt(big.r ** 3 + small.r ** 3);
    const Qbind = (0.6 * G * M_) / Rc;
    const ratio = Q / Qbind;
    const vEsc = Math.sqrt((2 * G * M_) / (big.r + small.r));
    // Impact parameter: 0 = head-on, 1 = grazing.
    const graze = v > 0 ? Math.min(1, Math.abs(rx * vy - ry * vx) / (r * v)) : 0;
    const tangentialSign = Math.sign(rx * vy - ry * vx) || 1;

    if (ratio > 1) {
      this.shatter([big, small], Math.min(3, ratio));
      return "shatter";
    }
    if (ratio > 0.25) {
      this.partialDisruption(big, small, ratio);
      return "partial";
    }
    if (graze > 0.6 && v > 1.2 * vEsc && smallInfo.terrain) {
      this.hitAndRun(big, small, angle, graze, tangentialSign);
      return "hit-and-run";
    }

    // Merge. The impactor's material lands as a patch or streak; a big enough hit melts everything.
    if (big.surface && small.surface) {
      if (ratio > 0.1 || small.m > 0.3 * big.m) {
        big.surface = remix(big.surface, big.m, small.surface, small.m, Math.floor(this.rand() * 1e9));
      } else {
        const [lon, lat] = this.surfacePoint(big, angle);
        const base = SURF_H * 0.5 * Math.cbrt(small.m / big.m) * (1 + ratio * 8);
        const elong = 1 + 3 * graze * Math.min(1, v / (1.5 * vEsc));
        const size = Math.min(SURF_H * 0.9, Math.max(1.5, base));
        splash(big.surface, small.surface, {
          lon: lon * SURF_W, lat: lat * SURF_H,
          along: size * elong, across: size / Math.sqrt(elong),
          heading: tangentialSign > 0 ? 0 : Math.PI,
          seed: Math.floor(this.rand() * 1e9),
        });
      }
      big.surfaceRev++;
    }
    const nDebris = Math.round(Math.min(400, 20 + ratio * 1500));
    this.spray(big, small, nDebris, angle);
    this.mergeInto(big, small);
    this.events.push({ kind: "flash", x: big.x, y: big.y, r: big.r });
    return "merge";
  }

  /** Momentum- and mass-conserving merge of `small` into `big`. */
  private mergeInto(big: Body, small: Body): void {
    const M_ = big.m + small.m;
    big.x = (big.x * big.m + small.x * small.m) / M_;
    big.y = (big.y * big.m + small.y * small.m) / M_;
    big.vx = (big.vx * big.m + small.vx * small.m) / M_;
    big.vy = (big.vy * big.m + small.vy * small.m) / M_;
    if (big.type === "blackhole") big.r = schwarzschildRadius(M_);
    else if (TYPES[big.type].terrain) big.r = Math.cbrt(big.r ** 3 + small.r ** 3);
    else big.r = radiusFor(big.type, M_) || big.r;
    big.m = M_;
    this.remove(small.id);
  }

  /**
   * Throw off colored debris from the impact site. Only ejecta faster than escape velocity
   * is worth simulating: anything slower lands again within one frame at any time warp.
   */
  private spray(big: Body, small: Body, count: number, angle: number, spread = 2.2): void {
    const src = [big, small];
    const vEsc = Math.sqrt((2 * G * big.m) / big.r);
    const cvx = (big.vx * big.m + small.vx * small.m) / (big.m + (small === big ? 0 : small.m));
    const cvy = (big.vy * big.m + small.vy * small.m) / (big.m + (small === big ? 0 : small.m));
    for (let k = 0; k < count; k++) {
      const from = src[k % 2];
      const col = from.surface
        ? materialColor(sampleSurface(from.surface, this.rand(), this.rand()))
        : TYPES[from.type].color;
      const a = angle + (this.rand() - 0.5) * spread;
      const sp = vEsc * (1.02 + this.rand() * 0.6);
      const px = big.x + Math.cos(a) * big.r * 1.05, py = big.y + Math.sin(a) * big.r * 1.05;
      this.addDebris(px, py, cvx + Math.cos(a) * sp, cvy + Math.sin(a) * sp, col);
    }
  }

  private hitAndRun(big: Body, small: Body, angle: number, graze: number, sign: number): void {
    // Each scars the other with a streak of its own material.
    if (big.surface && small.surface) {
      const [lon, lat] = this.surfacePoint(big, angle);
      const size = Math.max(1.5, SURF_H * 0.3 * Math.cbrt(small.m / big.m));
      splash(big.surface, small.surface, { lon: lon * SURF_W, lat: lat * SURF_H, along: size * (1 + 3 * graze), across: size * 0.5, heading: sign > 0 ? 0 : Math.PI, seed: Math.floor(this.rand() * 1e9) });
      const [slon, slat] = this.surfacePoint(small, angle + Math.PI);
      splash(small.surface, big.surface, { lon: slon * SURF_W, lat: slat * SURF_H, along: SURF_H * 0.5, across: SURF_H * 0.2, heading: sign > 0 ? Math.PI : 0, seed: Math.floor(this.rand() * 1e9) });
      big.surfaceRev++; small.surfaceRev++;
    }
    // Small body loses a tenth of its mass as debris and some relative speed to the big one.
    const lost = small.m * 0.1;
    const f = 0.85;
    const dvx = (small.vx - big.vx) * (1 - f), dvy = (small.vy - big.vy) * (1 - f);
    small.vx -= dvx; small.vy -= dvy;
    big.vx += (dvx * small.m) / big.m; big.vy += (dvy * small.m) / big.m;
    this.spray(big, small, 80, angle, 1.2);
    this.setMass(small, small.m - lost);
    big.m += lost; // mass stays in the system; the debris is visual
    // Separate them so they don't register the same contact next step.
    const d = big.r + small.r;
    small.x = big.x + Math.cos(angle) * d * 1.02;
    small.y = big.y + Math.sin(angle) * d * 1.02;
    this.events.push({ kind: "flash", x: small.x, y: small.y, r: small.r });
  }

  private partialDisruption(big: Body, small: Body, ratio: number): void {
    const M_ = big.m + small.m;
    const survivorMass = M_ * (1 - 0.5 * ratio);
    const ejecta = M_ - survivorMass;
    const cx = (big.x * big.m + small.x * small.m) / M_, cy = (big.y * big.m + small.y * small.m) / M_;
    const cvx = (big.vx * big.m + small.vx * small.m) / M_, cvy = (big.vy * big.m + small.vy * small.m) / M_;
    const mixed = big.surface && small.surface ? remix(big.surface, big.m, small.surface, small.m, Math.floor(this.rand() * 1e9)) : null;
    const Rc = Math.cbrt(big.r ** 3 + small.r ** 3);
    const angle = Math.atan2(small.y - big.y, small.x - big.x);
    this.spray(big, small, Math.round(200 + ratio * 400), angle, Math.PI * 2);

    // Survivor keeps the big body's identity.
    this.remove(small.id);
    big.x = cx; big.y = cy; big.vx = cvx; big.vy = cvy;
    big.m = survivorMass; big.r = Rc * Math.cbrt(survivorMass / M_);
    if (mixed) { big.surface = mixed; big.surfaceRev++; }

    // Ejecta: a ring of debris plus one or two moonlets on bound orbits that can grow over time.
    const moonlets = ratio > 0.6 ? 2 : 1;
    for (let k = 0; k < moonlets; k++) {
      const m = (ejecta / moonlets) * 0.999;
      const a = this.rand() * Math.PI * 2;
      const dist = Rc * (3 + this.rand() * 2);
      const x = cx + Math.cos(a) * dist, y = cy + Math.sin(a) * dist;
      const [vx, vy] = circularVelocity(big, x, y, this.rand() > 0.5 ? 1 : -1);
      this.add({
        type: m > 0.05 * 5.97e24 ? "moon" : "asteroid", x, y, vx, vy, m, r: Rc * Math.cbrt(m / M_),
        name: `${big.name} moonlet ${String.fromCharCode(65 + k)}`,
        surface: mixed ? fragmentSurface(mixed, Math.floor(this.rand() * 1e9)) : null,
      });
    }
    // Debris ring bound to the survivor.
    const ringCount = Math.round(150 + ratio * 200);
    for (let k = 0; k < ringCount; k++) {
      const a = this.rand() * Math.PI * 2;
      const dist = Rc * (1.6 + this.rand() * 2.5);
      const x = cx + Math.cos(a) * dist, y = cy + Math.sin(a) * dist;
      const [vx, vy] = circularVelocity(big, x, y);
      const col = mixed ? materialColor(sampleSurface(mixed, this.rand(), this.rand())) : TYPES[big.type].color;
      this.addDebris(x, y, vx, vy, col, big.id);
    }
    this.events.push({ kind: "flash", x: cx, y: cy, r: Rc * 1.5 });
  }

  /** Break bodies into fragments that fly apart. Mass is shared among the fragments. */
  shatter(parts: Body[], strength: number): Body[] {
    const M_ = parts.reduce((s, b) => s + b.m, 0);
    const cx = parts.reduce((s, b) => s + b.x * b.m, 0) / M_, cy = parts.reduce((s, b) => s + b.y * b.m, 0) / M_;
    const cvx = parts.reduce((s, b) => s + b.vx * b.m, 0) / M_, cvy = parts.reduce((s, b) => s + b.vy * b.m, 0) / M_;
    const Rc = Math.cbrt(parts.reduce((s, b) => s + b.r ** 3, 0));
    const vEsc = Math.sqrt((2 * G * M_) / Rc);
    const lead = parts.reduce((a, b) => (b.m > a.m ? b : a));
    let mixed: Uint8Array | null = null;
    for (const p of parts) {
      if (!p.surface) continue;
      mixed = mixed ? remix(mixed, 1, p.surface, 1, Math.floor(this.rand() * 1e9)) : p.surface.slice();
    }
    const baseType: BodyType = TYPES[lead.type].terrain ? lead.type : "asteroid";
    for (const p of parts) this.remove(p.id);

    const count = 3 + Math.floor(this.rand() * 4);
    const fr = Array.from({ length: count }, () => Math.pow(this.rand(), 2) + 0.05);
    const total = fr.reduce((s, v) => s + v, 0);
    const made: Body[] = [];
    const phase = this.rand() * Math.PI * 2;
    for (let k = 0; k < count; k++) {
      const m = (fr[k] / total) * M_;
      const a = phase + (k / count) * Math.PI * 2 + (this.rand() - 0.5) * 0.6;
      const dist = Rc * (1.5 + this.rand());
      const s = vEsc * (0.9 + 0.5 * strength) * (0.8 + this.rand() * 0.4);
      const type: BodyType = m > 0.2 * lead.m ? baseType : m > 1e21 ? "moon" : "asteroid";
      const b = this.add({
        type, m, r: Rc * Math.cbrt(m / M_),
        x: cx + Math.cos(a) * dist, y: cy + Math.sin(a) * dist,
        vx: cvx + Math.cos(a) * s, vy: cvy + Math.sin(a) * s,
        name: `${lead.name} fragment ${String.fromCharCode(65 + k)}`,
        surface: mixed ? fragmentSurface(mixed, Math.floor(this.rand() * 1e9)) : null,
      });
      if (b) made.push(b);
    }
    for (let k = 0; k < 500; k++) {
      const a = this.rand() * Math.PI * 2;
      const s = vEsc * (1.02 + this.rand() * (0.5 + strength * 0.5));
      const col = mixed ? materialColor(sampleSurface(mixed, this.rand(), this.rand())) : TYPES[lead.type].color;
      this.addDebris(cx + Math.cos(a) * Rc, cy + Math.sin(a) * Rc, cvx + Math.cos(a) * s, cvy + Math.sin(a) * s, col);
    }
    this.events.push({ kind: "shock", x: cx, y: cy, r: Rc });
    return made;
  }

  // ---------- Tools ----------

  /** Explode tool. Returns false for bodies that can't explode (black holes). */
  explode(id: number): boolean {
    const b = this.get(id);
    if (!b || b.type === "blackhole") return false;
    const cls = TYPES[b.type].cls;
    this.shockwave(b);
    if (cls === "star" || cls === "remnant") {
      // Supernova-style: most mass leaves as glowing gas; heavy stars leave a compact remnant.
      const cx = b.x, cy = b.y, cvx = b.vx, cvy = b.vy, R = b.r, m = b.m;
      const vEsc = Math.sqrt((2 * G * m) / R);
      this.remove(b.id);
      for (let k = 0; k < 900; k++) {
        const a = this.rand() * Math.PI * 2, s = vEsc * (0.3 + this.rand() * 1.2);
        const col = this.rand() > 0.5 ? materialColor(M.plasma) : TYPES[b.type].color;
        this.addDebris(cx + Math.cos(a) * R, cy + Math.sin(a) * R, cvx + Math.cos(a) * s, cvy + Math.sin(a) * s, col);
      }
      if (m > 8 * M_SUN) this.add({ type: "neutron", x: cx, y: cy, vx: cvx, vy: cvy, m: 1.4 * M_SUN, name: `${b.name} remnant` });
      else if (m > 0.5 * M_SUN && cls === "star") this.add({ type: "whitedwarf", x: cx, y: cy, vx: cvx, vy: cvy, m: 0.6 * M_SUN, name: `${b.name} remnant` });
      this.events.push({ kind: "shock", x: cx, y: cy, r: R * 3 });
      return true;
    }
    this.shatter([b], 2);
    return true;
  }

  private shockwave(src: Body): void {
    const reach = src.r * 60;
    const vEsc = Math.sqrt((2 * G * src.m) / src.r);
    for (const o of this.bodies) {
      if (o === src) continue;
      const dx = o.x - src.x, dy = o.y - src.y, d = Math.hypot(dx, dy);
      if (d > reach || d === 0) continue;
      const k = vEsc * 0.3 * (1 - d / reach) * Math.min(1, src.m / (o.m * 10));
      o.vx += (dx / d) * k; o.vy += (dy / d) * k;
    }
  }

  /** Collapse tool: any body becomes a black hole of the same mass. */
  collapse(id: number): boolean {
    const b = this.get(id);
    if (!b || b.type === "blackhole") return false;
    this.events.push({ kind: "collapse", x: b.x, y: b.y, r: b.r });
    b.type = "blackhole";
    b.r = schwarzschildRadius(b.m);
    b.surface = null;
    b.surfaceRev++;
    b.rings = undefined;
    this.topologyRev++;
    return true;
  }

  orbitLock(id: number): boolean {
    const b = this.get(id);
    if (!b) return false;
    const p = parentOf(this.bodies, b);
    if (!p) return false;
    const h = (b.x - p.x) * (b.vy - p.vy) - (b.y - p.y) * (b.vx - p.vx);
    [b.vx, b.vy] = circularVelocity(p, b.x, b.y, h < 0 ? -1 : 1, b.m);
    return true;
  }

  /** Erase everything inside a circle. Returns how many bodies were removed. */
  erase(x: number, y: number, radius: number): number {
    let removed = 0;
    for (const b of [...this.bodies]) {
      if (Math.hypot(b.x - x, b.y - y) < radius + b.r) { this.remove(b.id); removed++; }
    }
    const d = this.debris, r2 = radius * radius;
    const byId = new Map(this.bodies.map(b => [b.id, b]));
    for (let i = d.count - 1; i >= 0; i--) {
      const [px, py] = this.debrisPos(i, byId);
      const dx = px - x, dy = py - y;
      if (dx * dx + dy * dy < r2) this.removeDebris(i);
    }
    return removed;
  }

  /**
   * Laser tool: the beam from (x0,y0) along (dx,dy) stops at the first body it meets.
   * That body sheds mass as debris colored by the material under the beam.
   * `tolerance` widens bodies to their on-screen size so tiny true-scale bodies can be hit.
   * Returns the hit point for drawing, or null.
   */
  laser(x0: number, y0: number, dx: number, dy: number, realDt: number, tolerance: number): { x: number; y: number; id: number } | null {
    const len = Math.hypot(dx, dy);
    if (len === 0) return null;
    const ux = dx / len, uy = dy / len;
    let best: Body | null = null, bestT = Infinity;
    for (const b of this.bodies) {
      const px = b.x - x0, py = b.y - y0;
      const t = px * ux + py * uy;
      if (t <= 0) continue;
      const perp = Math.abs(px * uy - py * ux);
      const rr = Math.max(b.r, tolerance);
      if (perp < rr && t < bestT) { bestT = t - Math.sqrt(Math.max(0, rr * rr - perp * perp)); best = b; }
    }
    if (!best) return null;
    const hx = x0 + ux * bestT, hy = y0 + uy * bestT;
    if (best.type === "blackhole") return { x: hx, y: hy, id: best.id }; // the beam just falls in

    if (!this.laserStart.has(best.id)) this.laserStart.set(best.id, best.m);
    const start = this.laserStart.get(best.id)!;
    const loss = best.m * Math.min(0.9, 0.35 * realDt);
    const angle = Math.atan2(hy - best.y, hx - best.x);
    const vEsc = Math.sqrt((2 * G * best.m) / best.r);
    const count = Math.max(1, Math.round(240 * realDt));
    for (let k = 0; k < count; k++) {
      const col = best.surface
        ? materialColor(sampleSurface(best.surface, (angle - this.rotation(best)) / (Math.PI * 2) + (this.rand() - 0.5) * 0.05, 0.5 + (this.rand() - 0.5) * 0.2))
        : TYPES[best.type].color;
      const a = angle + (this.rand() - 0.5) * 1.4;
      const s = vEsc * (1.02 + this.rand() * 0.5);
      this.addDebris(best.x + Math.cos(angle) * best.r * 1.05, best.y + Math.sin(angle) * best.r * 1.05, best.vx + Math.cos(a) * s, best.vy + Math.sin(a) * s, col);
    }
    if (best.m - loss < start * 0.02) {
      // Burned through: whatever is left becomes debris.
      this.spray(best, best, 120, angle, Math.PI * 2);
      this.remove(best.id);
      this.laserStart.delete(best.id);
      this.events.push({ kind: "flash", x: best.x, y: best.y, r: best.r });
    } else {
      this.setMass(best, best.m - loss);
    }
    return { x: hx, y: hy, id: best.id };
  }

  laserEnd(): void {
    this.laserStart.clear();
  }

  // ---------- Undo & saves ----------

  pushUndo(): void {
    this.undoStack.push({ t: this.t, nextId: this.nextId, bodies: this.bodies.map(cloneBody), debris: cloneDebris(this.debris) });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.t = s.t; this.nextId = s.nextId;
    this.bodies = s.bodies; this.debris = s.debris;
    for (const b of this.bodies) b.surfaceRev++;
    this.grab = null;
    this.topologyRev++;
    return true;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  serialize(): SerializedWorld {
    const d = this.debris, n = d.count;
    return {
      v: 1, t: this.t, nextId: this.nextId,
      bodies: this.bodies.map(b => ({ ...b, surface: b.surface ? toB64(b.surface) : null })),
      debris: {
        x: Array.from(d.x.subarray(0, n)), y: Array.from(d.y.subarray(0, n)),
        vx: Array.from(d.vx.subarray(0, n)), vy: Array.from(d.vy.subarray(0, n)),
        color: Array.from(d.color.subarray(0, n)), host: Array.from(d.host.subarray(0, n)),
      },
    };
  }

  load(s: SerializedWorld): void {
    this.clear();
    this.t = s.t; this.nextId = s.nextId;
    this.bodies = s.bodies.map(b => ({ ...b, surface: b.surface ? fromB64(b.surface) : null, surfaceRev: 1 }));
    const d = this.debris;
    d.count = Math.min(MAX_DEBRIS, s.debris.x.length);
    for (let i = 0; i < d.count; i++) {
      d.x[i] = s.debris.x[i]; d.y[i] = s.debris.y[i]; d.vx[i] = s.debris.vx[i]; d.vy[i] = s.debris.vy[i];
      d.color[i] = s.debris.color[i]; d.host[i] = s.debris.host[i];
    }
    this.topologyRev++;
  }

  // ---------- Queries ----------

  totalMass(): number {
    return this.bodies.reduce((s, b) => s + b.m, 0);
  }

  luminousBodies(): { b: Body; L: number }[] {
    return this.bodies.map(b => ({ b, L: luminosityFor(b.type, b.m) })).filter(x => x.L > 0);
  }

  compositionOf(b: Body) {
    return b.surface ? composition(b.surface) : [];
  }
}

function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
