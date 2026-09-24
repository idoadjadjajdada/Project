/** Surface materials. A surface map stores one material index per cell. */
export interface Material {
  name: string;
  color: number;
  /** Counts as water for the habitability check. */
  water?: boolean;
}

export const MATERIALS: Material[] = [
  { name: "Silicate rock", color: 0x8f8a80 },     // 0
  { name: "Basalt", color: 0x4a4541 },            // 1
  { name: "Iron", color: 0x6b5b4b },              // 2
  { name: "Iron-oxide regolith", color: 0xc4623f }, // 3
  { name: "Water", color: 0x2f73c4, water: true }, // 4
  { name: "Ice", color: 0xdfeefc, water: true },   // 5
  { name: "Vegetation", color: 0x4f8f4a },        // 6
  { name: "Sulfur", color: 0xe0c060 },            // 7
  { name: "Carbon", color: 0x2b2b2e },            // 8
  { name: "Hydrogen", color: 0xd9a86f },          // 9
  { name: "Helium", color: 0xf0d9b5 },            // 10
  { name: "Methane ice", color: 0x7fc6d9, water: false }, // 11
  { name: "Anorthosite", color: 0xb7b4ac },       // 12
  { name: "Plasma", color: 0xffc35a },            // 13
  { name: "Tholin", color: 0xa4785a },            // 14
];

export const M = {
  silicate: 0, basalt: 1, iron: 2, regolith: 3, water: 4, ice: 5, vegetation: 6,
  sulfur: 7, carbon: 8, hydrogen: 9, helium: 10, methane: 11, anorthosite: 12, plasma: 13, tholin: 14,
} as const;

export function materialColor(i: number): number {
  return (MATERIALS[i] ?? MATERIALS[0]).color;
}
