import { MATERIALS, M } from "./materials";
import { pickWeighted, rng } from "./rng";
import { SURF_H, SURF_W } from "./types";

/**
 * Surface maps are equirectangular grids of material indices: SURF_W cells of longitude
 * by SURF_H cells of latitude. Impacts paint the impactor's own cells onto the target,
 * so mixed bodies keep distinct patches instead of an averaged color.
 */

const N = SURF_W * SURF_H;

function lonDist(a: number, b: number): number {
  const d = Math.abs(a - b) % SURF_W;
  return Math.min(d, SURF_W - d);
}

/** Voronoi-style patches: each cell takes the material of its nearest seed. */
function patches(weights: [number, number][], seeds: number, rand: () => number): Uint8Array {
  const sx: number[] = [], sy: number[] = [], sm: number[] = [];
  for (let i = 0; i < seeds; i++) {
    sx.push(rand() * SURF_W);
    // Uniform on the sphere, not in latitude, so poles aren't over-seeded.
    sy.push((Math.acos(1 - 2 * rand()) / Math.PI) * SURF_H);
    sm.push(pickWeighted(weights, rand()));
  }
  const out = new Uint8Array(N);
  for (let y = 0; y < SURF_H; y++) {
    const lat = ((y + 0.5) / SURF_H - 0.5) * Math.PI;
    const lonScale = Math.max(0.15, Math.cos(lat));
    for (let x = 0; x < SURF_W; x++) {
      let best = Infinity, mat = sm[0];
      for (let i = 0; i < seeds; i++) {
        // Jitter the distance a little so borders look organic.
        const dx = lonDist(x + 0.5, sx[i]) * lonScale, dy = y + 0.5 - sy[i];
        const d = dx * dx + dy * dy + rand() * 3;
        if (d < best) { best = d; mat = sm[i]; }
      }
      out[y * SURF_W + x] = mat;
    }
  }
  return out;
}

function bands(weights: [number, number][], rand: () => number): Uint8Array {
  const out = new Uint8Array(N);
  let y = 0;
  while (y < SURF_H) {
    const h = 1 + Math.floor(rand() * 3);
    const mat = pickWeighted(weights, rand());
    for (let yy = y; yy < Math.min(SURF_H, y + h); yy++) {
      for (let x = 0; x < SURF_W; x++) {
        // Wavy band edges.
        const wob = Math.sin((x / SURF_W) * Math.PI * 6 + yy) > 0.85 ? pickWeighted(weights, rand()) : mat;
        out[yy * SURF_W + x] = wob;
      }
    }
    y += h;
  }
  return out;
}

export function generateSurface(weights: [number, number][], banded: boolean, seed: number, polarIce = false): Uint8Array {
  const rand = rng(seed);
  const s = banded ? bands(weights, rand) : patches(weights, 28, rand);
  if (polarIce) {
    for (let x = 0; x < SURF_W; x++) {
      const cap = 2 + Math.floor(rand() * 2);
      for (let y = 0; y < cap; y++) {
        s[y * SURF_W + x] = M.ice;
        s[(SURF_H - 1 - y) * SURF_W + x] = M.ice;
      }
    }
  }
  return s;
}

/** Fraction of cells per material, largest first. */
export function composition(s: Uint8Array): { mat: number; frac: number }[] {
  const counts = new Map<number, number>();
  for (let i = 0; i < s.length; i++) counts.set(s[i], (counts.get(s[i]) ?? 0) + 1);
  return [...counts.entries()]
    .map(([mat, c]) => ({ mat, frac: c / s.length }))
    .sort((a, b) => b.frac - a.frac);
}

export function hasWater(s: Uint8Array | null, minFrac = 0.01): boolean {
  if (!s) return false;
  let w = 0;
  for (let i = 0; i < s.length; i++) if (MATERIALS[s[i]]?.water) w++;
  return w / s.length >= minFrac;
}

export function uniformSurface(mat: number): Uint8Array {
  return new Uint8Array(N).fill(mat);
}

export interface SplashParams {
  /** Impact point, in cells. */
  lon: number;
  lat: number;
  /** Semi-axes of the splash ellipse in cells: `along` follows the impact direction. */
  along: number;
  across: number;
  /** Direction of travel across the surface, radians (0 = +longitude). */
  heading: number;
  seed: number;
}

/**
 * Paint the impactor's material onto the target around the impact point.
 * Cells are sampled from the matching spot of the impactor's own map, so its
 * pattern survives as a patch or a streak.
 */
export function splash(target: Uint8Array, impactor: Uint8Array, p: SplashParams): void {
  const rand = rng(p.seed);
  const cosH = Math.cos(p.heading), sinH = Math.sin(p.heading);
  const reach = Math.ceil(Math.max(p.along, p.across)) + 2;
  for (let dy = -reach; dy <= reach; dy++) {
    const y = Math.round(p.lat) + dy;
    if (y < 0 || y >= SURF_H) continue;
    for (let dx = -reach; dx <= reach; dx++) {
      const x = (((Math.round(p.lon) + dx) % SURF_W) + SURF_W) % SURF_W;
      const u = dx * cosH + dy * sinH, v = -dx * sinH + dy * cosH;
      const d = (u * u) / (p.along * p.along) + (v * v) / (p.across * p.across);
      // Ragged rim: cells near the edge only sometimes get paint.
      if (d > 1 + (rand() - 0.5) * 0.5) continue;
      const iu = Math.floor(((u / p.along + 1) / 2) * SURF_W * 0.5 + SURF_W * 0.25);
      const iv = Math.floor(((v / p.across + 1) / 2) * SURF_H * 0.5 + SURF_H * 0.25);
      const src = impactor[Math.min(SURF_H - 1, Math.max(0, iv)) * SURF_W + (((iu % SURF_W) + SURF_W) % SURF_W)];
      target[y * SURF_W + x] = src;
    }
  }
}

/**
 * A huge impact melts both bodies: rebuild the surface as fresh patches drawn from
 * both compositions, weighted by mass. Materials stay separate, never averaged.
 */
export function remix(a: Uint8Array, ma: number, b: Uint8Array, mb: number, seed: number): Uint8Array {
  const w = new Map<number, number>();
  for (const { mat, frac } of composition(a)) w.set(mat, (w.get(mat) ?? 0) + frac * ma);
  for (const { mat, frac } of composition(b)) w.set(mat, (w.get(mat) ?? 0) + frac * mb);
  return patches([...w.entries()], 40, rng(seed));
}

/** Surface for a fragment broken off a parent: a rotated, slightly scrambled copy. */
export function fragmentSurface(parent: Uint8Array, seed: number): Uint8Array {
  const rand = rng(seed);
  const shift = Math.floor(rand() * SURF_W);
  const out = new Uint8Array(N);
  for (let y = 0; y < SURF_H; y++) {
    for (let x = 0; x < SURF_W; x++) {
      const sx = (x + shift) % SURF_W;
      const sy = Math.min(SURF_H - 1, Math.max(0, y + Math.round((rand() - 0.5) * 2)));
      out[y * SURF_W + x] = parent[sy * SURF_W + sx];
    }
  }
  return out;
}

/** Material under a longitude/latitude, used for debris color. */
export function sampleSurface(s: Uint8Array, lonFrac: number, latFrac: number): number {
  const x = Math.floor((((lonFrac % 1) + 1) % 1) * SURF_W);
  const y = Math.min(SURF_H - 1, Math.max(0, Math.floor(latFrac * SURF_H)));
  return s[y * SURF_W + x];
}
