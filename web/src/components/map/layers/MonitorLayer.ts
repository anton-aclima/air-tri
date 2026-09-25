/**
 * MonitorLayer — fixed instruments: reference monitors and fenceline sensors.
 *
 * On the regulator's map a stationary monitor is not a dot: it is an asset
 * with a footprint. Reference-grade instruments draw as masts with a coverage
 * ring; low-cost fenceline sensors draw as small pucks. Orthogonal channels,
 * so none is colour-alone:
 *
 *   shape  = grade      (reference mast / FEM mast / low-cost puck)
 *   colour = owner_type (regulator / industry / community / aclima)
 *   ring   = radius_m coverage (optional — `rings`)
 *   pulse  = an exceedance is live on this instrument (or the caller's `overIds`)
 *   weight = emphasis   (optional — `emphasizeIds`: full strength, or muted;
 *                        `mutedIds`: no channel for the measure in view)
 *   label  = name, and optionally the reading at the moment shown and its
 *            ratio to the action level (`readingFor`, `ratioFor`)
 */

import { IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { TextLayerProps } from '@deck.gl/layers';
import type { LayersList, PickingInfo } from 'deck.gl';
import type { MeasureCode, Monitor, Position } from '@/core/types';
import type { Theme } from '../../lib/theme';
import { circleRing } from '../../lib/geo';
import { icon, monitorGlyph } from '../../lib/glyphs';
import { LABEL_PRIORITY, collidingText, textBox } from './labelCollision';
import type { LabelCandidate, LabelCollision } from './labelCollision';

export interface MonitorLayerProps {
  id?: string;
  data: Monitor[] | null | undefined;
  theme: Theme;
  /** 0–1 triangle wave — feed from `usePulse()`. Drives the exceedance pulse. */
  pulse?: number;
  /** Draw `radius_m` coverage rings. Default true. */
  rings?: boolean;
  /** Which measure's `latest.exceeds` decides the alarm state. */
  measure?: MeasureCode;
  /** A text label under each mark. Default true. */
  labels?: boolean;
  /**
   * What the label says. `'code'` (default) is the instrument code,
   * `47-157-0058`; `'name'` is its place, `Harbor Avenue` — the words every
   * panel and alert uses for the same instrument, so a headline can be found
   * on the map.
   */
  labelBy?: 'code' | 'name';
  /**
   * Monitors to draw at full strength, with their label. Every other monitor
   * is muted, carries its label as `mutedLabels` says, and does not pulse.
   * Omit (the default) and every monitor draws at full strength, as before;
   * an empty array mutes them all — "none is downwind" is an answer.
   */
  emphasizeIds?: readonly string[] | null;
  /**
   * How a muted monitor's name shows: `'hover'` (default: only while hovered
   * or selected) or `'dim'` (always, small and faint). The industry deck uses
   * `'dim'`: the plan names all four reference monitors, lit only when
   * downwind — hover-only left the operator's map with no monitor named at
   * all whenever the plume reached none of them.
   */
  mutedLabels?: 'hover' | 'dim';
  /**
   * The name part of the label, overriding `labelBy` — for a short form such
   * as "Riverport Rd". Return an empty string for no name.
   */
  labelFor?: (m: Monitor) => string;
  /**
   * `'upper'` (default) prints the label in capitals, as every existing map
   * does. `'asis'` prints it as given — "Riverport Rd 10.6" — which is how
   * the regulator Network keeps under its all-caps budget (R9).
   */
  labelCase?: 'upper' | 'asis';
  /**
   * The monitor's reading AT THE MOMENT SHOWN, already formatted ("10.6"),
   * appended to its name: "Riverport Rd 10.6". Return null for none.
   *
   * A callback, not `m.latest`: `/monitors` "latest" is always the end of the
   * data whatever the cursor says, so a replay would print August 28's
   * number over August 25's map. The caller reads
   * `/monitors/{id}/readings?to=<moment>` (or `/regulator/network`) and hands
   * the figure in.
   */
  readingFor?: (m: Monitor) => string | null | undefined;
  /**
   * The reading ÷ its action level. Appended as "· 0.62×" only when it is
   * `RATIO_LABEL_FROM` (0.5) or more — the plan's floor (R3): four labels
   * each carrying "· 0.11×" is the busy map again, and the panel row still
   * prints the ratio for every monitor.
   */
  ratioFor?: (m: Monitor) => number | null | undefined;
  /**
   * The monitors that are OVER a level right now. When given, this alone
   * drives the alarm pulse and the critical glyph tint; the layer never
   * infers it from `m.latest`. The caller decides "over" by the
   * same-averaging-period rule (a 1-hour reading against a 1-hour level):
   * `m.latest.exceeds` compares against MIN(threshold) across every
   * averaging period, which is how "O3 ▲" appeared beside "Ozone 8-hour
   * CLEAR" (regulator review). Omit to keep the `measure`-based behaviour.
   */
  overIds?: readonly string[] | null;
  /**
   * Monitors with no channel for the measure in view: drawn muted, never
   * pulsing, no reading, and always labelled with `mutedNote` after the name
   * ("West Shelby Dr · no NO2 channel"), in muted ink.
   */
  mutedIds?: readonly string[] | null;
  /** What a `mutedIds` monitor's label says after its name, e.g. "no NO2 channel". */
  mutedNote?: string | ((m: Monitor) => string | null | undefined);
  /**
   * Take part in a shared label-collision pass (`labelCollision()`): a site
   * name never overprints a monitor's label or mast — monitors win. Omit and
   * every label draws, as before.
   */
  collision?: LabelCollision | null;
  /**
   * Draw the label on a plate of `--bg` at 80%, 3 px either side. The SDF
   * outline alone is about a pixel: on the regulator Network at Aug 25 06:00
   * three of Riverport's plume hairlines ran straight through "120.7", the
   * one figure the map exists to show. Default false.
   */
  labelPlate?: boolean;
  /** Pixel size of the tower glyph at nominal zoom. */
  sizePx?: number;
  hoveredId?: string | null;
  selectedId?: string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;
  visible?: boolean;
  pickable?: boolean;
}

function ownerToken(owner: string): string {
  switch (owner) {
    case 'regulator': return 'tower';
    case 'industry': return 'actor-industry';
    case 'community': return 'actor-community';
    default: return 'actor-aclima';
  }
}

/** Below this ratio to its action level, a map label does not print the ratio (R3). */
export const RATIO_LABEL_FROM = 0.5;

/**
 * "0.62×", "1.03×", "1.4×", "12×" — the ratio as a map label and the panel
 * print it, or null below `RATIO_LABEL_FROM`. One formatter, so the label and
 * the panel row cannot disagree about the same monitor. Two decimals below
 * 1.1×: one decimal printed 102.9 ppb against a 100 ppb standard as "1.0×"
 * beside the over mark, which reads as "at the level", not over it.
 */
export function formatRatio(r: number | null | undefined, from = RATIO_LABEL_FROM): string | null {
  if (r === null || r === undefined || !Number.isFinite(r) || r < from) return null;
  return `${r < 1.1 ? r.toFixed(2) : r < 10 ? r.toFixed(1) : r.toFixed(0)}×`;
}

export function monitorExceeds(m: Monitor, measure?: MeasureCode): boolean {
  const latest = m.latest ?? {};
  if (measure) return Boolean(latest[measure]?.exceeds);
  return Object.values(latest).some((l) => l?.exceeds);
}

/**
 * How far a muted monitor steps back. Low enough that a lit one is the obvious
 * subject, high enough that the muted mast is still there to hover — the
 * industry deck lights only the monitors downwind of the site, and the others
 * must stay findable, not vanish.
 */
const MUTED = 0.38;

export function MonitorLayer(props: MonitorLayerProps): LayersList {
  const {
    id = 'monitors', data, theme, pulse = 0, rings = true,
    measure, labels = true, labelBy = 'code', emphasizeIds, mutedLabels = 'hover', sizePx = 34, hoveredId, selectedId,
    labelFor, labelCase = 'upper', readingFor, ratioFor, overIds, mutedIds, mutedNote, collision,
    labelPlate = false,
    onHover, onClick, visible = true, pickable = true,
  } = props;

  const monitors = (data ?? []).filter((m) => Number.isFinite(m.lon) && Number.isFinite(m.lat));
  if (!monitors.length) {
    collision?.register(id, []);
    return [];
  }

  const layers: LayersList = [];
  const withRings = monitors.filter((m) => rings && (m.radius_m ?? 0) > 0);
  const lit = emphasizeIds ? new Set(emphasizeIds) : null;
  const noChannel = mutedIds?.length ? new Set(mutedIds) : null;
  const isMuted = (m: Monitor) => Boolean(noChannel?.has(m.id));
  const isLit = (m: Monitor) => (!lit || lit.has(m.id)) && !isMuted(m);
  const over = overIds ? new Set(overIds) : null;
  // A muted monitor has no reading for this measure, so it cannot be over it,
  // whatever `latest` says about another channel.
  const isOver = (m: Monitor) => !isMuted(m) && (over ? over.has(m.id) : monitorExceeds(m, measure));
  const dimFor = (m: Monitor) =>
    (m.status === 'online' ? 1 : m.status === 'degraded' ? 0.62 : 0.34) * (isLit(m) ? 1 : MUTED);
  const litKey = [
    emphasizeIds ? [...emphasizeIds].sort().join(',') : '*',
    noChannel ? [...noChannel].sort().join(',') : '',
  ].join('/');
  const overKey = over ? [...over].sort().join(',') : `m:${measure ?? ''}`;

  // ── coverage discs ────────────────────────────────────────────────────────
  if (withRings.length) {
    layers.push(new ScatterplotLayer<Monitor>({
      id: `${id}-coverage-fill`,
      data: withRings,
      visible,
      pickable: false,
      radiusUnits: 'meters',
      stroked: false,
      filled: true,
      getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
      getRadius: (m) => m.radius_m ?? 0,
      getFillColor: (m) => theme.color(ownerToken(m.owner_type), 0.05 * dimFor(m)),
      updateTriggers: { getFillColor: [theme.css('tower'), measure, litKey] },
    }));

    // Two concentric rings — the outer at radius, the inner at 55%, so the
    // reader can judge distance inside the footprint, not just its edge.
    const ringData = withRings.flatMap((m) => [
      { m, path: circleRing([m.lon, m.lat], m.radius_m ?? 0, 72), major: true },
      { m, path: circleRing([m.lon, m.lat], (m.radius_m ?? 0) * 0.55, 56), major: false },
    ]);
    layers.push(new PathLayer<{ m: Monitor; path: Position[]; major: boolean }>({
      id: `${id}-coverage-rings`,
      data: ringData,
      visible,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (d) => d.path as unknown as Position[],
      getWidth: (d) => (d.major ? 1.4 : 1),
      getColor: (d) => theme.color(ownerToken(d.m.owner_type), (d.major ? 0.42 : 0.2) * dimFor(d.m)),
      updateTriggers: { getColor: [theme.css('tower'), litKey] },
    }));
  }

  // ── exceedance pulse ──────────────────────────────────────────────────────
  // Lit monitors only. A pulse is the loudest mark on the map, and on the
  // industry deck the muted monitors are the ones NOT downwind of the site —
  // another operator's neighbourhood. Its exceedance still tints the mast; it
  // does not get to headline this map.
  const alarmed = monitors.filter((m) => isLit(m) && isOver(m));
  if (alarmed.length) {
    layers.push(new ScatterplotLayer<Monitor>({
      id: `${id}-alarm`,
      data: alarmed,
      visible,
      pickable: false,
      radiusUnits: 'pixels',
      stroked: true,
      filled: false,
      lineWidthUnits: 'pixels',
      getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
      getRadius: sizePx * (0.72 + pulse * 0.75),
      getLineWidth: 1.6 + (1 - pulse) * 1.4,
      getLineColor: theme.color('sev-critical', 0.28 + (1 - pulse) * 0.55),
      updateTriggers: { getRadius: pulse, getLineWidth: pulse, getLineColor: pulse },
    }));
  }

  // ── ground plate, so a mast reads as standing on the map ──────────────────
  layers.push(new ScatterplotLayer<Monitor>({
    id: `${id}-base`,
    data: monitors,
    visible,
    pickable,
    radiusUnits: 'pixels',
    radiusMinPixels: 4,
    stroked: true,
    filled: true,
    lineWidthUnits: 'pixels',
    getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
    getRadius: (m) => (m.id === selectedId ? 8 : m.id === hoveredId ? 7 : 5.5),
    getFillColor: (m) => theme.color('bg', 0.9 * dimFor(m)),
    getLineWidth: 1.6,
    getLineColor: (m) => theme.color(ownerToken(m.owner_type), dimFor(m)),
    onHover,
    onClick,
    updateTriggers: {
      getRadius: [hoveredId, selectedId],
      getLineColor: [theme.css('tower'), litKey],
      getFillColor: [theme.css('bg'), litKey],
    },
  }));

  // ── the instrument itself ─────────────────────────────────────────────────
  layers.push(new IconLayer<Monitor>({
    id: `${id}-glyph`,
    data: monitors,
    visible,
    pickable,
    sizeUnits: 'pixels',
    getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
    getIcon: (m) => icon(monitorGlyph(m.grade), 'bottom'),
    getSize: (m) => sizePx * (m.grade === 'lowcost' ? 0.55 : 1) * (m.id === selectedId ? 1.18 : 1),
    getColor: (m) => (isOver(m)
      ? theme.color('sev-critical', dimFor(m))
      : theme.color(ownerToken(m.owner_type), dimFor(m))),
    onHover,
    onClick,
    updateTriggers: {
      getSize: [sizePx, selectedId],
      getColor: [measure, theme.css('tower'), theme.css('sev-critical'), litKey, overKey],
    },
  }));

  // ── labels ────────────────────────────────────────────────────────────────
  // A muted monitor is labelled only while it is the one being looked at:
  // four always-on names over a map that is meant to say "these two" is the
  // busy header all over again. A monitor with no channel for the measure is
  // the exception — "no NO2 channel" IS its label, so it always shows.
  const labelled = lit && mutedLabels === 'hover'
    ? monitors.filter((m) => lit.has(m.id) || isMuted(m) || m.id === hoveredId || m.id === selectedId)
    : monitors;

  const noteFor = (m: Monitor) => (typeof mutedNote === 'function' ? mutedNote(m) : mutedNote) ?? null;
  const textFor = (m: Monitor) => {
    const name = labelFor ? labelFor(m) : labelBy === 'name' ? (m.name || m.code || '') : (m.code ?? m.name ?? '');
    const parts = [name];
    if (isMuted(m)) {
      const note = noteFor(m);
      if (note) parts.push(name ? `· ${note}` : note);
    } else {
      const reading = readingFor?.(m);
      if (reading) parts.push(reading);
      const ratio = ratioFor ? formatRatio(ratioFor(m)) : null;
      if (ratio) parts.push(`· ${ratio}`);
    }
    const t = parts.filter(Boolean).join(' ');
    return labelCase === 'upper' ? t.toUpperCase() : t;
  };
  // Resolved once, up front: the text is both drawn and measured for the
  // collision pass, and a callback's output is the only honest update trigger.
  const texts = new Map(labelled.map((m) => [m.id, textFor(m)]));
  const textKey = [...texts.entries()].map(([k, v]) => `${k}=${v}`).join('|');

  const LABEL_SIZE = 10;
  const LABEL_OFFSET: [number, number] = [0, 12];
  const PLATE_PAD: [number, number] = [3, 1];

  if (collision) {
    const tier = (m: Monitor) => (m.grade === 'lowcost' ? LABEL_PRIORITY.sensor : LABEL_PRIORITY.monitor)
      + (m.id === selectedId ? LABEL_PRIORITY.selected : m.id === hoveredId ? LABEL_PRIORITY.hovered : 0)
      + (isOver(m) && isLit(m) ? LABEL_PRIORITY.over : 0)
      - (isLit(m) ? 0 : 100);
    const candidates: LabelCandidate[] = [];
    for (const m of monitors) {
      // The mast and its ground plate, as drawn above: the tower stencil
      // spans x 11–37 and y 3–45 of its 48-unit box, anchored at y 45.
      const g = sizePx * (m.grade === 'lowcost' ? 0.55 : 1) * (m.id === selectedId ? 1.18 : 1);
      const half = Math.max(g * 0.28, 8);
      candidates.push({
        key: `${id}:mast:${m.id}`, owner: `monitor:${m.id}`, position: [m.lon, m.lat],
        box: [-half, -g * 0.9, half, 8], priority: tier(m) + 1, fixed: true,
      });
    }
    if (labels) {
      for (const m of labelled) {
        const t = texts.get(m.id) ?? '';
        if (!t) continue;
        const b = textBox(t, LABEL_SIZE, 'middle', 'top', LABEL_OFFSET);
        const [px, py] = labelPlate ? PLATE_PAD : [0, 0];
        candidates.push({
          key: `${id}:label:${m.id}`, owner: `monitor:${m.id}`, position: [m.lon, m.lat],
          box: [b[0] - px, b[1] - py, b[2] + px, b[3] + py], priority: tier(m),
        });
      }
    }
    collision.register(id, candidates);
  }

  if (labels && labelled.length) {
    const text: Omit<TextLayerProps<Monitor>, 'id' | 'data'> = {
      getPosition: (m) => [m.lon, m.lat] as unknown as [number, number],
      getText: (m) => texts.get(m.id) ?? '',
      getSize: LABEL_SIZE,
      sizeUnits: 'pixels',
      // A hovered muted monitor reads at full strength while it is hovered —
      // a label at 38% over the basemap is not legible, which defeats the hover.
      getColor: (m) => {
        const looked = m.id === hoveredId || m.id === selectedId;
        if (isMuted(m)) return theme.color(looked ? 'ink-2' : 'ink-3', 0.9);
        return lit
          ? (isLit(m) || looked
            ? theme.color(isLit(m) ? 'ink' : 'ink-2', dimFor(m) / (isLit(m) ? 1 : MUTED))
            : theme.color('ink-3', 0.85))
          : theme.color('ink-2', dimFor(m));
      },
      getPixelOffset: LABEL_OFFSET,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      fontFamily: theme.css('font-mono') || 'monospace',
      fontWeight: 600,
      characterSet: 'auto',
      outlineWidth: 3,
      outlineColor: theme.color('bg', 0.9),
      fontSettings: { sdf: true },
      ...(labelPlate
        ? { background: true, getBackgroundColor: theme.color('bg', 0.8), backgroundPadding: PLATE_PAD }
        : {}),
      updateTriggers: {
        getText: [labelBy, textKey],
        getColor: [theme.css('ink-2'), theme.css('ink'), litKey, hoveredId, selectedId, mutedLabels],
        getBackgroundColor: theme.css('bg'),
        outlineColor: theme.css('bg'),
      },
    };
    layers.push(collidingText<Monitor>({
      id: `${id}-label`,
      items: labelled,
      keyOf: (m) => `${id}:label:${m.id}`,
      collision,
      visible,
      pickable: false,
      text,
    }));
  }

  return layers;
}
