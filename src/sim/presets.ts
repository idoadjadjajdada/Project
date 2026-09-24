import { AU, DAY, EPOCH_MS, G, J2000_MS, M_EARTH, M_SUN, R_EARTH, R_SUN } from "./constants";
import { M } from "./materials";
import { rng } from "./rng";
import { generateSurface } from "./surface";
import type { Body, BodyType } from "./types";
import type { World } from "./world";

export type PresetId = "solar" | "earthmoon" | "jupiter" | "saturn" | "trappist" | "empty";

export interface PresetView {
  /** Body to centre the camera on. */
  focus: string;
  /** Half-width of the initial view, m. */
  span: number;
}

export const PRESETS: { id: PresetId; name: string; group: "Our Solar System" | "Other systems" | "Other"; note: string }[] = [
  { id: "solar", name: "Solar System", group: "Our Solar System", note: "real positions" },
  { id: "earthmoon", name: "Earth–Moon", group: "Our Solar System", note: "+ satellites" },
  { id: "jupiter", name: "Jupiter", group: "Our Solar System", note: "+ Galilean moons" },
  { id: "saturn", name: "Saturn", group: "Our Solar System", note: "+ rings, moons" },
  { id: "trappist", name: "TRAPPIST-1", group: "Other systems", note: "7 planets" },
  { id: "empty", name: "Empty space", group: "Other", note: "one star" },
];

/**
 * J2000 mean orbital elements (JPL, Standish 1992 approximations), planar:
 * a [AU], e, mean longitude L0 [deg], longitude of perihelion [deg], L rate [deg/century].
 * Inclinations are ignored because the sandbox is a 2D plane.
 */
const PLANETS: {
  name: string; type: BodyType; a: number; e: number; L0: number; peri: number; Ldot: number;
  m: number; r: number; spin: number; greenhouse?: number; albedo?: number; surface?: [number, number][]; rings?: [number, number];
}[] = [
  { name: "Mercury", type: "rocky", a: 0.38709927, e: 0.20563593, L0: 252.2503235, peri: 77.45779628, Ldot: 149472.67411175,
    m: 3.3011e23, r: 2.4397e6, spin: 58.646 * DAY, albedo: 0.088, surface: [[M.silicate, 6], [M.basalt, 3], [M.iron, 1]] },
  { name: "Venus", type: "rocky", a: 0.72333566, e: 0.00677672, L0: 181.9790995, peri: 131.60246718, Ldot: 58517.81538729,
    m: 4.8675e24, r: 6.0518e6, spin: -243.02 * DAY, greenhouse: 500, albedo: 0.76, surface: [[M.basalt, 7], [M.sulfur, 2], [M.silicate, 1]] },
  { name: "Earth", type: "ocean", a: 1.00000261, e: 0.01671123, L0: 100.46457166, peri: 102.93768193, Ldot: 35999.37244981,
    m: 5.9722e24, r: 6.371e6, spin: 0.99727 * DAY, greenhouse: 33, albedo: 0.306 },
  { name: "Mars", type: "rocky", a: 1.52371034, e: 0.0933941, L0: -4.55343205, peri: -23.94362959, Ldot: 19140.30268499,
    m: 6.4171e23, r: 3.3895e6, spin: 1.026 * DAY, greenhouse: 5, albedo: 0.25, surface: [[M.regolith, 8], [M.basalt, 2], [M.ice, 0.4]] },
  { name: "Jupiter", type: "gas", a: 5.202887, e: 0.04838624, L0: 34.39644051, peri: 14.72847983, Ldot: 3034.74612775,
    m: 1.8982e27, r: 6.9911e7, spin: 0.41354 * DAY, albedo: 0.503 },
  { name: "Saturn", type: "gas", a: 9.53667594, e: 0.05386179, L0: 49.95424423, peri: 92.59887831, Ldot: 1222.49362201,
    m: 5.6834e26, r: 5.8232e7, spin: 0.444 * DAY, albedo: 0.342, surface: [[M.helium, 6], [M.hydrogen, 4]], rings: [7.45e7, 1.368e8] },
  { name: "Uranus", type: "icegiant", a: 19.18916464, e: 0.04725744, L0: 313.23810451, peri: 170.9542763, Ldot: 428.48202785,
    m: 8.681e25, r: 2.5362e7, spin: -0.71833 * DAY, albedo: 0.3 },
  { name: "Neptune", type: "icegiant", a: 30.06992276, e: 0.00859048, L0: -55.12002969, peri: 44.96476227, Ldot: 218.45945325,
    m: 1.02413e26, r: 2.4622e7, spin: 0.6713 * DAY, albedo: 0.29 },
  { name: "Pluto", type: "dwarf", a: 39.48211675, e: 0.2488273, L0: 238.92903833, peri: 224.06891629, Ldot: 145.20780515,
    m: 1.303e22, r: 1.1883e6, spin: -6.387 * DAY, albedo: 0.52 },
];

