/**
 * Icon masks for deck.gl `IconLayer`.
 *
 * These are pure ALPHA MASKS — solid white shapes on transparent, rendered with
 * `mask: true` so deck.gl tints them from `getColor`. That is what keeps every
 * map mark's colour coming from a design token: the SVG carries the *shape*,
 * tokens carry the *colour*. The `#fff` below is a stencil, not a colour choice.
 */

const W = 48;

function uri(body: string, viewBox = `0 0 ${W} ${W}`): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${W}" height="${W}" fill="#fff">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A reference-grade monitor: a real mast. Reads as a tower at 24px. */
const TOWER = uri(`
  <path d="M24 3 L27 11 L21 11 Z"/>
  <rect x="22.6" y="9" width="2.8" height="18"/>
  <path d="M24 26 L37 45 L33.5 45 L24 31 L14.5 45 L11 45 Z"/>
  <rect x="16" y="34" width="16" height="2.2"/>
  <rect x="13" y="40" width="22" height="2.2"/>
  <rect x="18.5" y="16" width="11" height="2"/>
  <rect x="20" y="21" width="8" height="2"/>
`);

/** A federal-equivalent monitor: shorter mast, boxed head. */
const MAST = uri(`
  <rect x="18" y="6" width="12" height="9" rx="1.5"/>
  <rect x="22.6" y="14" width="2.8" height="22"/>
  <path d="M24 35 L34 45 L14 45 Z"/>
  <rect x="15" y="41" width="18" height="2.2"/>
`);

/** A low-cost sensor: a small hexagonal puck. */
const PUCK = uri(`
  <path d="M24 8 L37 15.5 L37 30.5 L24 38 L11 30.5 L11 15.5 Z"/>
`);

/** Emission stack. */
const STACK = uri(`
  <path d="M17 45 L20 12 L28 12 L31 45 Z"/>
  <rect x="18" y="6" width="12" height="5" rx="1"/>
`);

/** Cooling tower — hyperboloid silhouette. */
const COOLING = uri(`
  <path d="M14 45 C14 32 20 28 20 22 L20 9 L28 9 L28 22 C28 28 34 32 34 45 Z"/>
`);

/** Backup generator / genset — a boxy unit. */
const GENSET = uri(`
  <rect x="9" y="18" width="30" height="18" rx="2"/>
  <rect x="14" y="11" width="6" height="8" rx="1"/>
  <rect x="12" y="36" width="4" height="5"/>
  <rect x="32" y="36" width="4" height="5"/>
`);

/** Substation. */
const SUBSTATION = uri(`
  <path d="M24 5 L31 22 L26 22 L33 43 L17 22 L22 22 Z"/>
`);

/** Traffic gate. */
const GATE = uri(`
  <rect x="8" y="21" width="34" height="5" rx="1.5"/>
  <rect x="6" y="14" width="6" height="26" rx="1.5"/>
`);

/** Vehicle — a directional chevron so heading reads instantly. */
const VEHICLE = uri(`
  <path d="M24 5 L38 40 L24 32 L10 40 Z"/>
`);

/** Site anchor — a claimed industry footprint. */
const SITE = uri(`
  <path d="M24 4 L42 14 L42 38 L24 46 L6 38 L6 14 Z" fill-opacity="0"/>
  <path d="M24 4 L42 14 L42 38 L24 46 L6 38 L6 14 Z M24 10 L12 17 L12 34 L24 39 L36 34 L36 17 Z"/>
`);

