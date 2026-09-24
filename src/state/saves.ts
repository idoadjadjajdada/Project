import type { SerializedWorld } from "../sim/world";

/** Number of local save slots (the PRD leaves the count open; 8 fits the menu without scrolling on iPad). */
export const SLOT_COUNT = 8;

export interface SlotInfo {
  slot: number;
  name: string;
  savedAt: number;
  simDate: number;
  bodies: number;
}

interface Stored { info: SlotInfo; data: SerializedWorld }

const key = (slot: number) => `orbital.slot.${slot}`;

export function listSlots(): (SlotInfo | null)[] {
  return Array.from({ length: SLOT_COUNT }, (_, i) => {
    try {
      const raw = localStorage.getItem(key(i + 1));
      return raw ? (JSON.parse(raw) as Stored).info : null;
    } catch {
      return null;
    }
  });
}

/** Returns false when the browser refuses to store (quota or blocked storage). */
export function writeSlot(info: SlotInfo, data: SerializedWorld): boolean {
  try {
    localStorage.setItem(key(info.slot), JSON.stringify({ info, data } satisfies Stored));
    return true;
  } catch {
    return false;
  }
}

export function readSlot(slot: number): SerializedWorld | null {
  try {
    const raw = localStorage.getItem(key(slot));
    return raw ? (JSON.parse(raw) as Stored).data : null;
  } catch {
    return null;
  }
}
