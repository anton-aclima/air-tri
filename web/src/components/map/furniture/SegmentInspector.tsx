/**
 * SegmentInspector — everything known about one ~200 m piece of street.
 *
 * The road grid answers "where"; this answers "what, exactly, and is that
 * unusual". It is the one place where a magnitude, its persistence, its rank
 * against the whole campaign and its daily shape sit next to each other, which is
 * the argument that mobile monitoring says something a stationary network cannot.
 *
 * Degrades cleanly: give it only `SegmentProps` from the map and it renders the
 * stat block. Give it a `SegmentDetail` and it grows the trend, the diurnal clock
 * and the distribution.
 */

import { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type {
  MeasureCode, MeasureDef, SegmentDetail, SegmentMetric, SegmentProps,
} from '@/core/types';
import {
  METRIC_LABEL_SHORT, formatValue, plainName, riskLabel, unitFor,
} from '@/core/measures';
import { fmtDistance, fmtNum, humanize } from '@/core/format';
import { useTheme } from '../../lib/theme';
import { makeColorScale, persistenceWidth } from '../../lib/scales';
import { Sparkline } from '../../charts/Sparkline';
import { DiurnalClock } from '../../charts/DiurnalClock';
import { Distribution } from '../../charts/Distribution';
import s from './furniture.module.css';

export interface SegmentInspectorProps {
  /** From the map's picking info. */
  segment: SegmentProps | null | undefined;
  /** From `GET /segments/{id}` — unlocks the charts. */
  detail?: SegmentDetail | null;
  measure?: MeasureDef | null;
  measureCode?: MeasureCode;
  metric?: SegmentMetric;
  /** Community framing: plain names, unitless, risk-first. */
  plainLanguage?: boolean;
  /** Campaign-wide values for the same measure, for the percentile chart. */
  campaignValues?: number[];
  /** Colour domain, so the header swatch matches the map exactly. */
  domain?: [number, number];
  onClose?(): void;
  /** Extra rows / actions below the stats. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function SegmentInspector(props: SegmentInspectorProps) {
  const {
    segment, detail, measure, measureCode, metric = 'median',
    plainLanguage = false, campaignValues, domain,
    onClose, children, className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);

  if (!segment) return null;

  const role = plainLanguage ? 'community' : null;
  const unit = plainLanguage ? '' : unitFor(measure ?? undefined);
  const name = segment.name ?? 'Unnamed street';
  const measureName = measure ? plainName(measure, role) : 'Measurement';

  const scale = makeColorScale(theme, {
    domain: domain ?? [0, Math.max(1, (segment.p90 ?? segment.value ?? 1) * 1.4)],
  });

  const persistence = segment.persistence;
  const risk = segment.risk;
  const code = measureCode ?? measure?.code;
  const daily = code && detail?.daily ? detail.daily[code] : undefined;
  const diurnal = code && detail?.diurnal ? detail.diurnal[code] : undefined;
  const rankPct = code && detail?.rank_pct ? detail.rank_pct[code] : undefined;

  // Community sees the risk score first; everyone else sees the concentration.
  const heroValue = plainLanguage
    ? (risk === null ? '—' : String(Math.round(risk)))
    : formatValue(measure ?? undefined, segment.value, { role });
  const heroUnit = plainLanguage ? '' : unit;
  const heroCaption = plainLanguage
    ? riskLabel(risk)
    : `${METRIC_LABEL_SHORT[metric]} · ${segment.n_passes} passes`;

  return (
    <div
      ref={ref}
      className={[s.panel, s.inspector, className].filter(Boolean).join(' ')}
      style={style}
      role="region"
      aria-label={`Details for ${name}`}
    >
      <div className={s.between}>
        <div className={s.inspectorHead}>
          <span className={s.roadClass}>
            {humanize(segment.road_class)}
            {segment.district ? ` · ${segment.district}` : ''}
            {` · ${fmtDistance(segment.length_m)}`}
          </span>
          <h3 className={s.title}>{name}</h3>
        </div>
        {onClose && (
          <button type="button" className={s.close} onClick={onClose} aria-label="Close">×</button>
        )}
      </div>

      {/* the headline */}
      <div className={s.row} style={{ gap: 'var(--s-3)', alignItems: 'baseline' }}>
        <span
          style={{
            inlineSize: 5, blockSize: 30, borderRadius: 3,
            background: scale.css(segment.value), flex: '0 0 auto',
          }}
          aria-hidden="true"
        />
        <div style={{ display: 'grid', gap: 1 }}>
          <span className={s.hero}>
            {heroValue}
            {heroUnit && <span className={s.heroUnit}>{heroUnit}</span>}
          </span>
          <span className={s.capLabel}>{measureName} · {heroCaption}</span>
        </div>
      </div>

      {/* the numbers, in the order a reader wants them */}
      {!plainLanguage && (
        <div className={s.statGrid}>
          {([
            ['Median', segment.median],
            ['P90', segment.p90],
            ['Max', segment.max],
          ] as const).map(([label, val]) => (
            <div key={label} className={s.stat}>
              <span className={s.capLabel}>{label}</span>
              <span className={s.statVal}>
                {val === null ? '—' : fmtNum(val, measure?.decimals ?? 1)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* persistence — the second half of the map's dual encoding, spelled out */}
      {persistence !== null && (
        <div className={s.section}>
          <div className={s.between}>
            <span className={s.capLabel}>How often over the reference level</span>
            <span className={s.num}>{Math.round(persistence * 100)}%</span>
          </div>
          <div className={s.meter}>
            <span
              className={s.meterFill}
              style={{ inlineSize: `${persistence * 100}%`, background: scale.css(segment.value) }}
            />
          </div>
          {/* the same stroke the map draws, so the panel teaches the legend */}
          <div className={s.row}>
            <span
              style={{
                inlineSize: 34,
                blockSize: Math.max(2, persistenceWidth(persistence, 2, 7)),
                borderRadius: 4,
                background: scale.css(segment.value),
              }}
              aria-hidden="true"
            />
            <span className={s.keyNote}>
              {persistence > 0.66
                ? 'Over the reference level on most passes.'
                : persistence > 0.33
                  ? 'Over the reference level about half the time.'
                  : 'Only occasionally over the reference level.'}
            </span>
          </div>
        </div>
      )}

      {plainLanguage && risk !== null && (
        <p className={s.keyNote} style={{ margin: 0 }}>
          This street scores <strong style={{ color: 'var(--ink)' }}>{Math.round(risk)}</strong> out
          of 100 — <strong style={{ color: 'var(--ink)' }}>{riskLabel(risk)}</strong>. Measured on{' '}
          {segment.n_passes} separate drives.
        </p>
      )}

      {children}

      {/* trend */}
      {daily?.length ? (
        <div className={s.section}>
          <div className={s.divider} />
          <div className={s.between}>
            <span className={s.capLabel}>Day by day</span>
            <Sparkline
              points={daily}
              width={168}
              height={30}
              threshold={plainLanguage ? null : measure?.ref_level ?? null}
              ariaLabel={`Daily trend for ${name}`}
            />
          </div>
        </div>
      ) : null}

      {/* the diurnal fingerprint */}
      {diurnal?.length ? (
        <div className={s.section}>
          <div className={s.divider} />
          <DiurnalClock
            points={diurnal}
            size={196}
            measure={measure ?? undefined ? measure : null}
            plainLanguage={plainLanguage}
            refLevel={plainLanguage ? null : measure?.ref_level ?? null}
            title="Through the day"
            subtitle="When this street is worst."
            showTable={false}
          />
        </div>
      ) : null}

      {/* where it sits */}
      {campaignValues?.length && segment.value !== null ? (
        <div className={s.section}>
          <div className={s.divider} />
          <Distribution
            values={campaignValues}
            marker={segment.value}
            markerLabel={name}
            percentile={rankPct ?? null}
            unit={unit}
            decimals={measure?.decimals ?? 1}
            height={128}
            title="Against the whole campaign"
            showTable={false}
          />
        </div>
      ) : null}
    </div>
  );
}
