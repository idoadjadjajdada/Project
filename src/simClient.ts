import type { PresetId, PresetView } from "./sim/presets";
import { STRIDE, type BodyMeta, type FromWorker, type StateMsg, type ToWorker } from "./sim/protocol";
import type { Body } from "./sim/types";
import type { SerializedWorld, SimEvent } from "./sim/world";

/**
 * Main-thread view of the simulation. The worker owns the truth; this keeps a mirror of
 * Body objects (so orbit and habitability helpers work unchanged) plus the latest debris.
 */
export class SimClient {
  bodies: Body[] = [];
  byId = new Map<number, Body>();
  t = 0;
  limited = false;
  undoDepth = 0;
  debrisCount = 0;
  debrisXY: Float64Array = new Float64Array(0);
  debrisColor: Uint32Array = new Uint32Array(0);
  laserHit: { x: number; y: number; id: number } | null = null;
  /** Current world epoch (see StateMsg.epoch). */
  epoch = 0;
  /** Bumped when the body list or names change. */
  topologyRev = 0;

  onView: (v: PresetView, epoch: number) => void = () => {};
  /** A preset or save replaced the world: drop anything keyed by body id. */
  onReset: () => void = () => {};
  onEvents: (e: SimEvent[]) => void = () => {};
  onNotice: (text: string) => void = () => {};
  onSaved: (slot: number, data: SerializedWorld) => void = () => {};

  private worker: Worker;
  private waiting = false;
  private meta = new Map<number, BodyMeta>();

  constructor() {
    this.worker = new Worker(new URL("./sim/worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.receive(e.data);
  }

  send(msg: ToWorker): void {
    this.worker.postMessage(msg);
  }

  /** Ask for the next step. Skipped while the previous one is still running (backpressure). */
  tick(realDt: number, rate: number, laser?: Extract<ToWorker, { type: "tick" }>["laser"]): void {
    if (this.waiting) return;
    this.waiting = true;
    this.send({ type: "tick", realDt, rate, laser });
  }

  preset(id: PresetId): void {
    this.send({ type: "preset", id });
  }

  private receive(m: FromWorker): void {
    switch (m.type) {
      case "state": this.applyState(m); break;
      case "view": this.onView(m.view, m.epoch); break;
      case "notice": this.onNotice(m.text); break;
      case "saved": this.onSaved(m.slot, m.data); break;
    }
  }

  private applyState(s: StateMsg): void {
    this.waiting = false;
    if (s.epoch !== this.epoch) {
      this.epoch = s.epoch;
      this.byId.clear();
      this.onReset();
    }
    this.t = s.t;
    this.limited = s.limited;
    this.undoDepth = s.undoDepth;
    this.laserHit = s.laserHit;
    if (s.meta) {
      this.meta = new Map(s.meta.map(m => [m.id, m]));
      this.topologyRev++;
    }
    const next: Body[] = [];
    const nextById = new Map<number, Body>();
    for (let i = 0; i < s.ids.length; i++) {
      const id = s.ids[i], o = i * STRIDE;
      const meta = this.meta.get(id);
      if (!meta) continue;
      let b = this.byId.get(id);
      if (!b) {
        b = { id, name: meta.name, type: meta.type, x: 0, y: 0, vx: 0, vy: 0, m: 0, r: 0, spin: meta.spin, greenhouse: meta.greenhouse, albedo: meta.albedo, surface: null, surfaceRev: 0, rings: meta.rings };
      }
      b.name = meta.name; b.type = meta.type; b.spin = meta.spin; b.rings = meta.rings;
      b.greenhouse = meta.greenhouse; b.albedo = meta.albedo;
      b.x = s.bodies[o]; b.y = s.bodies[o + 1]; b.vx = s.bodies[o + 2]; b.vy = s.bodies[o + 3];
      b.m = s.bodies[o + 4]; b.r = s.bodies[o + 5];
      if (meta.type === "blackhole" && b.surface) { b.surface = null; b.surfaceRev++; }
      next.push(b);
      nextById.set(id, b);
    }
    for (const surf of s.surfaces) {
      const b = nextById.get(surf.id);
      if (b) { b.surface = surf.data; b.surfaceRev++; }
    }
    this.bodies = next;
    this.byId = nextById;
    this.debrisCount = s.debrisCount;
    this.debrisXY = s.debrisXY;
    this.debrisColor = s.debrisColor;
    if (s.events.length) this.onEvents(s.events);
  }
}
