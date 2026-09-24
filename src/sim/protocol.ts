import type { PresetId, PresetView } from "./presets";
import type { BodyType } from "./types";
import type { SerializedWorld, SimEvent } from "./world";

/** Fields per body in the packed state array. */
export const STRIDE = 6; // x, y, vx, vy, m, r

export interface BodyMeta {
  id: number;
  name: string;
  type: BodyType;
  spin: number;
  albedo: number;
  greenhouse: number;
  rings?: [number, number];
}

/**
 * A world point anchored to a body: the worker runs ahead of what's on screen, so absolute
 * coordinates would land wherever a fast-moving planet *was*. `ref` 0 means absolute.
 */
export interface Pt { ref: number; dx: number; dy: number }

export type ToWorker =
  | { type: "tick"; realDt: number; rate: number; laser?: { from: Pt; to: Pt; tol: number } }
  | { type: "preset"; id: PresetId }
  | { type: "place"; body: BodyType; m: number; at: Pt; launch?: { dx: number; dy: number } }
  | { type: "grab"; id: number; at: Pt }
  | { type: "grabMove"; at: Pt }
  | { type: "grabEnd"; vx: number; vy: number }
  | { type: "field"; field: { at: Pt; radius: number; accel: number } | null }
  | { type: "erase"; at: Pt; radius: number }
  | { type: "laserEnd" }
  | { type: "collapse"; id: number }
  | { type: "explode"; id: number }
  | { type: "orbitLock"; id: number }
  | { type: "delete"; id: number }
  | { type: "setMass"; id: number; m: number }
  | { type: "rename"; id: number; name: string }
  | { type: "snapshot" }
  | { type: "undo" }
  | { type: "save"; slot: number }
  | { type: "load"; data: SerializedWorld };

export interface StateMsg {
  type: "state";
  /** Changes whenever a preset or save is loaded; ids from an older epoch mean nothing. */
  epoch: number;
  t: number;
  limited: boolean;
  ids: Int32Array;
  bodies: Float64Array;
  /** Present when bodies were added/removed/renamed since the last state. */
  meta?: BodyMeta[];
  /** Surface maps that changed, keyed by body id. */
  surfaces: { id: number; data: Uint8Array }[];
  debrisCount: number;
  debrisXY: Float64Array;
  debrisColor: Uint32Array;
  events: SimEvent[];
  laserHit: { x: number; y: number; id: number } | null;
  undoDepth: number;
}

export type FromWorker =
  | StateMsg
  | { type: "view"; view: PresetView; epoch: number }
  | { type: "saved"; slot: number; data: SerializedWorld }
  | { type: "notice"; text: string };