// ── concern kinds — geometric, legible at 20px, never reliant on colour ──
const SMELL = uri(`
  <path d="M12 34 C18 34 18 26 24 26 C30 26 30 34 36 34" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round"/>
  <path d="M12 24 C18 24 18 16 24 16 C30 16 30 24 36 24" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round"/>
  <path d="M14 43 C19 43 19 37 24 37 C29 37 29 43 34 43" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round"/>
`);
const NOISE = uri(`
  <path d="M10 19 h7 L27 9 v30 L17 29 h-7 Z"/>
  <path d="M32 16 C37 20 37 28 32 32" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round"/>
  <path d="M37 11 C45 18 45 30 37 37" stroke="#fff" stroke-width="3.2" fill="none" stroke-linecap="round"/>
`);
const SMOKE = uri(`
  <path d="M15 38 C9 38 6 34 6 30 C6 25 10 22 14 22 C15 15 21 10 28 10 C36 10 42 16 42 24 C42 24 44 26 44 30 C44 34 41 38 36 38 Z"/>
`);
const DUST = uri(`
  <circle cx="14" cy="14" r="3.4"/><circle cx="27" cy="10" r="2.6"/>
  <circle cx="36" cy="17" r="3.6"/><circle cx="19" cy="25" r="2.8"/>
  <circle cx="31" cy="29" r="3.2"/><circle cx="13" cy="35" r="3"/>
  <circle cx="25" cy="39" r="2.4"/><circle cx="38" cy="36" r="2.6"/>
`);
const HEALTH = uri(`
  <path d="M24 12 v14"/>
  <rect x="22.4" y="8" width="3.2" height="18"/>
  <path d="M22 24 C22 34 17 38 12 40 C9 41 7 39 7 35 C7 27 12 22 18 21 Z"/>
  <path d="M26 24 C26 34 31 38 36 40 C39 41 41 39 41 35 C41 27 36 22 30 21 Z"/>
`);
const LIGHT = uri(`
  <path d="M24 6 C31 6 36 11 36 18 C36 24 31 26 30 32 L18 32 C17 26 12 24 12 18 C12 11 17 6 24 6 Z"/>
  <rect x="18" y="35" width="12" height="3.4" rx="1.2"/>
  <rect x="20" y="40" width="8" height="3.2" rx="1.2"/>
`);
const TRAFFIC = uri(`
  <path d="M5 30 L5 16 L26 16 L26 30 Z"/>
  <path d="M28 30 L28 20 L36 20 L43 27 L43 30 Z"/>
  <circle cx="13" cy="34" r="4.6"/><circle cx="35" cy="34" r="4.6"/>
`);
const VIBRATION = uri(`
  <path d="M5 24 L12 24 L16 12 L22 36 L28 14 L33 30 L37 24 L43 24" stroke="#fff" stroke-width="3.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
`);
const OTHER = uri(`
  <path d="M24 6 C31 6 36 11 36 17 C36 23 30 25 27 28 C25.6 29.4 25.6 31 25.6 33 L22 33 C22 29.6 22.6 27.6 25 25.4 C27.6 23 31.6 21.6 31.6 17.6 C31.6 13.6 28.4 10.6 24 10.6 C19.6 10.6 16.4 13.6 16.4 18 L12 18 C12 11 17 6 24 6 Z"/>
  <circle cx="23.8" cy="40" r="3.4"/>
`);

/** Cluster badge — a ring the count is drawn inside. */
const CLUSTER = uri(`
  <path d="M24 3 A21 21 0 1 1 23.9 3 Z M24 10 A14 14 0 1 0 24.1 10 Z"/>
`);

export const GLYPH = {
  tower: TOWER, mast: MAST, puck: PUCK,
  stack: STACK, cooling: COOLING, genset: GENSET, substation: SUBSTATION, gate: GATE,
  vehicle: VEHICLE, site: SITE, cluster: CLUSTER,
  smell: SMELL, noise: NOISE, smoke: SMOKE, dust: DUST, health: HEALTH,
  light: LIGHT, traffic: TRAFFIC, vibration: VIBRATION, other: OTHER,
} as const;

export type GlyphName = keyof typeof GLYPH;

export interface IconSpec {
  url: string; width: number; height: number;
  anchorX: number; anchorY: number; mask: boolean;
  id: string;
}

/** deck.gl `getIcon` payload for a named glyph. `bottom` anchors a mast to the ground. */
export function icon(name: GlyphName, anchor: 'center' | 'bottom' = 'center'): IconSpec {
  return {
    id: `${name}-${anchor}`,
    url: GLYPH[name],
    width: W, height: W,
    anchorX: W / 2,
    anchorY: anchor === 'bottom' ? W - 3 : W / 2,
    mask: true,
  };
}

export function monitorGlyph(grade: string): GlyphName {
  return grade === 'reference' ? 'tower' : grade === 'fem' ? 'mast' : 'puck';
}

export function emissionGlyph(kind: string): GlyphName {
  switch (kind) {
    case 'generator': return 'genset';
    case 'cooling_tower': return 'cooling';
    case 'backup': return 'genset';
    case 'stack': return 'stack';
    case 'traffic_gate': return 'gate';
    case 'substation': return 'substation';
    default: return 'stack';
  }
}

export function concernGlyph(kind: string): GlyphName {
  return (kind in GLYPH ? kind : 'other') as GlyphName;
}
