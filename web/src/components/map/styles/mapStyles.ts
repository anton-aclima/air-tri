/**
 * The four map skins.
 *
 * A basemap is not decoration here — it is the substrate the road grid has to
 * burn through. So each skin is derived from the *role tokens*, not authored
 * separately: the same function produces a MapLibre restyle and a Google Maps
 * style array, and both get their colours from `tokens.css`.
 *
 *   light      community  — warm paper, generous, nothing technical
 *   dark       regulator  — tactical, instrumented, roads recede to line-weight
 *   night      industry   — near-black with a phosphor cast; the grid is the light
 *   blueprint  admin      — drafting-table blue on ink, hairline everything
 */

import type { MapSkin, Theme } from '../../lib/theme';
import { mix, parseColor, rgbaCss, withAlpha } from '../../lib/theme';

/** Keyless CARTO bases. No token, no account, always renders. */
export const BASE_STYLE_URL: Record<MapSkin, string> = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  night: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  blueprint: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};

export interface SkinPalette {
  background: string;
  water: string;
  waterLabel: string;
  land: string;
  park: string;
  building: string;
  buildingOutline: string;
  roadCasing: string;
  roadMinor: string;
  roadMajor: string;
  roadMotorway: string;
  boundary: string;
  label: string;
  labelStrong: string;
  labelHalo: string;
  /** Hide point-of-interest symbols — noise under a data grid. */
  hidePoi: boolean;
  /** Hide street-name labels; the inspector names the street instead. */
  hideRoadLabels: boolean;
}

/**
 * Skin → colour set, entirely from tokens.
 *
 * `mix` is used to place a basemap element *between* two tokens (a road that
 * should sit above the background but below the ink) so we never invent a hex.
 */
export function skinPalette(theme: Theme, skin: MapSkin): SkinPalette {
  const bg = theme.color('bg');
  const sunk = theme.color('bg-sunk');
  const surface = theme.color('surface');
  const line = theme.color('line');
  const lineStrong = theme.color('line-strong');
  const ink3 = theme.color('ink-3');
  const ink2 = theme.color('ink-2');
  const accent = theme.color('accent');
  const accent2 = theme.color('accent-2');

  /**
   * Terrain, from its own tokens.
   *
   * Every skin used to derive water and parks by mixing the ground a few
   * percent toward `--accent`, which made them invisible — and under the
   * industry skin `--accent-2` is amber, so the honest fix of "use the other
   * hue" would have painted an amber Mississippi. Terrain is not a severity and
   * not an actor; it gets `--map-water` / `--map-green` / `--map-urban`.
   *
   * These are the one part of the basemap allowed to be *legible*, because they
   * are what answers "what is my plume actually over" — and that question does
   * not stop at the campaign boundary, so they are not clipped to it.
   */
  const water = theme.css('map-water');
  const green = theme.css('map-green');
  const urban = theme.css('map-urban');

  switch (skin) {
    // Community. Warm paper. Roads are white lanes on ivory; water is a soft
    // wash of the role accent so the map feels made, not generated.
    case 'light':
      return {
        background: rgbaCss(bg),
        water,
        waterLabel: rgbaCss(withAlpha(mix(ink2, accent, 0.25), 0.95)),
        land: urban,
        park: green,
        building: rgbaCss(withAlpha(mix(bg, lineStrong, 0.38), 0.55)),
        buildingOutline: rgbaCss(withAlpha(lineStrong, 0.35)),
        roadCasing: rgbaCss(withAlpha(line, 0.9)),
        roadMinor: rgbaCss(surface),
        roadMajor: rgbaCss(surface),
        roadMotorway: rgbaCss(mix(surface, lineStrong, 0.18)),
        boundary: rgbaCss(withAlpha(lineStrong, 0.7)),
        label: rgbaCss(withAlpha(ink2, 0.85)),
        labelStrong: rgbaCss(withAlpha(theme.color('ink'), 0.92)),
        labelHalo: rgbaCss(withAlpha(bg, 0.95)),
        hidePoi: true,
        hideRoadLabels: false,
      };

    // Regulator. A watchtower console: everything that is not data drops to
    // line-weight, so the grid and the towers own the screen.
    case 'dark':
      return {
        background: rgbaCss(sunk),
        water,
        waterLabel: rgbaCss(withAlpha(ink2, 0.88)),
        land: urban,
        park: green,
        building: rgbaCss(withAlpha(surface, 0.75)),
        buildingOutline: rgbaCss(withAlpha(line, 0.6)),
        roadCasing: rgbaCss(withAlpha(sunk, 0.9)),
        roadMinor: rgbaCss(withAlpha(line, 0.85)),
        roadMajor: rgbaCss(lineStrong),
        roadMotorway: rgbaCss(mix(lineStrong, ink3, 0.3)),
        boundary: rgbaCss(withAlpha(lineStrong, 0.8)),
        label: rgbaCss(withAlpha(ink3, 0.9)),
        labelStrong: rgbaCss(withAlpha(theme.color('ink'), 0.92)),
        labelHalo: rgbaCss(withAlpha(sunk, 0.85)),
        hidePoi: true,
        hideRoadLabels: false,
      };

    // Industry. Near-black. The roads are barely there; a phosphor cast on the
    // land is the only tint, so any lit segment reads as a signal.
    case 'night':
      return {
        background: rgbaCss(sunk),
        water,
        waterLabel: rgbaCss(withAlpha(ink2, 0.85)),
        land: urban,
        park: green,
        building: rgbaCss(withAlpha(surface, 0.55)),
        buildingOutline: rgbaCss(withAlpha(mix(line, accent, 0.15), 0.5)),
        roadCasing: rgbaCss(withAlpha(sunk, 0.95)),
        roadMinor: rgbaCss(withAlpha(mix(line, accent, 0.1), 0.7)),
        roadMajor: rgbaCss(withAlpha(mix(line, accent, 0.2), 0.9)),
        roadMotorway: rgbaCss(withAlpha(mix(lineStrong, accent, 0.22), 0.95)),
        boundary: rgbaCss(withAlpha(mix(lineStrong, accent, 0.3), 0.7)),
        label: rgbaCss(withAlpha(mix(ink3, accent, 0.3), 0.72)),
        labelStrong: rgbaCss(withAlpha(theme.color('ink'), 0.92)),
        labelHalo: rgbaCss(withAlpha(sunk, 0.9)),
        hidePoi: true,
        hideRoadLabels: true,
      };

    // Admin. Drafting table: blueprint-blue linework on ink, every element the
    // same weight, nothing styled for comfort.
    case 'blueprint':
    default:
      return {
        background: rgbaCss(sunk),
        water,
        waterLabel: rgbaCss(withAlpha(ink2, 0.9)),
        land: urban,
        park: green,
        building: rgbaCss(withAlpha(mix(bg, accent2, 0.1), 0.6)),
        buildingOutline: rgbaCss(withAlpha(accent2, 0.28)),
        roadCasing: rgbaCss(withAlpha(sunk, 0.85)),
        roadMinor: rgbaCss(withAlpha(accent2, 0.24)),
        roadMajor: rgbaCss(withAlpha(accent2, 0.42)),
        roadMotorway: rgbaCss(withAlpha(accent2, 0.6)),
        boundary: rgbaCss(withAlpha(accent2, 0.5)),
        label: rgbaCss(withAlpha(ink3, 0.85)),
        labelStrong: rgbaCss(withAlpha(theme.color('ink'), 0.92)),
        labelHalo: rgbaCss(withAlpha(sunk, 0.9)),
        hidePoi: true,
        hideRoadLabels: false,
      };
  }
}

