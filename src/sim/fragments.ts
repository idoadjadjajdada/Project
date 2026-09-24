import { G } from "./constants";
import { MATERIALS, M } from "./materials";

/**
 * Massive fragments: what bodies break into on big impacts, explosions and laser cuts.
 *
 * Fragments pull on each other (Barnes-Hut quadtree) and on nearby bodies, and bodies feel
 * them back. When two fragments touch slowly enough they stick (accretion); faster contacts
 * bounce inelastically and heat up. A clump that grows past its promotion mass becomes a
 * Body. Nothing about the outcome is scripted: reformed planets, debris disks and moons
 * all come out of these rules.
 *
 * Collision radius uses the 2D area share of the parent (r = R·√(m/M)) so a freshly broken
 * body tiles its old disk instead of overlapping itself.
 */

export const NMAT = MATERIALS.length;
/** Specific heat for rock-ish material, J/(kg·K). Turns impact energy into temperature. */
export const HEAT_CAP = 1000;
/** Fragments hotter than this glow and land as magma. */
export const MOLTEN_K = 1200;
/** Roughly where rock vaporises; fragments don't get hotter than this. */
export const MAX_K = 6000;
/** Restitution for cool, solid fragments (they mostly stick or thud). */
const RESTITUTION = 0.3;
/** Above this, fragments are molten/partly vaporised: they splash off each other almost elastically instead of sticking. */
export const STICK_K = 1800;
/** Roche limit factor for a fluid satellite: 2.44 · R · (ρ_planet / ρ_satellite)^⅓, with similar densities. */
const ROCHE = 2.44;
const THETA = 0.6;

export interface FragmentState {
  n: number;
  x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array;
  m: Float64Array; r: Float64Array;
  T: Float32Array;
  /** Mass that turns this fragment into a Body (1% of the event that made it). */
  promote: Float64Array;
  /** Id of the body this fragment mostly came from (for naming what reforms). */
  src: Uint32Array;
  /** Material mass histogram: NMAT floats per fragment (what it looks like and paints). */
  hist: Float32Array;
  /** Bulk density, kg/m³, inherited from the parent body (decides the size of what reforms). */
  rho: Float32Array;
}

export interface Attractor { x: number; y: number; vx: number; vy: number; m: number; r: number; id: number }

function alloc(cap: number): FragmentState {
  return {
    n: 0,
    x: new Float64Array(cap), y: new Float64Array(cap), vx: new Float64Array(cap), vy: new Float64Array(cap),
    m: new Float64Array(cap), r: new Float64Array(cap), T: new Float32Array(cap),
    promote: new Float64Array(cap), src: new Uint32Array(cap), hist: new Float32Array(cap * NMAT),
    rho: new Float32Array(cap),
  };
}

// ---------- Barnes-Hut quadtree over fragments ----------

class QuadTree {
  // Node arrays: bounds centre/half-size, mass, centre of mass, children (-1 = none), leaf body (-1 = none).
  cx = new Float64Array(0); cy = new Float64Array(0); half = new Float64Array(0);
  mass = new Float64Array(0); mx = new Float64Array(0); my = new Float64Array(0);
  child = new Int32Array(0); leaf = new Int32Array(0);
  count = 0;

  private ensure(n: number) {
    if (this.cx.length >= n) return;
    const cap = Math.max(n, this.cx.length * 2, 64);
    const grow = <T extends Float64Array | Int32Array>(a: T, ctor: new (n: number) => T) => { const b = new ctor(cap); b.set(a); return b; };
    this.cx = grow(this.cx, Float64Array); this.cy = grow(this.cy, Float64Array); this.half = grow(this.half, Float64Array);
    this.mass = grow(this.mass, Float64Array); this.mx = grow(this.mx, Float64Array); this.my = grow(this.my, Float64Array);
    const c = new Int32Array(cap * 4); c.set(this.child); this.child = c;
    this.leaf = grow(this.leaf, Int32Array);
  }

  private node(cx: number, cy: number, half: number): number {
    this.ensure(this.count + 1);
    const k = this.count++;
    this.cx[k] = cx; this.cy[k] = cy; this.half[k] = half;
    this.mass[k] = 0; this.mx[k] = 0; this.my[k] = 0; this.leaf[k] = -1;
    this.child.fill(-1, k * 4, k * 4 + 4);
    return k;
  }

