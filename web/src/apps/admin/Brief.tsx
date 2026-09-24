/**
 * SHEET 08 — /admin/brief · The Mission Brief.
 *
 * What a fleet lead reads at 07:00: the day's call in one sentence, where the
 * plume is forecast to cross, today's routes coloured by which question each
 * leg answers, yesterday's paired result, the five-day watch list, and what the
 * day costs. One request (`GET /admin/brief`).
 *
 * READ-ONLY over the datagen-built plan. The routes are the ones that produced
 * this campaign's data; nothing here dispatches a car or touches the solver.
 * It is a proposal with a debrief.
 *
 * Epistemic registers (CONTRACT 10b), which this sheet has more of than any
 * other:
 *
 *   forecast swath      modelled — hairline outlines, no fill
 *   route strata        modelled — which side of the source a street is on IF
 *                       the forecast is right
 *   yesterday's passes  measured — the only inked thing under the routes
 *   the debrief         measured — intervals count hours, not passes
 */

import { useCallback, useMemo, useState } from 'react'
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { LayersList } from 'deck.gl'

import { BaseMap, MapOverlay, MapScale, destination } from '@/components'
import type { Theme } from '@/components'
import { Segmented } from '@/app/ui'
import { fmtDayFull, fmtNum, fmtSigned } from '@/core/format'
import { campaignMs } from '@/core/clock'
import { useCampaignInfo, useMissionBrief } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type {
  BriefAssignment, BriefDebrief, BriefOutlookDay, BriefStat, BriefStratum, MissionBrief, Position,
} from '@/core/types'

import { Caps, Sheet, TitleBlock, campaignView, styles as s } from './lib'

/** One token per stratum, shared by the map, the legend and the km bars. */
const STRATUM_TOKEN: Record<BriefStratum, string> = {
  downwind: 'sev-warning',
  upwind: 'accent',
  background: 'ink-3',
}

const STRATUM_LABEL: Record<BriefStratum, string> = {
  downwind: 'downwind · is the plume here?',
  upwind: 'upwind · what is arriving?',
  background: 'background · coverage',
}

const VERDICT_LABEL: Record<BriefDebrief['verdict'], string> = {
  local: 'local',
  advected: 'advected',
  no_detection: 'no detection',
  contested: 'insufficient data',
  unpaired: 'unpaired',
}

const hhmm = (iso: string | null | undefined) => (iso ? iso.slice(11, 16) : '—')

