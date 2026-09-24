export type BodyType =
  | "rocky" | "ocean" | "ice" | "gas" | "icegiant"
  | "moon" | "asteroid" | "comet" | "dwarf"
  | "reddwarf" | "star" | "bluegiant" | "redgiant"
  | "whitedwarf" | "neutron" | "pulsar" | "blackhole"
  | "spacecraft";

export type BodyClass = "planet" | "small" | "star" | "remnant" | "craft";

export interface Body {
  id: number;
  name: string;
  type: BodyType;
  x: number; y: number;
  vx: number; vy: number;
  /** kg */
  m: number;
  /** m */
  r: number;
  /** Rotation period in seconds (negative = retrograde). Only affects drawing. */
  spin: number;
  /** Kelvin added on top of equilibrium temperature. */
  greenhouse: number;
  albedo: number;
  /** Material index per cell, SURF_W × SURF_H, or null for bodies without a surface. */
  surface: Uint8Array | null;
  /** Bumped whenever `surface` changes so the renderer rebuilds its texture. */
  surfaceRev: number;
  /** Planetary rings drawn around the body, in metres (Saturn preset). */
  rings?: [number, number];
}

export interface DebrisSet {
  count: number;
  x: Float64Array; y: Float64Array;
  vx: Float64Array; vy: Float64Array;
  color: Uint32Array;
  /** Id of the body a ring particle is bound to (0 = free debris). Bound particles only feel that body. */
  host: Uint32Array;
}

export const SURF_W = 64;
export const SURF_H = 32;
