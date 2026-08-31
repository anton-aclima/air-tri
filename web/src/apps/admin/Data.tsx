/**
 * SHEET 05 — /admin/data · Measures, ramps, breakpoints.
 *
 * The measurement language, written down. Every number the other three
 * interfaces show is a `MeasureDef` plus a ramp plus a set of breakpoints, and
 * this is the only screen in the product where you can see all three at once
 * for all ten measures. It is a specification sheet, so it reads like one:
 * definition on the left, the curve that turns a concentration into a public
 * risk score on the right, and the action levels the regulator has hung on it
 * underneath.
 *
 * The two-ramp rule gets its own block at the bottom, because "never mix the
 * health ramp with the analytical ramp" is a rule about this product, and this
 * is the sheet that documents the product.
 */

import { useMemo, useState } from 'react'

import { Distribution } from '@/components'
import { Badge, Segmented } from '@/app/ui'
import { fmtNum } from '@/core/format'
import {
  RISK_BANDS, formatValue, modalityVar, rampGradient, rampVars, riskFromValue,
  severityVar,
} from '@/core/measures'
import { useActionLevels, useMeasures, useSegments } from '@/core/queries'
import type { MeasureCode, MeasureDef } from '@/core/types'

import { Caps, KV, Readout, Readouts, Sheet, TitleBlock, styles as s } from './lib'