  build(f: FragmentState): void {
    this.count = 0;
    if (f.n === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < f.n; i++) {
      if (f.x[i] < minX) minX = f.x[i]; if (f.x[i] > maxX) maxX = f.x[i];
      if (f.y[i] < minY) minY = f.y[i]; if (f.y[i] > maxY) maxY = f.y[i];
    }
    const half = Math.max(maxX - minX, maxY - minY, 1) / 2 + 1;
    this.node((minX + maxX) / 2, (minY + maxY) / 2, half);
    for (let i = 0; i < f.n; i++) this.insert(0, i, f, 0);
    this.summarize(0, f);
  }

  private quad(k: number, x: number, y: number): number {
    return (x >= this.cx[k] ? 1 : 0) + (y >= this.cy[k] ? 2 : 0);
  }

  private insert(k: number, i: number, f: FragmentState, depth: number): void {
    for (;;) {
      const hasKids = this.child[k * 4] !== -1 || this.child[k * 4 + 1] !== -1 || this.child[k * 4 + 2] !== -1 || this.child[k * 4 + 3] !== -1;
      if (!hasKids && this.leaf[k] === -1) { this.leaf[k] = i; return; }
      if (depth > 40) { // coincident points: just accumulate in this leaf's mass later
        this.leaf[k] = this.leaf[k] === -1 ? i : this.leaf[k];
        return;
      }
      if (!hasKids) {
        // Split: push the existing leaf down.
        const j = this.leaf[k];
        this.leaf[k] = -1;
        const q = this.quad(k, f.x[j], f.y[j]);
        this.child[k * 4 + q] = this.makeChild(k, q);
        this.leaf[this.child[k * 4 + q]] = j;
      }
      const q = this.quad(k, f.x[i], f.y[i]);
      if (this.child[k * 4 + q] === -1) this.child[k * 4 + q] = this.makeChild(k, q);
      k = this.child[k * 4 + q];
      depth++;
    }
  }

  private makeChild(k: number, q: number): number {
    const h = this.half[k] / 2;
    return this.node(this.cx[k] + (q & 1 ? h : -h), this.cy[k] + (q & 2 ? h : -h), h);
  }

  private summarize(k: number, f: FragmentState): void {
    let m = 0, sx = 0, sy = 0;
    const leaf = this.leaf[k];
    if (leaf !== -1) { m += f.m[leaf]; sx += f.x[leaf] * f.m[leaf]; sy += f.y[leaf] * f.m[leaf]; }
    for (let q = 0; q < 4; q++) {
      const c = this.child[k * 4 + q];
      if (c === -1) continue;
      this.summarize(c, f);
      m += this.mass[c]; sx += this.mx[c] * this.mass[c]; sy += this.my[c] * this.mass[c];
    }
    this.mass[k] = m;
    this.mx[k] = m > 0 ? sx / m : this.cx[k];
    this.my[k] = m > 0 ? sy / m : this.cy[k];
  }

  /** Acceleration at (x, y) from all fragments except `self`, softened by `soft`. */
  accel(x: number, y: number, self: number, soft: number, f: FragmentState, out: [number, number]): void {
    let ax = 0, ay = 0;
    if (this.count === 0) { out[0] = 0; out[1] = 0; return; }
    const stack = [0];
    const s2 = soft * soft;
    while (stack.length) {
      const k = stack.pop()!;
      if (this.mass[k] === 0) continue;
      const dx = this.mx[k] - x, dy = this.my[k] - y;
      const d2 = dx * dx + dy * dy;
      const size = this.half[k] * 2;
      const leaf = this.leaf[k];
      const hasKids = this.child[k * 4] !== -1 || this.child[k * 4 + 1] !== -1 || this.child[k * 4 + 2] !== -1 || this.child[k * 4 + 3] !== -1;
      if (!hasKids || size * size < THETA * THETA * d2) {
        if (!hasKids && leaf === self) continue;
        const r2 = d2 + s2;
        const g = (G * this.mass[k]) / (r2 * Math.sqrt(r2));
        ax += dx * g; ay += dy * g;
      } else {
        if (leaf !== -1 && leaf !== self) {
          const ldx = f.x[leaf] - x, ldy = f.y[leaf] - y, r2 = ldx * ldx + ldy * ldy + s2;
          const g = (G * f.m[leaf]) / (r2 * Math.sqrt(r2));
          ax += ldx * g; ay += ldy * g;
        }
        for (let q = 0; q < 4; q++) { const c = this.child[k * 4 + q]; if (c !== -1) stack.push(c); }
      }
    }
    out[0] = ax; out[1] = ay;
  }
}

