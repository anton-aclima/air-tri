/**
 * /regulator — THE WATCHFLOOR.
 *
 * Network status at a glance, and what is over the line right now.
 *
 * The screen is laid out the way the agency actually thinks: the lines they
 * drew are on the left, the assets that watch those lines are on the right, and
 * the sky the assets are watching runs along the bottom. Every tripwire shows
 * its worst live reading against the threshold on the same pinned scale, so the
 * eye compares overshoot rather than units.
 *
 * Two of those tripwires are drawn in a different colour, and not for decoration:
 * black carbon, methane and diesel are channels no DRAQA reference instrument
 * carries. The agency can set the number; it cannot measure it. That is the
 * whole argument for the fleet, and it is read off the instrument list rather
 * than asserted.
 */

import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { AlertTimeline } from '@/components'
import { fmtCompact, fmtNum, relativeShort } from '@/core/format'
import { severityRank, severityVar } from '@/core/measures'
import {
  useActionLevels, useAlerts, useCampaignStats, useFleet, useMonitors, useSites,
} from '@/core/queries'
import { useSession } from '@/core/session'
import type { Alert, MeasureCode, Monitor, Severity } from '@/core/types'

import {
  Caps, KIND_CODE, Panel, Readout, Sev, Tag, Unit, Wire, fmtRatio, liveAlerts, levelUnit,
  overBy, shortWhere, sortLevels, sourceTag, SOURCE_TAG_LABEL, styles as s, tinyCode,
  towerMeasures, towersFor, useMeasureMap, useNowTick, useReach, useTowers,
} from './lib'

