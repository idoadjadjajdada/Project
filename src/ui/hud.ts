import { sfx } from "../audio";
import { TYPES, typesInTab, TAB_ORDER } from "../sim/catalog";
import { EPOCH_MS, M_EARTH, M_SUN, MAX_RATE } from "../sim/constants";
import { habitability, temperature } from "../sim/habitability";
import { MATERIALS } from "../sim/materials";
import { elements, parentOf } from "../sim/orbit";
import { PRESETS, type PresetId } from "../sim/presets";
import { composition } from "../sim/surface";
import type { Body, BodyType } from "../sim/types";
import { SURF_H, SURF_W } from "../sim/types";
import type { SimClient } from "../simClient";
import { listSlots, SLOT_COUNT } from "../state/saves";
import { settings, type Settings } from "../state/settings";
import * as fmt from "./format";

export type Tool = "select" | "grab" | "erase" | "attract" | "orbitlock" | "laser" | "collapse" | "explode";

export const TOOLS: Record<Tool, [string, string]> = {
  select: ["Select", "Tap a body to inspect it. Drag empty space to pan."],
  grab: ["Grab", "Drag a body; it keeps your throw velocity on release."],
  erase: ["Erase", "Hold and sweep to delete bodies and debris."],
  attract: ["Attract", "Hold to pull everything toward your finger or cursor."],
  orbitlock: ["Orbit lock", "Tap a body to set a circular orbit around its strongest attractor."],
  laser: ["Laser", "Press, hold, then swipe away. The beam fires from the hold point."],
  collapse: ["Collapse", "Tap a body to turn it into a black hole of the same mass."],
  explode: ["Explode", "Tap a body to shatter it into fragments and debris."],
};
export const TOOL_KEYS: Tool[] = ["select", "grab", "erase", "attract", "orbitlock", "laser", "collapse", "explode"];
const DESTROY = new Set<Tool>(["laser", "collapse", "explode"]);

export interface HudState {
  tool: Tool | null;
  placeType: BodyType | null;
  placeMass: number;
  paused: boolean;
  rate: number;
  selectedId: number | null;
  hoverId: number | null;
  follow: boolean;
  pencilSeen: boolean;
}

export interface HudActions {
  preset(id: PresetId): void;
  undo(): void;
  collapse(id: number): void;
  explode(id: number): void;
  remove(id: number): void;
  setMass(id: number, m: number): void;
  rename(id: number, name: string): void;
  follow(id: number | null): void;
  save(slot: number): void;
  load(slot: number): void;
  newSandbox(): void;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

export class Hud {
  state: HudState = {
    tool: "select", placeType: null, placeMass: M_EARTH, paused: false, rate: 86400,
    selectedId: null, hoverId: null, follow: false, pencilSeen: false,
  };
  private infoOpenFor: number | null = null;
  private lastInfoUpdate = 0;
  private massBase = 0;
  private noticeTimer = 0;
  private screenStack: string[] = [];
  private wasPaused = false;
  private fps = 60;
  onToolChange: () => void = () => {};

  constructor(private sim: SimClient, private act: HudActions) {
    this.buildPicker();
    this.buildToolbar();
    this.buildTime();
    this.buildPresets();
    this.buildInfo();
    this.buildScreens();
    this.setTool("select");
  }

  // ---------- Picker ----------