export interface Promotion {
  m: number; x: number; y: number; vx: number; vy: number;
  T: number; src: number; hist: Float32Array; rho: number;
}

export interface Landing {
  /** Index into the attractors list passed to step(). */
  body: number;
  m: number; vx: number; vy: number; x: number; y: number;
  T: number; hist: Float32Array;
}

export class Fragments {
  s: FragmentState;
  private tree = new QuadTree();
  private tmp: [number, number] = [0, 0];

  constructor(public cap: number) {
    this.s = alloc(cap);
  }

  get n(): number { return this.s.n; }
  get free(): number { return this.cap - this.s.n; }

  setCap(cap: number): void {
    if (cap === this.cap) return;
    const old = this.s;
    this.s = alloc(cap);
    this.cap = cap;
    const keep = Math.min(old.n, cap);
    // Keep the heaviest fragments when shrinking.
    const order = Array.from({ length: old.n }, (_, i) => i).sort((a, b) => old.m[b] - old.m[a]).slice(0, keep);
    for (const i of order) this.copyFrom(old, i);
  }

  private copyFrom(o: FragmentState, i: number): number {
    const s = this.s, k = s.n++;
    s.x[k] = o.x[i]; s.y[k] = o.y[i]; s.vx[k] = o.vx[i]; s.vy[k] = o.vy[i];
    s.m[k] = o.m[i]; s.r[k] = o.r[i]; s.T[k] = o.T[i]; s.promote[k] = o.promote[i]; s.src[k] = o.src[i]; s.rho[k] = o.rho[i];
    s.hist.set(o.hist.subarray(i * NMAT, i * NMAT + NMAT), k * NMAT);
    return k;
  }

  clone(): Fragments {
    const f = new Fragments(this.cap);
    for (let i = 0; i < this.s.n; i++) f.copyFrom(this.s, i);
    return f;
  }

  clear(): void {
    this.s.n = 0;
  }

  add(x: number, y: number, vx: number, vy: number, m: number, r: number, T: number, promote: number, src: number, mat: number | Float32Array, rho = 3000): number {
    const s = this.s;
    if (s.n >= this.cap) return -1;
    const k = s.n++;
    s.x[k] = x; s.y[k] = y; s.vx[k] = vx; s.vy[k] = vy; s.m[k] = m; s.r[k] = r; s.T[k] = T;
    s.promote[k] = promote; s.src[k] = src; s.rho[k] = rho;
    const h = s.hist.subarray(k * NMAT, k * NMAT + NMAT);
    if (typeof mat === "number") { h.fill(0); h[mat] = m; } else h.set(mat);
    return k;
  }

  remove(i: number): void {
    const s = this.s, last = --s.n;
    if (i === last) return;
    s.x[i] = s.x[last]; s.y[i] = s.y[last]; s.vx[i] = s.vx[last]; s.vy[i] = s.vy[last];
    s.m[i] = s.m[last]; s.r[i] = s.r[last]; s.T[i] = s.T[last]; s.promote[i] = s.promote[last]; s.src[i] = s.src[last]; s.rho[i] = s.rho[last];
    s.hist.copyWithin(i * NMAT, last * NMAT, last * NMAT + NMAT);
  }

  totalMass(): number {
    let m = 0;
    for (let i = 0; i < this.s.n; i++) m += this.s.m[i];
    return m;
  }

  /** Physical (3D) radius of fragment i from its composition, for tidal checks. */
  bulkRadius(i: number): number {
    return Math.cbrt((3 * this.s.m[i]) / (4 * Math.PI * this.s.rho[i]));
  }

  /** Dominant material of fragment i. */
  material(i: number): number {
    const h = this.s.hist;
    let best = 0;
    for (let k = 1; k < NMAT; k++) if (h[i * NMAT + k] > h[i * NMAT + best]) best = k;
    return best;
  }