export function Watchfloor() {
  const navigate = useNavigate()
  const now = useNowTick()
  const setMeasure = useSession((x) => x.setMeasure)

  const towersQ = useTowers()
  const towers = towersQ.data ?? []
  const monitors = useMonitors().data ?? []
  const alertsQ = useAlerts({})
  const levels = useActionLevels().data ?? []
  const stats = useCampaignStats().data
  const fleet = useFleet().data ?? []
  const sites = useSites().data ?? []
  const measures = useMeasureMap()

  const live = useMemo(() => liveAlerts(alertsQ.data), [alertsQ.data])
  const towerIds = useMemo(() => new Set(towers.map((m) => m.id)), [towers])
  const canSee = useMemo(() => towerMeasures(towers), [towers])

  // The reach numbers are computed against whichever pollutant is in the
  // session, so the "how far past the towers" read follows the measure picker.
  const measureCode = useSession((x) => x.measure)
  const { reach } = useReach(measureCode)

  /**
   * The headline is a concentration, not a report count: a community cluster and
   * a 192 ppb fenceline reading can both be `warning`, but only one of them is a
   * number the agency can put in a notice. Concentration wins the tie.
   */
  const worst = useMemo(
    () =>
      [...live].sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          Number(isConcentration(b)) - Number(isConcentration(a)) ||
          (overBy(b) ?? 0) - (overBy(a) ?? 0),
      )[0],
    [live],
  )
  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, warning: 0, watch: 0, info: 0 }
    for (const a of live) c[a.severity] += 1
    return c
  }, [live])
  const over = counts.critical > 0 || counts.warning > 0

  /** Worst live reading per tripwire, and who saw it. */
  const byLevel = useMemo(() => {
    const m = new Map<string, Alert[]>()
    for (const a of live) {
      if (!a.action_level_id) continue
      const arr = m.get(a.action_level_id)
      if (arr) arr.push(a)
      else m.set(a.action_level_id, [a])
    }
    return m
  }, [live])

  const rows = useMemo(
    () =>
      sortLevels(levels.filter((l) => l.enabled)).map((l) => {
        const hits = (byLevel.get(l.id) ?? []).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
        const top = hits[0]
        const sources = new Set(hits.map((a) => sourceTag(a, towerIds)))
        return {
          level: l,
          hits,
          top,
          sources,
          blind: !canSee.has(l.measure),
          towers: towersFor(towers, l.measure).length,
        }
      }),
    [levels, byLevel, towerIds, canSee, towers],
  )

  const tripped = rows.filter((r) => r.hits.length > 0)
  const blindTripped = tripped.filter((r) => r.blind)
  const online = towers.filter((m) => m.status === 'online').length
  const driving = fleet.filter((v) => v.status === 'driving').length

  const timeline = useMemo(
    () =>
      [...live]
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
        .slice(0, 14)
        .map((a) => ({
          id: a.id,
          label: `${a.measure ? a.measure.toUpperCase() : 'CLUSTER'} · ${shortWhere(a)}`,
          code: tinyCode(a),
          severity: a.severity,
          startedAt: a.started_at,
          endedAt: a.ended_at,
          acknowledged: a.status === 'acknowledged',
        })),
    [live],
  )

  return (
    <div className={`${s.page} ${s.watchPage}`}>
      {/* ── the one-second read ─────────────────────────────────────────── */}
      <div className={`${s.verdict} ${over ? s.verdictOver : s.verdictClear}`}>
        <div className={s.verdictMark}>
          <span className={`${s.verdictGlyph} ${over ? s.overInk : s.clearInk}`}>{over ? '▲' : '◇'}</span>
          <span className={`${s.verdictWord} ${over ? s.overInk : s.clearInk}`}>
            {over ? 'OVER THE LINE' : live.length ? 'WATCH' : 'WITHIN LIMITS'}
          </span>
        </div>

        <div className={s.verdictLines}>
          {worst ? (
            <>
              <span className={s.verdictHead}>
                {worst.measure ? worst.measure.toUpperCase() : 'CLUSTER'}
                {'  '}
                {fmtNum(worst.value, isConcentration(worst) ? (measures.get(worst.measure ?? 'no2')?.decimals ?? 1) : 0)}
                {worst.unit ? ` ${worst.unit === 'ug/m3' ? 'µg/m³' : worst.unit}` : ''}
                {'   ·   '}
                {fmtRatio(overBy(worst))} the action level
                {'   ·   '}
                {shortWhere(worst)}
              </span>
              <span className={s.sub}>
                {tripped.length} of {rows.length} action levels tripped ·{' '}
                {blindTripped.length > 0
                  ? `${blindTripped.length} of them on channels no reference instrument carries`
                  : 'all on channels the reference network carries'}
              </span>
            </>
          ) : (
            <>
              <span className={s.verdictHead}>No action level is currently tripped</span>
              <span className={s.sub}>{rows.length} tripwires armed across {towers.length} reference sites.</span>
            </>
          )}
        </div>

        <div className={s.verdictStats}>
          <Readout label="Active" value={fmtNum(live.length, 0)} tone={over ? 'over' : 'accent'} big />
          <Readout label="Warn / Watch" value={`${counts.warning + counts.critical} / ${counts.watch}`} tone={over ? 'over' : undefined} />
          <Readout label="Towers up" value={`${online}/${towers.length}`} tone={online === towers.length ? 'tower' : 'over'} />
          <Readout label="Cars rolling" value={`${driving}/${fleet.length}`} tone="fleet" />
          <Readout
            label="Street-km measured"
            value={fmtNum((stats?.km_driven ?? 0) / 1000, 1)}
            unit="k km"
            tone="fleet"
            title="Cumulative distance our fleet has driven inside the campaign."
          />
        </div>
      </div>

      <div className={s.watchBody}>
        {/* ── the lines DRAQA drew, and what is standing on them ───────── */}
        <Panel
          title="The line right now"
          aside={
            <>
              <Caps>threshold pinned · bar is overshoot</Caps>
              <Tag tone="accent">{tripped.length} tripped</Tag>
            </>
          }
        >
          <div className={s.rows}>
            <div className={`${s.rowHead} ${s.overCols}`} style={{ gridTemplateColumns: '62px minmax(0, 1fr) 92px 74px' }}>
              <span>measure</span><span>action level · worst live reading</span><span style={{ textAlign: 'right' }}>value</span><span style={{ textAlign: 'right' }}>× limit</span>
            </div>
            {rows.map((r) => {
              const def = measures.get(r.level.measure)
              const v = r.top?.value ?? null
              const ratio = v != null && r.level.threshold > 0 ? v / r.level.threshold : null
              return (
                <button
                  key={r.level.id}
                  type="button"
                  className={`${s.lineRow}${r.hits.length ? ` ${s.lineRowOver}` : ''}`}
                  onClick={() => {
                    setMeasure(r.level.measure as MeasureCode)
                    navigate({ to: '/regulator/thresholds' })
                  }}
                  title={`${r.level.label} — ${r.hits.length} live`}
                >
                  <span className={s.lineName}>
                    <span className={`${s.lineNum} ${s.accentInk}`} style={{ textAlign: 'left' }}>
                      {r.level.measure.toUpperCase()}
                    </span>
                    <span className={s.caps}>{KIND_CODE[r.level.kind]} {fmtNum(r.level.averaging_hours, 0)}h</span>
                  </span>

                  <span className={s.lineName}>
                    <span className={s.lineLabel}>
                      {r.level.label}
                      <span className={s.dim}>
                        {'  '}· {fmtNum(r.level.threshold, 1)} <Unit>{levelUnit(r.level)}</Unit>
                      </span>
                    </span>
                    <Wire value={v} threshold={r.level.threshold} severity={r.level.severity} />
                    <span className={s.toolbar}>
                      <Sev severity={r.level.severity} />
                      {r.blind ? (
                        <Tag tone="fleet" title="No DRAQA reference instrument carries this channel. Only the mobile fleet can trip this line.">
                          fleet only · 0 towers
                        </Tag>
                      ) : (
                        <Tag tone="tower">{r.towers} of {towers.length} towers</Tag>
                      )}
                      {[...r.sources].map((src) => (
                        <Tag key={src} tone={src === 'fleet' ? 'fleet' : src === 'tower' ? 'tower' : src === 'community' ? 'community' : 'invader'}>
                          {SOURCE_TAG_LABEL[src]}
                        </Tag>
                      ))}
                      {r.hits.length ? <Caps>{r.hits.length} live · {shortWhere(r.top)}</Caps> : <Caps>clear</Caps>}
                    </span>
                  </span>

                  <span className={s.lineNum} style={{ color: ratio != null && ratio >= 1 ? severityVar(r.level.severity) : 'var(--ink-3)' }}>
                    {v == null ? '—' : fmtNum(v, def?.decimals ?? 1)}
                  </span>
                  <span className={s.lineNum} style={{ color: ratio != null && ratio >= 1 ? severityVar(r.level.severity) : 'var(--ink-3)' }}>
                    {fmtRatio(ratio)}
                  </span>
                </button>
              )
            })}
          </div>
        </Panel>

        {/* ── the assets ───────────────────────────────────────────────── */}
        <div className={s.watchSide}>
          <TowerBoard towers={towers} allMonitors={monitors} />

          <Panel
            title={`Reach · ${measureCode.toUpperCase()}`}
            aside={<Caps>p90 by street, 90 days</Caps>}
          >
            <div className={s.reach}>
              <div className={s.reachRow}>
                <Caps tone="ink">coverage</Caps>
                <div className={s.reachBar} role="presentation">
                  <div className={s.reachInside} style={{ width: `${pct(reach.inside, reach.total)}%` }} />
                  <div className={s.reachOutside} style={{ width: `${100 - pct(reach.inside, reach.total)}%` }} />
                  <div className={s.reachEdge} style={{ left: `${pct(reach.inside, reach.total)}%` }} />
                </div>
                <span className={`${s.reachNum} ${s.fleetInk}`}>{fmtNum(reach.kmOutside, 0)} km</span>
              </div>
              <span className={s.subTight}>
                <span className={s.towerInk}>■</span> {fmtNum(reach.inside, 0)} street segments inside a
                2.5 km representativeness radius   ·   <span className={s.fleetInk}>▨</span>{' '}
                {fmtNum(reach.outside, 0)} beyond every ring, {fmtNum(reach.kmOutside, 0)} km of road no
                stationary instrument stands for. The fleet drives all of them.
              </span>

              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-2)' }}>
                <Caps tone="ink">inside one ring, the streets still disagree</Caps>
              </div>
              {reach.perTower
                .filter((t) => t.towerValue != null && t.segments > 0)
                .map((t) => (
                  <div key={t.monitor.id} className={s.kv}>
                    <span className={s.rowTrunc}>
                      {t.monitor.name}
                      <span className={s.dim}> · {fmtNum(t.segments, 0)} streets in ring</span>
                    </span>
                    <span className={s.kvVal}>
                      tower {fmtNum(t.towerValue, 1)} → streets {fmtNum(t.lo, 1)}–{fmtNum(t.hi, 1)}
                      <span className={s.fleetInk}>{'  '}{fmtNum(t.spread, 1)}×</span>
                    </span>
                  </div>
                ))}
              {reach.perTower.every((t) => t.towerValue == null) ? (
                <div className={s.blindBanner}>
                  <span className={s.fleetInk}>▨</span>
                  <span className={s.subTight}>
                    No reference instrument carries a {measureCode.toUpperCase()} channel. Every number
                    on this pollutant in the region comes from the mobile fleet.
                  </span>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title="Suspected emitters" aside={<Caps>three sides · attribution unresolved</Caps>}>
            <div className={s.rows}>
              {sites.map((site) => {
                const near = live.filter((a) => a.site_id === site.id)
                return (
                  <div key={site.id} className={`${s.row} ${s.overCols}`} style={{ cursor: 'default', gridTemplateColumns: '20px minmax(0,1fr) auto' }}>
                    <span className={s.overInk}>◤</span>
                    <span className={s.rowTrunc}>
                      {site.name}
                      <span className={s.dim}> · {site.kind}</span>
                    </span>
                    <span className={s.toolbar}>
                      {near.length ? <Tag tone="invader">{near.length} contact{near.length > 1 ? 's' : ''}</Tag> : <Caps>quiet</Caps>}
                    </span>
                  </div>
                )
              })}
            </div>
          </Panel>
        </div>
      </div>

      {/* ── how long each has been standing there ───────────────────────── */}
      <Panel
        title="Live exceedances · duration"
        aside={<Caps>{live.length ? `oldest ${relativeShort(oldest(live), now)}` : 'nothing up'}</Caps>}
      >
        {timeline.length ? (
          <AlertTimeline
            alerts={timeline}
            rowHeight={13}
            maxRows={6}
            labels
            onSelect={(id) => id && navigate({ to: '/regulator/alerts' })}
            style={{ padding: '4px 10px 8px' }}
          />
        ) : (
          <div className={s.empty}>No live exceedances in the window.</div>
        )}
      </Panel>
    </div>
  )
}

