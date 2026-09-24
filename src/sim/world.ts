import { luminosityFor, radiusFor, schwarzschildRadius, TYPES } from "./catalog";
import { DAY, G, M_EARTH, M_SUN, MAX_BODIES, MAX_DEBRIS, UNDO_DEPTH } from "./constants";
import { Fragments, fragmentColor, HEAT_CAP, interiorMaterial, MAX_K, MOLTEN_K, NMAT, STICK_K, type Attractor, type Landing, type Promotion } from "./fragments";
import { materialColor, M } from "./materials";
import { circularVelocity, parentOf, propagateKepler } from "./orbit";
import { rng } from "./rng";
import { composition, generateSurface, sampleSurface, splash, uniformSurface } from "./surface";
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
  frags: Fragments;
  impactUntil: number;
}

export interface SerializedWorld {
  v: 1;
  t: number;
  nextId: number;
  bodies: (Omit<Body, "surface" | "under"> & { surface: string | null; under?: string | null })[];
  debris: { x: number[]; y: number[]; vx: number[]; vy: number[]; color: number[]; host: number[] };
  /** Per fragment: x, y, vx, vy, m, r, T, promote, src, NMAT histogram values, density. */
  frags?: number[][];
  /** Sim time until which an impact was still playing out when saved. */
  impactUntil?: number;
}

/** Attract tool's pull, in sim-time units. */
export interface Field { x: number; y: number; radius: number; accel: number }

export interface Grab { id: number; x: number; y: number }

interface HeavyState { x: number; y: number; vx: number; vy: number; m: number; r: number }

export type CollisionOutcome = "merge" | "absorb" | "fragment";

/** Planet kind from what it's made of and how dense it is: icy only if it's actually light. */
function planetType(h: Float32Array, rho: number): BodyType {
  let total = 0;
  for (let k = 0; k < h.length; k++) total += h[k];
  const share = (k: number) => (total > 0 ? h[k] / total : 0);
  if (rho < 2500 && share(M.ice) + share(M.methane) + share(M.water) > 0.3) return "ice";
  if (share(M.water) > 0.15) return "ocean";
  return "rocky";
}

