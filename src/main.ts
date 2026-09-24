import "./styles/hud.css";
import { sfx } from "./audio";
import { InputController } from "./input/controller";
import { Camera } from "./render/camera";
import { Renderer } from "./render/renderer";
import { EPOCH_MS } from "./sim/constants";
import { PRESETS, type PresetId } from "./sim/presets";
import { SimClient } from "./simClient";
import { readSlot, writeSlot } from "./state/saves";
import { settings } from "./state/settings";
import { Hud, TOOL_KEYS } from "./ui/hud";

async function start() {
  const worldEl = document.getElementById("world")!;
  const sim = new SimClient();
  const cam = new Camera();
  const renderer = new Renderer();
  await renderer.init(worldEl);
  // Labels are drawn on the canvas, so wait for the mono font before the first frame.
  try { await document.fonts.load("12px 'Share Tech Mono'"); } catch { /* fallback font is fine */ }

  let presetName = "Solar System";
  /** Where to point the camera once the first state of the new world arrives. */
  let pendingFocus: { name: string; span: number; epoch: number } | null = null;

  const hud = new Hud(sim, {
    preset(id: PresetId) {
      presetName = PRESETS.find(p => p.id === id)?.name ?? "Sandbox";
      hud.select(null);
      sim.preset(id);
    },
    undo: () => sim.send({ type: "undo" }),
    collapse(id) { sim.send({ type: "snapshot" }); sim.send({ type: "collapse", id }); },
    explode(id) { sim.send({ type: "snapshot" }); sim.send({ type: "explode", id }); },
    remove(id) { sim.send({ type: "snapshot" }); sim.send({ type: "delete", id }); },
    setMass: (id, m) => sim.send({ type: "setMass", id, m }),
    rename: (id, name) => sim.send({ type: "rename", id, name }),
    follow(id) { cam.followId = id; },
    save: slot => sim.send({ type: "save", slot }),
    load(slot) {
      const data = readSlot(slot);
      if (!data) { hud.notice("That slot is empty."); return; }
      hud.select(null);
      sim.send({ type: "load", data });
      const heaviest = data.bodies.reduce((a, b) => (b.m > a.m ? b : a), data.bodies[0]);
      if (heaviest) pendingFocus = { name: heaviest.name, span: cam.mpp * Math.min(cam.w, cam.h) / 2, epoch: sim.epoch + 1 };
      hud.notice(`Loaded slot ${slot}.`);
    },
    newSandbox() { this.preset("empty"); },
  });

  sim.onView = (v, epoch) => { pendingFocus = { name: v.focus, span: v.span, epoch }; };
  sim.onReset = () => { renderer.reset(); cam.followId = null; hud.select(null); };
  sim.onEvents = e => renderer.addEvents(e);
  sim.onNotice = t => hud.notice(t);
  sim.onSaved = (slot, data) => {
    const ok = writeSlot({ slot, name: presetName, savedAt: Date.now(), simDate: EPOCH_MS + data.t * 1000, bodies: data.bodies.length }, data);
    hud.notice(ok ? `Saved to slot ${slot}.` : "Couldn't save: the browser refused to store it (storage full or blocked).");
  };

  const input = new InputController(worldEl, cam, sim, renderer, hud);

  // Fragment budget follows the Graphics setting.
  const FRAG_CAP = { low: 250, med: 600, high: 1500 } as const;
  sim.send({ type: "fragCap", cap: FRAG_CAP[settings.get().quality] });
  settings.subscribe(s => sim.send({ type: "fragCap", cap: FRAG_CAP[s.quality] }));

  // ---------- Keyboard (PRD v1 set: 1–8, Space, [ ], Esc; plus Ctrl/Cmd+Z) ----------
  document.addEventListener("keydown", e => {
    const t = e.target as HTMLElement;
    if (t.matches("input:not([type=range])")) return;
    if (hud.menuOpen) { if (e.key === "Escape") hud.go("back"); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); sim.send({ type: "undo" }); return; }
    if (e.key >= "1" && e.key <= "8") { sfx.tool(); hud.setTool(TOOL_KEYS[+e.key - 1]); }
    else if (e.key === " ") { e.preventDefault(); hud.setPaused(!hud.state.paused); }
    else if (e.key === "[") hud.nudge(0.5);
    else if (e.key === "]") hud.nudge(2);
    else if (e.key === "Escape") { hud.closePresets(); hud.select(null); }
  });

  /** Name of the followed body, so the camera can pick up its reformed successor. */
  let followName: string | null = null;

  // ---------- Frame loop ----------
  let last = performance.now();
  const frame = (now: number) => {
    const realDt = Math.min(0.1, (now - last) / 1000);
    last = now;
    cam.resize(worldEl.clientWidth, worldEl.clientHeight);

    if (pendingFocus && sim.epoch >= pendingFocus.epoch) {
      const b = sim.bodies.find(x => x.name === pendingFocus!.name);
      // Presets centre on and follow their focus body; panning releases the follow.
      if (b) { cam.frame(b.x, b.y, pendingFocus.span); cam.followId = b.id; pendingFocus = null; }
    }
    if (cam.followId !== null) {
      let b = sim.byId.get(cam.followId);
      // The followed body broke up: stay with whatever reforms under its name.
      if (!b && followName) b = sim.bodies.find(x => x.name === followName);
      if (b) { cam.followId = b.id; followName = b.name; cam.cx = b.x; cam.cy = b.y; }
      else if (!sim.fragCount) cam.followId = null; // nothing left to wait for
    }

    const laser = input.frame();
    sim.tick(realDt, hud.state.paused ? 0 : hud.state.rate, laser);
    renderer.draw(sim, cam, {
      selectedId: hud.state.selectedId, hoverId: hud.state.hoverId, settings: settings.get(),
      realDt, rate: hud.state.paused ? 0 : hud.state.rate, overlay: input.overlay,
    });
    hud.tick(realDt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // Test hook for the browser checks; dev builds only.
  if (import.meta.env.DEV) Object.assign(window, { __orbital: { sim, cam, hud, renderer, input } });

  // PRD: no onboarding; drop straight into the real Solar System.
  hud.setTool("select");
  sim.preset("solar");
}

start().catch(err => {
  document.body.insertAdjacentHTML("beforeend", `<p style="position:fixed;inset:auto 16px 16px;color:#FF3366;font:14px monospace">Couldn't start: ${String(err?.message ?? err)}</p>`);
  console.error(err);
});