// ───────────────────────────────────────────────────────────── MapLibre

type StyleLayer = { id: string; type: string };
/** The slice of the MapLibre map API this module needs. Keeps maplibre-gl out. */
export interface StyleTarget {
  getStyle(): { layers?: StyleLayer[] } | undefined;
  setPaintProperty(layerId: string, name: string, value: unknown): unknown;
  setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
}

type Kind =
  | 'background' | 'water' | 'land' | 'park' | 'building'
  | 'road-casing' | 'road-minor' | 'road-major' | 'road-motorway'
  | 'boundary' | 'label-place' | 'label-road' | 'label-water' | 'label-poi' | 'other';

function classify(id: string, type: string): Kind {
  const s = id.toLowerCase();
  if (type === 'background') return 'background';
  if (type === 'symbol') {
    if (s.includes('poi')) return 'label-poi';
    if (s.includes('water') || s.includes('ocean')) return 'label-water';
    if (s.includes('road') || s.includes('highway') || s.includes('street')) return 'label-road';
    return 'label-place';
  }
  if (s.includes('water') || s.includes('ocean') || s.includes('river')) return 'water';
  if (s.includes('park') || s.includes('wood') || s.includes('grass') || s.includes('landcover')) return 'park';
  if (s.includes('building')) return 'building';
  if (s.includes('boundary') || s.includes('admin')) return 'boundary';
  if (s.includes('casing')) return 'road-casing';
  if (s.includes('motorway') || s.includes('trunk')) return 'road-motorway';
  if (s.includes('major') || s.includes('primary') || s.includes('secondary')) return 'road-major';
  if (s.includes('highway') || s.includes('road') || s.includes('tunnel')
    || s.includes('bridge') || s.includes('street') || s.includes('path')
    || s.includes('aeroway') || s.includes('rail')) return 'road-minor';
  if (s.includes('landuse') || s.includes('land')) return 'land';
  return 'other';
}

const PAINT: Record<string, string> = {
  fill: 'fill-color', line: 'line-color', background: 'background-color',
  symbol: 'text-color', circle: 'circle-color',
};

