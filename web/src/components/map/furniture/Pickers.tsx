/**
 * MeasurePicker / MetricPicker — the two controls every map view needs.
 *
 * Per the dataviz filter rule these are ordinary form controls, not chart marks:
 * one row above the thing they scope. They also carry the community language
 * rule — `plainLanguage` swaps `label` for `plain_name` and drops every unit, so
 * a resident never sees "NO₂ µg/m³".
 */

import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { MeasureCode, MeasureDef, SegmentMetric } from '@/core/types';
import {
  METRIC_LABEL, METRIC_LABEL_SHORT, modalityVar, plainName, shortName, unitFor,
} from '@/core/measures';
import { useTheme } from '../../lib/theme';
import { METRIC_HELP } from '../../lib/vizmeta';
import s from './furniture.module.css';

export type PickerVariant = 'segmented' | 'chips' | 'select';

export interface MeasurePickerProps {
  measures: MeasureDef[];
  value: MeasureCode | null;
  onChange(next: MeasureCode): void;
  variant?: PickerVariant;
  /** Community framing: plain names, no units. */
  plainLanguage?: boolean;
  /** Show the unit beside each option. Ignored when `plainLanguage`. */
  showUnit?: boolean;
  /** Show the modality identity dot. Useful when charts are colour-keyed. */
  showHue?: boolean;
  disabled?: MeasureCode[];
  label?: string;
  className?: string;
  style?: CSSProperties;
}

export function MeasurePicker(props: MeasurePickerProps) {
  const {
    measures, value, onChange, variant = 'segmented', plainLanguage = false,
    showUnit = false, showHue = false, disabled = [],
    label = 'Measure', className, style,
  } = props;

  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme(ref);
  const role = plainLanguage ? 'community' : null;

  const options = measures.map((m) => ({
    code: m.code,
    text: variant === 'select' || plainLanguage
      ? plainName(m, role)
      : shortName(m, role),
    unit: plainLanguage ? '' : unitFor(m),
    hue: theme.css(modalityVar(m.code as MeasureCode).replace('--', '')),
    off: disabled.includes(m.code),
  }));

  if (variant === 'select') {
    return (
      <div ref={ref} className={className} style={style}>
        <select
          className={s.select}
          aria-label={label}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value as MeasureCode)}
        >
          {options.map((o) => (
            <option key={o.code} value={o.code} disabled={o.off}>
              {o.text}{showUnit && o.unit ? ` (${o.unit})` : ''}
            </option>
          ))}
        </select>
      </div>
    );
  }

  const Wrap = variant === 'chips' ? s.chips : s.segmented;
  const Item = variant === 'chips' ? s.chip : s.segment;

  return (
    <div ref={ref} className={[Wrap, className].filter(Boolean).join(' ')} style={style} role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.code}
          type="button"
          className={Item}
          aria-pressed={o.code === value}
          disabled={o.off}
          onClick={() => onChange(o.code as MeasureCode)}
        >
          {showHue && <span className={s.segmentDot} style={{ background: o.hue }} />}
          {o.text}
          {showUnit && o.unit && <span className={s.segmentUnit}>{o.unit}</span>}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

export interface MetricPickerProps {
  value: SegmentMetric;
  onChange(next: SegmentMetric): void;
  /** Which metrics to offer. Community should usually pass `['risk']` only. */
  metrics?: SegmentMetric[];
  variant?: PickerVariant;
  /** Long labels instead of MED / P90 / MAX. */
  longLabels?: boolean;
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const ALL_METRICS: SegmentMetric[] = ['median', 'p90', 'max', 'persistence', 'risk'];

export function MetricPicker(props: MetricPickerProps) {
  const {
    value, onChange, metrics = ALL_METRICS, variant = 'segmented',
    longLabels = false, label = 'Metric', className, style,
  } = props;

  if (variant === 'select') {
    return (
      <select
        className={[s.select, className].filter(Boolean).join(' ')}
        style={style}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as SegmentMetric)}
      >
        {metrics.map((m) => (
          <option key={m} value={m}>{METRIC_LABEL[m]}</option>
        ))}
      </select>
    );
  }

  const Wrap = variant === 'chips' ? s.chips : s.segmented;
  const Item = variant === 'chips' ? s.chip : s.segment;

  return (
    <div className={[Wrap, className].filter(Boolean).join(' ')} style={style} role="group" aria-label={label}>
      {metrics.map((m) => (
        <button
          key={m}
          type="button"
          className={Item}
          aria-pressed={m === value}
          title={METRIC_HELP[m]}
          onClick={() => onChange(m)}
        >
          {longLabels ? METRIC_LABEL[m] : METRIC_LABEL_SHORT[m]}
        </button>
      ))}
    </div>
  );
}
