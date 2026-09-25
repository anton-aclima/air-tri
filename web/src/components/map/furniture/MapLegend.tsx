/**
 * MapLegend — reads the road grid.
 *
 * Two channels, so the legend documents two things:
 *   HOW MUCH  → hue, the role's `--ramp-map-*`
 *   HOW OFTEN → weight, the persistence channel
 *
 * The dual-encoding key is not decoration: without it "thick" looks like
 * "important" instead of "over the reference level on most passes". It is drawn
 * as three miniature road strokes, which is the same mark the map uses.
 *
 * Optional rows, each drawn with the layer's own mark: `fewPassesNote` (the
 * thin few-pass stroke) and `contextNote` (the neutral `tone: 'context'`
 * hairline). `empty` swaps the ramp for one sentence when the window shown
 * has no streets, and `control` places a switch that belongs to this key.
 */

import { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { MeasureDef, SegmentMetric } from '@/core/types';
import { INDEX_DOMAIN, METRIC_LABEL_SHORT, metricIsUnitless, plainName, unitFor } from '@/core/measures';
import { fmtNum } from '@/core/format';
import { useTheme } from '../../lib/theme';
import type { ColorScale } from '../../lib/scales';
import { persistenceWidth } from '../../lib/scales';
import { CONTEXT_STROKE, fewPassAlpha } from '../layers/SegmentLayer';
import type { DualEncoding } from '../layers/SegmentLayer';
import s from './furniture.module.css';

export interface MapLegendProps {
  /** The scale the `SegmentLayer` is using. Supply this and domain/stops follow. */
  scale?: ColorScale | null;
  /** Fallback when no scale is given. */
  domain?: [number, number];
  measure?: MeasureDef | null;
  metric?: SegmentMetric;
  /** Which persistence channel the map is using — drives the key. */
  dualEncode?: DualEncoding;
  /** Community framing: plain names, no units, no acronyms. */
  plainLanguage?: boolean;
  /** Show the "not enough passes" swatch. Default true. */
  showNoData?: boolean;
  /**
   * A row for `SegmentLayer`'s `fewPassesBelow` streets — a thin stroke in
   * the ramp colour beside this note, e.g. "thin: 2–3 passes that day".
   * Omit for no row (the default).
   */
  fewPassesNote?: string | null;
  /**
   * A row for a `SegmentLayer({ tone: 'context' })` grid drawn under the
   * coloured one — its own neutral hairline beside this note, e.g. "grey:
   * measured earlier, not in this window". Omit for no row (the default).
   * Still shown when `empty` is set: the context grid is on the map either way.
   */
  contextNote?: string | null;
  /**
   * The window has no streets. When set, this one line replaces the ramp,
   * its ticks, the dual-encoding key, the few-pass row and the no-data row —
   * an empty ramp would claim a range nothing was measured on — e.g. "No
   * NO2 passes in the 7 days to Aug 24 06:00 · last one Aug 15 20:30".
   * The title, `control` and `contextNote` stay. Omit or null for the ramp.
   */
  empty?: string | null;
  /**
   * A control that belongs to this key — e.g. the street window switch —
   * rendered under the title row. The legend only places it.
   */
  control?: ReactNode;
  /** Drop the dual-encoding key and tighten the padding. */
  compact?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function MapLegend(props: MapLegendProps) {
  const {
    scale, domain, measure, metric = 'median', dualEncode = 'width',
    plainLanguage = false, showNoData = true, compact = false, fewPassesNote,
    contextNote, empty, control, title, className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);

  const stops = (scale?.stops?.length ? scale.stops : theme.ramp).filter(Boolean);
  // A measure with no unit is a derived index: its value is already the score,
  // so EVERY metric of it is fixed 0-100, not just `risk`. Without this the
  // legend prints "25 to 32" beneath a ramp that is defined 0-100.
  const isIndex = measure?.unit === '';
  // Persistence and risk have fixed, known ranges. Inheriting a concentration
  // domain here is how a legend ends up reading "4263 %".
  //
  // ORDER MATTERS. `risk` is checked before `isIndex` so the community map —
  // which passes metric="risk" and paints the AQI ramp, where a colour position
  // means a RISK_BANDS word — keeps its [0,100] scale. An index on any other
  // metric is the analytical case and must match `measureDomain`, or the legend
  // prints one range under a ramp drawn to another.
  const fixedDomain: [number, number] | null = metric === 'persistence'
    ? [0, 1]
    : metric === 'risk' ? [0, 100]
    : isIndex ? INDEX_DOMAIN
    : null;
  const [lo, hi] = fixedDomain ?? scale?.domain ?? domain ?? [0, 1];
  const unitless = metricIsUnitless(metric) || plainLanguage || isIndex;
  const unit = unitless ? (metric === 'persistence' ? '%' : '') : unitFor(measure ?? undefined);
  const name = measure
    ? plainName(measure, plainLanguage ? 'community' : null)
    : 'Measurement';

  const fmt = (v: number) => {
    if (metric === 'persistence') return `${Math.round(v * 100)}`;
    // Risk is a whole-number score — a decimal implies precision it lacks.
    if (metric === 'risk' || isIndex) return String(Math.round(v));
    return fmtNum(v, measure?.decimals ?? (hi - lo > 20 ? 0 : 1));
  };

  const gradient = `linear-gradient(90deg, ${stops.join(', ')})`;
  const isEmpty = Boolean(empty);
  const showKey = !isEmpty && !compact && dualEncode !== 'none';

  return (
    <div
      ref={ref}
      className={[s.panel, s.legend, className].filter(Boolean).join(' ')}
      style={style}
    >
      <div className={s.between}>
        <span className={s.title} style={{ fontSize: 'var(--text-sm)' }}>{title ?? name}</span>
        {/* A resident's map carries no metric jargon: the all-caps RISK chip
            was a label for analysts. With no streets in the window nothing
            is coloured by the metric, so the chip would label nothing. */}
        {plainLanguage || isEmpty ? null : <span className={s.metricChip}>{METRIC_LABEL_SHORT[metric]}</span>}
      </div>

      {control ?? null}

      {isEmpty ? (
        <p className={s.keyNote} style={{ margin: 0 }}>{empty}</p>
      ) : (
        <>
          <div className={s.ramp} style={{ background: gradient }} role="img"
            aria-label={`Colour scale from ${fmt(lo)} to ${fmt(hi)} ${unit}`.trim()} />

          <div className={s.rampTicks}>
            <span>{fmt(lo)}</span>
            <span>{fmt((lo + hi) / 2)}</span>
            <span>{fmt(hi)}{unit ? ` ${unit}` : ''}</span>
          </div>
        </>
      )}

      {showKey && (
        <div className={s.keyBlock}>
          <div className={s.keyRow}>
            <span className={s.capLabel}>How much</span>
            <span className={s.keyNote}>Colour — {unitless ? 'low to high' : `${fmt(lo)} to ${fmt(hi)} ${unit}`}</span>
          </div>
          <div className={s.keyRow}>
            <span className={s.capLabel}>How often</span>
            <PersistenceKey mode={dualEncode} color={stops[Math.floor(stops.length * 0.72)] ?? stops[0]} />
          </div>
          <p className={s.keyNote} style={{ margin: 0 }}>
            {dualEncode === 'opacity'
              ? 'Solid streets are over the reference level on most passes; faint ones only occasionally.'
              : 'Thick streets are over the reference level on most passes; hairlines only occasionally.'}
          </p>
        </div>
      )}

      {fewPassesNote && !isEmpty ? (
        <div className={s.row}>
          {/* The same mark the map draws: a hairline in the ramp colour, at
              the layer's few-pass alpha for this skin. Not dashed — §10b
              keeps dashes for the model. */}
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block', inlineSize: 16, blockSize: 1.5, borderRadius: 1,
              background: stops[Math.floor(stops.length * 0.72)] ?? stops[0], opacity: fewPassAlpha(theme),
            }}
          />
          <span className={s.keyNote}>{fewPassesNote}</span>
        </div>
      ) : null}

      {contextNote ? (
        <div className={s.row}>
          {/* The context grid's own mark (`CONTEXT_STROKE`): neutral ink, a
              hairline, no hue — measurement drawn quiet, never a ramp step. */}
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block', inlineSize: 16, blockSize: CONTEXT_STROKE.widthPx, borderRadius: 1,
              background: theme.css(CONTEXT_STROKE.token), opacity: CONTEXT_STROKE.alpha,
            }}
          />
          <span className={s.keyNote}>{contextNote}</span>
        </div>
      ) : null}

      {showNoData && !isEmpty && (
        <div className={s.row}>
          <span className={s.noDataSwatch} />
          <span className={s.keyNote}>Too few passes to report</span>
        </div>
      )}
    </div>
  );
}

/** Three miniature road strokes — the same mark the map draws. */
function PersistenceKey(p: { mode: DualEncoding; color: string }) {
  const { mode, color } = p;
  const rungs = [0.12, 0.5, 0.92];
  return (
    <span className={s.swatchRow} aria-hidden="true">
      {rungs.map((r) => {
        const w = mode === 'opacity' ? 3 : Math.max(1.5, persistenceWidth(r, 1, 5.5));
        const a = mode === 'opacity' ? 0.22 + r * 0.78 : 1;
        return (
          <span
            key={r}
            style={{
              display: 'inline-block',
              inlineSize: 16,
              blockSize: w,
              borderRadius: 3,
              background: color,
              opacity: a,
            }}
          />
        );
      })}
      <span className={s.keyNote} style={{ marginInlineStart: 4 }}>rare → constant</span>
    </span>
  );
}
