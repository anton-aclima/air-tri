/**
 * Gauge — one value against one limit.
 *
 * A single ratio against a threshold is a meter, not a chart (and never a
 * two-slice pie). The unfilled track is a lighter step of the same ramp so the
 * whole bar carries state, and the limit is a hard tick you can point at.
 */

import { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { fmtNum } from '@/core/format';
import { useTheme } from '../lib/theme';
import { makeColorScale } from '../lib/scales';
import type { RampName } from '../lib/scales';
import s from './chart.module.css';
import g from './Gauge.module.css';

export interface GaugeProps {
  value: number | null | undefined;
  domain?: [number, number];
  /** The limit. Drawn as a tick with a label. */
  threshold?: number | null;
  thresholdLabel?: string;
  unit?: string;
  decimals?: number;
  label?: ReactNode;
  /** Words instead of a number for the community skin. */
  valueLabel?: string;
  ramp?: RampName;
  /** Bar thickness. Default 10. */
  thickness?: number;
  /** Show min / max under the bar. Default true. */
  scaleLabels?: boolean;
  footer?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Gauge(props: GaugeProps) {
  const {
    value, domain = [0, 100], threshold, thresholdLabel = 'limit',
    unit = '', decimals = 1, label, valueLabel, ramp = 'map',
    thickness = 10, scaleLabels = true, footer, className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);
  const scale = makeColorScale(theme, { domain, ramp });

  const [lo, hi] = domain;
  const span = hi - lo || 1;
  const v = value === null || value === undefined || !Number.isFinite(value) ? null : value;
  const pct = v === null ? 0 : Math.max(0, Math.min(1, (v - lo) / span));
  const over = threshold !== null && threshold !== undefined && v !== null && v > threshold;
  const thPct = threshold === null || threshold === undefined
    ? null : Math.max(0, Math.min(1, (threshold - lo) / span));

  return (
    <div ref={ref} className={[s.root, className].filter(Boolean).join(' ')} style={style}>
      <div className={g.head}>
        {label && <span className={s.capLabel}>{label}</span>}
        <span className={g.value}>
          {valueLabel ?? (v === null ? '—' : fmtNum(v, decimals))}
          {unit && !valueLabel ? <span className={s.heroUnit}>{unit}</span> : null}
        </span>
      </div>

      <div
        className={g.track}
        style={{ blockSize: thickness, background: scale.css(lo + span * 0.06) }}
        role="meter"
        aria-valuenow={v ?? undefined}
        aria-valuemin={lo}
        aria-valuemax={hi}
        aria-label={typeof label === 'string' ? label : 'Gauge'}
      >
        {/* the track is a light step of the same ramp — blue-on-blue, not grey */}
        <span
          className={g.fill}
          style={{ inlineSize: `${pct * 100}%`, background: scale.css(v ?? lo) }}
        />
        {thPct !== null && (
          <span className={g.limit} style={{ insetInlineStart: `${thPct * 100}%` }} />
        )}
      </div>

      {(scaleLabels || thPct !== null) && (
        <div className={g.scaleRow}>
          <span>{fmtNum(lo, 0)}</span>
          {thPct !== null && (
            <span
              className={g.limitLabel}
              style={{
                insetInlineStart: `${thPct * 100}%`,
                color: over ? theme.css('sev-critical') : theme.css('ink-3'),
              }}
            >
              {thresholdLabel} {fmtNum(threshold as number, decimals)}
            </span>
          )}
          <span>{fmtNum(hi, 0)}{unit ? ` ${unit}` : ''}</span>
        </div>
      )}

      {over && (
        <span className={g.overFlag}>◆ Over {thresholdLabel}</span>
      )}
      {footer}
    </div>
  );
}
