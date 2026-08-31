/**
 * ModelVerificationPanel — "verify your consultant".
 *
 * The single most valuable screen in the industry interface, and the strongest
 * argument for why an operator should pay us: their AERMOD/CALPUFF study is only
 * as good as the wind rose it assumed, and our vehicles measured the real one.
 *
 * Structure follows the argument, in order:
 *   1. the VERDICT, in words, as the headline — nobody should have to derive it
 *   2. the two roses superimposed — observed filled, assumed as a dashed outline
 *   3. per-bearing bias as a diverging bar chart, centred on zero, because
 *      "understates" and "overstates" are opposite polarities
 *   4. who it lands on — the districts the study under-weights
 *   5. the sample size, stated plainly, including when it is too small to claim
 *      anything at all
 */

import { useMemo, useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { ModelVerification } from '@/core/types';
import { compassPoint, fmtNum, fmtDay } from '@/core/format';
import { useTheme } from '../lib/theme';
import { WindRose } from '../charts/WindRose';
import { ChartFrame } from '../charts/primitives';
import s from '../charts/chart.module.css';
import v from './ModelVerificationPanel.module.css';

export interface ModelVerificationPanelProps {
  data: ModelVerification | null | undefined;
  /** Rose diameter. Default 210. */
  roseSize?: number;
  /** Hide the per-bearing bias chart for a compact card. */
  showBias?: boolean;
  /** Hide the affected-district list. */
  showDistricts?: boolean;
  title?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const VERDICT: Record<ModelVerification['verdict'], { label: string; tone: string; glyph: string }> = {
  understates: { label: 'Model understates transport', tone: 'sev-critical', glyph: '▲' },
  overstates: { label: 'Model overstates transport', tone: 'sev-watch', glyph: '▼' },
  consistent: { label: 'Model consistent with observation', tone: 'sev-ok', glyph: '◆' },
  insufficient_data: { label: 'Not enough observations to judge', tone: 'ink-3', glyph: '·' },
};

export function ModelVerificationPanel(props: ModelVerificationPanelProps) {
  const {
    data, roseSize = 210, showBias = true, showDistricts = true,
    title, className, style,
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme(rootRef);

  const bias = useMemo(
    () => [...(data?.bearing_bias ?? [])].sort((a, b) => a.dir_deg - b.dir_deg),
    [data],
  );
  const maxAbs = useMemo(
    () => Math.max(0.01, ...bias.map((b) => Math.abs(b.delta))),
    [bias],
  );
  /** The single worst bearing — the headline when `disagreement` is 0. */
  const topBias = useMemo(() => {
    let best: ModelVerification['bearing_bias'][number] | null = null;
    for (const b of bias) if (!best || Math.abs(b.delta) > Math.abs(best.delta)) best = b;
    return best;
  }, [bias]);

  if (!data) {
    return (
      <div ref={rootRef} className={[s.root, className].filter(Boolean).join(' ')} style={style}>
        <div className={s.empty}>No model on file</div>
      </div>
    );
  }

  const verdict = VERDICT[data.verdict] ?? VERDICT.insufficient_data;
  const understated = new Set(data.understated_bearings ?? []);
  const thin = data.verdict === 'insufficient_data' || data.n_obs < 40;

  return (
    <div ref={rootRef} className={[s.root, v.panel, className].filter(Boolean).join(' ')} style={style}>
      {/* 1 ─ the verdict */}
      <div className={v.verdictRow}>
        <span className={v.verdictGlyph} style={{ color: `var(--${verdict.tone})` }}>
          {verdict.glyph}
        </span>
        <div className={v.verdictText}>
          <span className={v.verdictLabel} style={{ color: `var(--${verdict.tone})` }}>
            {title ?? verdict.label}
          </span>
          <span className={v.summary}>{data.summary}</span>
        </div>
        <div className={v.disagreement}>
          {/* `disagreement` is a 0-1 fraction, NOT a percentage — scale it once.
              When the API reports 0 the honest headline is the largest single
              per-bearing gap instead, in percentage points. */}
          {(data.disagreement ?? 0) > 0 ? (
            <>
              <span className={s.capLabel}>Hours mispredicted</span>
              <span className={v.disagreementValue}>
                {fmtNum(data.disagreement * 100, 0)}%
              </span>
            </>
          ) : topBias ? (
            <>
              <span className={s.capLabel}>Largest gap</span>
              <span className={v.disagreementValue}>
                {topBias.delta > 0 ? '+' : topBias.delta < 0 ? '−' : ''}
                {fmtNum(Math.abs(topBias.delta), 1)}
              </span>
              <span className={v.disagreementUnit}>
                pts · {compassPoint(topBias.dir_deg)}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className={v.meta}>
        <span>{data.model.name}</span>
        {data.model.vendor && <span>· {data.model.vendor}</span>}
        {data.model.method && <span>· {data.model.method}</span>}
        {data.model.issued_at && <span>· issued {fmtDay(data.model.issued_at)}</span>}
      </div>

      {/* 2 ─ the two roses, superimposed */}
      <div className={v.roseRow}>
        <WindRose
          rose={data.observed_wind}
          compare={data.model.assumed_wind}
          roseLabel="Observed (our fleet)"
          compareLabel="Assumed by model"
          size={roseSize}
          mode="freq"
          nObs={data.n_obs}
          title="Assumed vs observed"
          subtitle="Filled = what we measured. Dashed = what the study assumed."
          showTable={false}
        />
      </div>

      {/* 3 ─ per-bearing bias: diverging, centred on zero */}
      {showBias && bias.length > 0 && (
        <ChartFrame
          title="Per-bearing bias"
          subtitle="Observed minus assumed frequency, in percentage points."
        >
          <div className={v.biasList}>
            {bias.map((b) => {
              const w = (Math.abs(b.delta) / maxAbs) * 50;
              const under = b.delta > 0;
              const flagged = understated.has(b.dir_deg);
              return (
                <div key={b.dir_deg} className={v.biasRow}>
                  <span className={v.biasDir}>
                    {compassPoint(b.dir_deg)}
                    {flagged && <span className={v.flag} title="Model materially understates this bearing">◆</span>}
                  </span>
                  <span className={v.biasTrack}>
                    <span className={v.biasZero} />
                    <span
                      className={v.biasBar}
                      style={{
                        inlineSize: `${w}%`,
                        // Diverging: warm = we saw MORE than assumed (the risky
                        // direction), cool = we saw less. Neutral zero in between.
                        [under ? 'insetInlineStart' : 'insetInlineEnd']: '50%',
                        background: under ? theme.css('sev-critical') : theme.css('sev-info'),
                        opacity: flagged ? 1 : 0.72,
                      } as CSSProperties}
                    />
                  </span>
                  <span className={v.biasVal} style={{ color: under ? theme.css('sev-critical') : theme.css('ink-2') }}>
                    {b.delta > 0 ? '+' : b.delta < 0 ? '−' : ''}{fmtNum(Math.abs(b.delta), 1)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className={v.biasLegend}>
            <span>← model overstates</span>
            <span>model understates →</span>
          </div>
        </ChartFrame>
      )}

      {/* 4 ─ who it lands on */}
      {showDistricts && data.affected_districts?.length > 0 && (
        <div className={v.districts}>
          <span className={s.capLabel}>Under-weighted receptors</span>
          {data.affected_districts.map((d) => (
            <div key={d.district} className={v.districtRow}>
              <span className={v.districtName}>{d.district}</span>
              <span className={v.districtNums}>
                assumed <strong>{fmtNum(d.assumed_freq, 1)}%</strong>
                {' · '}observed <strong>{fmtNum(d.observed_freq, 1)}%</strong>
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 5 ─ the sample, stated plainly */}
      <p className={thin ? v.cautionNote : v.note}>
        {thin ? '◆ ' : ''}
        Based on <strong>{fmtNum(data.n_obs, 0)}</strong> mobile anemometer observations
        {thin
          ? '. That is a thin sample — treat this as indicative, not conclusive.'
          : ' from our vehicles at street level.'}
      </p>
    </div>
  );
}
