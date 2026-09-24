import { AU, DAY, M_EARTH, M_SUN, YEAR } from "../sim/constants";
import { settings } from "../state/settings";

/** Number with sensible precision and thousands separators. */
export function num(v: number, sig = 4): string {
  if (!isFinite(v)) return "∞";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e7 || a < 1e-3)) return sci(v, 3);
  const digits = a >= 1000 ? 0 : Math.max(0, sig - 1 - Math.floor(Math.log10(a || 1)));
  return v.toLocaleString("en-US", { maximumFractionDigits: Math.min(digits, 6), minimumFractionDigits: Math.min(digits, 6) });
}

export function sci(v: number, sig = 3): string {
  const [m, e] = v.toExponential(sig - 1).split("e");
  const exp = Number(e);
  const sup = String(exp).replace(/[-0-9]/g, c => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(c)]);
  return `${m}×10${sup}`;
}

const astro = () => settings.get().units === "astro";

export function mass(kg: number): [string, string] {
  if (!astro()) return [sci(kg), "kg"];
  if (kg >= 0.08 * M_SUN) return [num(kg / M_SUN), "M☉"];
  return [num(kg / M_EARTH), "M⊕"];
}

export function length(m: number): [string, string] {
  if (!astro()) return m >= 1e4 ? [num(m / 1000), "km"] : [num(m), "m"];
  if (m >= 0.01 * AU) return [num(m / AU), "AU"];
  if (m >= 10_000) return [num(m / 1000), "km"];
  if (m >= 1) return [num(m), "m"];
  return [num(m * 1000), "mm"];
}

export function radius(m: number): [string, string] {
  if (m < 1) return [num(m * 1000), "mm"];
  if (m < 10_000) return [num(m), "m"];
  return [num(m / 1000), "km"];
}

export function speed(ms: number): [string, string] {
  return astro() ? [num(ms / 1000), "km/s"] : [num(ms), "m/s"];
}

export function duration(s: number): [string, string] {
  if (!isFinite(s)) return ["Escaping", ""];
  if (!astro()) return [sci(s), "s"];
  if (s < 2 * 3600) return [num(s / 60), "min"];
  if (s < 2 * DAY) return [num(s / 3600), "h"];
  if (s < 1000 * DAY) return [num(s / DAY), "d"];
  return [num(s / YEAR), "yr"];
}

export function density(kgm3: number): [string, string] {
  return astro() ? [num(kgm3 / 1000), "g/cm³"] : [num(kgm3), "kg/m³"];
}

const RATE_UNITS: [number, string][] = [[YEAR, "yr"], [30.44 * DAY, "mo"], [7 * DAY, "wk"], [DAY, "day"], [3600, "hr"], [60, "min"], [1, "s"]];

/** Time warp in human units: "1.0 day/s". */
export function rate(r: number): string {
  const [d, u] = RATE_UNITS.find(([d]) => r >= d * 0.999) ?? RATE_UNITS[RATE_UNITS.length - 1];
  const n = r / d;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u}/s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function date(ms: number): string {
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "—";
  const y = d.getUTCFullYear();
  return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${y}`;
}

export function int(n: number): string {
  return n.toLocaleString("en-US");
}
