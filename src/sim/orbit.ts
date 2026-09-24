import { G } from "./constants";
import type { Body } from "./types";

/** The body pulling hardest on point (x, y): the one a new body should orbit. */
export function strongestAttractor(bodies: readonly Body[], x: number, y: number, exclude?: Body): Body | null {
  let best: Body | null = null, bestA = 0;
  for (const b of bodies) {
    if (b === exclude || b.type === "spacecraft") continue;
    const dx = b.x - x, dy = b.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 === 0) continue;
    const a = b.m / d2;
    if (a > bestA) { bestA = a; best = b; }
  }
  return best;
}

/**
 * The parent a body orbits: the heaviest body whose Hill-sphere-like region contains it.
 * Falls back to the strongest attractor. Using acceleration alone makes moons flip to
 * the Sun whenever they pass the far side of their planet, so bodies that are bound
 * to a lighter neighbour are preferred.
 */
export function parentOf(bodies: readonly Body[], b: Body): Body | null {
  let best: Body | null = null;
  for (const p of bodies) {
    if (p === b || p.m <= b.m || p.type === "spacecraft") continue;
    const dx = b.x - p.x, dy = b.y - p.y;
    const d = Math.hypot(dx, dy);
    const dvx = b.vx - p.vx, dvy = b.vy - p.vy;
    const energy = 0.5 * (dvx * dvx + dvy * dvy) - (G * (p.m + b.m)) / d;
    if (energy >= 0) continue; // not bound to p
    // Among bound candidates prefer the closest-in (smallest d / hill radius), i.e. the moon's planet over the star.
    if (!best) { best = p; continue; }
    const bd = Math.hypot(b.x - best.x, b.y - best.y);
    const rel = d / Math.cbrt(p.m), relBest = bd / Math.cbrt(best.m);
    if (rel < relBest) best = p;
  }
  return best ?? strongestAttractor(bodies, b.x, b.y, b);
}

export interface Elements {
  /** Distance to parent, m. */
  dist: number;
  /** Speed relative to parent, m/s. */
  speed: number;
  /** Semi-major axis, m (Infinity when unbound). */
  a: number;
  e: number;
  /** Orbital period, s (Infinity when unbound). */
  period: number;
  bound: boolean;
  /** Argument of periapsis in the plane, radians. */
  argPeri: number;
}

export function elements(b: Body, p: Body): Elements {
  const rx = b.x - p.x, ry = b.y - p.y;
  const vx = b.vx - p.vx, vy = b.vy - p.vy;
  const mu = G * (p.m + b.m);
  const r = Math.hypot(rx, ry), v2 = vx * vx + vy * vy;
  const energy = v2 / 2 - mu / r;
  const h = rx * vy - ry * vx;
  // Eccentricity vector.
  const ex = (vy * h) / mu - rx / r, ey = (-vx * h) / mu - ry / r;
  const e = Math.hypot(ex, ey);
  const bound = energy < 0;
  const a = bound ? -mu / (2 * energy) : Infinity;
  const period = bound ? 2 * Math.PI * Math.sqrt((a * a * a) / mu) : Infinity;
  return { dist: r, speed: Math.sqrt(v2), a, e, period, bound, argPeri: Math.atan2(ey, ex) };
}

/**
 * Circular orbit velocity for a body of mass `m` at (x, y) around parent, keeping the given
 * turning direction. Uses the two-body G(M + m) so heavy companions are circular too.
 */
export function circularVelocity(p: Body, x: number, y: number, prograde = 1, m = 0): [number, number] {
  const rx = x - p.x, ry = y - p.y;
  const r = Math.hypot(rx, ry);
  if (r === 0) return [p.vx, p.vy];
  const v = Math.sqrt((G * (p.m + m)) / r);
  // Counter-clockwise (in world coordinates) for prograde = 1.
  return [p.vx + (-ry / r) * v * prograde, p.vy + (rx / r) * v * prograde];
}

function solveE(M: number, e: number): number {
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 20; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-10) break;
  }
  return E;
}

/**
 * Exact two-body propagation of a relative state by `dt` (Lagrange f and g functions).
 * Returns null for unbound orbits so the caller can integrate numerically instead.
 */
export function propagateKepler(mu: number, rx: number, ry: number, vx: number, vy: number, dt: number): [number, number, number, number] | null {
  const r0 = Math.hypot(rx, ry);
  const v2 = vx * vx + vy * vy;
  const a = 1 / (2 / r0 - v2 / mu);
  if (!(a > 0)) return null;
  const n = Math.sqrt(mu / (a * a * a));
  const ecosE0 = 1 - r0 / a;
  const esinE0 = (rx * vx + ry * vy) / Math.sqrt(mu * a);
  const e = Math.hypot(ecosE0, esinE0);
  if (e >= 0.99) return null;
  const E0 = Math.atan2(esinE0, ecosE0);
  const M0 = E0 - esinE0;
  const M = (M0 + n * dt) % (2 * Math.PI);
  const E = solveE(M, e);
  const dE = E - E0;
  const cd = Math.cos(dE), sd = Math.sin(dE);
  const f = 1 - (a / r0) * (1 - cd);
  // Total change in E including whole revolutions, straight from Kepler's equation.
  const dEtotal = n * dt + e * Math.sin(E) - esinE0;
  const g = dt - (dEtotal - sd) / n;
  const r = a * (1 - e * Math.cos(E));
  const fdot = (-Math.sqrt(mu * a) * sd) / (r * r0);
  const gdot = 1 - (a / r) * (1 - cd);
  return [f * rx + g * vx, f * ry + g * vy, fdot * rx + gdot * vx, fdot * ry + gdot * vy];
}
