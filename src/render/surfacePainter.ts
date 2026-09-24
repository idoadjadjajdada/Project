import { MATERIALS } from "../sim/materials";
import { SURF_H, SURF_W } from "../sim/types";

const palette = MATERIALS.map(m => [(m.color >> 16) & 255, (m.color >> 8) & 255, m.color & 255]);

/** The most common material's color, for bodies too small to texture. */
export function dominantColor(surface: Uint8Array | null, fallback: number): number {
  if (!surface) return fallback;
  const counts = new Uint16Array(MATERIALS.length);
  for (let i = 0; i < surface.length; i += 7) counts[surface[i]]++;
  let best = 0;
  for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
  return MATERIALS[best].color;
}

/** 4×4 Bayer matrix, normalized to 0..1, for ordered dithering. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16);
/** Brightness steps a pixel can land on: a small palette per material, like hand-shaded pixel art. */
const SHADES = [0.14, 0.38, 0.66, 1.0];

/**
 * Pixel-art globe: one canvas pixel per screen "pixel" of the pixelated world, hard edge,
 * lighting quantized to four shades with ordered dithering between them.
 */
export function paintPixelGlobe(canvas: HTMLCanvasElement, surface: Uint8Array, rotation: number, light: [number, number] | null): void {
  const size = canvas.width;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  let lx = 0, ly = 0, lz = 1;
  if (light) {
    lx = light[0]; ly = light[1]; lz = 0.2;
    const n = Math.hypot(lx, ly, lz); lx /= n; ly /= n; lz /= n;
  }
  const twoPi = Math.PI * 2;
  const r = size / 2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const o = (py * size + px) * 4;
      const x = (px + 0.5 - r) / r, y = (py + 0.5 - r) / r;
      const r2 = x * x + y * y;
      if (r2 > 1) { img.data[o + 3] = 0; continue; }
      const z = Math.sqrt(1 - r2);
      const lat = Math.asin(-y);
      const row = Math.min(SURF_H - 1, Math.max(0, Math.floor((lat / Math.PI + 0.5) * SURF_H)));
      let lon = (Math.atan2(x, z) + rotation) / twoPi;
      lon -= Math.floor(lon);
      const c = palette[surface[row * SURF_W + Math.floor(lon * SURF_W)]] ?? palette[0];
      const lambert = light ? Math.max(0, x * lx + -y * ly + z * lz) : 0.8;
      // Quantize to the shade steps, dithering between neighbours.
      const t = lambert * (SHADES.length - 1);
      const lo = Math.floor(t), frac = t - lo;
      const step = frac > BAYER[(py & 3) * 4 + (px & 3)] ? Math.min(SHADES.length - 1, lo + 1) : lo;
      const k = SHADES[step];
      img.data[o] = c[0] * k; img.data[o + 1] = c[1] * k; img.data[o + 2] = c[2] * k;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
