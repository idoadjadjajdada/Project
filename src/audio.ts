import { settings } from "./state/settings";

/**
 * UI sounds only (PRD): short, quiet synthesized clicks. No audio files, and nothing
 * plays until the player has interacted, as browsers require.
 */
let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (!settings.get().sounds) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function blip(freq: number, dur: number, gain: number, type: OscillatorType = "square", slide = 0): void {
  const a = ac();
  if (!a) return;
  const t = a.currentTime;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  tool: () => blip(1400, 0.035, 0.03),
  press: () => blip(900, 0.03, 0.025),
  open: () => blip(600, 0.07, 0.025, "triangle", 1.6),
  close: () => blip(960, 0.07, 0.025, "triangle", 0.6),
  pause: () => blip(520, 0.09, 0.03, "triangle", 0.7),
  resume: () => blip(520, 0.09, 0.03, "triangle", 1.4),
  save: () => { blip(880, 0.05, 0.025, "triangle"); setTimeout(() => blip(1320, 0.07, 0.025, "triangle"), 60); },
};