export function Data() {
  const measures = useMeasures()
  const levels = useActionLevels()
  const [code, setCode] = useState<MeasureCode>('no2')
  const [metric, setMetric] = useState<'median' | 'p90' | 'max'>('median')

  const def = measures.find((m) => m.code === code)
  const segments = useSegments({ measure: code, metric, limit: 2000 })

  const values = useMemo(
    () => (segments.data?.features ?? [])
      .map((f) => f.properties.value)
      .filter((v): v is number => v != null && Number.isFinite(v)),
    [segments.data],
  )

  const onThis = useMemo(
    () => (levels.data ?? []).filter((l) => l.measure === code),
    [levels.data, code],
  )

  const modalities = measures.filter((m) => m.family === 'modality')
  const indicators = measures.filter((m) => m.family === 'indicator')

  return (
    <div className={`${s.page} ${s.rowsData}`}>
      <TitleBlock
        sheet="data"
        subtitle="Every number in the product resolves through one of these definitions — label, unit, ramp, breakpoints."
        cells={[
          { label: 'measures', value: fmtNum(measures.length, 0) },
          { label: 'modalities', value: fmtNum(modalities.length, 0) },
          { label: 'indicators', value: fmtNum(indicators.length, 0) },
          { label: 'action levels', value: fmtNum(levels.data?.length ?? null, 0), tone: 'accent' },
        ]}
      />

      <div className={s.split}>
        {/* ── the register ────────────────────────────────────────────── */}
        <div className={s.stack} style={{ overflow: 'auto' }}>
          <Sheet code="05-A" title="Modalities · measured directly">
            <div className={s.measureList}>
              {modalities.map((m) => (
                <MeasureRow key={m.code} def={m} active={m.code === code} onSelect={setCode} />
              ))}
            </div>
          </Sheet>
          <Sheet
            code="05-B"
            title="Indicators · derived"
            aside={<Caps ink>no reference monitor measures these</Caps>}
          >
            <div className={s.measureList}>
              {indicators.map((m) => (
                <MeasureRow key={m.code} def={m} active={m.code === code} onSelect={setCode} />
              ))}
            </div>
            <div className={s.pad}>
              <p className={s.note}>
                Black carbon, the diesel indicator and methane are not on DRAQA's reference
                network at all. Their action levels are unreachable by the regulator's own
                instruments — which is the argument for mobile measurement, and a property
                of the data rather than a claim anyone is making.
              </p>
            </div>
          </Sheet>
        </div>

        {/* ── the specification ───────────────────────────────────────── */}
        <div className={s.stack} style={{ overflow: 'auto' }}>
          <Sheet
            code="05-C"
            title={def ? `${def.label} · specification` : 'Specification'}
            aside={<Caps accent>{def?.code.toUpperCase()}</Caps>}
          >
            {def ? (
              <>
                <div className={s.pad}>
                  <div
                    className={s.rampBar}
                    style={{ background: rampGradient('intensity') }}
                    aria-hidden
                  />
                  <ScaleTicks def={def} />
                  <p className={s.noteDim} style={{ marginTop: 'var(--s-2)' }}>
                    Admin reads this on <strong>--ramp-intensity</strong>; the community reads the
                    same number on --ramp-aqi as a unitless 0–100 score. Two languages, one measure.
                  </p>
                </div>
                <KV
                  wide
                  rows={[
                    ['code', def.code],
                    ['label', def.label],
                    ['plain name', def.plain_name ?? '—'],
                    ['unit', def.unit || '—'],
                    ['family', def.family],
                    ['reference level', def.ref_level != null ? `${fmtNum(def.ref_level, def.decimals)} ${def.unit}` : '—'],
                    ['healthy max', def.healthy_max != null ? `${fmtNum(def.healthy_max, def.decimals)} ${def.unit}` : '—'],
                    ['breakpoints', `${def.scale.length} on the risk curve`],
                  ]}
                />
              </>
            ) : null}
          </Sheet>

          <Sheet
            code="05-D"
            title="Risk curve · concentration → 0–100"
            aside={<Caps ink>{def ? `${def.scale.length} breakpoints` : ''}</Caps>}
          >
            {def ? <RiskCurve def={def} /> : null}
          </Sheet>

          <Sheet
            code="05-E"
            title="Action levels on this measure"
            aside={<Caps ink>{onThis.length ? `${onThis.length} defined` : 'none'}</Caps>}
          >
            {onThis.length ? (
              <div className={s.rowList}>
                <div className={s.rowHead} style={{ gridTemplateColumns: 'minmax(0,1fr) 60px 64px 70px' }}>
                  <span>level</span><span className={s.num}>threshold</span>
                  <span className={s.num}>avg h</span><span>severity</span>
                </div>
                {onThis.map((l) => (
                  <div
                    key={l.id}
                    className={`${s.row} ${s.rowStatic}`}
                    style={{ gridTemplateColumns: 'minmax(0,1fr) 60px 64px 70px' }}
                  >
                    <span className={s.truncate} title={l.label}>
                      {l.label}
                      {!l.enabled ? <span className={s.noteDim}> · disabled</span> : null}
                    </span>
                    <span className={`${s.num} num`}>{fmtNum(l.threshold, 2)}</span>
                    <span className={`${s.num} num`}>{fmtNum(l.averaging_hours, 0)}</span>
                    <span style={{ color: severityVar(l.severity), fontSize: 'var(--text-3xs)', letterSpacing: 'var(--tracking-caps)', textTransform: 'uppercase' }}>
                      {l.severity}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={s.err}>
                No action level is defined on {def?.label ?? 'this measure'}. Nothing in the
                product can raise an exceedance for it.
              </div>
            )}
          </Sheet>

        </div>
      </div>

      {/* ── the campaign's own numbers, and the rule that colours them ── */}
      <div className={s.splitBottom}>
          <Sheet
            code="05-F"
            title="Campaign distribution"
                        aside={
              <Segmented
                value={metric}
                options={[
                  { value: 'median', label: 'median' },
                  { value: 'p90', label: 'p90' },
                  { value: 'max', label: 'max' },
                ]}
                onValueChange={(v) => setMetric(v as 'median' | 'p90' | 'max')}
              />
            }
          >
            {values.length ? (
              <div className={s.pad2}>
                <Distribution
                  values={values}
                  marker={def?.ref_level ?? null}
                  markerLabel="reference"
                  bins={30}
                  height={112}
                  unit={def ? ` ${def.unit}` : ''}
                  decimals={def?.decimals ?? 1}
                  ramp="intensity"
                  colorByValue
                  subtitle={`${fmtNum(values.length, 0)} segments · ${metric} of ${def?.label ?? ''} over the whole campaign`}
                />
              </div>
            ) : (
              <div className={s.err}>Reading the road grid…</div>
            )}
          </Sheet>
        <Sheet code="05-G" title="Two ramps, never mixed">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: 'var(--s-3)',
            padding: 'var(--s-3)',
          }}
        >
          <RampCard
            name="--ramp-aqi"
            who="community"
            note="Public-health framing. Any 'is this risky' question, anywhere in the product."
            family="aqi"
          />
          <RampCard
            name="--ramp-intensity"
            who="regulator · industry · admin"
            note="Analytical magnitude. Never used where a resident is being told about risk."
            family="intensity"
          />
          <div className={s.dualNode} style={{ gap: 6 }}>
            <span className={s.dualLabel}>risk bands · 0–100</span>
            <div className={s.chips}>
              {RISK_BANDS.map((b, i) => (
                <span
                  key={b.short}
                  className={s.chip}
                  style={{ color: rampVars('aqi')[i], borderColor: rampVars('aqi')[i] }}
                >
                  {b.min}+ {b.short}
                </span>
              ))}
            </div>
            <span className={s.noteDim}>
              Seven bands, one per stop on the health ramp. Colour is never the only channel —
              every band carries a word.
            </span>
          </div>
        </div>
        </Sheet>
      </div>
    </div>
  )
}

function MeasureRow({
  def, active, onSelect,
}: {
  def: MeasureDef
  active: boolean
  onSelect(code: MeasureCode): void
}) {
  return (
    <button
      type="button"
      className={`${s.measureRow}${active ? ` ${s.rowActive}` : ''}`}
      onClick={() => onSelect(def.code)}
    >
      <span className={s.measureCode} style={{ color: modalityVar(def.code) }}>
        {def.code}
      </span>
      <span style={{ minWidth: 0, display: 'grid', gap: 1 }}>
        <span className={s.truncate} style={{ fontSize: 'var(--text-xs)' }}>{def.label}</span>
        <span className={`${s.truncate} ${s.noteDim}`}>
          {def.plain_name ?? def.short_label}
        </span>
      </span>
      <span className={`${s.num} num`} style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-2)' }}>
        {def.ref_level != null ? `${fmtNum(def.ref_level, def.decimals)} ${def.unit}` : '—'}
      </span>
    </button>
  )
}

