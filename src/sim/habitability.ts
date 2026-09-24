import { luminosityFor, starTeff, TYPES } from "./catalog";
import { AU, M_EARTH } from "./constants";
import { elements, parentOf } from "./orbit";
import { hasWater } from "./surface";
import type { Body } from "./types";

/** Stellar flux at a body in units of Earth's (1 = what Earth gets from the Sun). */
export function fluxAt(bodies: readonly Body[], b: Body): number {
  let s = 0;
  for (const o of bodies) {
    if (o === b) continue;
    const L = luminosityFor(o.type, o.m);
    if (L <= 0) continue;
    const d = Math.hypot(o.x - b.x, o.y - b.y) / AU;
    if (d > 0) s += L / (d * d);
  }
  return s;
}

/** Surface temperature in K: effective temperature for stars, equilibrium plus greenhouse for everything else. */
export function temperature(bodies: readonly Body[], b: Body): number {
  const cls = TYPES[b.type].cls;
  if (cls === "star" || b.type === "whitedwarf" || b.type === "neutron" || b.type === "pulsar") return starTeff(b.type, b.m, b.r);
  if (b.type === "blackhole") return 0;
  const S = fluxAt(bodies, b);
  const teq = 278.6 * Math.pow(S, 0.25) * Math.pow(1 - b.albedo, 0.25);
  // Deep space floor: the cosmic microwave background.
  // Leftover impact heat (a magma ocean) adds on top.
  return Math.max(2.7, teq + (S > 0 ? b.greenhouse : 0)) + b.heat;
}

export interface Factor { name: string; detail: string; pass: boolean }

export interface Habitability {
  applicable: boolean;
  score: number;
  factors: Factor[];
}

/**
 * Life likelihood: six pass/fail factors from the PRD, weighted equally
 * (weighting is still an open question in the PRD).
 */
export function habitability(bodies: readonly Body[], b: Body): Habitability {
  const cls = TYPES[b.type].cls;
  if (cls !== "planet" && cls !== "small") return { applicable: false, score: 0, factors: [] };
  const S = fluxAt(bodies, b);
  const T = temperature(bodies, b);
  const mE = b.m / M_EARTH;
  const p = parentOf(bodies, b);
  const el = p ? elements(b, p) : null;
  // Nearest luminous star, for the flare check.
  let nearest: Body | null = null, nd = Infinity;
  for (const o of bodies) {
    if (o === b || luminosityFor(o.type, o.m) <= 0) continue;
    const d = Math.hypot(o.x - b.x, o.y - b.y);
    if (d < nd) { nd = d; nearest = o; }
  }
  const factors: Factor[] = [
    // Conservative habitable zone: 0.36–1.1 times Earth's stellar flux.
    { name: "Habitable zone", detail: "liquid water possible", pass: S >= 0.36 && S <= 1.1 },
    { name: "Temperature", detail: "273–373 K", pass: T >= 273 && T <= 373 },
    { name: "Mass", detail: "0.5–5 M⊕", pass: mE >= 0.5 && mE <= 5 },
    { name: "Water", detail: "in composition", pass: hasWater(b.surface) },
    { name: "Stable orbit", detail: "ecc. < 0.3", pass: !!el && el.bound && el.e < 0.3 },
    { name: "Flare risk", detail: "no close red dwarf", pass: !(nearest?.type === "reddwarf" && nd < 0.1 * AU) },
  ];
  const score = factors.filter(f => f.pass).length / factors.length;
  return { applicable: true, score, factors };
}
