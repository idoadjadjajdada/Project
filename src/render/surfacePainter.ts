import { MATERIALS } from "../sim/materials";
import { SURF_H, SURF_W } from "../sim/types";

interface Lut {
  size: number;
  /** Per pixel: -1 outside the disk, else latitude row. */
  row: Int16Array;
  /** Per pixel: longitude offset in radians from the sub-viewer meridian. */
  lon: Float32Array;
  nx: Float32Array; ny: Float32Array; nz: Float32Array;
}

const luts = new Map<number, Lut>();

function lut(size: number): Lut {
  let l = luts.get(size);
  if (l) return l;
  const n = size * size;
  l = { size, row: new Int16Array(n), lon: new Float32Array(n), nx: new Float32Array(n), ny: new Float32Array(n), nz: new Float32Array(n) };
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = py * size + px;
      const x = ((px + 0.5) / size) * 2 - 1, y = ((py + 0.5) / size) * 2 - 1;
      const r2 = x * x + y * y;
      if (r2 > 1) { l.row[i] = -1; continue; }
      const z = Math.sqrt(1 - r2);
      const lat = Math.asin(-y); // screen y down, north up
      l.row[i] = Math.min(SURF_H - 1, Math.max(0, Math.floor(((lat / Math.PI) + 0.5) * SURF_H)));
      l.lon[i] = Math.atan2(x, z);
      l.nx[i] = x; l.ny[i] = -y; l.nz[i] = z;
    }
  }
  luts.set(size, l);
  return l;
}

const palette = MATERIALS.map(m => [(m.color >> 16) & 255, (m.color >> 8) & 255, m.color & 255]);

/**
 * Draws a body's surface map as a lit globe (orthographic view of the hemisphere facing
 * the camera). `rotation` spins the map; the light vector points toward the nearest star
 * (screen space, y up), or is null for self-lit/no-star scenes.
 */
export function paintGlobe(canvas: HTMLCanvasElement, surface: Uint8Array, rotation: number, light: [number, number] | null): void {
  const size = canvas.width;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const l = lut(size);
  let lx = 0, ly = 0, lz = 1;
  if (light) {
    // Keep a little light toward the viewer so the night side isn't pure black.
    lx = light[0]; ly = light[1]; lz = 0.25;
    const n = Math.hypot(lx, ly, lz); lx /= n; ly /= n; lz /= n;
  }
  const twoPi = Math.PI * 2;
  for (let i = 0; i < size * size; i++) {
    const row = l.row[i];
    const o = i * 4;
    if (row < 0) { img.data[o + 3] = 0; continue; }
    let lon = (l.lon[i] + rotation) / twoPi;
    lon -= Math.floor(lon);
    const mat = surface[row * SURF_W + Math.floor(lon * SURF_W)];
    const c = palette[mat] ?? palette[0];
    const lambert = light ? Math.max(0, l.nx[i] * lx + l.ny[i] * ly + l.nz[i] * lz) : 0.85;
    const limb = 0.75 + 0.25 * l.nz[i];
    const k = (0.08 + 0.92 * lambert) * limb;
    img.data[o] = c[0] * k; img.data[o + 1] = c[1] * k; img.data[o + 2] = c[2] * k;
    // Soft anti-aliased rim.
    const edge = Math.min(1, l.nz[i] * size * 0.25);
    img.data[o + 3] = 255 * edge;
  }
  ctx.putImageData(img, 0, 0);
}

/** The most common material's color, for bodies too small to texture. */
export function dominantColor(surface: Uint8Array | null, fallback: number): number {
  if (!surface) return fallback;
  const counts = new Uint16Array(MATERIALS.length);
  for (let i = 0; i < surface.length; i += 7) counts[surface[i]]++;
  let best = 0;
  for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
  return MATERIALS[best].color;
}
