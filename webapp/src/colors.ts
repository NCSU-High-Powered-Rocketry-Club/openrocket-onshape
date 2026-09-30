import type { Color, Material } from './types';

/** Approximate fallback colors for common OpenRocket materials. */
export const MATERIAL_COLORS: Record<string, Color> = {
  cardboard: { red: 0.78, green: 0.61, blue: 0.38, alpha: 1 },
  paper: { red: 0.92, green: 0.90, blue: 0.82, alpha: 1 },
  balsa: { red: 0.82, green: 0.65, blue: 0.40, alpha: 1 },
  birch: { red: 0.78, green: 0.62, blue: 0.38, alpha: 1 },
  plywood: { red: 0.68, green: 0.48, blue: 0.28, alpha: 1 },
  wood: { red: 0.65, green: 0.45, blue: 0.25, alpha: 1 },
  foam: { red: 0.94, green: 0.87, blue: 0.65, alpha: 1 },
  plastic: { red: 0.75, green: 0.78, blue: 0.82, alpha: 1 },
  abs: { red: 0.90, green: 0.90, blue: 0.88, alpha: 1 },
  pvc: { red: 0.85, green: 0.86, blue: 0.88, alpha: 1 },
  polystyrene: { red: 0.92, green: 0.92, blue: 0.94, alpha: 1 },
  polycarbonate: { red: 0.72, green: 0.82, blue: 0.88, alpha: 1 },
  acrylic: { red: 0.75, green: 0.88, blue: 0.92, alpha: 1 },
  delrin: { red: 0.88, green: 0.88, blue: 0.84, alpha: 1 },
  nylon: { red: 0.90, green: 0.88, blue: 0.80, alpha: 1 },
  rubber: { red: 0.20, green: 0.20, blue: 0.22, alpha: 1 },
  fiberglass: { red: 0.25, green: 0.42, blue: 0.55, alpha: 1 },
  'carbon fiber': { red: 0.12, green: 0.12, blue: 0.14, alpha: 1 },
  carbon: { red: 0.12, green: 0.12, blue: 0.14, alpha: 1 },
  kevlar: { red: 0.72, green: 0.62, blue: 0.30, alpha: 1 },
  epoxy: { red: 0.45, green: 0.38, blue: 0.28, alpha: 1 },
  aluminum: { red: 0.72, green: 0.74, blue: 0.78, alpha: 1 },
  steel: { red: 0.45, green: 0.48, blue: 0.52, alpha: 1 },
  brass: { red: 0.72, green: 0.52, blue: 0.20, alpha: 1 },
  copper: { red: 0.72, green: 0.35, blue: 0.20, alpha: 1 },
  titanium: { red: 0.48, green: 0.48, blue: 0.50, alpha: 1 },
};

function normalizeMaterialName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Return a guessed opaque color for a known material, if one is available. */
export function guessMaterialColor(material: Material | undefined): Color | undefined {
  if (!material) return undefined;
  const name = normalizeMaterialName(material.name);
  const exact = MATERIAL_COLORS[name];
  if (exact) return { ...exact };

  // Names may include grade/type details, e.g. "Fiberglass, G10, bulk".
  const match = Object.keys(MATERIAL_COLORS)
    .filter((key) => key.length >= 4)
    .sort((a, b) => b.length - a.length)
    .find((key) => name.includes(key));
  return match ? { ...MATERIAL_COLORS[match] } : undefined;
}
