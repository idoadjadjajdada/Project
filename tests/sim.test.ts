import { describe, expect, it } from "vitest";
import { AU, DAY, G, M_EARTH, M_SUN, YEAR } from "../src/sim/constants";
import { habitability, temperature } from "../src/sim/habitability";
import { elements, parentOf } from "../src/sim/orbit";
import { loadPreset } from "../src/sim/presets";
import { composition } from "../src/sim/surface";
import { World } from "../src/sim/world";

function sunEarth() {
  const w = new World();
  const sun = w.add({ type: "star", name: "Sun", x: 0, y: 0, m: M_SUN })!;
  const v = Math.sqrt((G * (M_SUN + M_EARTH)) / AU);
  const earth = w.add({ type: "ocean", name: "Earth", x: AU, y: 0, vx: 0, vy: v, m: M_EARTH, greenhouse: 33, albedo: 0.306 })!;
  return { w, sun, earth };
}

function runFor(w: World, total: number) {
  let left = total;
  while (left > 0) left -= w.step(Math.min(left, 5 * DAY), 1e9);
}

describe("gravity", () => {
  it("keeps a circular orbit closed after one period", () => {
    const { w, sun, earth } = sunEarth();
    const period = 2 * Math.PI * Math.sqrt(AU ** 3 / (G * (M_SUN + M_EARTH)));
    runFor(w, period);
    const d = Math.hypot(earth.x - sun.x, earth.y - sun.y);
    expect(Math.abs(d - AU) / AU).toBeLessThan(1e-3);
    // Back near the start point.
    expect(Math.hypot(earth.x - sun.x - AU, earth.y - sun.y) / AU).toBeLessThan(0.01);
  });

  it("reports sensible orbital elements", () => {
    const { w, sun, earth } = sunEarth();
    expect(parentOf(w.bodies, earth)).toBe(sun);
    const el = elements(earth, sun);
    expect(el.e).toBeLessThan(1e-6);
    expect(el.period / DAY).toBeCloseTo(365.25, 0);
  });
});

describe("collisions", () => {
  it("merges conserve mass and momentum", () => {
    const w = new World();
    const a = w.add({ type: "rocky", x: 0, y: 0, vx: 0, vy: 0, m: M_EARTH })!;
    w.add({ type: "moon", x: a.r * 3, y: 0, vx: -2000, vy: 0 })!;
    const m0 = w.totalMass();
    const px0 = w.bodies.reduce((s, b) => s + b.m * b.vx, 0);
    runFor(w, 3 * 3600);
    expect(w.bodies.length).toBeGreaterThanOrEqual(1);
    expect(w.totalMass()).toBeCloseTo(m0, -18);
    const px = w.bodies.reduce((s, b) => s + b.m * b.vx, 0);
    expect(Math.abs(px - px0) / (m0 * 2000)).toBeLessThan(1e-6);
  });

  it("paints the impactor's material as a separate patch", () => {
    const w = new World();
    const target = w.add({ type: "ocean", x: 0, y: 0, m: M_EARTH })!;
    const iceBefore = composition(target.surface!).find(c => c.mat === 11)?.frac ?? 0; // methane ice
    w.add({ type: "ice", x: target.r * 1.2, y: 0, vx: -500, m: 0.01 * M_EARTH });
    runFor(w, 3600);
    expect(w.bodies).toHaveLength(1);
    const after = composition(w.bodies[0].surface!).find(c => c.mat === 11)?.frac ?? 0;
    expect(after).toBeGreaterThan(iceBefore);
    // Still mostly ocean: a patch, not a full recolor.
    expect(composition(w.bodies[0].surface!)[0].mat).toBe(4);
  });

  it("breaks big impacts into fragments, conserving mass and momentum", () => {
    const w = new World();
    const a = w.add({ type: "rocky", x: 0, y: 0, m: M_EARTH })!;
    w.add({ type: "rocky", x: a.r * 2.5, y: 0, vx: -20_000, m: 0.3 * M_EARTH })!;
    const m0 = w.totalMass();
    const p0 = w.bodies.reduce((s, b) => s + b.m * b.vx, 0);
    runFor(w, 600);
    expect(w.frags.n).toBeGreaterThan(50);
    expect(w.totalMass() / m0).toBeCloseTo(1, 9);
    const f = w.frags.s;
    let p = w.bodies.reduce((s, b) => s + b.m * b.vx, 0);
    for (let i = 0; i < f.n; i++) p += f.m[i] * f.vx[i];
    expect(Math.abs(p - p0) / (m0 * 20_000)).toBeLessThan(0.01);
  });

  it("reforms the planet from fragments after a giant impact", () => {
    const w = new World();
    const e = w.add({ type: "rocky", name: "Earth", x: 0, y: 0, m: M_EARTH })!;
    const rT = e.r * 0.53, vEsc = Math.sqrt((2 * G * 1.11 * M_EARTH) / (e.r + rT));
    w.add({ type: "rocky", name: "Theia", x: -3 * e.r, y: 0.7 * (e.r + rT), vx: 0.7 * vEsc, m: 0.11 * M_EARTH, r: rT });
    const m0 = w.totalMass();
    for (let t = 0; t < 5 * DAY; ) t += w.step(3600, 1e9);
    const main = w.bodies.reduce((a, b) => (b.m > a.m ? b : a));
    expect(main.name).toBe("Earth");
    expect(main.m / M_EARTH).toBeGreaterThan(1.0);
    expect(main.heat).toBeGreaterThan(1000); // still a magma ocean
    expect(w.totalMass() / m0).toBeGreaterThan(0.97); // only escaping dust leaves
  });
});

