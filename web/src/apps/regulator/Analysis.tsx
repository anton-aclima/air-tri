/**
 * /regulator/analysis — diurnal, dispersion, ranking.
 *
 * Written for the data scientist on staff, so nothing is rounded away and
 * nothing is renamed into plain English. Three questions, in the order an
 * analyst asks them:
 *
 *   WHEN   — the two 24-hour clocks, on ONE shared scale. The reference
 *            instrument's shape is nearly flat, because a regional monitor is
 *            sited to be regionally representative; the street's is not,
 *            because a street a few hundred metres from a generator hall is not
 *            regionally representative of anything. Same pollutant, same 90
 *            days, same region, same axis. The gap between the two dials is the
 *            resolution argument, drawn rather than claimed.
 *   HOW    — the observed wind rose, binned across the whole region, plus the
 *            mixing height that traps a plume near the ground at night.
 *   WHERE  — the ranking, each street against the full campaign distribution.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { DiurnalClock, Distribution, SeasonalStrip, TimeSeries, WindRose } from '@/components'
import { Segmented, Select } from '@/app/ui'
import { fmtCompact, fmtHourLabel, fmtNum, fmtWind } from '@/core/format'
import {
  useActiveMeasure, useMeasures, useMonitorReadings, useSegmentDetail, useWind,
} from '@/core/queries'
import { useSession } from '@/core/session'
import type { MeasureCode, SegmentMetric } from '@/core/types'

import {
  Caps, Panel, Readout, Tag, peakOf, styles as s, toDiurnal24, towersFor, useReach,
  useStableWindow, useTowers,
} from './lib'

type Rank = Extract<SegmentMetric, 'p90' | 'max' | 'median' | 'persistence'>

const RANK_TABS: { value: Rank; label: string }[] = [
  { value: 'p90', label: 'p90' },
  { value: 'max', label: 'max' },
  { value: 'median', label: 'median' },
  { value: 'persistence', label: 'persist' },
]

interface StatBlock { median: number; p90: number; max: number; persistence: number }

export function Analysis() {
  const navigate = useNavigate()
  const measures = useMeasures('modality')
  const measure = useActiveMeasure()
  const measureCode = useSession((x) => x.measure)
  const setMeasure = useSession((x) => x.setMeasure)
  const select = useSession((x) => x.select)

  const towers = useTowers().data ?? []
  const carriers = useMemo(() => towersFor(towers, measureCode), [towers, measureCode])
  const [towerId, setTowerId] = useState<string | null>(null)
  const tower = carriers.find((m) => m.id === towerId) ?? carriers[0]

  const [rank, setRank] = useState<Rank>('p90')
  const { reach, segments } = useReach(measureCode)

  // The whole 90-day record, so the diurnal shape is a campaign fingerprint
  // rather than one day's weather.
  const longWin = useStableWindow(24 * 90, 60)
  const readings = useMonitorReadings(
    tower?.id ?? null,
    { measure: measureCode, from: longWin.from, to: longWin.to, interval: 'hour' },
    { enabled: !!tower },
  ).data

  const windWin = useStableWindow(24 * 30, 60)
  const wind = useWind(windWin).data
  const nowWind = wind?.[wind.length - 1]

  const ranked = useMemo(() => {
    const feats = [...(segments?.features ?? [])]
    feats.sort((a, b) => (b.properties[rank] ?? -Infinity) - (a.properties[rank] ?? -Infinity))
    return feats.slice(0, 30)
  }, [segments, rank])

  const topVal = ranked[0]?.properties[rank] ?? 0
  const [pickedId, setPickedId] = useState<string | null>(null)
  const focusId = pickedId ?? ranked[0]?.properties.id ?? null
  const detail = useSegmentDetail(focusId).data

  const streetHours = useMemo(
    () => toDiurnal24(detail?.diurnal?.[measureCode as MeasureCode]),
    [detail, measureCode],
  )
  const towerHours = useMemo(() => toDiurnal24(readings?.points), [readings])

  const streetPeak = useMemo(() => peakOf(streetHours), [streetHours])
  const towerPeak = useMemo(() => peakOf(towerHours), [towerHours])

  const campaignValues = useMemo(() => {
    const out: number[] = []
    for (const f of segments?.features ?? []) {
      const v = f.properties[rank]
      if (v != null) out.push(v)
    }
    return out
  }, [segments, rank])

  /** One axis for both clocks, or the comparison means nothing. */
  const shared = useMemo(() => {
    const all = [...towerHours, ...streetHours].filter((v): v is number => v != null)
    return all.length ? ([0, Math.max(...all) * 1.05] as [number, number]) : undefined
  }, [towerHours, streetHours])

  const unit = measure?.unit === 'ug/m3' ? 'µg/m³' : measure?.unit ?? ''
  const rankUnit = rank === 'persistence' ? '' : unit

  return (
    <div className={`${s.page} ${s.anaPage}`}>
      <div className={`${s.verdict} ${s.verdictClear}`}>
        <div className={s.verdictMark}>
          <span className={`${s.verdictGlyph} ${s.accentInk}`}>∿</span>
          <span className={`${s.verdictWord} ${s.accentInk}`}>ANALYSIS</span>
        </div>
        <div className={s.verdictLines}>
          <span className={s.verdictHead}>
            {measure?.label ?? measureCode.toUpperCase()} · {fmtNum(reach.total, 0)} segments ·{' '}
            {carriers.length} of {towers.length} reference instruments carry this channel
          </span>
          <span className={s.sub}>
            {streetPeak ? (
              <>
                This street peaks at <b>{fmtNum(streetPeak.value, measure?.decimals ?? 1)} {unit}</b>{' '}
                at {fmtHourLabel(streetPeak.hour)} — {fmtNum(streetPeak.ratio, 2)}× its own daily
                median.
                {towerPeak
                  ? ` The reference instrument's whole 24-hour shape varies by only ${fmtNum(towerPeak.ratio, 2)}×.`
                  : ''}
              </>
            ) : (
              'Pick a street in the ranking to see its 24-hour fingerprint.'
            )}
          </span>
        </div>
        <div className={s.verdictStats}>
          <div className={s.readout}>
            <Select
              value={measureCode as MeasureCode}
              options={measures.map((m) => ({ value: m.code as MeasureCode, label: `${m.short_label} · ${m.unit}` }))}
              onValueChange={(c) => { setMeasure(c); setPickedId(null) }}
              size="sm"
            />
            <Caps>pollutant</Caps>
          </div>
          <Readout label="Wind now" value={nowWind ? fmtWind(nowWind.speed_ms, nowWind.dir_deg) : '—'} tone="accent" />
          <Readout label="Mixing height" value={fmtNum(nowWind?.pbl_m ?? null, 0)} unit="m" />
        </div>
      </div>

      <div className={s.anaBody}>
        {/* ── WHEN · the stationary shape ──────────────────────────────── */}
        <Panel
          title="Diurnal · reference instrument"
          aside={
            carriers.length > 1 ? (
              <Select
                value={tower?.id ?? ''}
                options={carriers.map((m) => ({ value: m.id, label: m.name }))}
                onValueChange={setTowerId}
                size="sm"
              />
            ) : (
              <Caps>{tower?.name ?? 'no carrier'}</Caps>
            )
          }
        >
          <div className={s.chartPad}>
            {tower && towerPeak ? (
              <DiurnalClock
                points={towerHours}
                size={244}
                measure={measure ?? null}
                domain={shared}
                ramp="intensity"
                refLevel={measure?.ref_level ?? null}
                subtitle={`${tower.name} · hourly mean, 90 days`}
                aside={<Tag tone="tower">{fmtNum(towerPeak.ratio, 2)}× across the day</Tag>}
              />
            ) : (
              <div className={s.empty}>
                No reference instrument carries a {measureCode.toUpperCase()} channel. There is no
                stationary 24-hour shape for this pollutant anywhere in the region — only the fleet
                has one.
              </div>
            )}
          </div>
        </Panel>

        {/* ── WHEN · the street ────────────────────────────────────────── */}
        <Panel
          title={`Diurnal · ${detail?.name ?? 'street'}`}
          aside={
            <Caps>
              {detail?.district ?? ''}
              {detail ? ` · ${fmtNum(detail.n_passes, 0)} passes` : ''}
            </Caps>
          }
        >
          <div className={s.chartPad}>
            {streetPeak ? (
              <DiurnalClock
                points={streetHours}
                size={244}
                measure={measure ?? null}
                domain={shared}
                ramp="intensity"
                refLevel={measure?.ref_level ?? null}
                subtitle={
                  detail?.nearest_site
                    ? `${fmtNum(detail.nearest_site.distance_m, 0)} m from ${detail.nearest_site.name} · measured in ${streetPeak.covered} of 24 hours`
                    : `mobile measurement · ${streetPeak.covered} of 24 hours`
                }
                aside={<Tag tone="fleet">{fmtNum(streetPeak.ratio, 2)}× across the day</Tag>}
              />
            ) : (
              <div className={s.empty}>Select a street in the ranking.</div>
            )}
            {detail?.daily?.[measureCode as MeasureCode]?.length ? (
              <>
                <Caps>90 days on this street</Caps>
                <SeasonalStrip
                  points={detail.daily[measureCode as MeasureCode]}
                  unit={unit}
                  decimals={measure?.decimals ?? 1}
                  ramp="intensity"
                  height={38}
                />
              </>
            ) : null}
          </div>
        </Panel>

        {/* ── WHERE · the whole distribution ───────────────────────────── */}
        <Panel
          title="Distribution · every measured street"
          aside={<Tag tone="fleet">{fmtNum(campaignValues.length, 0)} segments</Tag>}
        >
          <div className={s.chartPad}>
            {campaignValues.length ? (
              <Distribution
                values={campaignValues}
                marker={statOf(detail?.stats?.[measureCode as MeasureCode], rank)}
                markerLabel={detail?.name ?? 'selected street'}
                percentile={detail?.rank_pct?.[measureCode as MeasureCode] ?? null}
                unit={rankUnit}
                decimals={measure?.decimals ?? 1}
                height={210}
                bins={36}
                colorByValue={false}
                ramp="intensity"
                subtitle={`Campaign ${rank} for ${measure?.label ?? measureCode.toUpperCase()}, 90 days.`}
              />
            ) : (
              <div className={s.empty}>No coverage.</div>
            )}
          </div>
        </Panel>

        {/* ── HOW · dispersion ─────────────────────────────────────────── */}
        <Panel title="Regional wind · observed" aside={<Caps>30 days</Caps>}>
          <div className={s.chartPad}>
            {wind?.length ? (
              <>
                <WindRose
                  points={wind}
                  mode="speed"
                  sectors={16}
                  size={196}
                  nObs={wind.length}
                  subtitle="Frequency by the bearing wind blows FROM, stacked by speed band."
                />
                <TimeSeries
                  series={[{ id: 'pbl', label: 'Mixing height', points: wind.map((w) => ({ t: w.ts, v: w.pbl_m })) }]}
                  unit="m"
                  decimals={0}
                  height={98}
                  subtitle="A shallow nocturnal boundary layer traps a plume near the ground — which is why a street clock peaks before dawn and a regional instrument does not."
                />
              </>
            ) : (
              <div className={s.empty}>No wind record.</div>
            )}
          </div>
        </Panel>

        {/* ── WHERE · the ranking ──────────────────────────────────────── */}
        <Panel
          className={s.anaRank}
          title="Ranking"
          aside={<Segmented value={rank} options={RANK_TABS} onValueChange={(v) => { setRank(v); setPickedId(null) }} />}
        >
          <div className={s.rows}>
            <div className={`${s.rowHead} ${s.rankCols}`}>
              <span>#</span><span>street</span><span>district</span>
              <span style={{ textAlign: 'right' }}>{rank}</span>
              <span style={{ textAlign: 'right' }}>vs top</span>
              <span style={{ textAlign: 'right' }}>pass</span>
            </div>
            {ranked.map((f, i) => {
              const p = f.properties
              const v = p[rank]
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`${s.row} ${s.rankCols}${focusId === p.id ? ` ${s.rowActive}` : ''}`}
                  onClick={() => { setPickedId(p.id); select({ segmentId: p.id }) }}
                  onDoubleClick={() => navigate({ to: '/regulator/map' })}
                  title={`${p.name ?? p.id} · ${p.id}`}
                >
                  <span className={`${s.rowNum} ${s.dim}`} style={{ textAlign: 'left' }}>{i + 1}</span>
                  <span className={s.rowTrunc}>{p.name ?? p.id}</span>
                  <span className={`${s.rowTrunc} ${s.dim}`}>{p.district ?? '—'}</span>
                  <span className={s.rowNum} style={{ color: 'var(--accent)' }}>
                    {rank === 'persistence' ? `${fmtNum((v ?? 0) * 100, 0)}%` : fmtNum(v, measure?.decimals ?? 1)}
                  </span>
                  <span className={s.wire} style={{ height: 6 }} aria-hidden>
                    <span
                      className={s.wireFill}
                      style={{
                        width: `${topVal ? Math.max(3, ((v ?? 0) / topVal) * 100) : 0}%`,
                        background: 'var(--accent)',
                      }}
                    />
                  </span>
                  <span className={`${s.rowNum} ${s.dim}`}>{fmtCompact(p.n_passes)}</span>
                </button>
              )
            })}
          </div>
        </Panel>
      </div>
    </div>
  )
}

function statOf(stat: StatBlock | undefined, key: Rank): number | null {
  return stat ? (stat[key] ?? null) : null
}
