export interface Settings {
  units: "astro" | "si";
  minSize: boolean;
  pencil: boolean;
  quality: "low" | "med" | "high";
  trails: boolean;
  sounds: boolean;
}

const KEY = "orbital.settings.v1";

const DEFAULTS: Settings = { units: "astro", minSize: true, pencil: false, quality: "med", trails: true, sounds: true };

type Listener = (s: Settings) => void;

class SettingsStore {
  private value: Settings = { ...DEFAULTS };
  private listeners = new Set<Listener>();

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.value = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      // Storage blocked (private window): run on defaults.
    }
  }

  get(): Settings {
    return this.value;
  }

  set<K extends keyof Settings>(key: K, v: Settings[K]): void {
    if (this.value[key] === v) return;
    this.value = { ...this.value, [key]: v };
    try { localStorage.setItem(KEY, JSON.stringify(this.value)); } catch { /* not persisted */ }
    for (const l of this.listeners) l(this.value);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

export const settings = new SettingsStore();