describe("giant impact in a full system", () => {
  it("conserves mass through fragmenting and settling at high time warp", () => {
    const w = new World();
    loadPreset(w, "earthmoon");
    const e = w.bodies.find(b => b.name === "Earth")!;
    const rT = e.r * 0.53, vEsc = Math.sqrt((2 * G * 1.11 * M_EARTH) / (e.r + rT));
    w.add({ type: "rocky", name: "Theia", x: e.x - 3 * e.r, y: e.y + 0.7 * (e.r + rT), vx: e.vx + 0.7 * vEsc, vy: e.vy, m: 0.11 * M_EARTH, r: rT });
    const sunM = w.bodies.find(b => b.name === "Sun")!.m;
    const m0 = w.totalMass();
    // One day per frame, like the game at 1 day/s, for three weeks.
    for (let f = 0; f < 21; f++) w.step(DAY, 1e9);
    expect(w.frags.n).toBe(0); // settled
    const earth = w.bodies.find(b => b.name === "Earth");
    expect(earth).toBeDefined();
    expect(earth!.m / M_EARTH).toBeGreaterThan(1.0);
    expect(w.bodies.find(b => b.name === "Sun")!.m).toBe(sunM); // the Sun doesn't swallow Earth's debris
    expect(w.totalMass() / m0).toBeGreaterThan(0.98);
  });
});

