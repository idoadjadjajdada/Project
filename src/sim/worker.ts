/// <reference lib="webworker" />
import { circularVelocity, strongestAttractor } from "./orbit";
import { loadPreset } from "./presets";
import { STRIDE, type BodyMeta, type FromWorker, type Pt, type StateMsg, type ToWorker } from "./protocol";
import { World } from "./world";

declare const self: DedicatedWorkerGlobalScope;

const world = new World();
let sentTopology = -1;
const sentSurfaceRev = new Map<number, number>();
let laserHit: { x: number; y: number; id: number } | null = null;
let epoch = 0;
let lastRenamed = 0;
/** Held attract field, re-anchored every step so it rides along with its reference body. */
let fieldAt: Pt | null = null;

function resolve(p: Pt): [number, number] {
  const b = p.ref ? world.get(p.ref) : undefined;
  return b ? [b.x + p.dx, b.y + p.dy] : [p.dx, p.dy];
}

function post(msg: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(msg, transfer);
}

function sendState() {
  const bs = world.bodies, n = bs.length;
  const ids = new Int32Array(n), data = new Float64Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    const b = bs[i], o = i * STRIDE;
    ids[i] = b.id;
    data[o] = b.x; data[o + 1] = b.y; data[o + 2] = b.vx; data[o + 3] = b.vy; data[o + 4] = b.m; data[o + 5] = b.r;
  }
  let meta: BodyMeta[] | undefined;
  if (world.topologyRev !== sentTopology || lastRenamed) {
    sentTopology = world.topologyRev;
    lastRenamed = 0;
    meta = bs.map(b => ({ id: b.id, name: b.name, type: b.type, spin: b.spin, albedo: b.albedo, greenhouse: b.greenhouse, rings: b.rings }));
    for (const id of [...sentSurfaceRev.keys()]) if (!bs.some(b => b.id === id)) sentSurfaceRev.delete(id);
  }
  const surfaces: StateMsg["surfaces"] = [];
  for (const b of bs) {
    if (!b.surface) continue;
    if (sentSurfaceRev.get(b.id) === b.surfaceRev) continue;
    sentSurfaceRev.set(b.id, b.surfaceRev);
    surfaces.push({ id: b.id, data: b.surface.slice() });
  }
  const d = world.debris, dc = d.count;
  const debrisXY = new Float64Array(dc * 2), debrisColor = d.color.slice(0, dc);
  const byId = new Map(bs.map(b => [b.id, b]));
  for (let i = 0; i < dc; i++) {
    const [x, y] = world.debrisPos(i, byId);
    debrisXY[i * 2] = x; debrisXY[i * 2 + 1] = y;
  }
  const msg: StateMsg = {
    type: "state", epoch, t: world.t, limited: world.limited, ids, bodies: data, meta, surfaces,
    debrisCount: dc, debrisXY, debrisColor, events: world.events.splice(0), laserHit, undoDepth: world.undoDepth,
  };
  post(msg, [ids.buffer, data.buffer, debrisXY.buffer, debrisColor.buffer, ...surfaces.map(s => s.data.buffer)]);
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "tick": {
      laserHit = null;
      if (m.laser) {
        const [x0, y0] = resolve(m.laser.from), [x1, y1] = resolve(m.laser.to);
        laserHit = world.laser(x0, y0, x1 - x0, y1 - y0, m.realDt, m.laser.tol);
      }
      if (fieldAt && world.field) [world.field.x, world.field.y] = resolve(fieldAt);
      world.step(m.rate * m.realDt);
      sendState();
      break;
    }
    case "preset": {
      const view = loadPreset(world, m.id);
      sentSurfaceRev.clear();
      epoch++;
      fieldAt = null;
      post({ type: "view", view, epoch });
      break;
    }
    case "place": {
      const [px, py] = resolve(m.at);
      const p = strongestAttractor(world.bodies, px, py);
      let vx = 0, vy = 0;
      if (p) {
        [vx, vy] = circularVelocity(p, px, py, 1, m.m);
        if (m.launch) {
          // Drag sets the velocity relative to the parent, scaled by the local circular speed.
          const vc = Math.hypot(vx - p.vx, vy - p.vy);
          vx = p.vx + m.launch.dx * vc;
          vy = p.vy + m.launch.dy * vc;
        }
      }
      const b = world.add({ type: m.body, m: m.m, x: px, y: py, vx, vy });
      if (!b) post({ type: "notice", text: "The sandbox is full (200 bodies). Erase something first." });
      break;
    }
    case "grab": { const [x, y] = resolve(m.at); world.grab = { id: m.id, x, y }; break; }
    case "grabMove": if (world.grab) [world.grab.x, world.grab.y] = resolve(m.at); break;
    case "grabEnd": {
      const g = world.grab;
      world.grab = null;
      const b = g && world.get(g.id);
      if (b) { b.vx += m.vx; b.vy += m.vy; }
      break;
    }
    case "field":
      fieldAt = m.field ? m.field.at : null;
      world.field = m.field ? { x: 0, y: 0, radius: m.field.radius, accel: m.field.accel } : null;
      if (world.field && fieldAt) [world.field.x, world.field.y] = resolve(fieldAt);
      break;
    case "erase": { const [x, y] = resolve(m.at); world.erase(x, y, m.radius); break; }
    case "laserEnd": world.laserEnd(); break;
    case "collapse":
      if (!world.collapse(m.id)) post({ type: "notice", text: "That's already a black hole." });
      break;
    case "explode":
      if (!world.explode(m.id)) post({ type: "notice", text: "Black holes can't be exploded." });
      break;
    case "orbitLock": world.orbitLock(m.id); break;
    case "delete": world.remove(m.id); break;
    case "setMass": { const b = world.get(m.id); if (b) world.setMass(b, m.m); break; }
    case "rename": { const b = world.get(m.id); if (b) { b.name = m.name; lastRenamed = 1; } break; }
    case "snapshot": world.pushUndo(); break;
    case "undo":
      if (!world.undo()) post({ type: "notice", text: "Nothing to undo." });
      sentSurfaceRev.clear();
      break;
    case "save": post({ type: "saved", slot: m.slot, data: world.serialize() }); break;
    case "load": world.load(m.data); sentSurfaceRev.clear(); epoch++; fieldAt = null; break;
  }
};