/** Does this alert carry a real concentration, or is it a count of something? */
function isConcentration(a: Alert): boolean {
  return a.measure != null && a.unit != null && !/report|%|hour/i.test(a.unit)
}

function pct(a: number, b: number): number {
  return b > 0 ? (a / b) * 100 : 0
}

function oldest(alerts: Alert[]): string {
  return alerts.reduce((acc, a) => (a.started_at < acc ? a.started_at : acc), alerts[0]?.started_at ?? '')
}

/**
 * The towers, and what each one is blind to.
 *
 * A reference instrument is not a dot on a map to the agency that owns it: it
 * is an asset with a status, a channel list and a calibration date. The channel
 * list is the important half — printing what an instrument does NOT carry is
 * more informative here than printing what it does.
 */
function TowerBoard({ towers, allMonitors }: { towers: Monitor[]; allMonitors: Monitor[] }) {
  const navigate = useNavigate()
  const measures = useMeasureMap()
  const measureCode = useSession((x) => x.measure)
  const others = allMonitors.filter((m) => m.owner_type !== 'regulator')

  return (
    <Panel
      title={`Reference network · ${towers.length} towers`}
      aside={<Caps>{others.length} non-DRAQA sensors on the map</Caps>}
    >
      <div className={s.towerGrid}>
        {towers.map((m) => {
          const dark = !m.measures.includes(measureCode)
          const reads = m.measures
            .map((c) => ({ code: c, latest: m.latest?.[c] ?? null, def: measures.get(c) }))
            .sort((a, b) => (a.code === measureCode ? -1 : b.code === measureCode ? 1 : 0))
          return (
            <button
              key={m.id}
              type="button"
              className={[
                s.tower,
                m.status === 'degraded' ? s.towerDegraded : '',
                m.status === 'offline' || m.status === 'maintenance' ? s.towerOffline : '',
                dark ? '' : s.towerActive,
              ].filter(Boolean).join(' ')}
              onClick={() => navigate({ to: '/regulator/map' })}
            >
              <span className={s.towerHead}>
                <span className={dark ? s.dim : s.towerInk}>▲</span>
                <span className={s.towerName}>{m.name}</span>
              </span>
              <span className={s.toolbar}>
                <Tag tone={m.status === 'online' ? 'tower' : undefined}>{m.status}</Tag>
                <Caps>{fmtCompact((m.radius_m ?? 0) / 1000)} km ring</Caps>
              </span>
              <span className={s.towerReads}>
                {reads.map((r) => (
                  <span
                    key={r.code}
                    className={`${s.towerRead}${r.latest?.exceeds ? ` ${s.towerReadOver}` : ''}`}
                  >
                    <span className={r.code === measureCode ? s.accentInk : s.dim}>{r.code.toUpperCase()}</span>
                    <span style={{ textAlign: 'right' }}>{fmtNum(r.latest?.value ?? null, r.def?.decimals ?? 1)}</span>
                    <span className={s.dim}>{r.latest?.exceeds ? '▲' : ''}</span>
                  </span>
                ))}
              </span>
              {dark ? (
                <span className={s.blind}>
                  blind to {measureCode.toUpperCase()}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>
    </Panel>
  )
}