  /**
   * Largest safe step: fragments must not skip past each other or around a planet.
   * Returns Infinity when there are no fragments.
   */
  maxStep(attractors: readonly Attractor[]): number {
    const s = this.s;
    if (s.n === 0) return Infinity;
    const gap = this.neighbourGaps();
    let dt = Infinity;
    for (let i = 0; i < s.n; i++) {
      // Orbit accuracy around the nearest attractor, and no skipping through a contact:
      // move at most ~30% of the larger of own radius and the gap to anything it could hit.
      let vr = Math.hypot(s.vx[i], s.vy[i]), tau = Infinity, g = gap[i];
      for (const b of attractors) {
        const dx = b.x - s.x[i], dy = b.y - s.y[i];
        const d = Math.hypot(dx, dy);
        const t = Math.sqrt((d * d * d) / (G * b.m));
        if (t < tau) { tau = t; vr = Math.hypot(s.vx[i] - b.vx, s.vy[i] - b.vy); }
        g = Math.min(g, d - b.r - s.r[i]);
      }
      dt = Math.min(dt, 0.02 * tau, (0.3 * Math.max(s.r[i], g)) / Math.max(1, vr));
    }
    return Math.max(1, dt);
  }

  /** Distance from each fragment's edge to the nearest other fragment's edge. */
  gaps(): Float64Array {
    return this.neighbourGaps();
  }

  private neighbourGaps(): Float64Array {
    const s = this.s, gap = new Float64Array(s.n).fill(Infinity);
    const idx = Array.from({ length: s.n }, (_, i) => i).sort((a, b) => s.x[a] - s.x[b]);
    for (let p = 0; p < idx.length; p++) {
      const i = idx[p];
      for (let q = p + 1; q < idx.length; q++) {
        const j = idx[q];
        const dx = s.x[j] - s.x[i];
        if (dx - s.r[i] - s.r[j] > Math.min(gap[i], 1e12)) break;
        const d = Math.hypot(dx, s.y[j] - s.y[i]) - s.r[i] - s.r[j];
        if (d < gap[i]) gap[i] = d;
        if (d < gap[j]) gap[j] = d;
      }
    }
    return gap;
  }

  /**
   * Acceleration on fragment i from other fragments (tree) and from attractors.
   * The tree must have been built for the current positions.
   */
  private accelOn(i: number, attractors: readonly Attractor[], out: [number, number]): void {
    const s = this.s;
    this.tree.accel(s.x[i], s.y[i], i, s.r[i], s, out);
    let ax = out[0], ay = out[1];
    for (const b of attractors) {
      const dx = b.x - s.x[i], dy = b.y - s.y[i];
      const r2 = dx * dx + dy * dy + s.r[i] * s.r[i] * 0.01;
      const g = (G * b.m) / (r2 * Math.sqrt(r2));
      ax += dx * g; ay += dy * g;
    }
    out[0] = ax; out[1] = ay;
  }

  /** Pull of all fragments on a point (for the back-reaction on bodies). */
  fieldAt(x: number, y: number, soft: number, out: [number, number]): void {
    this.tree.accel(x, y, -1, soft, this.s, out);
  }

  rebuildTree(): void {
    this.tree.build(this.s);
  }

