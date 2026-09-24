import { C, G, M_EARTH, M_SUN, R_EARTH, R_SUN } from "./constants";
import { M } from "./materials";
import type { BodyClass, BodyType } from "./types";

export interface TypeInfo {
  label: string;
  cls: BodyClass;
  /** Picker tab, or null for types that only appear in presets. */
  tab: "planets" | "small" | "stars" | "remnants" | null;
  /** Reference mass (kg) and radius (m) for that mass. */
  m0: number;
  r0: number;
  /** How radius scales with mass: r = r0 * (m/m0)^exp. */
  rExp: number;
  /** Luminosity in solar units at m0 (stars), scaling as (m/m0)^lumExp. */
  lum0: number;
  lumExp: number;
  /** Starting surface: weighted materials, painted as blobs. `bands` paints latitude stripes instead. */
  surface: [number, number][] | null;
  bands?: boolean;
  /** Takes impactor material as separate terrain patches. Gas giants and stars absorb instead. */
  terrain: boolean;
  color: number;
  albedo: number;
  greenhouse: number;
  spin: number;
  /** Unit label for the picker's mass field. */
  unit: "M⊕" | "M☉";
}

const H = 3600, D = 86400;

export const TYPES: Record<BodyType, TypeInfo> = {
  rocky: { label: "Rocky planet", cls: "planet", tab: "planets", m0: M_EARTH, r0: R_EARTH, rExp: 0.27, lum0: 0, lumExp: 0,
    surface: [[M.silicate, 6], [M.basalt, 3], [M.iron, 1]], terrain: true, color: 0x9a8f80, albedo: 0.2, greenhouse: 0, spin: 26 * H, unit: "M⊕" },
  ocean: { label: "Ocean world", cls: "planet", tab: "planets", m0: M_EARTH, r0: R_EARTH, rExp: 0.27, lum0: 0, lumExp: 0,
    surface: [[M.water, 7], [M.silicate, 2], [M.vegetation, 1.5], [M.ice, 0.4]], terrain: true, color: 0x3d8fe0, albedo: 0.3, greenhouse: 33, spin: 24 * H, unit: "M⊕" },
  ice: { label: "Ice world", cls: "planet", tab: "planets", m0: 0.5 * M_EARTH, r0: 0.9 * R_EARTH, rExp: 0.3, lum0: 0, lumExp: 0,
    surface: [[M.ice, 7], [M.methane, 1.5], [M.silicate, 1.5]], terrain: true, color: 0xcfe6f5, albedo: 0.6, greenhouse: 0, spin: 30 * H, unit: "M⊕" },
  gas: { label: "Gas giant", cls: "planet", tab: "planets", m0: 317.8 * M_EARTH, r0: 6.9911e7, rExp: 0.05, lum0: 0, lumExp: 0,
    surface: [[M.hydrogen, 8], [M.helium, 2]], bands: true, terrain: false, color: 0xd9a86f, albedo: 0.5, greenhouse: 0, spin: 9.9 * H, unit: "M⊕" },
  icegiant: { label: "Ice giant", cls: "planet", tab: "planets", m0: 14.5 * M_EARTH, r0: 2.5362e7, rExp: 0.1, lum0: 0, lumExp: 0,
    surface: [[M.methane, 7], [M.hydrogen, 2], [M.helium, 1]], bands: true, terrain: false, color: 0x7fc6d9, albedo: 0.3, greenhouse: 0, spin: 17 * H, unit: "M⊕" },

  moon: { label: "Moon", cls: "small", tab: "small", m0: 7.342e22, r0: 1.7374e6, rExp: 0.3, lum0: 0, lumExp: 0,
    surface: [[M.anorthosite, 8], [M.basalt, 2]], terrain: true, color: 0xb7b4ac, albedo: 0.12, greenhouse: 0, spin: 27.3 * D, unit: "M⊕" },
  asteroid: { label: "Asteroid", cls: "small", tab: "small", m0: 9.4e20, r0: 4.7e5, rExp: 0.33, lum0: 0, lumExp: 0,
    surface: [[M.silicate, 5], [M.carbon, 3], [M.iron, 2]], terrain: true, color: 0x8a7d6f, albedo: 0.09, greenhouse: 0, spin: 9 * H, unit: "M⊕" },
  comet: { label: "Comet", cls: "small", tab: "small", m0: 1e13, r0: 5.5e3, rExp: 0.33, lum0: 0, lumExp: 0,
    surface: [[M.ice, 6], [M.carbon, 3], [M.silicate, 1]], terrain: true, color: 0xc9f0ff, albedo: 0.04, greenhouse: 0, spin: 2.2 * D, unit: "M⊕" },
  dwarf: { label: "Dwarf planet", cls: "small", tab: "small", m0: 1.303e22, r0: 1.1883e6, rExp: 0.3, lum0: 0, lumExp: 0,
    surface: [[M.methane, 4], [M.ice, 3], [M.tholin, 3]], terrain: true, color: 0xc7a88a, albedo: 0.5, greenhouse: 0, spin: 6.4 * D, unit: "M⊕" },

  reddwarf: { label: "Red dwarf", cls: "star", tab: "stars", m0: 0.3 * M_SUN, r0: 0.3 * R_SUN, rExp: 0.8, lum0: 0.012, lumExp: 3.5,
    surface: [[M.plasma, 1]], terrain: false, color: 0xff7a4a, albedo: 0, greenhouse: 0, spin: 30 * D, unit: "M☉" },
  star: { label: "Yellow star", cls: "star", tab: "stars", m0: M_SUN, r0: R_SUN, rExp: 0.8, lum0: 1, lumExp: 3.5,
    surface: [[M.plasma, 1]], terrain: false, color: 0xffc35a, albedo: 0, greenhouse: 0, spin: 25 * D, unit: "M☉" },
  bluegiant: { label: "Blue giant", cls: "star", tab: "stars", m0: 15 * M_SUN, r0: 7 * R_SUN, rExp: 0.8, lum0: 20000, lumExp: 3.5,
    surface: [[M.plasma, 1]], terrain: false, color: 0x9cc8ff, albedo: 0, greenhouse: 0, spin: 2 * D, unit: "M☉" },
  redgiant: { label: "Red giant", cls: "star", tab: "stars", m0: 1.2 * M_SUN, r0: 60 * R_SUN, rExp: 0.5, lum0: 800, lumExp: 1,
    surface: [[M.plasma, 1]], terrain: false, color: 0xff6a3a, albedo: 0, greenhouse: 0, spin: 400 * D, unit: "M☉" },

  whitedwarf: { label: "White dwarf", cls: "remnant", tab: "remnants", m0: 0.6 * M_SUN, r0: 0.0126 * R_SUN, rExp: -1 / 3, lum0: 0.001, lumExp: 1,
    surface: null, terrain: false, color: 0xeef4ff, albedo: 0, greenhouse: 0, spin: H, unit: "M☉" },
  neutron: { label: "Neutron star", cls: "remnant", tab: "remnants", m0: 1.4 * M_SUN, r0: 1.2e4, rExp: 0, lum0: 0, lumExp: 0,
    surface: null, terrain: false, color: 0x9fe6ff, albedo: 0, greenhouse: 0, spin: 1, unit: "M☉" },
  pulsar: { label: "Pulsar", cls: "remnant", tab: "remnants", m0: 1.4 * M_SUN, r0: 1.2e4, rExp: 0, lum0: 0, lumExp: 0,
    surface: null, terrain: false, color: 0xbff1ff, albedo: 0, greenhouse: 0, spin: 0.033, unit: "M☉" },
  blackhole: { label: "Black hole", cls: "remnant", tab: "remnants", m0: 10 * M_SUN, r0: 0, rExp: 1, lum0: 0, lumExp: 0,
    surface: null, terrain: false, color: 0x000000, albedo: 0, greenhouse: 0, spin: 1, unit: "M☉" },

  spacecraft: { label: "Spacecraft", cls: "craft", tab: null, m0: 4.2e5, r0: 50, rExp: 0, lum0: 0, lumExp: 0,
    surface: null, terrain: false, color: 0xe2e8f0, albedo: 0.5, greenhouse: 0, spin: 90 * 60, unit: "M⊕" },
};

