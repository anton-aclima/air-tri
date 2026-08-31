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
  /** 0–1 pulse — active emission points breathe. Feed from `usePulse()`. */
  pulse?: number;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible?: boolean;
  pickable?: boolean;
}

type Ring = { site: IndustrySite; polygon: Position[] };
type Outline = { site: IndustrySite; path: Position[] };
type Point = { point: EmissionPoint; site: IndustrySite };

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
    pulse = 0, hoveredId, selectedId, onHover, onClick, visible = true, pickable = true,
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
      getFillColor: (d) => brand(theme, d.site, (d.site.id === selectedId ? 0.34 : 0.2) * dim(d.site)),
      onHover,
      onClick,
      updateTriggers: { getFillColor: [selectedId, theme.css('actor-industry')] },
    }));

    // Two-pass edge: a soft outer wash then a crisp 1.5px line — reads drawn
    // rather than filled, which is what stops a big polygon dominating the grid.
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
    layers.push(new PathLayer<Outline>({
      id: `${id}-edge`,
      data: outlines,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (d) => d.path as unknown as Position[],
      getWidth: (d) => (d.site.id === selectedId || d.site.id === hoveredId ? 2.4 : 1.5),
      getColor: (d) => brand(theme, d.site, 0.95 * dim(d.site)),
      updateTriggers: {
        getWidth: [selectedId, hoveredId],
        getColor: theme.css('actor-industry'),
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
        getColor: [255, 255, 255, 255],
        getTextAnchor: 'middle',
        getAlignmentBaseline: 'center',
        getPixelOffset: [0, -8],
        characterSet: 'auto',
        fontSettings: { sdf: false },
        onHover,
        onClick,
      }));
    }
  }

  return layers;
}