export function Brief() {
  const campaign = useCampaignInfo()
  const [siteId, setSiteId] = useState<string | null>(null)
  const q = useMissionBrief(siteId)
  const b = q.data
  // Before the first 07:00 issue (where Start lands, Jun 1 06:00) the server
  // clamps to the first brief there is, which is still in the future. Say so
  // rather than show a brief "issued" an hour after the moment on screen.
  const now = useNowCampaign()
  const notYet = !!b?.issued_at && campaignMs(b.issued_at) > campaignMs(now)
  const [day, setDay] = useState<0 | 1>(0)

  const siteShort = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of b?.sites_ranked ?? []) m.set(r.site_id, r.short)
    return m
  }, [b])

  if (!b) {
    return (
      <div className={`${s.page} ${s.rows}`}>
        <TitleBlock sheet="brief" subtitle="Issuing the brief…" />
        <div className={s.err}>{q.error ? `Brief unavailable — ${q.error.message}` : 'Loading…'}</div>
      </div>
    )
  }

  const conf = b.call?.confidence
  return (
    <div className={`${s.page} ${s.rowsBrief}`}>
      <TitleBlock
        sheet="brief"
        title={`Mission brief · ${fmtDayFull(`${b.date}T12:00:00`)}`}
        subtitle={notYet
          ? `No brief had been issued yet at this moment — the first is issued ${b.issued_at?.slice(0, 16).replace('T', ' ')}. Showing it for reference.`
          : `Issued ${b.issued_at?.slice(0, 16).replace('T', ' ') ?? '—'} · read-only over ${b.plan_id ?? 'no plan'} · a proposal with a debrief, never a dispatch`}
        cells={[
          { label: 'target', value: b.site.short, tone: 'accent' },
          { label: 'routes today', value: fmtNum(b.ledger.vehicles, 0) },
          {
            label: 'paired hours',
            value: `${fmtNum(b.sample_size.paired_rate * 100, 1)}%`,
            tone: 'warn',
          },
        ]}
        aside={
          <Segmented
            value={siteId ?? 'auto'}
            options={[
              { value: 'auto', label: 'Auto' },
              ...b.sites_ranked.map((r) => ({ value: r.site_id, label: r.short })),
            ]}
            onValueChange={(v) => setSiteId(v === 'auto' ? null : v)}
          />
        }
      />

      {/* ── 08-A the call ─────────────────────────────────────────────── */}
      <Sheet code="08-A" title="The call" aside={<Caps>forecast · modelled</Caps>}>
        <div className={s.call}>
          <p className={s.callSentence}>{b.call?.sentence ?? 'No forecast could be issued for this day.'}</p>
          <div className={s.callMeta}>
            <span className={s.chip}>issued {hhmm(b.issued_at)}</span>
            {b.call?.from ? <span className={s.chip}>{hhmm(b.call.from)}–{hhmm(b.call.to)} · {b.call.hours} h</span> : null}
            {conf ? (
              <span className={`${s.chip} ${s.chipOn}`} title="Two sigma of the forecast's own measured direction error at this lead">
                ±{fmtNum(conf.spread_deg, 0)}° · {conf.lead_h} h · {conf.tier}
              </span>
            ) : null}
            <span className={s.noteDim}>
              Direction error is measured on this campaign's own record, not chosen. One simulated campaign — its numbers, not the atmosphere's.
            </span>
          </div>
        </div>
      </Sheet>

      <div className={s.split}>
        {/* ── 08-B the map ────────────────────────────────────────────── */}
        <Sheet
          code="08-B"
          title={day === 0 ? "Today's routes · coloured by the question each leg answers" : "Tomorrow's routes · coloured by the question each leg answers"}
          className={s.mapCard}
          flat
          aside={
            <Segmented
              value={String(day)}
              options={[{ value: '0', label: 'Today' }, { value: '1', label: 'Tomorrow' }]}
              onValueChange={(v) => setDay(v === '1' ? 1 : 0)}
            />
          }
        >
          <div className={s.mapBox}>
            <BriefMap brief={b} day={day} campaignViewOf={campaignView(campaign, -0.3, [b.site.lon, b.site.lat + 0.012])} />
          </div>
        </Sheet>

        {/* ── 08-C assignments ────────────────────────────────────────── */}
        <Sheet code="08-C" title="Assignments" aside={<Caps>{day === 0 ? 'today' : 'tomorrow'}</Caps>}>
          <Assignments rows={b.assignments.filter((a) => a.day === day)} site={b.site.short} />
        </Sheet>
      </div>

      <div className={s.briefBottom}>
        {/* ── 08-D yesterday's debrief ────────────────────────────────── */}
        <Sheet
          code="08-D"
          title={`Debrief · ${fmtDayFull(`${b.debrief.date}T12:00:00`)}`}
          aside={<Caps>measured · {b.debrief.sites[0]?.measure.toUpperCase()}</Caps>}
        >
          <div className={s.debrief}>
            {b.debrief.sites.map((d) => (
              <DebriefRow key={d.site_id} d={d} name={siteShort.get(d.site_id) ?? d.site_id} />
            ))}
            <span className={s.noteDim}>
              Anomaly vs each street's own median, ppb. Intervals count hours, not passes — passes in one hour share their weather.
            </span>
          </div>
        </Sheet>

        {/* ── 08-E five-day strip ─────────────────────────────────────── */}
        <Sheet code="08-E" title="Five days" aside={<Caps>assigned 2 · watch 4</Caps>}>
          <div className={s.outlook}>
            {b.outlook.map((o) => <OutlookDay key={o.date} o={o} />)}
          </div>
          <div className={s.pad}>
            <span className={s.noteDim}>
              Past about {fmtNum(b.crossover_h, 0)} h the wind rose beats persistence, so days 2–5 are a watch list, not a schedule. The plan is rewritten every morning because the wind moved.
            </span>
          </div>
        </Sheet>

        {/* ── 08-F the ledger + the sample-size argument ──────────────── */}
        <Sheet code="08-F" title="Cost · coverage · capture" aside={<Caps>together or not at all</Caps>}>
          <Ledger b={b} />
        </Sheet>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════ the map

interface StratumPath { path: Position[]; stratum: BriefStratum }

function BriefMap({
  brief: b, day, campaignViewOf,
}: {
  brief: MissionBrief
  day: 0 | 1
  campaignViewOf: { longitude: number; latitude: number; zoom: number }
}) {
  // Data arrays are memoised: deck.gl diffs `data` by reference, and a fresh
  // array every render re-uploads every path.
  const paths = useMemo<StratumPath[]>(() => {
    const out: StratumPath[] = []
    for (const r of b.routes) {
      if (r.day !== day) continue
      // Background first, so the two questions draw on top of coverage.
      for (const st of ['background', 'upwind', 'downwind'] as BriefStratum[]) {
        for (const p of r.paths[st]) out.push({ path: p, stratum: st })
      }
    }
    return out
  }, [b.routes, day])

  const swath = useMemo(() => b.swath.filter((f) => f.ring), [b.swath])
  const callKeys = useMemo(() => {
    const from = b.call?.from
    const to = b.call?.to
    return new Set(swath.filter((f) => from && to && f.valid_at >= from && f.valid_at <= to).map((f) => f.lead_h))
  }, [swath, b.call])

  const axis = useMemo(() => {
    if (b.call?.axis_deg == null) return []
    const reach = Math.max(0, ...swath.filter((f) => callKeys.has(f.lead_h)).map((f) => f.x_reach_m))
    if (!reach) return []
    const o: Position = [b.site.lon, b.site.lat]
    const tip = destination(o, b.call.axis_deg, reach)
    const tick = [destination(tip, b.call.axis_deg - 90, 120), destination(tip, b.call.axis_deg + 90, 120)]
    return [{ path: [o, tip] }, { path: tick }]
  }, [b.call, b.site, swath, callKeys])

  const site = useMemo(() => [{ position: [b.site.lon, b.site.lat] as Position }], [b.site])
  const touchdown = b.debrief.touchdown

  const layers = useCallback((theme: Theme): LayersList => [
    // Yesterday, measured. The only inked thing that is not a route.
    new PathLayer({
      id: 'brief-yesterday',
      data: touchdown,
      getPath: (d: MissionBrief['debrief']['touchdown'][number]) => d.path,
      getColor: theme.color('ink', 0.3),
      getWidth: 6,
      widthUnits: 'pixels',
      capRounded: true,
    }),
    new PathLayer<StratumPath>({
      id: 'brief-routes',
      data: paths,
      getPath: (d) => d.path,
      getColor: (d) => theme.color(STRATUM_TOKEN[d.stratum], d.stratum === 'background' ? 0.35 : 0.95),
      getWidth: (d) => (d.stratum === 'background' ? 1.2 : 3),
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getColor: [theme], getWidth: [theme] },
    }),
    // The forecast, modelled: hairline outlines only, never a fill. The
    // call's own hours draw stronger than the rest of the day.
    new PolygonLayer({
      id: 'brief-swath',
      data: swath,
      getPolygon: (f: MissionBrief['swath'][number]) => f.ring as Position[],
      filled: false,
      stroked: true,
      getLineColor: (f: MissionBrief['swath'][number]) => theme.color('ink-2', callKeys.has(f.lead_h) ? 0.7 : 0.18),
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      updateTriggers: { getLineColor: [theme, callKeys] },
    }),
    new PathLayer({
      id: 'brief-axis',
      data: axis,
      getPath: (d: { path: Position[] }) => d.path,
      getColor: theme.color('ink', 0.85),
      getWidth: 1.2,
      widthUnits: 'pixels',
      getDashArray: [4, 3],
    }),
    new ScatterplotLayer({
      id: 'brief-site',
      data: site,
      getPosition: (d: { position: Position }) => d.position,
      getRadius: 6,
      radiusUnits: 'pixels',
      getFillColor: theme.color('actor-industry', 0.95),
      getLineColor: theme.color('bg', 1),
      lineWidthMinPixels: 2,
      stroked: true,
    }),
  ], [touchdown, paths, swath, callKeys, axis, site])

  return (
    <BaseMap label="Mission brief" initialView={campaignViewOf} layers={layers}>
      <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
      <MapOverlay place="top-right">
        <div className={s.overlayCard}>
          <Caps accent>legend</Caps>
          {(['downwind', 'upwind', 'background'] as BriefStratum[]).map((st) => (
            <div className={s.overlayRow} key={st}>
              <span className={s.legendLine} style={{ background: `var(--${STRATUM_TOKEN[st]})`, height: st === 'background' ? 1 : 3 }} />
              <span>{STRATUM_LABEL[st]}</span>
            </div>
          ))}
          <div className={s.overlayRow}>
            <span className={s.legendOutline} />
            <span>forecast plume, by hour · modelled</span>
          </div>
          <div className={s.overlayRow}>
            <span className={s.legendLine} style={{ background: 'var(--ink)', opacity: 0.3, height: 6 }} />
            <span>yesterday downwind · measured</span>
          </div>
          <span className={s.noteDim}>Strata are where a street falls IF the forecast is right. Computed now, never stored.</span>
        </div>
      </MapOverlay>
    </BaseMap>
  )
}