  /**
   * Advance fragments by h with kick-drift-kick against the attractors (bodies at their
   * current positions, moving linearly across the step). Handles fragment contacts
   * (stick or bounce), landings on bodies and cooling. Returns what landed and what
   * grew big enough to become a body; both are removed from the fragment set.
   */
  step(h: number, attractors: Attractor[], field: ((x: number, y: number, out: [number, number]) => void) | null, movable = Infinity): { landed: Landing[]; promoted: Promotion[] } {
    const s = this.s;
    // Fragments at index >= movable were created during this step (a collision mid-block):
    // they start moving next step instead of being flung across the whole elapsed interval.
    const nMove = Math.min(s.n, movable);
    const landed: Landing[] = [], promoted: Promotion[] = [];
    if (s.n === 0) return { landed, promoted };
    const a = this.tmp;
    const ax = new Float64Array(s.n), ay = new Float64Array(s.n);
    this.tree.build(s);
    for (let i = 0; i < nMove; i++) {
      this.accelOn(i, attractors, a);
      ax[i] = a[0]; ay[i] = a[1];
      if (field) { field(s.x[i], s.y[i], a); ax[i] += a[0]; ay[i] += a[1]; }
      s.vx[i] += ax[i] * h * 0.5; s.vy[i] += ay[i] * h * 0.5;
      s.x[i] += s.vx[i] * h; s.y[i] += s.vy[i] * h;
    }
    // Bodies move during the step too; test contacts against where they are now.
    const moved = attractors.map(b => ({ ...b, x: b.x + b.vx * h, y: b.y + b.vy * h }));
    this.tree.build(s);
    for (let i = 0; i < nMove; i++) {
      this.accelOn(i, moved, a);
      let fx = a[0], fy = a[1];
      if (field) { field(s.x[i], s.y[i], a); fx += a[0]; fy += a[1]; }
      s.vx[i] += fx * h * 0.5; s.vy[i] += fy * h * 0.5;
    }

    this.contacts(moved);

    // Landings: a fragment touching a body joins it.
    for (let i = s.n - 1; i >= 0; i--) {
      for (let k = 0; k < moved.length; k++) {
        const b = moved[k];
        const dx = s.x[i] - b.x, dy = s.y[i] - b.y;
        if (dx * dx + dy * dy < b.r * b.r) {
          landed.push({ body: k, m: s.m[i], vx: s.vx[i], vy: s.vy[i], x: s.x[i], y: s.y[i], T: s.T[i], hist: s.hist.slice(i * NMAT, i * NMAT + NMAT) });
          this.remove(i);
          break;
        }
      }
    }

    // Cooling: radiation (rate grows like T³, so white-hot pieces dim fast); small pieces cool fastest.
    for (let i = 0; i < s.n; i++) {
      if (s.T[i] <= 300) continue;
      const hotness = Math.max(1, (s.T[i] / 1500) ** 3);
      const tau = Math.max(600, (3 * 86400 * (s.r[i] / 1e6)) / hotness);
      s.T[i] = Math.min(MAX_K, 300 + (s.T[i] - 300) * Math.exp(-h / tau));
    }

    // Promotion: a clump past its threshold becomes a body.
    for (let i = s.n - 1; i >= 0; i--) {
      if (s.m[i] < s.promote[i]) continue;
      promoted.push({ m: s.m[i], x: s.x[i], y: s.y[i], vx: s.vx[i], vy: s.vy[i], T: s.T[i], src: s.src[i], hist: s.hist.slice(i * NMAT, i * NMAT + NMAT), rho: s.rho[i] });
      this.remove(i);
    }
    return { landed, promoted };
  }

  /**
   * Inside the Roche zone of a much bigger body (a planet or the reforming main clump),
   * tides pull small pieces apart faster than they can stick: no accretion there.
   */
  private insideRoche(x: number, y: number, m: number, dominant: readonly { x: number; y: number; m: number; r: number }[]): boolean {
    for (const b of dominant) {
      if (b.m < 50 * m) continue;
      const lim = ROCHE * b.r;
      if ((x - b.x) ** 2 + (y - b.y) ** 2 < lim * lim) return true;
    }
    return false;
  }

