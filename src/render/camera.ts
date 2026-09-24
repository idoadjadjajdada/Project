/**
 * World ↔ screen transform. World coordinates are metres (float64), with y pointing up so
 * prograde orbits turn counter-clockwise like a view from above the ecliptic. The transform
 * runs on the CPU in double precision; PixiJS only ever sees screen pixels, which keeps
 * true-scale positions (1e12 m) from losing precision in float32.
 */
export class Camera {
  cx = 0;
  cy = 0;
  /** Metres per CSS pixel. */
  mpp = 1e9;
  w = 1;
  h = 1;
  followId: number | null = null;

  static readonly MIN_MPP = 1e-3;
  static readonly MAX_MPP = 5e13;

  resize(w: number, h: number): void {
    this.w = w; this.h = h;
  }

  sx(x: number): number { return this.w / 2 + (x - this.cx) / this.mpp; }
  sy(y: number): number { return this.h / 2 - (y - this.cy) / this.mpp; }
  wx(sx: number): number { return this.cx + (sx - this.w / 2) * this.mpp; }
  wy(sy: number): number { return this.cy - (sy - this.h / 2) * this.mpp; }

  /** Zoom by `factor` (>1 zooms in) keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.wx(sx), wy = this.wy(sy);
    this.mpp = Math.min(Camera.MAX_MPP, Math.max(Camera.MIN_MPP, this.mpp / factor));
    if (this.followId === null) {
      this.cx = wx - (sx - this.w / 2) * this.mpp;
      this.cy = wy + (sy - this.h / 2) * this.mpp;
    }
  }

  panPx(dx: number, dy: number): void {
    this.followId = null;
    this.cx -= dx * this.mpp;
    this.cy += dy * this.mpp;
  }

  /** Frame a region of half-width `span` metres around (x, y). */
  frame(x: number, y: number, span: number): void {
    this.cx = x; this.cy = y;
    this.mpp = Math.min(Camera.MAX_MPP, Math.max(Camera.MIN_MPP, (span * 2) / Math.max(1, Math.min(this.w, this.h))));
  }
}