/** Moons: semi-major axis [km], mass [kg], radius [km]. Phases are seeded, not ephemeris. */
const MOONS: Record<string, { name: string; type: BodyType; a: number; m: number; r: number; retro?: boolean; surface?: [number, number][] }[]> = {
  Earth: [{ name: "Moon", type: "moon", a: 384_400, m: 7.342e22, r: 1737.4 }],
  Jupiter: [
    { name: "Io", type: "moon", a: 421_700, m: 8.9319e22, r: 1821.6, surface: [[M.sulfur, 6], [M.basalt, 3], [M.silicate, 1]] },
    { name: "Europa", type: "moon", a: 671_034, m: 4.7998e22, r: 1560.8, surface: [[M.ice, 8], [M.tholin, 2]] },
    { name: "Ganymede", type: "moon", a: 1_070_412, m: 1.4819e23, r: 2634.1, surface: [[M.ice, 5], [M.silicate, 5]] },
    { name: "Callisto", type: "moon", a: 1_882_709, m: 1.0759e23, r: 2410.3, surface: [[M.carbon, 5], [M.ice, 4], [M.silicate, 1]] },
  ],
  Saturn: [
    { name: "Mimas", type: "moon", a: 185_539, m: 3.75e19, r: 198.2, surface: [[M.ice, 9], [M.silicate, 1]] },
    { name: "Enceladus", type: "moon", a: 237_948, m: 1.08e20, r: 252.1, surface: [[M.ice, 10]] },
    { name: "Tethys", type: "moon", a: 294_619, m: 6.174e20, r: 531.1, surface: [[M.ice, 9], [M.silicate, 1]] },
    { name: "Dione", type: "moon", a: 377_396, m: 1.095e21, r: 561.4, surface: [[M.ice, 7], [M.silicate, 3]] },
    { name: "Rhea", type: "moon", a: 527_108, m: 2.306e21, r: 763.8, surface: [[M.ice, 8], [M.silicate, 2]] },
    { name: "Titan", type: "moon", a: 1_221_870, m: 1.3452e23, r: 2574.7, surface: [[M.tholin, 5], [M.methane, 3], [M.ice, 2]] },
    { name: "Iapetus", type: "moon", a: 3_560_820, m: 1.806e21, r: 734.5, surface: [[M.ice, 5], [M.carbon, 5]] },
  ],
  Uranus: [
    { name: "Titania", type: "moon", a: 435_910, m: 3.4e21, r: 788.9, surface: [[M.ice, 6], [M.silicate, 4]] },
    { name: "Oberon", type: "moon", a: 583_520, m: 3.076e21, r: 761.4, surface: [[M.ice, 5], [M.carbon, 5]] },
  ],
  Neptune: [{ name: "Triton", type: "moon", a: 354_759, m: 2.139e22, r: 1353.4, retro: true, surface: [[M.ice, 6], [M.methane, 3], [M.tholin, 1]] }],
  Pluto: [{ name: "Charon", type: "moon", a: 19_591, m: 1.586e21, r: 606, surface: [[M.ice, 7], [M.tholin, 3]] }],
};

