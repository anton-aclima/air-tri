/**
 * SiteLayer — industry footprints and their emission points.
 *
 * A claimed site is a *branded* object: it wears its own `brand_color` and
 * `logo_emoji` (both come from the data, so this is the one place on the map
 * where a colour is not a token — it is an operator's identity). Everything
 * around it — strokes, labels, inactive states — still comes from tokens.
 */

import { IconLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { EmissionPoint, IndustrySite, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';
import { parseColor, withAlpha } from '../../lib/theme';
import { toPolygons } from '../../lib/geo';
import { emissionGlyph, icon } from '../../lib/glyphs';

export interface SiteLayerProps {
  id?: string;
  data: IndustrySite[] | null | undefined;
  theme: Theme;
  /** Draw emission points. Default true. */
  emissionPoints?: boolean;
  /** Site name labels. Default true. */
  labels?: boolean;
  /** Brand emoji beside the label. Default true. */
  branding?: boolean;
  /**
   * `'fill'` (default): a brand-coloured wash under a brand-coloured edge.
   * `'outline'`: a single neutral `--ink-2` edge, no wash, no brand colour —
   * for maps where CONTRACT §10b makes measurement the only filled or inked
   * thing. On the industry deck the washed campus was the loudest shape
   * beside the plume it emits, and then its orange brand edge (Ridgeline's
   * #C9773A, a long thin polygon) read as one more hot measured street, one
   * of five things drawn orange (phase 3 review). The footprint stays
   * clickable either way.
   */
  footprint?: 'fill' | 'outline';
  /** 0–1 pulse — active emission points breathe. Feed from `usePulse()`. */
  pulse?: number;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible?: boolean;
  pickable?: boolean;
}

/** Anything with a pictographic codepoint renders in its own colours. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

type Ring = { site: IndustrySite; polygon: Position[] };
type Outline = { site: IndustrySite; path: Position[] };
type Point = { point: EmissionPoint; site: IndustrySite };

/**
 * Unwrap whatever `SiteLayer` just handed back from a click.
 *
 * The layer is pickable in three places and each returns a DIFFERENT shape:
 * the footprint fill returns a `Ring` (`{site, polygon}`), an emission point
 * returns a `Point` (`{point, site}`), and the brand badge returns the
 * `IndustrySite` itself. Only the last of those has an `id` on it, so a caller
 * reading `info.object.id` silently gets `undefined` for two of the three — the
 * footprint, which is by far the biggest target, does nothing at all. Both the
 * community map and the industry scope had that bug.
 *
 * Knowing the shapes belongs next to the code that makes them, not copied into
 * every screen that draws a site.
 */
export function pickedSite(obj: unknown): { siteId: string | null; emissionPointId: string | null } {
  const o = obj as {
    id?: unknown;
    site?: { id?: unknown };
    point?: { id?: unknown };
  } | null;
  if (!o) return { siteId: null, emissionPointId: null };
  const siteId = typeof o.site?.id === 'string' ? o.site.id
    : typeof o.id === 'string' ? o.id
    : null;
  return {
    siteId,
    emissionPointId: typeof o.point?.id === 'string' ? o.point.id : null,
  };
}

/** A site's own brand colour, or the industry actor token when it has none. */
function brand(theme: Theme, site: IndustrySite, alpha?: number) {
  const c = site.brand_color ? parseColor(site.brand_color) : theme.color('actor-industry');
  return alpha === undefined ? c : withAlpha(c, alpha);
}

const STATUS_ALPHA: Record<string, number> = {
  operating: 1, construction: 0.72, permitting: 0.5, proposed: 0.38,
};

export function SiteLayer(props: SiteLayerProps): LayersList {
  const {
    id = 'sites', data, theme, emissionPoints = true, labels = true, branding = true,
    footprint = 'fill', pulse = 0, hoveredId, selectedId, onHover, onClick, visible = true, pickable = true,
  } = props;

  const sites = data ?? [];
  if (!sites.length) return [];

  const rings: Ring[] = [];
  const outlines: Outline[] = [];
  for (const site of sites) {
    for (const poly of toPolygons(site.footprint)) {
      if (!poly.length) continue;
      rings.push({ site, polygon: poly[0] });
      for (const r of poly) outlines.push({ site, path: r });
    }
  }

  const points: Point[] = emissionPoints
    ? sites.flatMap((site) => (site.emission_points ?? []).map((point) => ({ point, site })))
    : [];

  const dim = (s: IndustrySite) => STATUS_ALPHA[s.status] ?? 0.6;
  const layers: LayersList = [];

  // ── footprint fill ────────────────────────────────────────────────────────
  if (rings.length) {
    layers.push(new PolygonLayer<Ring>({
      id: `${id}-fill`,
      data: rings,
      visible,
      pickable,
      stroked: false,
      filled: true,
      getPolygon: (d) => d.polygon as unknown as Position[],
      // Alpha 0 in 'outline' rather than no layer: deck still picks a
      // transparent polygon, and the footprint is by far the biggest target.
      getFillColor: (d) => brand(
        theme, d.site, footprint === 'outline' ? 0 : (d.site.id === selectedId ? 0.34 : 0.2) * dim(d.site),
      ),
      onHover,
      onClick,
      updateTriggers: { getFillColor: [selectedId, theme.css('actor-industry'), footprint] },
    }));

    // Two-pass edge: a soft outer wash then a crisp 1.5px line — reads drawn
    // rather than filled, which is what stops a big polygon dominating the grid.
    // 'outline' drops the wash and the brand colour: one neutral hairline.
    const neutral = footprint === 'outline';
    if (!neutral) {
      layers.push(new PathLayer<Outline>({
        id: `${id}-edge-soft`,
        data: outlines,
        visible,
        pickable: false,
        widthUnits: 'pixels',
        getPath: (d) => d.path as unknown as Position[],
        getWidth: 6,
        getColor: (d) => brand(theme, d.site, 0.16 * dim(d.site)),
        updateTriggers: { getColor: theme.css('actor-industry') },
      }));
    }
    layers.push(new PathLayer<Outline>({
      id: `${id}-edge`,
      data: outlines,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (d) => d.path as unknown as Position[],
      getWidth: (d) => (d.site.id === selectedId || d.site.id === hoveredId
        ? (neutral ? 2 : 2.4)
        : (neutral ? 1.25 : 1.5)),
      getColor: (d) => (neutral
        ? theme.color('ink-2', 0.75 * dim(d.site))
        : brand(theme, d.site, 0.95 * dim(d.site))),
      updateTriggers: {
        getWidth: [selectedId, hoveredId, footprint],
        getColor: [theme.css('actor-industry'), theme.css('ink-2'), footprint],
      },
    }));
  }

  // ── emission points ───────────────────────────────────────────────────────
  if (points.length) {
    const active = points.filter((p) => p.point.active);
    if (active.length) {
      layers.push(new ScatterplotLayer<Point>({
        id: `${id}-emit-pulse`,
        data: active,
        visible,
        pickable: false,
        radiusUnits: 'pixels',
        stroked: true,
        filled: false,
        lineWidthUnits: 'pixels',
        getPosition: (d) => [d.point.lon, d.point.lat] as unknown as [number, number],
        getRadius: 12 + pulse * 10,
        getLineWidth: 1.2,
        getLineColor: theme.color('accent-2', 0.42 * (1 - pulse)),
        updateTriggers: { getRadius: pulse, getLineColor: pulse },
      }));
    }
    layers.push(new IconLayer<Point>({
      id: `${id}-emit`,
      data: points,
      visible,
      pickable,
      sizeUnits: 'pixels',
      getPosition: (d) => [d.point.lon, d.point.lat] as unknown as [number, number],
      getIcon: (d) => icon(emissionGlyph(d.point.kind), 'bottom'),
      getSize: 22,
      getColor: (d) => (d.point.active
        ? theme.color('accent-2', 0.95)
        : theme.color('ink-3', 0.7)),
      onHover,
      onClick,
      updateTriggers: { getColor: [theme.css('accent-2'), theme.css('ink-3')] },
    }));
  }

  // ── labels ────────────────────────────────────────────────────────────────
  if (labels) {
    layers.push(new TextLayer<IndustrySite>({
      id: `${id}-label`,
      data: sites,
      visible,
      pickable: false,
      getPosition: (s) => s.centroid as unknown as [number, number],
      getText: (s) => s.name.toUpperCase(),
      getSize: 11,
      sizeUnits: 'pixels',
      getColor: (s) => theme.color('ink', dim(s)),
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      getPixelOffset: [0, 14],
      fontFamily: theme.css('font-mono') || 'monospace',
      fontWeight: 700,
      characterSet: 'auto',
      outlineWidth: 3.5,
      outlineColor: theme.color('bg', 0.92),
      fontSettings: { sdf: true },
      updateTriggers: { getColor: theme.css('ink'), outlineColor: theme.css('bg') },
    }));
  }

  if (branding) {
    const badged = sites.filter((s) => Boolean(s.logo_emoji));
    if (badged.length) {
      layers.push(new TextLayer<IndustrySite>({
        id: `${id}-brand`,
        data: badged,
        visible,
        pickable,
        getPosition: (s) => s.centroid as unknown as [number, number],
        getText: (s) => s.logo_emoji ?? '',
        getSize: 20,
        sizeUnits: 'pixels',
        /*
          A COLOUR emoji ignores this tint and renders in its own colours, so
          white was fine for ⚒️ and 🚚. A geometric glyph does not: Ridgeline's
          badge is `▲`, a plain character, and hardcoded white painted it white
          on the community skin's light background — invisible, and therefore
          unhittable. Tint only the glyphs that actually take a tint.
        */
        getColor: (s) => (PICTOGRAPHIC.test(s.logo_emoji ?? '')
          ? [255, 255, 255, 255]
          : theme.color('ink', dim(s))),
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        getPixelOffset: [0, -8],
        characterSet: 'auto',
        fontSettings: { sdf: false },
        updateTriggers: { getColor: theme.css('ink') },
        onHover,
        onClick,
      }));
    }
  }

  return layers;
}