/** The breakpoints, drawn under the ramp bar as a measured rule. */
function ScaleTicks({ def }: { def: MeasureDef }) {
  const max = def.scale.length ? def.scale[def.scale.length - 1][0] : 1
  return (
    <div className={s.rampTicks}>
      {def.scale.map(([v]) => (
        <span key={v} className={s.rampTick} style={{ left: `${(100 * v) / (max || 1)}%` }}>
          <span className={s.rampTickLine} />
          <span className={s.rampTickLabel}>{fmtNum(v, v < 10 ? 1 : 0)}</span>
        </span>
      ))}
    </div>
  )
}

/** value → risk, as a plotted piecewise curve with the reference level marked. */
function RiskCurve({ def }: { def: MeasureDef }) {
  const w = 100
  const h = 100
  const maxV = def.scale.length ? def.scale[def.scale.length - 1][0] : 1
  const pts = def.scale
    .map(([v, r]) => `${(100 * v) / (maxV || 1)},${100 - r}`)
    .join(' ')
  const refX = def.ref_level != null ? (100 * def.ref_level) / (maxV || 1) : null
  const refRisk = riskFromValue(def, def.ref_level)

  return (
    <>
      <div className={s.pad2}>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: 112, display: 'block' }}
          role="img"
          aria-label={`${def.label} concentration to risk curve`}
        >
          {[20, 40, 55, 70, 85].map((r) => (
            <line
              key={r}
              x1={0} x2={w} y1={100 - r} y2={100 - r}
              stroke="var(--line)" strokeWidth={0.4}
            />
          ))}
          {refX != null ? (
            <line
              x1={refX} x2={refX} y1={0} y2={h}
              stroke="var(--sev-warning)" strokeWidth={0.6} strokeDasharray="2 2"
            />
          ) : null}
          <polyline
            points={pts}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
          {def.scale.map(([v, r]) => (
            <circle
              key={v}
              cx={(100 * v) / (maxV || 1)}
              cy={100 - r}
              r={1.2}
              fill="var(--accent)"
            />
          ))}
        </svg>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <Caps>0 {def.unit}</Caps>
          <Caps>{fmtNum(maxV, def.decimals)} {def.unit} → risk 100</Caps>
        </div>
      </div>
      <Readouts>
        <Readout
          label="reference"
          value={def.ref_level != null ? formatValue(def, def.ref_level) : '—'}
          foot={refRisk != null ? `risk ${fmtNum(refRisk, 0)}` : undefined}
          tone="warn"
        />
        <Readout
          label="healthy max"
          value={def.healthy_max != null ? formatValue(def, def.healthy_max) : '—'}
          foot="below this, no framing"
        />
        <Readout label="breakpoints" value={String(def.scale.length)} foot="piecewise-linear" />
        <Readout label="decimals" value={String(def.decimals)} foot="everywhere it is printed" />
      </Readouts>
    </>
  )
}

function RampCard({
  name, who, note, family,
}: {
  name: string
  who: string
  note: string
  family: 'aqi' | 'intensity'
}) {
  return (
    <div className={s.dualNode} style={{ gap: 6 }}>
      <span className={s.dualLabel}>{name}</span>
      <div className={s.rampBar} style={{ background: rampGradient(family) }} aria-hidden />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <Badge tone={family === 'aqi' ? 'warning' : 'accent'}>{who}</Badge>
      </div>
      <span className={s.noteDim}>{note}</span>
    </div>
  )
}