// ═════════════════════════════════════════════════════════════ assignments

function Assignments({ rows, site }: { rows: BriefAssignment[]; site: string }) {
  if (!rows.length) {
    return <div className={s.err}>No route in the plan for this day — the campaign's plan ends here.</div>
  }
  return (
    <div className={s.rowList}>
      {rows.map((a) => {
        const total = Math.max(0.01, a.km)
        return (
          <div className={s.assign} key={a.route_id}>
            <div className={s.assignTop}>
              <span className={s.assignVehicle}>{a.vehicle ?? '—'}</span>
              <span className={s.truncate}>{a.call_sign ?? ''} · {a.operator ?? 'unassigned'}</span>
              <span className={s.num}>{a.shift} · {hhmm(a.start)} · {fmtNum(a.km, 0)} km</span>
            </div>
            <div className={s.kmBar} aria-label={`${a.downwind_km} km downwind, ${a.upwind_km} km upwind, ${a.background_km} km background`}>
              {(['downwind', 'upwind', 'background'] as BriefStratum[]).map((st) => {
                const km = st === 'downwind' ? a.downwind_km : st === 'upwind' ? a.upwind_km : a.background_km
                return km > 0 ? (
                  <span key={st} style={{ width: `${(100 * km) / total}%`, background: `var(--${STRATUM_TOKEN[st]})`, opacity: st === 'background' ? 0.35 : 1 }} />
                ) : null
              })}
            </div>
            <div className={s.assignKm}>
              <span>downwind <b className={s.mono}>{fmtNum(a.downwind_km, 1)}</b> km{a.downwind_roads[0] ? ` · ${a.downwind_roads[0].road}` : ''}</span>
              <span>upwind <b className={s.mono}>{fmtNum(a.upwind_km, 1)}</b> km{a.upwind_roads[0] ? ` · ${a.upwind_roads[0].road}` : ''}</span>
            </div>
            <div className={a.control_ok ? s.controlLine : `${s.controlLine} ${s.controlLineWarn}`}>
              <Caps ink={a.control_ok} accent={false}>{a.control_ok ? 'control' : `control · ${site}`}</Caps>
              <span>{a.control_line}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════ the debrief

/** Shared x-axis for every site's bars, so the rows are comparable. */
const AXIS_PPB = 15

function DebriefRow({ d, name }: { d: BriefDebrief; name: string }) {
  const copy = debriefCopy(d, name)
  return (
    <div className={s.debriefRow}>
      <div className={s.debriefHead}>
        <span className={s.debriefSite}>{name}</span>
        <span className={`${s.verdict} ${s[`verdict_${d.verdict}`] ?? ''}`}>{VERDICT_LABEL[d.verdict]}</span>
      </div>
      {d.bars ? (
        <div className={s.bars}>
          {(['downwind', 'upwind', 'background'] as BriefStratum[]).map((st) => (
            <Bar key={st} label={st} stat={d.bars![st]} token={STRATUM_TOKEN[st]} />
          ))}
        </div>
      ) : null}
      <span className={s.note}>{copy}</span>
    </div>
  )
}

function Bar({ label, stat, token }: { label: string; stat: BriefStat; token: string }) {
  const x = (v: number) => 50 + (50 * Math.max(-AXIS_PPB, Math.min(AXIS_PPB, v))) / AXIS_PPB
  const has = stat.mean != null
  return (
    <div className={s.barRow}>
      <span className={s.barLabel}>{label}</span>
      <div className={s.barTrack}>
        <span className={s.barZero} />
        {has ? (
          <>
            <span
              className={s.barFill}
              style={{
                left: `${Math.min(50, x(stat.mean!))}%`,
                width: `${Math.abs(x(stat.mean!) - 50)}%`,
                background: `var(--${token})`,
              }}
            />
            {stat.ci_lo != null && stat.ci_hi != null ? (
              <span className={s.barCi} style={{ left: `${x(stat.ci_lo)}%`, width: `${x(stat.ci_hi) - x(stat.ci_lo)}%` }} />
            ) : null}
          </>
        ) : null}
      </div>
      <span className={s.barNum}>
        {has ? `${fmtSigned(stat.mean, 1)}` : 'not driven'}
        <span className={s.noteDim}> n {stat.n} · {stat.hours} h</span>
      </span>
    </div>
  )
}

function debriefCopy(d: BriefDebrief, name: string): string {
  const diff = d.downwind_minus_upwind
  switch (d.verdict) {
    case 'local':
      return `Downwind ran ${fmtSigned(diff?.mean, 1)} ppb above upwind [${fmtSigned(diff?.ci_lo, 1)}, ${fmtSigned(diff?.ci_hi, 1)}], over ${d.paired_hours ?? 0} paired hours. Rotated bearings did not reproduce it.`
    case 'advected':
      return `The air arrived elevated, and ${name} is not detectably adding to it. Only knowable because the upwind leg was driven.`
    case 'no_detection':
      return `Both sides driven. Downwind minus upwind ${fmtSigned(diff?.mean, 1)} ppb [${fmtSigned(diff?.ci_lo, 1)}, ${fmtSigned(diff?.ci_hi, 1)}] — inside the noise.`
    case 'contested':
      return 'A rotated bearing produced a comparable difference, so no interval or sample size is shown.'
    case 'unpaired':
      if (!d.missing.length) return 'Both sides driven, but never in the same hour — the day\'s traffic and mixing changed in between, so they cannot be compared.'
      if (d.missing.length === 2) return 'Neither side of the site was driven.'
      if (d.missing[0] === 'upwind') return 'We cannot distinguish local from advected because the control was not sampled.'
      return 'The fleet did not cross the plume.'
  }
}

// ═══════════════════════════════════════════════════════════ five-day strip

function OutlookDay({ o }: { o: BriefOutlookDay }) {
  const watch = o.status === 'watch'
  const spread = o.dir_sd_deg != null ? 2 * o.dir_sd_deg : null
  return (
    <div className={watch ? `${s.dayCell} ${s.dayWatch}` : s.dayCell}>
      <div className={s.dayTop}>
        <span className={s.dayName}>{o.day === 0 ? 'Today' : o.day === 1 ? 'Tomorrow' : fmtDayFull(`${o.date}T12:00:00`).split(/[ ,]/)[0]}</span>
        <span className={watch ? s.chip : `${s.chip} ${s.chipOn}`}>{o.status}</span>
      </div>
      <Compass axis={o.axis_deg} spread={spread} faint={watch} />
      <span className={s.dayDir}>{o.compass ? `→ ${o.compass}` : 'aloft'}</span>
      <span className={s.noteDim}>{o.district ?? '—'}</span>
      <span className={s.noteDim}>
        {spread != null ? `±${fmtNum(spread, 0)}°` : '—'} · {o.stable_hours} stable h
      </span>
      {o.beyond_crossover ? <span className={s.noteDim}>the rose, not a forecast</span> : null}
    </div>
  )
}

/** A small compass: the arc is the measured spread, the tick is the axis. */
function Compass({ axis, spread, faint }: { axis: number | null; spread: number | null; faint: boolean }) {
  const r = 18
  const pt = (deg: number, rr = r) => {
    const a = ((deg - 90) * Math.PI) / 180
    return [22 + rr * Math.cos(a), 22 + rr * Math.sin(a)]
  }
  let arc: string | null = null
  if (axis != null && spread != null && spread > 0) {
    const half = Math.min(179, spread)
    const [x0, y0] = pt(axis - half)
    const [x1, y1] = pt(axis + half)
    arc = `M22 22 L${x0} ${y0} A${r} ${r} 0 ${half > 90 ? 1 : 0} 1 ${x1} ${y1} Z`
  }
  const tip = axis != null ? pt(axis, r - 2) : null
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" className={s.compass} aria-hidden>
      <circle cx="22" cy="22" r={r} className={s.compassRing} />
      {arc ? <path d={arc} className={faint ? s.compassArcFaint : s.compassArc} /> : null}
      {tip ? <line x1="22" y1="22" x2={tip[0]} y2={tip[1]} className={s.compassNeedle} /> : null}
    </svg>
  )
}

// ═════════════════════════════════════════════════════════════════ ledger

function Ledger({ b }: { b: MissionBrief }) {
  const l = b.ledger
  const ss = b.sample_size
  const share = l.control_share
  return (
    <div className={s.stack}>
      <div className={s.ledger}>
        <div className={s.ledgerCell}>
          <Caps>cost</Caps>
          <span className={s.ledgerValue}>{fmtNum(l.vehicle_hours, 0)} h</span>
          <span className={s.noteDim}>{l.vehicles} vehicles · {fmtNum(l.km_driven, 0)} km</span>
        </div>
        <div className={s.ledgerCell}>
          <Caps>coverage</Caps>
          <span className={s.ledgerValue}>{fmtNum(l.network_pct, 0)}%</span>
          <span className={s.noteDim}>of {fmtNum(l.network_km, 0)} km network</span>
        </div>
        <div className={s.ledgerCell} style={{ ['--cellColor' as string]: 'var(--sev-warning)' }}>
          <Caps>capture</Caps>
          <span className={s.ledgerValue}>{fmtNum(l.downwind_km, 1)} km</span>
          <span className={s.noteDim}>
            in the corridor · control {share == null ? '—' : `${fmtNum(share * 100, 0)}%`}
            {l.control_check === 'fail' ? ` < ${fmtNum(l.min_control_share * 100, 0)}% floor` : ''}
          </span>
        </div>
      </div>
      <span className={s.noteDim}>
        Targeting reallocates these same shifts; it does not reduce them. The defensible claim is the same plume capture with fewer vehicle-days.
      </span>
      <div className={s.argument}>
        <Caps accent>the argument for targeted driving</Caps>
        <span className={s.note}>
          In the whole campaign, <b className={s.mono}>{ss.paired_hours}</b> of {ss.driven_hours} driven hours
          ({fmtNum(ss.paired_rate * 100, 1)}%) put a car on both sides of {b.site.short} at once,
          covering <b className={s.mono}>{ss.sectors_covered}</b> of {ss.sectors_total} wind directions.
        </span>
        <span className={s.note}>
          Within {fmtNum(ss.stable_near.radius_m / 1000, 0)} km in stable air: <b className={s.mono}>{ss.stable_near.passes}</b> downwind
          passes on {ss.stable_near.segments} street segments across {ss.stable_near.roads} roads.
        </span>
      </div>
    </div>
  )
}