function histMax(h: Float32Array): number {
  let best = 0;
  for (let k = 1; k < h.length; k++) if (h[k] > h[best]) best = k;
  return best;
}

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
  return { ...b, surface: b.surface ? b.surface.slice() : null, under: b.under ? b.under.slice() : null, rings: b.rings ? [...b.rings] as [number, number] : undefined };
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
  /** Massive fragments from impacts, explosions and laser cuts. Budget follows the Graphics setting. */
  frags = new Fragments(600);
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
      surface, surfaceRev: 0, heat: 0, under: null,
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
    this.frags.clear();
    this.fragNames.clear();
    this.impactUntil = -1;
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

  /** Index from which fragments were created during the current block (see Fragments.step). */
  private fragNewStart = Infinity;

  private block(maxH: number): number {
    const bs = this.bodies, n = bs.length;
    this.fragNewStart = Infinity;
    // Fragments need short steps (they touch and orbit close in); bodies share that bound.
    const fragStep = this.frags.n ? this.frags.maxStep(this.fragAttractors(0)) : Infinity;
    if (this.frags.n) this.frags.rebuildTree();
    if (n === 0) {
      const h = Math.min(maxH, fragStep);
      this.t += h;
      this.afterBlock(h, []);
      return h;
    }
    const ax = new Float64Array(n), ay = new Float64Array(n), tau = new Float64Array(n);
    this.forcesAll(ax, ay, tau);

    let tauMax = 0;
    for (let i = 0; i < n; i++) if (tau[i] !== Infinity && tau[i] > tauMax) tauMax = tau[i];
    const H = Math.min(tauMax > 0 ? Math.min(maxH, ETA * tauMax) : maxH, fragStep);
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
        this.afterBlock(fine * (s + 1), heavyStart);
        return fine * (s + 1);
      }

      // Due bodies end their step (half kick) and, unless the block is over, start the next (half kick).
      this.forcesOn(members, due, ax, ay);
      for (const i of due) {
        const b = members[i], k = last ? 0.5 : 1;
        b.vx += ax[i] * hOf(i) * k; b.vy += ay[i] * hOf(i) * k;
      }
    }
    this.afterBlock(H, heavyStart);
    return H;
  }

  /** Work that follows the bodies' step: fragments, cooling, debris. */
  private afterBlock(h: number, heavyStart: HeavyState[]): void {
    if (this.frags.n) this.stepFragments(h);
    this.coolBodies(h);
    this.stepDebris(h, heavyStart);
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
    for (let i = 0; i < n; i++) { this.addField(bs[i], i, ax, ay); this.addFragPull(bs[i], i, ax, ay); }
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
      this.addFragPull(a, i, ax, ay);
    }
  }

  private fragPull: [number, number] = [0, 0];

  /** Back-reaction: bodies are pulled by the fragment cloud (tree built at block start). */
  private addFragPull(b: Body, i: number, ax: Float64Array, ay: Float64Array): void {
    if (!this.frags.n) return;
    // Same light softening the fragments feel from bodies, so the pull is equal and opposite.
    this.frags.fieldAt(b.x, b.y, b.r * 0.1, this.fragPull);
    ax[i] += this.fragPull[0]; ay[i] += this.fragPull[1];
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
        // No host to be relative to: the particle's coordinates mean nothing, so drop it.
        if (!host) { this.removeDebris(i); continue; }
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

  /**
   * Resolve a contact between two bodies.
   * - Stars, giants, remnants and spacecraft impacts: the big body swallows the small one.
   * - Small hits (impactor under 0.5% of the target and low energy): a crater patch.
   * - Everything bigger: both bodies break into fragments and the physics decides what
   *   reforms, what orbits and what escapes.
   */
  collide(a: Body, b: Body): CollisionOutcome {
    const big = a.m >= b.m ? a : b, small = big === a ? b : a;
    const M_ = big.m + small.m;
    const rx = small.x - big.x, ry = small.y - big.y;
    const vx = small.vx - big.vx, vy = small.vy - big.vy;
    const v = Math.hypot(vx, vy);
    const angle = Math.atan2(ry, rx);
    const bigInfo = TYPES[big.type];

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

    // Low-energy contacts (small impactors, clumps settling back onto a reforming planet)
    // merge with a crater patch. Only impacts carrying at least 5% of the combined body's
    // binding energy break things apart. A Moon-forming hit is ~12%, a moonlet falling back ~2%.
    // Collisions between small bodies (under ~1.4 Moon masses together) also just merge:
    // their fragments would be too small to matter and would only churn the budget.
    // Clumps that reformed during an impact still playing out just merge when they meet:
    // re-breaking them would churn forever without changing the outcome.
    const reformed = big.settleUntil !== undefined || small.settleUntil !== undefined;
    const settling = reformed && (this.t < this.impactUntil || (big.settleUntil ?? -1) > this.t || (small.settleUntil ?? -1) > this.t);
    if (ratio < 0.05 || M_ < 1e23 || settling) {
      this.crater(big, small, angle, v);
      return "merge";
    }
    this.fragmentCollision(big, small, Q);
    return "fragment";
  }

  /** Small impact: the impactor's material lands as a patch (molten if the hit was hot). */
  private crater(big: Body, small: Body, angle: number, v: number): void {
    const vEsc = Math.sqrt((2 * G * (big.m + small.m)) / (big.r + small.r));
    if (big.surface && small.surface) {
      const [lon, lat] = this.surfacePoint(big, angle);
      const size = Math.min(SURF_H * 0.6, Math.max(1.5, SURF_H * 0.5 * Math.cbrt(small.m / big.m) * (1 + v / vEsc)));
      const T = 300 + (0.5 * v * v) / HEAT_CAP;
      this.paint(big, small.surface, lon * SURF_W, lat * SURF_H, size, T);
      big.surfaceRev++;
    }
    big.heat = Math.min(4000, big.heat + (0.5 * small.m * v * v) / (big.m * HEAT_CAP));
    this.spray(big, small, 24, angle, 1.6);
    this.mergeInto(big, small);
    if (this.t >= this.impactUntil) this.events.push({ kind: "flash", x: big.x, y: big.y, r: big.r });
  }

  /**
   * Paint an impactor's material onto a body in a round patch. Hot material lands as
   * magma, remembering what it will crust into.
   */
  private paint(b: Body, src: Uint8Array, lonCell: number, latCell: number, size: number, T: number): void {
    if (!b.surface) return;
    const molten = T > MOLTEN_K;
    if (molten && !b.under) b.under = b.surface.slice();
    const tmp = molten ? new Uint8Array(src.length) : b.surface;
    if (molten) tmp.set(b.under!);
    splash(tmp, src, { lon: lonCell, lat: latCell, along: size, across: size, heading: 0, seed: Math.floor(this.rand() * 1e9) });
    if (molten) {
      for (let i = 0; i < tmp.length; i++) {
        if (tmp[i] !== b.under![i]) { b.under![i] = tmp[i]; b.surface[i] = M.magma; }
      }
    }
  }

  /**
   * Clumps that reform during an impact start small (moonlet, asteroid). Once one has
   * grown into planet territory, call it a planet of the right kind.
   */
  private retype(b: Body): void {
    if (b.type !== "moon" && b.type !== "asteroid") return;
    if (b.m > 0.05 * M_EARTH && b.surface) {
      const w = new Float32Array(NMAT);
      for (const c of composition(b.under ?? b.surface)) w[c.mat] = c.frac;
      b.type = planetType(w, b.m / ((4 / 3) * Math.PI * b.r ** 3));
      this.topologyRev++;
    } else if (b.type === "asteroid" && b.m > 1e21) {
      b.type = "moon";
      this.topologyRev++;
    }
  }

  /** Momentum- and mass-conserving merge of `small` into `big`. */
  private mergeInto(big: Body, small: Body): void {
    const M_ = big.m + small.m;
    // A reformed planet reclaims its name when it swallows the clump that took it first.
    if (big.name.startsWith(small.name + " ")) { big.name = small.name; this.topologyRev++; }
    big.x = (big.x * big.m + small.x * small.m) / M_;
    big.y = (big.y * big.m + small.y * small.m) / M_;
    big.vx = (big.vx * big.m + small.vx * small.m) / M_;
    big.vy = (big.vy * big.m + small.vy * small.m) / M_;
    if (big.type === "blackhole") big.r = schwarzschildRadius(M_);
    else if (TYPES[big.type].terrain) big.r = Math.cbrt(big.r ** 3 + small.r ** 3);
    else big.r = radiusFor(big.type, M_) || big.r;
    big.m = M_;
    this.remove(small.id);
    this.retype(big);
  }

  /**
   * Visual-only ejecta (massless debris) for small impacts. Only ejecta faster than escape
   * velocity is worth drawing: anything slower lands again within one frame at any time warp.
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

  // ---------- Fragments ----------

  /** Names of bodies that broke up, so what reforms from them can take the name back. */
  private fragNames = new Map<number, string>();
  private moonletCount = new Map<string, number>();
  /** Sim time until which an impact is still playing out (for the slow-down suggestion). */
  impactUntil = -1;
  impactId = 0;

  /** Change the fragment budget (tied to the Graphics setting). */
  setFragmentCap(cap: number): void {
    this.frags.setCap(cap);
  }

  /**
   * Make room for `need` new fragments by folding the smallest existing ones into their
   * nearest neighbour (mass and momentum kept). A lone last fragment becomes debris.
   */
  private makeRoom(need: number): void {
    const f = this.frags, s = f.s;
    while (f.free < need && s.n > 0) {
      let small = 0;
      for (let i = 1; i < s.n; i++) if (s.m[i] < s.m[small]) small = i;
      let near = -1, nd = Infinity;
      for (let i = 0; i < s.n; i++) {
        if (i === small) continue;
        const d = (s.x[i] - s.x[small]) ** 2 + (s.y[i] - s.y[small]) ** 2;
        if (d < nd) { nd = d; near = i; }
      }
      if (near < 0) {
        this.addDebris(s.x[small], s.y[small], s.vx[small], s.vy[small], fragmentColor(f.material(small), s.T[small]));
      } else {
        const mt = s.m[near] + s.m[small];
        s.vx[near] = (s.vx[near] * s.m[near] + s.vx[small] * s.m[small]) / mt;
        s.vy[near] = (s.vy[near] * s.m[near] + s.vy[small] * s.m[small]) / mt;
        s.r[near] = Math.hypot(s.r[near], s.r[small]);
        s.m[near] = mt;
        for (let k = 0; k < NMAT; k++) s.hist[near * NMAT + k] += s.hist[small * NMAT + k];
      }
      f.remove(small);
    }
  }

  /**
   * Break a body into `n` fragments tiling its disk. Material comes from its surface map
   * (crust) and depth (mantle, core). `kick(x, y)` adds velocity per fragment.
   */
  private fragmentBody(b: Body, n: number, T: (x: number, y: number) => number, promote: number, kick?: (x: number, y: number) => [number, number]): void {
    this.fragNames.set(b.id, b.name);
    const spacing = Math.sqrt((Math.PI * b.r * b.r) / n);
    const rFrag = spacing * 0.49;
    const cells: [number, number][] = [];
    // Hex-ish grid clipped to the disk.
    for (let gy = -b.r; gy <= b.r; gy += spacing * 0.866) {
      const row = Math.round(gy / (spacing * 0.866));
      for (let gx = -b.r + (row & 1 ? spacing / 2 : 0); gx <= b.r; gx += spacing) {
        if (gx * gx + gy * gy <= b.r * b.r) cells.push([gx, gy]);
      }
    }
    if (!cells.length) cells.push([0, 0]);
    // The hex grid can overshoot n a little; drop random cells so we take exactly what was
    // asked for and never more than the budget has (every cell must get a slot, or mass is lost).
    this.makeRoom(1);
    this.fragNewStart = Math.min(this.fragNewStart, this.frags.n);
    const room = Math.max(1, Math.min(cells.length, n, this.frags.free));
    while (cells.length > room) cells.splice(Math.floor(this.rand() * cells.length), 1);
    const mEach = b.m / cells.length;
    const rot = this.rotation(b);
    const rho = b.m / ((4 / 3) * Math.PI * b.r ** 3);
    for (const [gx, gy] of cells) {
      const x = b.x + gx + (this.rand() - 0.5) * spacing * 0.1, y = b.y + gy + (this.rand() - 0.5) * spacing * 0.1;
      const depth = 1 - Math.hypot(gx, gy) / b.r;
      const crust = b.surface ? sampleSurface(b.surface, (Math.atan2(gy, gx) - rot) / (Math.PI * 2), this.rand()) : M.basalt;
      const icyBody = b.type === "ice" || b.type === "comet" || b.type === "dwarf";
      const mat = interiorMaterial(crust === M.magma ? M.basalt : crust, depth, icyBody);
      const [kx, ky] = kick ? kick(x, y) : [0, 0];
      this.frags.add(x, y, b.vx + kx, b.vy + ky, mEach, rFrag, T(x, y), promote, b.id, mat, rho);
    }
  }

  private fragmentCollision(big: Body, small: Body, Q: number): void {
    const f = this.frags;
    const want = Math.max(24, Math.floor(f.cap * 0.85));
    this.makeRoom(want);
    const total = Math.min(want, f.free);
    const M_ = big.m + small.m;
    const nSmall = Math.max(6, Math.round(total * Math.sqrt(small.m / M_) * 0.6));
    const nBig = Math.max(12, total - nSmall);
    // Impact energy becomes heat, concentrated near the contact point.
    const ix = (big.x * small.r + small.x * big.r) / (big.r + small.r), iy = (big.y * small.r + small.y * big.r) / (big.r + small.r);
    const dT = Math.min(MAX_K, Q / HEAT_CAP);
    const heatAt = (x: number, y: number) => {
      const d = Math.hypot(x - ix, y - iy) / (big.r + small.r);
      return Math.min(MAX_K, 300 + big.heat + dT * Math.max(0.2, 1.6 - 1.4 * d));
    };
    const promote = 0.01 * M_;
    this.fragmentBody(big, nBig, heatAt, promote);
    this.fragmentBody(small, nSmall, heatAt, promote);
    this.events.push({ kind: "flash", x: ix, y: iy, r: Math.max(big.r, small.r) });
    this.remove(big.id);
    this.remove(small.id);
    this.startImpact(Math.max(big.r, small.r), M_);
  }

  /** Mark an impact as playing out, long enough for the fragments to settle. */
  private startImpact(r: number, m: number): void {
    const tDyn = Math.sqrt((r * r * r) / (G * m));
    this.impactUntil = Math.max(this.impactUntil, this.t + 60 * tDyn);
    this.impactId++;
  }

  /** Bodies that matter to the fragment cloud: everything whose pull there is non-negligible. */
  private fragAttractors(backstep: number): Attractor[] {
    const s = this.frags.s;
    let cx = 0, cy = 0, mt = 0;
    for (let i = 0; i < s.n; i++) { cx += s.x[i] * s.m[i]; cy += s.y[i] * s.m[i]; mt += s.m[i]; }
    if (mt > 0) { cx /= mt; cy /= mt; }
    const out: Attractor[] = [];
    let amax = 0;
    const acc = this.bodies.map(b => {
      if (b.type === "spacecraft") return 0;
      const d2 = (b.x - cx) ** 2 + (b.y - cy) ** 2 + b.r * b.r;
      const a = (G * b.m) / d2;
      if (a > amax) amax = a;
      return a;
    });
    this.bodies.forEach((b, i) => {
      if (acc[i] <= 0 || acc[i] < 1e-5 * amax) return;
      out.push({ x: b.x - b.vx * backstep, y: b.y - b.vy * backstep, vx: b.vx, vy: b.vy, m: b.m, r: b.r, id: b.id });
    });
    return out;
  }

  private fieldFn = (x: number, y: number, out: [number, number]) => {
    const f = this.field;
    out[0] = 0; out[1] = 0;
    if (!f) return;
    const dx = f.x - x, dy = f.y - y, d = Math.hypot(dx, dy);
    if (d === 0 || d > f.radius * 3) return;
    const k = f.accel * (1 - d / (f.radius * 3));
    out[0] = (dx / d) * k; out[1] = (dy / d) * k;
  };

  private stepFragments(h: number): void {
    // Bodies have already moved by h; hand the fragments their start-of-step positions.
    const attr = this.fragAttractors(h);
    const { landed, promoted } = this.frags.step(h, attr, this.field ? this.fieldFn : null, this.fragNewStart);
    this.fragNewStart = Infinity;
    for (const l of landed) {
      const b = this.get(attr[l.body].id);
      if (b) this.land(b, l);
    }
    for (const p of promoted) this.promote(p);
    if (this.t > this.impactUntil) this.settleFragments();
  }

  /**
   * Once an impact has played out, what's left becomes permanent:
   * - fragments still crowded or molten wait (the impact window is extended);
   * - fragments inside a planet's Roche zone become a debris ring bound to it (their mass joins the planet);
   * - the biggest remaining chunks become small moons or asteroids;
   * - the rest falls back into whatever it's bound to, or leaves as debris if escaping.
   */
  private settleFragments(): void {
    const f = this.frags, s = f.s;
    const gap = f.gaps();
    const planets = this.bodies.filter(b => b.type !== "spacecraft");
    let waiting = false;
    // Classify first, remove at the end: removing swaps the last fragment into the gap,
    // so indices must not change while we're still deciding.
    const ring: [number, Body][] = [];
    const loose: number[] = [];
    for (let i = 0; i < s.n; i++) {
      if (s.T[i] > STICK_K || gap[i] < 3 * s.r[i]) { waiting = true; continue; }
      const host = this.rocheHost(s.x[i], s.y[i], s.m[i], planets);
      if (host) ring.push([i, host]);
      else loose.push(i);
    }
    if (waiting) this.impactUntil = this.t + 0.1 * Math.max(3600, this.impactUntil - this.t + 3600);
    const done: number[] = [];
    for (const [i, host] of ring) {
      this.absorbInto(host, i);
      this.addDebris(s.x[i], s.y[i], s.vx[i], s.vy[i], fragmentColor(f.material(i), s.T[i]), host.id);
      done.push(i);
    }
    // Chunks in orbit become moonlet bodies so the disk keeps accreting (moonlets that touch
    // merge). Escaping chunks: the biggest few become asteroids, the rest leave as debris.
    const pieces = loose.map(i => ({ i, m: s.m[i] })).sort((a, b) => b.m - a.m);
    let room = MAX_BODIES - 10 - this.bodies.length;
    let escapers = 0;
    for (const { i } of pieces) {
      const bound = this.boundTo(s.x[i], s.y[i], s.vx[i], s.vy[i], planets);
      const keep = s.m[i] >= 1e18 && room > 0 && (bound !== null || escapers++ < 6);
      if (keep) {
        this.promote({ m: s.m[i], x: s.x[i], y: s.y[i], vx: s.vx[i], vy: s.vy[i], T: s.T[i], src: s.src[i], hist: s.hist.slice(i * NMAT, i * NMAT + NMAT), rho: s.rho[i] });
        room--;
      } else {
        if (bound) this.absorbInto(bound, i); // falls back eventually
        this.addDebris(s.x[i], s.y[i], s.vx[i], s.vy[i], fragmentColor(f.material(i), s.T[i]));
      }
      done.push(i);
    }
    // promote() can append a fragment when there's no room for a body; those sit past the
    // old end and are untouched by removing lower indices in descending order.
    done.sort((a, b) => b - a).forEach(i => f.remove(i));
  }

  /** The planet whose Roche zone contains a small piece at (x, y), if any. */
  private rocheHost(x: number, y: number, m: number, planets: Body[]): Body | null {
    for (const b of planets) {
      if (b.m < 50 * m || !TYPES[b.type].terrain) continue;
      if ((x - b.x) ** 2 + (y - b.y) ** 2 < (2.44 * b.r) ** 2) return b;
    }
    return null;
  }

  /** The heaviest body a point mass with this velocity is gravitationally bound to. */
  private boundTo(x: number, y: number, vx: number, vy: number, planets: Body[]): Body | null {
    let best: Body | null = null;
    for (const b of planets) {
      const d = Math.hypot(x - b.x, y - b.y);
      const e = 0.5 * ((vx - b.vx) ** 2 + (vy - b.vy) ** 2) - (G * b.m) / d;
      if (e < 0 && (!best || b.m > best.m)) best = b;
    }
    return best;
  }

  /** Fold fragment i's mass and momentum into a body (without removing the fragment). */
  private absorbInto(b: Body, i: number): void {
    const s = this.frags.s, mt = b.m + s.m[i];
    b.vx = (b.vx * b.m + s.vx[i] * s.m[i]) / mt;
    b.vy = (b.vy * b.m + s.vy[i] * s.m[i]) / mt;
    b.m = mt;
  }

  /** A fragment touches down on a body: it joins it, painting its material where it hit. */
  private land(b: Body, l: Landing): void {
    const mt = b.m + l.m;
    const rvx = l.vx - b.vx, rvy = l.vy - b.vy;
    const v2 = rvx * rvx + rvy * rvy;
    const T = l.T + (0.5 * v2) / HEAT_CAP;
    if (TYPES[b.type].terrain && b.surface) {
      const mat = histMax(l.hist);
      const angle = Math.atan2(l.y - b.y, l.x - b.x);
      const [lon, lat] = this.surfacePoint(b, angle);
      const size = Math.max(1, SURF_H * 0.5 * Math.sqrt(l.m / mt));
      this.paint(b, uniformSurface(mat), lon * SURF_W, lat * SURF_H, size, T);
      b.surfaceRev++;
      b.heat = Math.min(4000, (b.heat * b.m + Math.max(0, T - 300) * l.m) / mt);
      const rho = b.m / ((4 / 3) * Math.PI * b.r ** 3);
      b.r = Math.cbrt(b.r ** 3 + (3 * l.m) / (4 * Math.PI * rho));
    } else if (b.type === "blackhole") {
      b.r = schwarzschildRadius(mt);
    }
    b.vx = (b.vx * b.m + l.vx * l.m) / mt;
    b.vy = (b.vy * b.m + l.vy * l.m) / mt;
    b.m = mt;
    this.retype(b);
  }

  /** A clump has grown past its threshold: it becomes a body (a reformed planet, or a new moon). */
  private promote(p: Promotion): void {
    const r = Math.cbrt((3 * p.m) / (4 * Math.PI * p.rho));
    const type: BodyType = p.m > 0.05 * M_EARTH ? planetType(p.hist, p.rho) : p.m > 1e21 ? "moon" : "asteroid";
    // Surface: patches of what the clump is made of, with a magma ocean while it's hot.
    const weights: [number, number][] = [];
    p.hist.forEach((w, k) => { if (w > 0) weights.push([k === M.magma ? M.basalt : k, w]); });
    const surface = generateSurface(weights.length ? weights : [[M.basalt, 1]], false, Math.floor(this.rand() * 1e9));
    // The biggest thing to reform from a body keeps its name; everything else is a moonlet of it.
    const base = this.fragNames.get(p.src) ?? "Fragment";
    const holder = this.bodies.find(o => o.name === base);
    const nextMoonlet = () => {
      const k = (this.moonletCount.get(base) ?? 0) + 1;
      this.moonletCount.set(base, k);
      return `${base} moonlet ${String.fromCharCode(64 + ((k - 1) % 26) + 1)}`;
    };
    let name = base;
    if (holder && holder.m >= p.m) name = nextMoonlet();
    else if (holder) { holder.name = nextMoonlet(); this.topologyRev++; }
    const b = this.add({ type, name, x: p.x, y: p.y, vx: p.vx, vy: p.vy, m: p.m, r, surface, spin: (8 + this.rand() * 30) * 3600 });
    if (!b) {
      // No room for another body: keep it as a fragment instead.
      this.frags.add(p.x, p.y, p.vx, p.vy, p.m, r, p.T, Infinity, p.src, p.hist, p.rho);
      return;
    }
    b.heat = Math.max(0, p.T - 300);
    b.settleUntil = this.impactUntil;
    this.applyMagma(b);
  }

  /** Target share of the surface that is still molten at the body's current heat. */
  private magmaTarget(heat: number): number {
    return Math.min(1, Math.max(0, (heat - 500) / 1500));
  }

  /** Cover a hot body's surface with magma, keeping what each cell will crust into. */
  private applyMagma(b: Body): void {
    if (!b.surface) return;
    const f = this.magmaTarget(b.heat);
    if (f <= 0) return;
    b.under = b.surface.slice();
    const mask = generateSurface([[1, f], [0, 1 - f]], false, Math.floor(this.rand() * 1e9));
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1) b.surface[i] = M.magma;
    b.surfaceRev++;
  }

  /** Hot bodies radiate: heat decays and magma crusts over (rock into basalt, ice stays ice). */
  private coolBodies(h: number): void {
    for (const b of this.bodies) {
      if (b.heat <= 0) continue;
      const tau = Math.max(5 * DAY, 120 * DAY * (b.r / 6.371e6));
      b.heat *= Math.exp(-h / tau);
      if (b.heat < 1) b.heat = 0;
      if (!b.surface || !b.under) continue;
      const target = this.magmaTarget(b.heat);
      let molten = 0;
      for (let i = 0; i < b.surface.length; i++) if (b.surface[i] === M.magma) molten++;
      let excess = molten - Math.floor(target * b.surface.length);
      if (excess <= 0) continue;
      for (let i = 0; i < b.surface.length && excess > 0; i++) {
        const k = (i * 7919 + Math.floor(this.t / 3600)) % b.surface.length; // spread the crust around
        if (b.surface[k] !== M.magma) continue;
        const u = b.under[k];
        b.surface[k] = u === M.water || u === M.ice || u === M.methane ? u : M.basalt;
        excess--;
      }
      if (target === 0) b.under = null;
      b.surfaceRev++;
    }
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
    // Blow the body apart: fragments fly out at 0.3–1.5× escape speed, so some fall back and reform.
    const vEsc = Math.sqrt((2 * G * b.m) / b.r);
    const cx = b.x, cy = b.y;
    this.makeRoom(Math.floor(this.frags.cap * 0.85));
    const n = Math.max(24, Math.min(this.frags.free, Math.floor(this.frags.cap * 0.85)));
    this.fragmentBody(b, n, () => 2200 + this.rand() * 800, 0.01 * b.m, (x, y) => {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
      const sp = vEsc * (0.3 + this.rand() * 1.2) * (0.4 + (0.6 * d) / b.r);
      return [(dx / d) * sp, (dy / d) * sp];
    });
    this.remove(b.id);
    this.events.push({ kind: "shock", x: cx, y: cy, r: b.r });
    this.startImpact(b.r, b.m);
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
      if (perp < rr && t < bestT) { bestT = Math.max(0, t - Math.sqrt(Math.max(0, rr * rr - perp * perp))); best = b; }
    }
    if (!best) return null;
    const hx = x0 + ux * bestT, hy = y0 + uy * bestT;
    if (best.type === "blackhole") return { x: hx, y: hy, id: best.id }; // the beam just falls in

    if (!this.laserStart.has(best.id)) this.laserStart.set(best.id, best.m);
    const start = this.laserStart.get(best.id)!;
    const loss = best.m * Math.min(0.9, 0.35 * realDt);
    const angle = Math.atan2(hy - best.y, hx - best.x);
    const vEsc = Math.sqrt((2 * G * best.m) / best.r);
    // Cut material leaves as small molten fragments (massive, so they can clump or fall back).
    const count = Math.max(1, Math.round(90 * realDt));
    for (let k = 0; k < count; k++) {
      const mat = best.surface
        ? sampleSurface(best.surface, (angle - this.rotation(best)) / (Math.PI * 2) + (this.rand() - 0.5) * 0.05, 0.5 + (this.rand() - 0.5) * 0.2)
        : M.plasma;
      const a = angle + (this.rand() - 0.5) * 1.4;
      const s = vEsc * (0.9 + this.rand() * 0.6);
      const px = best.x + Math.cos(angle) * best.r * 1.1, py = best.y + Math.sin(angle) * best.r * 1.1;
      const m = loss / count;
      if (this.frags.free > 0 && TYPES[best.type].cls !== "star") {
        const rho = best.m / ((4 / 3) * Math.PI * best.r ** 3);
        this.frags.add(px, py, best.vx + Math.cos(a) * s, best.vy + Math.sin(a) * s, m, best.r * Math.sqrt(m / best.m), 2600, Math.max(0.01 * start, 1e19), best.id, mat === M.magma ? M.basalt : mat, rho);
        this.fragNames.set(best.id, best.name);
      } else {
        this.addDebris(px, py, best.vx + Math.cos(a) * s, best.vy + Math.sin(a) * s, fragmentColor(mat, 2600));
      }
    }
    if (this.frags.n) this.impactUntil = Math.max(this.impactUntil, this.t + 6 * 3600);
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
    this.undoStack.push({ t: this.t, nextId: this.nextId, bodies: this.bodies.map(cloneBody), debris: cloneDebris(this.debris), frags: this.frags.clone(), impactUntil: this.impactUntil });
    if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.t = s.t; this.nextId = s.nextId;
    this.bodies = s.bodies; this.debris = s.debris;
    this.impactUntil = s.impactUntil;
    const cap = this.frags.cap;
    this.frags = s.frags;
    this.frags.setCap(cap);
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
      v: 1, t: this.t, nextId: this.nextId, impactUntil: this.impactUntil,
      bodies: this.bodies.map(b => ({ ...b, surface: b.surface ? toB64(b.surface) : null, under: b.under ? toB64(b.under) : null })),
      frags: Array.from({ length: this.frags.n }, (_, i) => {
        const f = this.frags.s;
        return [f.x[i], f.y[i], f.vx[i], f.vy[i], f.m[i], f.r[i], f.T[i], isFinite(f.promote[i]) ? f.promote[i] : -1, f.src[i], ...f.hist.subarray(i * NMAT, i * NMAT + NMAT), f.rho[i]];
      }),
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
    this.impactUntil = s.impactUntil ?? -1;
    this.bodies = s.bodies.map(b => ({
      ...b, surface: b.surface ? fromB64(b.surface) : null, under: b.under ? fromB64(b.under) : null,
      heat: b.heat ?? 0, surfaceRev: 1,
    }));
    for (const r of s.frags ?? []) {
      this.frags.add(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7] < 0 ? Infinity : r[7], r[8], Float32Array.from(r.slice(9, 9 + NMAT)), r[9 + NMAT] ?? 3000);
    }
    const d = this.debris;
    d.count = Math.min(MAX_DEBRIS, s.debris.x.length);
    for (let i = 0; i < d.count; i++) {
      d.x[i] = s.debris.x[i]; d.y[i] = s.debris.y[i]; d.vx[i] = s.debris.vx[i]; d.vy[i] = s.debris.vy[i];
      d.color[i] = s.debris.color[i]; d.host[i] = s.debris.host[i];
    }
    this.topologyRev++;
  }

  // ---------- Queries ----------

  /** Mass in bodies plus fragments (massless debris excluded). */
  totalMass(): number {
    return this.bodies.reduce((s, b) => s + b.m, 0) + this.frags.totalMass();
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
