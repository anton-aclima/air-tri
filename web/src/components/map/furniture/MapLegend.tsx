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
 */

import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { MeasureDef, SegmentMetric } from '@/core/types';
import { METRIC_LABEL_SHORT, metricIsUnitless, plainName, unitFor } from '@/core/measures';
import { fmtNum } from '@/core/format';
import { useTheme } from '../../lib/theme';
import type { ColorScale } from '../../lib/scales';
import { persistenceWidth } from '../../lib/scales';
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
  /** Drop the dual-encoding key and tighten the padding. */
  compact?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function MapLegend(props: MapLegendProps) {
  const {
    scale, domain, measure, metric = 'median', dualEncode = 'width',
    plainLanguage = false, showNoData = true, compact = false,
    className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);

  const stops = (scale?.stops?.length ? scale.stops : theme.ramp).filter(Boolean);
  // Persistence and risk have fixed, known ranges. Inheriting a concentration
  // domain here is how a legend ends up reading "4263 %".
  const fixedDomain: [number, number] | null = metric === 'persistence'
    ? [0, 1]
    : metric === 'risk' ? [0, 100] : null;
  const [lo, hi] = fixedDomain ?? scale?.domain ?? domain ?? [0, 1];
  const unitless = metricIsUnitless(metric) || plainLanguage;
  const unit = unitless ? (metric === 'persistence' ? '%' : '') : unitFor(measure ?? undefined);
  const name = measure
    ? plainName(measure, plainLanguage ? 'community' : null)
    : 'Measurement';

  const fmt = (v: number) => {
    if (metric === 'persistence') return `${Math.round(v * 100)}`;
    // Risk is a whole-number score — a decimal implies precision it lacks.
    if (metric === 'risk') return String(Math.round(v));
    return fmtNum(v, measure?.decimals ?? (hi - lo > 20 ? 0 : 1));
  };

  const gradient = `linear-gradient(90deg, ${stops.join(', ')})`;
  const showKey = !compact && dualEncode !== 'none';

  return (
    <div
      ref={ref}
      className={[s.panel, s.legend, className].filter(Boolean).join(' ')}
      style={style}
    >
      <div className={s.between}>
        <span className={s.title} style={{ fontSize: 'var(--text-sm)' }}>{name}</span>
        <span className={s.metricChip}>{METRIC_LABEL_SHORT[metric]}</span>
      </div>

      <div className={s.ramp} style={{ background: gradient }} role="img"
        aria-label={`Colour scale from ${fmt(lo)} to ${fmt(hi)} ${unit}`.trim()} />

      <div className={s.rampTicks}>
        <span>{fmt(lo)}</span>
        <span>{fmt((lo + hi) / 2)}</span>
        <span>{fmt(hi)}{unit ? ` ${unit}` : ''}</span>
      </div>

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

      {showNoData && (
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