/**
 * Recolour a loaded CARTO style in place from the role tokens.
 * Safe to call repeatedly — it is idempotent and skips unknown layers.
 */
export function applyMapLibreSkin(map: StyleTarget, theme: Theme, skin: MapSkin): void {
  const p = skinPalette(theme, skin);
  let layers: StyleLayer[] = [];
  try {
    layers = map.getStyle()?.layers ?? [];
  } catch {
    return;
  }

  const set = (id: string, name: string, value: unknown) => {
    try { map.setPaintProperty(id, name, value); } catch { /* layer lacks that prop */ }
  };
  const hide = (id: string) => {
    try { map.setLayoutProperty(id, 'visibility', 'none'); } catch { /* ignore */ }
  };

  for (const layer of layers) {
    const kind = classify(layer.id, layer.type);
    const prop = PAINT[layer.type];
    if (!prop) continue;

    switch (kind) {
      case 'background': set(layer.id, prop, p.background); break;
      case 'water': set(layer.id, prop, p.water); break;
      case 'park': set(layer.id, prop, p.park); break;
      case 'land': set(layer.id, prop, p.land); break;
      case 'building':
        set(layer.id, prop, p.building);
        set(layer.id, 'fill-outline-color', p.buildingOutline);
        break;
      case 'road-casing': set(layer.id, prop, p.roadCasing); break;
      case 'road-minor': set(layer.id, prop, p.roadMinor); break;
      case 'road-major': set(layer.id, prop, p.roadMajor); break;
      case 'road-motorway': set(layer.id, prop, p.roadMotorway); break;
      case 'boundary': set(layer.id, prop, p.boundary); break;
      case 'label-poi':
        if (p.hidePoi) hide(layer.id);
        else set(layer.id, 'text-color', p.label);
        break;
      case 'label-road':
        if (p.hideRoadLabels) hide(layer.id);
        else {
          set(layer.id, 'text-color', p.label);
          set(layer.id, 'text-halo-color', p.labelHalo);
        }
        break;
      case 'label-water':
        set(layer.id, 'text-color', p.waterLabel);
        set(layer.id, 'text-halo-color', p.labelHalo);
        break;
      case 'label-place':
        set(layer.id, 'text-color', p.labelStrong);
        set(layer.id, 'text-halo-color', p.labelHalo);
        break;
      default: break;
    }
  }
}

// ───────────────────────────────────────────────────────────── Google Maps

/** Structurally compatible with `google.maps.MapTypeStyle`. */
export interface GoogleStyleRule {
  featureType?: string;
  elementType?: string;
  stylers: Record<string, string | number>[];
}

/** Google wants `#rrggbb`; it has no alpha channel in styler colours. */
function flat(color: string, over: string): string {
  const c = parseColor(color);
  const bg = parseColor(over);
  const a = c[3] / 255;
  const f = mix(bg, [c[0], c[1], c[2], 255], a);
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(f[0])}${hex(f[1])}${hex(f[2])}`;
}

/**
 * The same four skins as a Google Maps style array.
 *
 * Note: when `VITE_GOOGLE_MAPS_MAP_ID` is set, Google ignores `styles` and uses
 * the cloud-configured Map ID instead — so a deployment that wants these exact
 * colours should leave the Map ID unset (or replicate them in Cloud Console).
 */
export function googleMapStyles(theme: Theme, skin: MapSkin): GoogleStyleRule[] {
  const p = skinPalette(theme, skin);
  const over = p.background;
  const c = (v: string) => flat(v, over);

  const rules: GoogleStyleRule[] = [
    { elementType: 'geometry', stylers: [{ color: c(p.land) }] },
    { elementType: 'labels.text.fill', stylers: [{ color: c(p.label) }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: c(p.labelHalo) }] },
    { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: c(p.water) }] },
    { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: c(p.waterLabel) }] },
    { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: c(p.park) }] },
    { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: c(p.park) }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: c(p.roadCasing) }] },
    { featureType: 'road.local', elementType: 'geometry.fill', stylers: [{ color: c(p.roadMinor) }] },
    { featureType: 'road.arterial', elementType: 'geometry.fill', stylers: [{ color: c(p.roadMajor) }] },
    { featureType: 'road.highway', elementType: 'geometry.fill', stylers: [{ color: c(p.roadMotorway) }] },
    { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: c(p.boundary) }] },
    { featureType: 'administrative.locality', elementType: 'labels.text.fill', stylers: [{ color: c(p.labelStrong) }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  ];

  if (p.hidePoi) {
    rules.push({ featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] });
    rules.push({ featureType: 'poi.business', stylers: [{ visibility: 'off' }] });
  }
  if (p.hideRoadLabels) {
    rules.push({ featureType: 'road', elementType: 'labels', stylers: [{ visibility: 'off' }] });
  }
  return rules;
}