  private buildPicker(): void {
    const list = $("#objList");
    const render = (tab: (typeof TAB_ORDER)[number]) => {
      $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
      list.innerHTML = typesInTab(tab).map(t => {
        const info = TYPES[t];
        const m = info.unit === "M☉" ? info.m0 / M_SUN : info.m0 / M_EARTH;
        return `<button class="obj" data-obj="${t}" aria-pressed="${t === this.state.placeType}" title="${info.label}">
          <svg class="ico" aria-hidden="true"><use href="#o-${t}"/></svg><span>${info.label}</span><small class="num">${fmtMass(m)} ${info.unit}</small></button>`;
      }).join("");
    };
    $$(".tab").forEach(t => t.addEventListener("click", () => { sfx.press(); render(t.dataset.tab as (typeof TAB_ORDER)[number]); }));
    list.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".obj");
      if (!b) return;
      sfx.tool();
      this.setPlace(b.dataset.obj as BodyType);
    });
    $<HTMLInputElement>("#spawnMass").addEventListener("change", e => {
      const input = e.target as HTMLInputElement;
      const v = parseFloat(input.value.replace(/[×x]10\^?/, "e"));
      if (!(v > 0) || !this.state.placeType) { this.setPlace(this.state.placeType!); return; }
      const unit = TYPES[this.state.placeType].unit === "M☉" ? M_SUN : M_EARTH;
      this.state.placeMass = v * unit;
    });
    render("planets");
  }

  setPlace(type: BodyType): void {
    const info = TYPES[type];
    this.state.placeType = type;
    this.state.tool = null;
    this.state.placeMass = info.m0;
    $$(".obj").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.obj === type)));
    $$(".tool[data-tool]").forEach(x => x.setAttribute("aria-pressed", "false"));
    $<HTMLInputElement>("#spawnMass").value = fmtMass(info.m0 / (info.unit === "M☉" ? M_SUN : M_EARTH));
    $("#spawnUnit").textContent = info.unit;
    $("#spawn").hidden = false;
    this.setHint("Place", `${info.label}: tap for a stable orbit, drag to launch.`, false);
    this.onToolChange();
  }

  // ---------- Toolbar ----------

  private buildToolbar(): void {
    $$(".tool[data-tool]").forEach(b => {
      const t = b.dataset.tool as Tool;
      b.title = `${TOOLS[t][0]} (${b.querySelector("kbd")!.textContent})`;
      b.addEventListener("click", () => { sfx.tool(); this.setTool(t); });
    });
    $("#undoBtn").addEventListener("click", () => { sfx.press(); this.act.undo(); });
    $("#pencilBtn").addEventListener("click", () => { sfx.press(); settings.set("pencil", !settings.get().pencil); });
    settings.subscribe(s => this.syncPencil(s));
  }

  setTool(t: Tool): void {
    this.state.tool = t;
    this.state.placeType = null;
    $("#spawn").hidden = true;
    $$(".obj").forEach(x => x.setAttribute("aria-pressed", "false"));
    $$(".tool[data-tool]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
    this.setHint(TOOLS[t][0], TOOLS[t][1], DESTROY.has(t));
    this.onToolChange();
  }

  private setHint(name: string, text: string, destroy: boolean): void {
    const h = $("#hint");
    h.className = "hint" + (destroy ? " destroy" : "");
    h.innerHTML = `<span class="label"></span><span></span>`;
    h.children[0].textContent = name;
    h.children[1].textContent = text;
  }

  /** Called the first time a Pencil touches the screen: show the toggle and switch Pencil mode on. */
  pencilDetected(): void {
    if (this.state.pencilSeen) return;
    this.state.pencilSeen = true;
    settings.set("pencil", true);
    this.syncPencil(settings.get());
  }

  private syncPencil(s: Settings): void {
    const b = $("#pencilBtn");
    b.hidden = !this.state.pencilSeen && !s.pencil;
    b.setAttribute("aria-pressed", String(s.pencil));
  }

  // ---------- Time ----------

  private buildTime(): void {
    const speed = $<HTMLInputElement>("#speed");
    const toRate = (v: number) => Math.pow(MAX_RATE, v / 1000);
    const toSlider = (r: number) => Math.round((Math.log(r) / Math.log(MAX_RATE)) * 1000);
    speed.value = String(toSlider(this.state.rate));
    const show = () => { if (!this.state.paused) $("#speedOut").textContent = fmt.rate(this.state.rate); };
    speed.addEventListener("input", () => { this.state.rate = toRate(+speed.value); show(); });
    const nudge = (f: number) => {
      this.state.rate = Math.min(MAX_RATE, Math.max(1, this.state.rate * f));
      speed.value = String(toSlider(this.state.rate));
      show();
    };
    this.nudge = nudge;
    $("#slower").addEventListener("click", () => { sfx.press(); nudge(0.5); });
    $("#faster").addEventListener("click", () => { sfx.press(); nudge(2); });
    $("#playPause").addEventListener("click", () => this.setPaused(!this.state.paused));
    show();
  }

  nudge: (f: number) => void = () => {};

  setPaused(p: boolean): void {
    if (p === this.state.paused) return;
    this.state.paused = p;
    (p ? sfx.pause : sfx.resume)();
    const pp = $("#playPause");
    pp.querySelector("use")!.setAttribute("href", p ? "#i-play" : "#i-pause");
    pp.setAttribute("aria-label", p ? "Resume" : "Pause");
    $("#pauseBanner").hidden = !p;
    $("#speedOut").textContent = p ? "0 s/s" : fmt.rate(this.state.rate);
  }

  private buildPresets(): void {
    const btn = $("#presetBtn"), menu = $("#presetMenu");
    const groups = [...new Set(PRESETS.map(p => p.group))];
    menu.innerHTML = groups.map(g => `<div class="grp" role="group" aria-label="${g}"><span class="label dim">${g}</span>${
      PRESETS.filter(p => p.group === g).map(p => `<button role="menuitemradio" aria-checked="${p.id === "solar"}" data-preset="${p.id}">${p.name} <small>${p.note}</small></button>`).join("")
    }</div>`).join("");
    const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    this.closePresets = close;
    btn.addEventListener("click", e => {
      e.stopPropagation();
      sfx.press();
      menu.hidden = !menu.hidden;
      btn.setAttribute("aria-expanded", String(!menu.hidden));
    });
    menu.addEventListener("click", e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-preset]");
      if (!b) return;
      $$("[data-preset]", menu).forEach(x => x.setAttribute("aria-checked", String(x === b)));
      close();
      this.act.preset(b.dataset.preset as PresetId);
    });
    document.addEventListener("pointerdown", e => { if (!menu.hidden && !(e.target as HTMLElement).closest(".timebar")) close(); });
  }

  closePresets: () => void = () => {};

  openPresets(): void {
    $("#presetBtn").click();
  }

  // ---------- Stats & notices ----------

  tick(realDt: number): void {
    this.fps = this.fps * 0.95 + (1 / Math.max(1e-3, realDt)) * 0.05;
    $("#statBodies").textContent = fmt.int(this.sim.bodies.length);
    $("#statDebris").textContent = fmt.int(this.sim.debrisCount);
    $("#statDate").textContent = fmt.date(EPOCH_MS + this.sim.t * 1000);
    const f = $("#statFps");
    f.textContent = String(Math.round(this.fps));
    f.classList.toggle("warn", this.fps < 45 && this.fps >= 30);
    f.classList.toggle("bad", this.fps < 30);
    $("#limited").hidden = !(this.sim.limited && !this.state.paused);

    // Keep the hover card current while the pointer rests (a collapse changes the type under it).
    if (this.peekAt && performance.now() - this.lastInfoUpdate > 200) {
      const b = this.sim.byId.get(this.peekAt.id);
      this.peek(b ?? null, this.peekAt.sx, this.peekAt.sy);
    }
    if (this.infoOpenFor !== null) {
      if (!this.sim.byId.has(this.infoOpenFor)) this.closeInfo();
      else if (performance.now() - this.lastInfoUpdate > 200) this.fillInfo(this.sim.byId.get(this.infoOpenFor)!, false);
    }
  }

  notice(text: string): void {
    const n = $("#notice");
    n.textContent = text;
    n.hidden = false;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => { n.hidden = true; }, 3200);
  }

  // ---------- Hover preview ----------

  private peekAt: { id: number; sx: number; sy: number } | null = null;

  peek(b: Body | null, sx = 0, sy = 0): void {
    const p = $("#peek");
    if (!b) { p.classList.remove("show"); this.peekAt = null; return; }
    this.peekAt = { id: b.id, sx, sy };
    const parent = parentOf(this.sim.bodies, b);
    const [mv, mu] = fmt.mass(b.m);
    const dist = parent ? fmt.length(Math.hypot(b.x - parent.x, b.y - parent.y)) : null;
    p.innerHTML = `<span class="label"></span>
      <div class="row"><span>Type</span><span>${TYPES[b.type].label}</span></div>
      <div class="row"><span>Mass</span><span class="num">${mv} ${mu}</span></div>
      <div class="row"><span>From parent</span><span class="num">${dist ? `${dist[0]} ${dist[1]}` : "—"}</span></div>`;
    p.firstElementChild!.textContent = b.name;
    p.style.left = Math.min(window.innerWidth - 200, sx + 16) + "px";
    p.style.top = Math.max(16, sy - 16) + "px";
    p.classList.add("show");
  }

  // ---------- Info panel ----------

  private buildInfo(): void {
    $("#infoClose").addEventListener("click", () => { sfx.close(); this.select(null); });
    const name = $<HTMLInputElement>("#infoName");
    name.addEventListener("change", () => { if (this.infoOpenFor !== null && name.value.trim()) this.act.rename(this.infoOpenFor, name.value.trim()); });
    name.addEventListener("keydown", e => { if (e.key === "Enter") name.blur(); });
    const ms = $<HTMLInputElement>("#massScale");
    ms.addEventListener("pointerdown", () => { const b = this.current(); if (b) this.massBase = b.m; });
    ms.addEventListener("input", () => { $("#massOut").textContent = "×" + Math.pow(10, +ms.value / 100).toFixed(2); });
    ms.addEventListener("change", () => {
      const b = this.current();
      if (!b) return;
      const base = this.massBase || b.m;
      this.act.setMass(b.id, base * Math.pow(10, +ms.value / 100));
      ms.value = "0"; $("#massOut").textContent = "×1.00"; this.massBase = 0;
    });
    $("#followBtn").addEventListener("click", () => {
      sfx.press();
      this.state.follow = !this.state.follow;
      $("#followBtn").setAttribute("aria-pressed", String(this.state.follow));
      this.act.follow(this.state.follow ? this.infoOpenFor : null);
    });
    $("#actCollapse").addEventListener("click", () => { const b = this.current(); if (b) this.act.collapse(b.id); });
    $("#actExplode").addEventListener("click", () => { const b = this.current(); if (b) this.act.explode(b.id); });
    $("#actDelete").addEventListener("click", () => { const b = this.current(); if (b) { this.act.remove(b.id); this.select(null); } });
  }

  private current(): Body | undefined {
    return this.infoOpenFor !== null ? this.sim.byId.get(this.infoOpenFor) : undefined;
  }

  select(id: number | null): void {
    this.state.selectedId = id;
    if (id === null) { this.closeInfo(); return; }
    const b = this.sim.byId.get(id);
    if (!b) return;
    if (this.infoOpenFor !== id) {
      // Only release the camera if the Follow button was holding it on the previous body;
      // a follow set by a preset (or none at all) is left alone.
      if (this.state.follow) this.act.follow(null);
      this.state.follow = false;
      $("#followBtn").setAttribute("aria-pressed", "false");
      sfx.open();
    }
    this.infoOpenFor = id;
    this.fillInfo(b, true);
    const info = $("#info");
    info.classList.add("open");
    info.setAttribute("aria-hidden", "false");
  }

  private closeInfo(): void {
    this.infoOpenFor = null;
    this.state.selectedId = null;
    if (this.state.follow) { this.state.follow = false; this.act.follow(null); }
    const info = $("#info");
    info.classList.remove("open");
    info.setAttribute("aria-hidden", "true");
  }

  private surfaceRevShown = -1;

  private fillInfo(b: Body, full: boolean): void {
    this.lastInfoUpdate = performance.now();
    const bodies = this.sim.bodies;
    const info = TYPES[b.type];
    if (full) {
      $("#infoIcon").setAttribute("href", `#o-${b.type === "spacecraft" ? "asteroid" : b.type}`);
      $<HTMLInputElement>("#infoName").value = b.name;
      this.surfaceRevShown = -1;
    }
    if (document.activeElement !== $("#infoName") && $<HTMLInputElement>("#infoName").value !== b.name) $<HTMLInputElement>("#infoName").value = b.name;
    $("#infoType").textContent = info.label;
    const p = parentOf(bodies, b);
    const el = p ? elements(b, p) : null;
    const sub = p && el ? `Orbiting ${p.name} · ${fmt.length(el.dist).join(" ")}` : "Drifting free";
    $("#infoSub").textContent = sub;

    // Physical
    const vol = (4 / 3) * Math.PI * b.r ** 3;
    const G = 6.674e-11;
    const phys: [string, [string, string]][] = [
      ["Mass", fmt.mass(b.m)],
      ["Radius", fmt.radius(b.r)],
      ["Density", fmt.density(b.m / vol)],
      ["Gravity", [fmt.num((G * b.m) / (b.r * b.r)), "m/s²"]],
      ["Escape vel.", fmt.speed(Math.sqrt((2 * G * b.m) / b.r))],
    ];
    $("#kvPhys").innerHTML = phys.map(([k, [v, u]]) => `<div><dt>${k}</dt><dd class="num">${v} <small>${u}</small></dd></div>`).join("");

    // Orbit
    $("#secOrbit").hidden = !el;
    if (el && p) {
      const rows: [string, string][] = [
        ["Period", el.bound ? fmt.duration(el.period).join(" ") : "Escaping"],
        ["Speed", fmt.speed(el.speed).join(" ")],
        ["Ecc.", el.bound ? el.e.toFixed(3) : "≥ 1"],
        ["a", el.bound ? fmt.length(el.a).join(" ") : "—"],
      ];
      $("#kvOrbit").innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd class="num">${v}</dd></div>`).join("");
      const e = el.bound ? Math.min(0.95, el.e) : 0.95;
      const rx = 40, ry = rx * Math.sqrt(1 - e * e), c = rx * e;
      $("#miniOrbit").setAttribute("ry", ry.toFixed(1));
      $("#miniOrbit").setAttribute("cx", (-c).toFixed(1));
      // Where the body is on its orbit, relative to periapsis.
      const theta = Math.atan2(b.y - p.y, b.x - p.x) - el.argPeri;
      const rr = el.bound ? (rx * (1 - e * e)) / (1 + e * Math.cos(theta)) : rx;
      $("#miniBody").setAttribute("cx", (Math.cos(theta) * rr).toFixed(1));
      $("#miniBody").setAttribute("cy", (-Math.sin(theta) * rr).toFixed(1));
    }

    // Composition + surface map
    const comp = b.surface ? composition(b.surface) : [];
    const T = temperature(bodies, b);
    $("#secComp").hidden = !b.surface;
    $("#infoTemp").textContent = T > 0 ? `Surface ${fmt.int(Math.round(T))} K` : "";
    if (b.surface) {
      const top = comp.slice(0, 5);
      $("#compBar").innerHTML = top.map(c => `<span style="flex:${c.frac};background:#${MATERIALS[c.mat].color.toString(16).padStart(6, "0")}"></span>`).join("");
      $("#compLegend").innerHTML = top.map(c => `<span><i style="background:#${MATERIALS[c.mat].color.toString(16).padStart(6, "0")}"></i>${MATERIALS[c.mat].name} ${Math.round(c.frac * 100)}%</span>`).join("");
      if (this.surfaceRevShown !== b.surfaceRev) { drawSurfaceMap(b.surface); this.surfaceRevShown = b.surfaceRev; }
    }

    // Life likelihood
    const h = habitability(bodies, b);
    if (!h.applicable) {
      $("#lifeScore").textContent = "";
      $("#factors").innerHTML = `<li class="na" style="grid-template-columns:1fr">Not applicable</li>`;
    } else {
      $("#lifeScore").textContent = Math.round(h.score * 100) + "%";
      $("#factors").innerHTML = h.factors.map(f => `<li><svg class="ico sm ${f.pass ? "pass" : "fail"}" role="img" aria-label="${f.pass ? "Pass" : "Fail"}"><use href="#i-${f.pass ? "pass" : "fail"}"/></svg><span>${f.name}</span><small>${f.detail}</small></li>`).join("");
    }
    $("#actCollapse").toggleAttribute("disabled", b.type === "blackhole");
    $("#actExplode").toggleAttribute("disabled", b.type === "blackhole");
  }

  // ---------- Screens ----------

  private buildScreens(): void {
    const scrim = $("#scrim");
    scrim.addEventListener("click", e => {
      const t = e.target as HTMLElement;
      const nav = t.closest<HTMLElement>("[data-go]");
      if (nav) { sfx.press(); this.go(nav.dataset.go!); return; }
      const slot = t.closest<HTMLElement>("[data-slot]");
      if (slot && !slot.hasAttribute("disabled")) {
        const n = +slot.dataset.slot!;
        if (this.slotsMode === "save") { this.act.save(n); sfx.save(); this.renderSlots(); }
        else { this.act.load(n); this.go("close"); }
        return;
      }
      const sw = t.closest<HTMLElement>(".switch[data-setting]");
      if (sw) { sfx.press(); const k = sw.dataset.setting as "minSize" | "pencil" | "trails" | "sounds"; settings.set(k, !settings.get()[k]); }
      const radio = t.closest<HTMLElement>(".seg [role=radio]");
      if (radio) {
        sfx.press();
        const k = radio.parentElement!.dataset.setting as "units" | "quality";
        settings.set(k, radio.dataset.value as never);
      }
    });
    const sync = (s: Settings) => {
      $$(".switch[data-setting]", scrim).forEach(sw => sw.setAttribute("aria-checked", String(s[sw.dataset.setting as keyof Settings])));
      $$(".seg[data-setting]", scrim).forEach(seg => $$("[role=radio]", seg).forEach(r => r.setAttribute("aria-checked", String(s[seg.dataset.setting as keyof Settings] === r.dataset.value))));
    };
    settings.subscribe(sync);
    sync(settings.get());
    $("#menuBtn").addEventListener("click", () => this.openMenu());
  }

  private slotsMode: "save" | "load" = "load";

  get menuOpen(): boolean {
    return !$("#scrim").hidden;
  }

  openMenu(view = "pause"): void {
    this.wasPaused = this.state.paused;
    this.setPaused(true);
    this.screenStack = [];
    sfx.open();
    this.go(view);
  }

  go(target: string): void {
    const scrim = $("#scrim");
    const show = (v: string) => { $$(".view", scrim).forEach(x => { x.hidden = x.dataset.view !== v; }); scrim.hidden = false; };
    switch (target) {
      case "close": scrim.hidden = true; this.screenStack = []; this.setPaused(this.wasPaused); return;
      case "back":
        this.screenStack.pop();
        if (!this.screenStack.length) return this.go("close");
        show(this.screenStack[this.screenStack.length - 1]);
        return;
      case "new": this.act.newSandbox(); this.wasPaused = false; this.go("close"); return;
      case "presets": this.wasPaused = false; this.go("close"); setTimeout(() => this.openPresets()); return;
      case "save": case "load":
        this.slotsMode = target;
        $("#slotsTitle").textContent = target === "save" ? "Save" : "Load";
        this.renderSlots();
        this.screenStack.push("slots"); show("slots");
        return;
      case "main": this.screenStack = []; break;
    }
    this.screenStack.push(target);
    show(target);
  }

  private renderSlots(): void {
    const slots = listSlots();
    $("#slotList").innerHTML = Array.from({ length: SLOT_COUNT }, (_, i) => {
      const s = slots[i];
      const disabled = !s && this.slotsMode === "load" ? "disabled" : "";
      return s
        ? `<button class="slot" data-slot="${i + 1}"><span>${escapeHtml(s.name)}<small class="num">${fmt.int(s.bodies)} bodies · ${fmt.date(s.simDate)}</small></span><span class="label dim">${i + 1}</span></button>`
        : `<button class="slot empty" data-slot="${i + 1}" ${disabled}><span>Empty slot</span><span class="label dim">${i + 1}</span></button>`;
    }).join("");
  }
}

function fmtMass(v: number): string {
  return v >= 0.01 ? String(+v.toPrecision(3)) : v.toExponential(1);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function drawSurfaceMap(s: Uint8Array): void {
  const cv = document.querySelector<HTMLCanvasElement>("#surface")!;
  const ctx = cv.getContext("2d")!;
  const cw = cv.width / SURF_W, ch = cv.height / SURF_H;
  for (let y = 0; y < SURF_H; y++) {
    for (let x = 0; x < SURF_W; x++) {
      ctx.fillStyle = "#" + MATERIALS[s[y * SURF_W + x]].color.toString(16).padStart(6, "0");
      ctx.fillRect(Math.floor(x * cw), Math.floor(y * ch), Math.ceil(cw), Math.ceil(ch));
    }
  }
}