export const TAB_ORDER = ["planets", "small", "stars", "remnants"] as const;

export function typesInTab(tab: (typeof TAB_ORDER)[number]): BodyType[] {
  return (Object.keys(TYPES) as BodyType[]).filter(t => TYPES[t].tab === tab);
}

export function schwarzschildRadius(m: number): number {
  return (2 * G * m) / (C * C);
}

/** Radius for a body of this type at mass m, following the type's mass-radius relation. */
export function radiusFor(type: BodyType, m: number): number {
  if (type === "blackhole") return schwarzschildRadius(m);
  const t = TYPES[type];
  return t.r0 * Math.pow(m / t.m0, t.rExp);
}

/** Luminosity in solar units. */
export function luminosityFor(type: BodyType, m: number): number {
  const t = TYPES[type];
  if (t.lum0 === 0) return 0;
  return t.lum0 * Math.pow(m / t.m0, t.lumExp);
}

/** Effective surface temperature of a star from luminosity and radius. */
export function starTeff(type: BodyType, m: number, r: number): number {
  if (type === "neutron" || type === "pulsar") return 600_000;
  const L = luminosityFor(type, m);
  if (L <= 0 || r <= 0) return 0;
  return 5772 * Math.pow(L / Math.pow(r / R_SUN, 2), 0.25);
}

export function isLuminous(type: BodyType): boolean {
  return TYPES[type].lum0 > 0;
}

export function hasGravityOnly(type: BodyType): boolean {
  // Spacecraft feel gravity but exert none (PRD: negligible mass).
  return type === "spacecraft";
}