function solveKepler(Mean: number, e: number): number {
  let E = e < 0.8 ? Mean : Math.PI;
  for (let k = 0; k < 30; k++) {
    const dE = (E - e * Math.sin(E) - Mean) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

/** Position and velocity (relative to the parent) from planar Keplerian elements. */
export function stateFromElements(mu: number, a: number, e: number, meanAnomaly: number, peri: number, retro = false): [number, number, number, number] {
  const E = solveKepler(meanAnomaly, e);
  const n = Math.sqrt(mu / (a * a * a));
  const cosE = Math.cos(E), sinE = Math.sin(E), q = Math.sqrt(1 - e * e);
  const Edot = n / (1 - e * cosE);
  let x = a * (cosE - e), y = a * q * sinE;
  let vx = -a * sinE * Edot, vy = a * q * cosE * Edot;
  if (retro) { y = -y; vy = -vy; }
  const c = Math.cos(peri), s = Math.sin(peri);
  return [x * c - y * s, x * s + y * c, vx * c - vy * s, vx * s + vy * c];
}

function addMoon(w: World, parent: Body, mo: (typeof MOONS)[string][number], rand: () => number): Body | null {
  const mu = G * (parent.m + mo.m);
  const [x, y, vx, vy] = stateFromElements(mu, mo.a * 1000, 0, rand() * Math.PI * 2, 0, mo.retro);
  return w.add({
    type: mo.type, name: mo.name, m: mo.m, r: mo.r * 1000,
    x: parent.x + x, y: parent.y + y, vx: parent.vx + vx, vy: parent.vy + vy,
    surface: mo.surface ? generateSurface(mo.surface, false, Math.floor(rand() * 1e9)) : undefined,
    albedo: mo.type === "moon" ? 0.2 : undefined,
  });
}

function addSun(w: World): Body {
  return w.add({ type: "star", name: "Sun", x: 0, y: 0, m: M_SUN, r: R_SUN })!;
}

function addPlanets(w: World, only?: string[], rand = rng(7)): Body[] {
  const T = (EPOCH_MS - J2000_MS) / (36525 * DAY * 1000); // centuries since J2000
  const sun = w.bodies.find(b => b.name === "Sun")!;
  const out: Body[] = [];
  for (const p of PLANETS) {
    if (only && !only.includes(p.name)) continue;
    const deg = Math.PI / 180;
    const L = (p.L0 + p.Ldot * T) * deg, peri = p.peri * deg;
    const [x, y, vx, vy] = stateFromElements(G * (M_SUN + p.m), p.a * AU, p.e, L - peri, peri);
    const b = w.add({
      type: p.type, name: p.name, m: p.m, r: p.r, spin: p.spin,
      x: sun.x + x, y: sun.y + y, vx: sun.vx + vx, vy: sun.vy + vy,
      greenhouse: p.greenhouse, albedo: p.albedo, rings: p.rings,
      surface: p.surface ? generateSurface(p.surface, p.type === "gas" || p.type === "icegiant", Math.floor(rand() * 1e9)) : undefined,
    });
    if (b) out.push(b);
  }
  return out;
}

/** Correct the Sun's velocity so the system's total momentum is zero and nothing drifts off-screen. */
function zeroMomentum(w: World): void {
  const sun = w.bodies.reduce<Body | null>((a, b) => (!a || b.m > a.m ? b : a), null);
  if (!sun) return;
  let px = 0, py = 0;
  for (const b of w.bodies) if (b !== sun && b.type !== "spacecraft") { px += b.m * b.vx; py += b.m * b.vy; }
  sun.vx = -px / sun.m; sun.vy = -py / sun.m;
}

export function loadPreset(w: World, id: PresetId): PresetView {
  w.clear();
  const rand = rng(42);
  switch (id) {
    case "solar": {
      addSun(w);
      const planets = addPlanets(w, undefined, rand);
      zeroMomentum(w);
      for (const p of planets) for (const mo of MOONS[p.name] ?? []) {
        // Only the larger Saturnian moons here; the full set is in the Saturn preset.
        if (p.name === "Saturn" && !["Titan", "Rhea", "Iapetus"].includes(mo.name)) continue;
        addMoon(w, p, mo, rand);
      }
      const sun = w.bodies[0];
      // Main belt: Ceres, Vesta, Pallas, Hygiea, plus smaller asteroids between 2.2 and 3.3 AU.
      const named: [string, BodyType, number, number, number, number][] = [
        ["Ceres", "dwarf", 9.393e20, 4.73e5, 2.7675, 0.0758],
        ["Vesta", "asteroid", 2.59e20, 2.63e5, 2.3615, 0.0887],
        ["Pallas", "asteroid", 2.04e20, 2.56e5, 2.7724, 0.2313],
        ["Hygiea", "asteroid", 8.32e19, 2.17e5, 3.1421, 0.1125],
      ];
      for (const [name, type, m, r, a, e] of named) {
        const [x, y, vx, vy] = stateFromElements(G * M_SUN, a * AU, e, rand() * Math.PI * 2, rand() * Math.PI * 2);
        w.add({ type, name, m, r, x: sun.x + x, y: sun.y + y, vx: sun.vx + vx, vy: sun.vy + vy });
      }
      for (let k = 0; k < 40; k++) {
        const a = (2.2 + rand() * 1.1) * AU, e = rand() * 0.2;
        const m = Math.pow(10, 17 + rand() * 2.5), r = Math.cbrt((3 * m) / (4 * Math.PI * 2500));
        const [x, y, vx, vy] = stateFromElements(G * M_SUN, a, e, rand() * Math.PI * 2, rand() * Math.PI * 2);
        w.add({ type: "asteroid", name: `Asteroid ${1000 + k * 37}`, m, r, x: sun.x + x, y: sun.y + y, vx: sun.vx + vx, vy: sun.vy + vy });
      }
      return { focus: "Sun", span: 2.2 * AU };
    }
    case "earthmoon": {
      addSun(w);
      const [earth] = addPlanets(w, ["Earth"], rand);
      zeroMomentum(w);
      addMoon(w, earth, MOONS.Earth[0], rand);
      const sats: [string, number][] = [["ISS", 6_791e3], ["Hubble", 6_918e3], ["GPS IIF-12", 26_560e3], ["GOES-18", 42_164e3]];
      for (const [name, a] of sats) {
        const [x, y, vx, vy] = stateFromElements(G * earth.m, a, 0.0005, rand() * Math.PI * 2, 0);
        w.add({ type: "spacecraft", name, m: name === "ISS" ? 4.2e5 : 2e3, r: 50, x: earth.x + x, y: earth.y + y, vx: earth.vx + vx, vy: earth.vy + vy });
      }
      return { focus: "Earth", span: 5e8 };
    }
    case "jupiter": {
      addSun(w);
      const [jup] = addPlanets(w, ["Jupiter"], rand);
      zeroMomentum(w);
      for (const mo of MOONS.Jupiter) addMoon(w, jup, mo, rand);
      return { focus: "Jupiter", span: 2.4e9 };
    }
    case "saturn": {
      addSun(w);
      const [sat] = addPlanets(w, ["Saturn"], rand);
      zeroMomentum(w);
      for (const mo of MOONS.Saturn) addMoon(w, sat, mo, rand);
      // A few hundred ring particles bound to Saturn stand in for the billions in the real rings.
      for (let k = 0; k < 400; k++) {
        const r = sat.rings![0] + rand() * (sat.rings![1] - sat.rings![0]);
        const [x, y, vx, vy] = stateFromElements(G * sat.m, r, 0, rand() * Math.PI * 2, 0);
        const col = rand() > 0.3 ? 0xd8cfb8 : 0xa89c86;
        w.addDebris(sat.x + x, sat.y + y, sat.vx + vx, sat.vy + vy, col, sat.id);
      }
      return { focus: "Saturn", span: 1.6e9 };
    }
    case "trappist": {
      // TRAPPIST-1: Agol et al. 2021 masses, radii and semi-major axes.
      const star = w.add({ type: "reddwarf", name: "TRAPPIST-1", x: 0, y: 0, m: 0.0898 * M_SUN, r: 0.1192 * R_SUN })!;
      const ps: [string, BodyType, number, number, number][] = [
        ["TRAPPIST-1b", "rocky", 1.374, 1.116, 0.01154], ["TRAPPIST-1c", "rocky", 1.308, 1.097, 0.0158],
        ["TRAPPIST-1d", "ocean", 0.388, 0.788, 0.02227], ["TRAPPIST-1e", "ocean", 0.692, 0.92, 0.02925],
        ["TRAPPIST-1f", "ice", 1.039, 1.045, 0.03849], ["TRAPPIST-1g", "ice", 1.321, 1.129, 0.04683],
        ["TRAPPIST-1h", "ice", 0.326, 0.755, 0.06189],
      ];
      for (const [name, type, m, r, a] of ps) {
        const [x, y, vx, vy] = stateFromElements(G * (star.m + m * M_EARTH), a * AU, 0.005, rand() * Math.PI * 2, rand() * Math.PI * 2);
        w.add({ type, name, m: m * M_EARTH, r: r * R_EARTH, x, y, vx, vy, spin: 0 });
      }
      zeroMomentum(w);
      return { focus: "TRAPPIST-1", span: 0.08 * AU };
    }
    case "empty": {
      addSun(w);
      return { focus: "Sun", span: 2 * AU };
    }
  }
}
