// SI units throughout the simulation.
export const G = 6.674e-11;
export const C = 299_792_458;
export const AU = 1.495978707e11;
export const M_EARTH = 5.9722e24;
export const M_SUN = 1.98847e30;
export const R_EARTH = 6.371e6;
export const R_SUN = 6.957e8;
export const L_SUN = 3.828e26;
export const DAY = 86_400;
export const YEAR = 365.25 * DAY;

/** Top of the time-warp slider: 10 years of sim time per real second. */
export const MAX_RATE = 10 * YEAR;

/** Epoch every preset starts at (the date the PRD was written). */
export const EPOCH_MS = Date.UTC(2026, 8, 24);
/** J2000.0 in ms since the Unix epoch; orbital elements are referenced to it. */
export const J2000_MS = Date.UTC(2000, 0, 1, 12);

export const MAX_BODIES = 200;
export const MAX_DEBRIS = 5000;
export const UNDO_DEPTH = 20;