describe("tools", () => {
  it("collapse keeps the mass and makes a black hole", () => {
    const { w, earth } = sunEarth();
    w.collapse(earth.id);
    expect(earth.type).toBe("blackhole");
    expect(earth.m).toBe(M_EARTH);
    expect(earth.r * 1000).toBeCloseTo(8.87, 1); // ~9 mm
  });

  it("orbit lock produces a circular orbit", () => {
    const { w, sun, earth } = sunEarth();
    earth.vy *= 0.7;
    w.orbitLock(earth.id);
    expect(elements(earth, sun).e).toBeLessThan(1e-6);
  });

  it("explode throws fragments, some of which fall back", () => {
    const { w, earth } = sunEarth();
    w.explode(earth.id);
    expect(w.get(earth.id)).toBeUndefined();
    expect(w.frags.n).toBeGreaterThan(50);
  });

  it("laser cuts off massive fragments", () => {
    const { w, earth } = sunEarth();
    const m0 = earth.m;
    for (let k = 0; k < 10; k++) w.laser(earth.x - 1e9, earth.y, 1, 0, 1 / 60, 1e6);
    expect(earth.m).toBeLessThan(m0);
    expect(w.frags.n).toBeGreaterThan(0);
    expect((earth.m + w.frags.totalMass()) / m0).toBeCloseTo(1, 9);
  });

  it("undo restores the previous state", () => {
    const { w, earth } = sunEarth();
    w.pushUndo();
    w.explode(earth.id);
    expect(w.get(earth.id)).toBeUndefined();
    w.undo();
    expect(w.bodies.find(b => b.name === "Earth")).toBeDefined();
  });

  it("serializes and loads", () => {
    const { w } = sunEarth();
    const s = JSON.parse(JSON.stringify(w.serialize()));
    const w2 = new World();
    w2.load(s);
    expect(w2.bodies.map(b => b.name)).toEqual(["Sun", "Earth"]);
    expect(w2.bodies[1].surface).toEqual(w.bodies[1].surface);
  });
});

describe("habitability", () => {
  it("rates Earth at 1 AU as habitable", () => {
    const { w, earth } = sunEarth();
    expect(temperature(w.bodies, earth)).toBeGreaterThan(280);
    expect(temperature(w.bodies, earth)).toBeLessThan(295);
    const h = habitability(w.bodies, earth);
    expect(h.score).toBe(1);
  });
});

describe("presets", () => {
  it("puts Earth about 1 AU from the Sun on the epoch date", () => {
    const w = new World();
    loadPreset(w, "solar");
    const sun = w.bodies.find(b => b.name === "Sun")!, earth = w.bodies.find(b => b.name === "Earth")!;
    const d = Math.hypot(earth.x - sun.x, earth.y - sun.y) / AU;
    expect(d).toBeGreaterThan(0.98);
    expect(d).toBeLessThan(1.02);
    const moon = w.bodies.find(b => b.name === "Moon")!;
    expect(parentOf(w.bodies, moon)?.name).toBe("Earth");
  });

  it("keeps the Moon bound to Earth for a year", () => {
    const w = new World();
    loadPreset(w, "earthmoon");
    runFor(w, YEAR);
    const earth = w.bodies.find(b => b.name === "Earth")!, moon = w.bodies.find(b => b.name === "Moon")!;
    const el = elements(moon, earth);
    expect(el.bound).toBe(true);
    expect(el.a / 1000).toBeGreaterThan(370_000);
    expect(el.a / 1000).toBeLessThan(400_000);
  });
});

describe("debris", () => {
  it("keeps Saturn's ring particles for a year at high warp", () => {
    const w = new World();
    loadPreset(w, "saturn");
    const n0 = w.debris.count;
    for (let f = 0; f < 60; f++) w.step(YEAR / 60, 1e9);
    expect(w.debris.count).toBe(n0);
  });

  it("laser fragments survive the frame they were made in", () => {
    const w = new World();
    loadPreset(w, "solar");
    const j = w.bodies.find(b => b.name === "Mars")!;
    for (let f = 0; f < 30; f++) { w.laser(j.x - 1e9, j.y, 1, 0, 1 / 60, 1e6); w.step(DAY / 600, 1e9); }
    expect(w.frags.n + w.debris.count).toBeGreaterThan(10);
  });
});

describe("kepler propagation", () => {
  it("matches a full circular orbit", async () => {
    const { propagateKepler } = await import("../src/sim/orbit");
    const mu = G * M_EARTH, r = 4e8, v = Math.sqrt(mu / r);
    const T = 2 * Math.PI * Math.sqrt(r ** 3 / mu);
    const s = propagateKepler(mu, r, 0, 0, v, T * 3.25)!;
    expect(s[0] / r).toBeCloseTo(0, 6);
    expect(s[1] / r).toBeCloseTo(1, 6);
  });
});