  /**
   * Sweep-and-prune on x: overlapping pairs stick when slow, cool enough and outside any
   * Roche zone; otherwise they bounce (nearly elastically when molten, like a splash).
   */
  private contacts(attractors: readonly Attractor[]): void {
    const s = this.s;
    if (s.n < 2) return;
    // The heaviest fragment counts as a "planet" for the Roche test too (a remnant still forming).
    let big = 0;
    for (let i = 1; i < s.n; i++) if (s.m[i] > s.m[big]) big = i;
    const dominant = [...attractors, { x: s.x[big], y: s.y[big], m: s.m[big], r: this.bulkRadius(big) }];
    const idx = Array.from({ length: s.n }, (_, i) => i).sort((a, b) => (s.x[a] - s.r[a]) - (s.x[b] - s.r[b]));
    const dead = new Uint8Array(s.n);
    for (let p = 0; p < idx.length; p++) {
      const i = idx[p];
      if (dead[i]) continue;
      for (let q = p + 1; q < idx.length; q++) {
        const j = idx[q];
        if (s.x[j] - s.r[j] > s.x[i] + s.r[i]) break;
        if (dead[j] || dead[i]) continue;
        const dx = s.x[j] - s.x[i], dy = s.y[j] - s.y[i];
        const rs = s.r[i] + s.r[j];
        const d2 = dx * dx + dy * dy;
        if (d2 >= rs * rs) continue;
        const d = Math.sqrt(d2) || rs * 1e-3;
        const nx = dx / d, ny = dy / d;
        const rvx = s.vx[j] - s.vx[i], rvy = s.vy[j] - s.vy[i];
        const vn = rvx * nx + rvy * ny;
        const mi = s.m[i], mj = s.m[j], mt = mi + mj;
        const vEsc = Math.sqrt((2 * G * mt) / rs);
        const vrel = Math.hypot(rvx, rvy);
        const hot = (s.T[i] * mi + s.T[j] * mj) / mt > STICK_K;
        const tidal = i !== big && j !== big && this.insideRoche((s.x[i] + s.x[j]) / 2, (s.y[i] + s.y[j]) / 2, mt, dominant);
        const joinsBig = (i === big || j === big) && vrel < 1.3 * Math.sqrt((2 * G * (s.m[big] + Math.min(mi, mj))) / rs);
        if (joinsBig || (vrel < 1.3 * vEsc && !hot && !tidal)) {
          // Stick: momentum-conserving merge; kinetic energy lost becomes heat.
          const cvx = (s.vx[i] * mi + s.vx[j] * mj) / mt, cvy = (s.vy[i] * mi + s.vy[j] * mj) / mt;
          const ke = 0.5 * ((mi * mj) / mt) * vrel * vrel;
          s.x[i] = (s.x[i] * mi + s.x[j] * mj) / mt; s.y[i] = (s.y[i] * mi + s.y[j] * mj) / mt;
          s.vx[i] = cvx; s.vy[i] = cvy;
          s.T[i] = Math.min(MAX_K, (s.T[i] * mi + s.T[j] * mj) / mt + ke / (mt * HEAT_CAP));
          // Area-conserving (2D) radius keeps clumps from shrinking out of contact.
          s.r[i] = Math.hypot(s.r[i], s.r[j]);
          s.m[i] = mt;
          s.promote[i] = Math.min(s.promote[i], s.promote[j]);
          s.rho[i] = mt / (mi / s.rho[i] + mj / s.rho[j]);
          if (mj > mi) s.src[i] = s.src[j];
          for (let k = 0; k < NMAT; k++) s.hist[i * NMAT + k] += s.hist[j * NMAT + k];
          dead[j] = 1;
        } else if (vn < 0) {
          // Bounce along the contact normal, then separate. Molten material splashes (bouncy);
          // solid rock thuds (most energy lost to heat).
          const e = hot ? 0.85 : RESTITUTION;
          const jImp = (-(1 + e) * vn) / (1 / mi + 1 / mj);
          s.vx[i] -= (jImp * nx) / mi; s.vy[i] -= (jImp * ny) / mi;
          s.vx[j] += (jImp * nx) / mj; s.vy[j] += (jImp * ny) / mj;
          const lost = 0.5 * ((mi * mj) / mt) * vn * vn * (1 - e * e);
          s.T[i] = Math.min(MAX_K, s.T[i] + lost / (2 * mi * HEAT_CAP));
          s.T[j] = Math.min(MAX_K, s.T[j] + lost / (2 * mj * HEAT_CAP));
          // Separate solid pieces a little. Pushing apart inside a gravity well adds energy,
          // so molten pieces aren't pushed at all and solid ones only by a fraction of the overlap.
          if (!hot) {
            const push = Math.min(rs - d, 0.2 * rs) * 0.25;
            s.x[i] -= nx * push * (mj / mt) * 2; s.y[i] -= ny * push * (mj / mt) * 2;
            s.x[j] += nx * push * (mi / mt) * 2; s.y[j] += ny * push * (mi / mt) * 2;
          }
        }
      }
    }
    for (let i = s.n - 1; i >= 0; i--) if (dead[i]) this.remove(i);
  }
}

/** Colour for a fragment: its material, heated toward orange-white as it gets hotter. */
export function fragmentColor(mat: number, T: number): number {
  const base = MATERIALS[mat]?.color ?? 0x888888;
  if (T < 700) return base;
  const hot = T > 2600 ? 0xfff2c0 : T > 1800 ? 0xffb040 : T > 1200 ? 0xff6a1a : 0xc4301a;
  const k = Math.min(1, (T - 700) / 900);
  const lerp = (a: number, b: number, sh: number) => Math.round(((a >> sh) & 255) * (1 - k) + ((b >> sh) & 255) * k);
  return (lerp(base, hot, 16) << 16) | (lerp(base, hot, 8) << 8) | lerp(base, hot, 0);
}

/**
 * What a piece of a body is made of at depth `f` (0 = surface, 1 = centre).
 * Icy bodies have rock cores under ice mantles; everything else has an iron core under a rock mantle.
 */
export function interiorMaterial(surfaceMat: number, f: number, icyBody: boolean): number {
  if (f > 0.75) return icyBody ? M.silicate : M.iron;   // core
  if (f > 0.35) return icyBody ? M.ice : M.silicate;    // mantle
  return surfaceMat;                                    // crust
}
