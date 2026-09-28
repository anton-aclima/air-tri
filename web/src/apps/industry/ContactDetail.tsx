/**
 * /industry/alerts/$alertId — one alert, and what to do about it.
 *
 * Two questions, in this order, and nothing else:
 *
 *   1. WHAT ELSE WAS MEASURING? The alert came from one source — a reference
 *      monitor, the residents, or Aclima's own cars. Beside it, each OTHER
 *      source on its own row, and the count of sources is the count of rows
 *      that actually say something. The fleet's own detection is never
 *      "corroborated" by the fleet: that was one measurement counted twice.
 *      Every row says which hours it describes. The operator's fenceline
 *      sensors are read AT THE ALERT'S HOURS, from the sensors that reported
 *      then; the street's record is the passes up to the moment shown
 *      (`todate&at`: the whole campaign at the end of the data, and labelled
 *      so either way), worded as where the street usually sits, not as proof.
 *
 *   2. WHAT DO I DO? A concrete recommendation. The rules answer is on screen
 *      the moment the page opens and is replaced in place when the model's
 *      lands. There is never a spinner where an answer should be.
 *
 * The wind panel describes the wind WHEN THE ALERT BEGAN — where it blew from
 * and where it carried this site's air — and stops there. It used to read the
 * latest wind and conclude "On the geometry, this is yours" or "it is unlikely
 * to be your plume": attribution from proximity and today's weather, which
 * CONTRACT §10a.3 forbids in both directions. Only the placebo-checked
 * downwind test (Evidence) may link a site to a place (F7).
 *
 * The alert is shown as it stood AT THE MOMENT SHOWN (F2): "ongoing for", or
 * "lasted" once it had ended. Only an ongoing alert offers Acknowledge; the
 * stored status is the final one and says nothing about the moment on screen.
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueries } from '@tanstack/react-query'

import { ModelVerificationPanel, TimeSeries, haversine } from '@/components'
import { Button, Field, Input, Textarea } from '@/app/ui'
import { getMonitorReadings } from '@/core/api'
import type { MonitorReadingsParams } from '@/core/api'
import {
  compassPoint, fmtCompact, fmtDateTime, fmtDay, fmtDistance,
  fmtNum, fmtPct, fmtTime24, isoDate, relativeShort,
} from '@/core/format'
import { addHours, campaignMs, floorTo } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { hasStarted, happenedBy, isOngoing } from '@/core/events'
import { SEVERITY_LABEL, formatValue, severityVar } from '@/core/measures'
import {
  qk, useAcknowledgeAlert, useAlert, useCreateMitigation, useCreatePost,
  useMeasure, useModelVerification, useMonitor, useMonitors, useSegmentDetail, useWind,
} from '@/core/queries'
import { timeParam, useNowCampaign, useSession } from '@/core/session'
import type { Alert, AlertStatus, Concern, MeasureCode, Monitor, SegmentProps } from '@/core/types'

import {
  Caps, Panel, Readout, Sev, Tag, endedBy, isSited, mitigationStatusAt, shortTitle, styles as s, upFor,
  useAdvisor, useCampaignWindow, useSiteLock, windThen,
} from './lib'
import { useStreetGrid } from './streets'

/** The one answer to "who can close a resident's report", matching the server (403). */
const WHO_CLOSES = "Only the air agency or Aclima can close a resident's report; you can answer it or propose a mitigation."

/** What became of a replayed, unacknowledged alert by the end of the data. */
const LATER_WORDS: Record<AlertStatus, string> = {
  active: 'Still open at the end',
  acknowledged: 'Acknowledged later',
  resolved: 'Resolved later',
  expired: 'Expired later',
}

/** "Aug 24 06:00" — a moment in campaign time, in words a glance can finish. */
function when(t: string): string {
  return `${fmtDay(t)} ${fmtTime24(t)}`
}

/** "Aug 27 02:00–07:00", or both dates when the span crosses midnight. */
function spanLabel(from: string, to: string): string {
  return from.slice(0, 10) === to.slice(0, 10)
    ? `${when(from)}–${fmtTime24(to)}`
    : `${when(from)} – ${when(to)}`
}

/** 1st, 2nd, 3rd, 11th, 92nd. */
function ordinal(n: number): string {
  const r = Math.round(n)
  const teen = r % 100 >= 11 && r % 100 <= 13
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[r % 10] ?? 'th'
  return `${r}${suffix}`
}

/** "NO2 1-hour watch level" — an action level as a noun the sentence can carry. */
function levelWords(label: string): string {
  return /watch$/i.test(label) ? `${label} level` : label
}

/**
 * The alert's own hours, as they stood at `now`: from the hour it began to the
 * moment it ended, or to now while it is ongoing. A resident cluster's hours
 * are its reports' hours — the cluster alert is raised later and runs for days
 * after the last report, and the question is what the air did while people
 * were reporting it. `to` is exclusive; hourly readings stamp the hour's start.
 */
function alertHours(
  alert: Alert, concerns: Concern[], now: CampaignTime,
): { from: CampaignTime; to: CampaignTime; label: string } {
  const nowMs = campaignMs(now)
  const cap = (t: CampaignTime) => (campaignMs(t) > nowMs ? floorTo(now, 60) : t)
  const cluster = alert.source_type === 'community' || alert.kind === 'concern_cluster'
  if (cluster && concerns.length) {
    const ts = concerns.map((c) => c.occurred_at).sort()
    const from = floorTo(ts[0], 60)
    const to = cap(addHours(floorTo(ts[ts.length - 1], 60), 1))
    return { from, to, label: spanLabel(from, to) }
  }
  const from = floorTo(alert.started_at, 60)
  const end = endedBy(alert, now)
  // Ongoing: the current hour is read too, and the label stops at the moment
  // shown rather than at the top of the next hour.
  return end
    ? { from, to: end, label: spanLabel(from, end) }
    : { from, to: addHours(floorTo(now, 60), 1), label: spanLabel(from, now) }
}

export function ContactDetail({ alertId }: { alertId: string }) {
  const site = useSiteLock()
  const now = useNowCampaign()
  const alertQ = useAlert(alertId, site?.id)
  const alert = alertQ.data
  const measure = useMeasure(alert?.measure ?? null)
  // The wind when the alert BEGAN, not the latest: the three hours up to its
  // start, so the observation in force then is always in the window.
  const startedAt = alert?.started_at
  const startWin = useMemo(() => {
    if (!startedAt) return null
    const to = addHours(floorTo(startedAt, 60), 1)
    return { from: addHours(to, -4), to }
  }, [startedAt])
  const windQ = useWind(startWin ?? {}, { enabled: !!startWin })
  const ack = useAcknowledgeAlert()
  const user = useSession((x) => x.user)
  // `status` is served as it stood at the moment shown (server/statusat.py):
  // 'acknowledged' only from the first acknowledgement's stamp. One made here
  // is stamped at the end of the data, so in replay it could not change what
  // this page shows; the control sends the reader to the end to make it.
  const replaying = useSession((x) => x.time.cursor != null)
  const setTimeCursor = useSession((x) => x.setTimeCursor)
  // The instrument that raised it, for its kind ("reference monitor") and owner.
  const sourceMonQ = useMonitor(alert?.source_type === 'monitor' ? alert.source_id : null)

  const advisor = useAdvisor(alertId, site?.id ?? null)

  if (alertQ.isError) {
    return <div className={`${s.page} ${s.detailPage}`}><div className={s.err}>Alert not found.</div></div>
  }
  if (!alert) {
    return <div className={`${s.page} ${s.detailPage}`}><div className={s.err}>Loading the alert…</div></div>
  }
  // Reached by a link while the clock is earlier than the alert: at the moment
  // shown it had not happened, so nothing about it is drawn (D2) — not even its
  // start time, which is the future too.
  if (!hasStarted(alert, now)) {
    return (
      <div className={`${s.page} ${s.detailPage}`}>
        <div className={s.err}>
          This alert had not begun at the moment shown. Move the clock later to see it, or{' '}
          <Link to="/industry/alerts">see the alerts up to now</Link>.
        </div>
      </div>
    )
  }

  const sited = isSited(alert)
  const ongoing = isOngoing(alert, now)
  const bearing = sited ? alert.bearing_deg ?? null : null
  const concerns = happenedBy(alert.concerns, now)
  const sourceMon = sourceMonQ.data
  const sourceKind = sourceKindOf(alert, sourceMon, site?.id ?? null)
  // D13: the fleet's detections reach industry with the regulator's advice
  // attached ("site a temporary monitor here"). It is not addressed to the
  // operator, so it is not printed to them.
  const recommendation = alert.audience?.includes('industry') ? alert.recommendation : null
  // The acknowledge control. `status` is as of the moment shown; an
  // acknowledgement is only ever made at the end of the data, where it meets
  // the status the alert has THERE — `status_at_end`, served beside `status`
  // with `at`. At the end an alert still 'active' is offered ACKNOWLEDGE even
  // when it has ended: that is the status an operator is asked to answer, and
  // a replayed "go to the end" would otherwise lead nowhere. In replay the
  // prompt is offered only when the end still has it 'active'; one that was
  // acknowledged, resolved or expired afterwards says so plainly. A server that
  // does not serve `status_at_end` yet keeps the old rule (ongoing only).
  const statusAtEnd = replaying ? alert.status_at_end : alert.status
  const ackControl: 'go-to-end' | 'later' | 'button' | 'ended' =
    replaying && alert.status === 'active'
      ? statusAtEnd === 'active' || (statusAtEnd == null && ongoing)
        ? 'go-to-end'
        : statusAtEnd != null ? 'later' : 'ended'
      : alert.status === 'active' || alert.status === 'acknowledged'
        ? 'button'
        : 'ended'

  return (
    <div className={`${s.page} ${s.detailPage}`}>
      {/* ── the alert, in one band ───────────────────────────────────── */}
      <div className={`${s.banner} ${alert.severity === 'critical' || alert.severity === 'warning' ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.verdict}>
          <span
            className={s.verdictGlyph}
            style={{ color: severityVar(alert.severity) }}
          >
            {alert.severity === 'critical' ? '◆' : alert.severity === 'warning' ? '▲' : alert.severity === 'watch' ? '△' : '·'}
          </span>
          <div className={s.bannerLine}>
            <span className={s.bannerHead}>{shortTitle(alert)}</span>
            <span className={s.bannerSub}>
              <Sev severity={alert.severity} />
              {' · '}
              {sourceKind.sentence}
              {alert.body ? ` · ${alert.body}` : ''}
            </span>
          </div>
        </div>
        <div className={s.bannerStats}>
          <Readout label="Toward" value={sited ? compassPoint(bearing) : 'site-wide'} />
          <Readout label="Distance" value={sited ? fmtDistance(alert.distance_m ?? null, 1) : '—'} />
          {/* As it stood AT THE MOMENT SHOWN: in replay an alert that ends
              later was still ongoing, and one that had ended reads how long it
              lasted, not the time since it began. */}
          <Readout label="Began" value={when(alert.started_at)} />
          <Readout
            label={ongoing ? 'Ongoing for' : 'Lasted'}
            value={<span style={ongoing ? { color: severityVar(alert.severity) } : undefined}>{upFor(alert, now)}</span>}
            big
          />
          {ackControl === 'go-to-end' ? (
            <div className={s.readout}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setTimeCursor(null)}
                title={`Not acknowledged as of ${when(now)}. An acknowledgement is stamped at the end of the data, so it is made from there.`}
              >
                GO TO THE END
              </Button>
              <Caps>to acknowledge</Caps>
            </div>
          ) : ackControl === 'later' && statusAtEnd ? (
            <Readout label="Not acknowledged by then" value={LATER_WORDS[statusAtEnd]} />
          ) : ackControl === 'button' ? (
            <div className={s.readout}>
              <Button
                size="sm"
                variant={alert.status === 'acknowledged' ? 'ghost' : 'secondary'}
                disabled={alert.status === 'acknowledged' || ack.isPending}
                onClick={() => ack.mutate({ id: alert.id, userId: user?.id })}
              >
                {alert.status === 'acknowledged' ? 'ACKNOWLEDGED' : 'ACKNOWLEDGE'}
              </Button>
              <Caps>{ongoing ? 'ongoing' : 'ended'}</Caps>
            </div>
          ) : (
            <Readout label="At the moment shown" value="Ended" />
          )}
        </div>
      </div>

      <div className={s.detailBody}>
        {/* ── evidence ─────────────────────────────────────────────── */}
        <div className={s.scrollStack}>
          {alert.kind === 'wind_shift' || alert.source_type === 'model' ? (
            <ModelCheck siteId={site?.id ?? null} />
          ) : (
            <Triangulation
              alert={alert}
              siteId={site?.id ?? null}
              now={now}
              concerns={concerns}
              source={sourceKind}
            />
          )}

          {alert.samples && alert.samples.length > 1 && measure && alert.kind !== 'wind_shift' ? (
            <Panel title={`${measure.code.toUpperCase()} at the ${sourceKind.noun}`}>
              <TimeSeries
                series={[{ id: 'src', label: shortTitle(alert), points: alert.samples }]}
                thresholds={alert.threshold != null
                  ? [{ id: 'lim', label: 'Action level', value: alert.threshold, severity: alert.severity, shade: true }]
                  : []}
                unit={alert.unit ?? ''}
                height={168}
                exceedanceSeriesId="src"
              />
            </Panel>
          ) : null}

          <ConcernList concerns={concerns} now={now} />
        </div>

        {/* ── the answer ───────────────────────────────────────────── */}
        <div className={s.scrollStack}>
          <Panel
            title="Recommended action"
            aside={
              advisor.upgrading ? (
                <span className={s.upgrading}><span className={s.upgradeDot} />refining</span>
              ) : advisor.reply ? (
                <Caps>{advisor.reply.source === 'llm' ? 'reviewed' : 'rules'} · {advisor.reply.confidence} confidence</Caps>
              ) : null
            }
          >
            <RecommendedAction advisor={advisor} recommendation={recommendation} />
          </Panel>

          <Panel title="The wind when it began">
            {!sited ? (
              <div className={s.geoText}>
                <span className={s.geoLine}>
                  This alert is about the site as a whole, not a place near it, so it has no
                  direction from your campus.
                </span>
              </div>
            ) : (
            // No compass dial: the owner retired the RWR's geometry (D8) —
            // "keep a small compass in the detail panel" was the option not
            // taken. The map already places the alert; this is the words.
            <div className={s.geo}>
              <div className={s.geoText}>
                <span className={s.geoLine}>
                  {windQ.isPending ? 'Reading the wind record…' : windThen(windQ.data, alert.started_at, bearing)}
                </span>
                {/* Wind, not attribution: which site's air this was is the
                    downwind test's question, and it is answered per site on
                    the Evidence page, with its rotation check. */}
                <span className={s.geoLine} style={{ color: 'var(--ink-2)' }}>
                  The wind says where air was carried, not whose it was. Your measured downwind
                  test, with its rotation check, is on the Evidence page.
                </span>
              </div>
            </div>
            )}
          </Panel>

          <RespondPanel alert={alert} siteId={site?.id ?? null} now={now} />
        </div>
      </div>
    </div>
  )
}

/* ────────────────────────────────────────────── what raised the alert */

interface SourceKind {
  kind: 'residents' | 'fleet' | 'fence' | 'reference' | 'monitor' | 'model'
  /** "reference monitor" — the thing, as a noun. */
  noun: string
  /** The banner's half-sentence: "Reference monitor run by DRAQA". */
  sentence: string
}

function sourceKindOf(alert: Alert, mon: Monitor | undefined, siteId: string | null): SourceKind {
  if (alert.source_type === 'community' || alert.kind === 'concern_cluster') {
    return { kind: 'residents', noun: 'residents', sentence: 'Reported by residents' }
  }
  if (alert.source_type === 'mobile') {
    return { kind: 'fleet', noun: 'Aclima fleet', sentence: 'Measured on the street by the Aclima fleet' }
  }
  if (alert.source_type === 'model') {
    return { kind: 'model', noun: 'model comparison', sentence: 'Model comparison' }
  }
  if (mon && siteId && mon.site_id === siteId) {
    return { kind: 'fence', noun: 'fenceline sensor', sentence: 'Your fenceline sensor' }
  }
  if (mon?.owner_type === 'regulator' || mon?.grade === 'reference') {
    return { kind: 'reference', noun: 'reference monitor', sentence: 'Reference monitor' }
  }
  return { kind: 'monitor', noun: 'monitor', sentence: 'Fixed monitor' }
}

/* ───────────────────────────────────────────────────── the recommendation */

function RecommendedAction({
  advisor, recommendation,
}: {
  advisor: ReturnType<typeof useAdvisor>
  recommendation: string | null
}) {
  const reply = advisor.reply
  // The backend's own one-liner stands in until the advisor's first answer
  // lands — a decisive sentence, never an empty box with a spinner in it.
  const headline = reply?.recommendation ?? recommendation
    ?? 'Check your fenceline sensors for the hours of this alert, and note what the site was running then.'

  return (
    <div className={s.action} key={advisor.revision}>
      <p className={`${s.actionText}${advisor.revision > 0 ? ` ${s.enriched}` : ''}`}>{headline}</p>

      {reply?.actions?.length ? (
        <div className={s.actionList}>
          {reply.actions.map((a, i) => (
            <div key={`${a.label}-${i}`} className={s.actionItem}>
              <span className={`${s.actionIndex} num`}>{i + 1}</span>
              <div>
                <div className={s.actionLabel}>{a.label}</div>
                <div className={s.actionDetail}>{a.detail}</div>
                {/* A sentence, so sentence case (DESIGN: caps are labels). */}
                {a.impact ? (
                  <div className={s.selNote} style={{ color: 'var(--scope, var(--accent))', marginTop: 'var(--s-1)' }}>
                    {a.impact}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {reply?.rationale ? (
        <details className={s.reasoning}>
          <summary>Why this</summary>
          <p>{reply.rationale}</p>
        </details>
      ) : null}

      {advisor.error ? <Caps>advisor unavailable</Caps> : null}
    </div>
  )
}

/* ─────────────────────────────── what else was measuring, at those hours */

interface FenceAtHours {
  state: 'no_sensors' | 'no_measure' | 'loading' | 'ready'
  /** Fenceline sensors that carry the pollutant (the one that raised the alert excluded). */
  carrying: number
  /** Of those, the ones with at least one valid reading in the hours. */
  reporting: number
  /** Of those, the ones that read over the lowest action level at least once. */
  over: number
  /** The highest reading in the hours, with where and when. */
  top: { m: Monitor; v: number; t: string } | null
  /** The lowest action level for the pollutant — what "over" means. */
  level: { label: string; threshold: number } | null
}

/**
 * The operator's own fenceline AT THE ALERT'S HOURS. Not `monitor.latest`,
 * which is the reading at the cursor — and, for a sensor that went offline in
 * July, a month-old value that sorted to the top and was printed as "the
 * fenceline" beside an August alert. Readings come from `/readings` over the
 * alert's hours, valid rows only, so a sensor that was offline then simply has
 * none and is counted as not reporting.
 */
function useFenceAtHours(
  siteId: string | null,
  code: MeasureCode | null,
  excludeId: string | null,
  win: { from: CampaignTime; to: CampaignTime },
): FenceAtHours {
  const monitorsQ = useMonitors({ site_id: siteId ?? undefined }, { enabled: !!siteId })
  const fence = useMemo(
    () => (monitorsQ.data ?? []).filter((m) => m.site_id === siteId && m.id !== excludeId),
    [monitorsQ.data, siteId, excludeId],
  )
  const carrying = useMemo(() => (code ? fence.filter((m) => m.measures.includes(code)) : []), [fence, code])
  // Inclusive on the server; the last hour is trimmed below. At least the
  // first hour, so an alert that began this hour still has one to read.
  const params: MonitorReadingsParams | null = code
    ? { measure: code, from: win.from, to: win.to, interval: 'hour' }
    : null
  const results = useQueries({
    queries: carrying.map((m) => ({
      queryKey: qk.monitors.readings(m.id, params as MonitorReadingsParams),
      queryFn: ({ signal }: { signal: AbortSignal }) => getMonitorReadings(m.id, params as MonitorReadingsParams, signal),
      enabled: !!params,
      staleTime: 60_000,
    })),
  })

  if (monitorsQ.isPending && !!siteId) return { state: 'loading', carrying: 0, reporting: 0, over: 0, top: null, level: null }
  if (!fence.length) return { state: 'no_sensors', carrying: 0, reporting: 0, over: 0, top: null, level: null }
  if (!carrying.length) return { state: 'no_measure', carrying: 0, reporting: 0, over: 0, top: null, level: null }
  if (results.some((r) => r.isPending)) {
    return { state: 'loading', carrying: carrying.length, reporting: 0, over: 0, top: null, level: null }
  }

  const fromMs = campaignMs(win.from)
  const toMs = campaignMs(win.to)
  const inHours = (t: string) => {
    const ms = campaignMs(t)
    return ms >= fromMs && (ms < toMs || ms === fromMs)
  }
  let level: FenceAtHours['level'] = null
  let top: FenceAtHours['top'] = null
  let reporting = 0
  let over = 0
  results.forEach((r, i) => {
    const data = r.data
    if (!data) return
    const lowest = data.action_levels.reduce<{ label: string; threshold: number } | null>(
      (a, b) => (!a || b.threshold < a.threshold ? { label: b.label, threshold: b.threshold } : a), null,
    )
    if (lowest && (!level || lowest.threshold < level.threshold)) level = lowest
    const pts = data.points.filter((p): p is { t: string; v: number } => p.v != null && inHours(p.t))
    if (!pts.length) return
    reporting += 1
    let best = pts[0]
    for (const p of pts) if (p.v > best.v) best = p
    if (lowest && best.v > lowest.threshold) over += 1
    if (!top || best.v > top.v) top = { m: carrying[i], v: best.v, t: best.t }
  })
  return { state: 'ready', carrying: carrying.length, reporting, over, top, level }
}

function Triangulation({
  alert, siteId, now, concerns, source,
}: {
  alert: Alert
  siteId: string | null
  now: CampaignTime
  concerns: Concern[]
  source: SourceKind
}) {
  // A community cluster names no pollutant, but the question is the same one:
  // what did the instruments see? NO2 is the proxy — it is what a turbine and
  // a diesel yard put out, and it is labelled as a proxy so nobody mistakes it
  // for what the residents actually reported.
  const isCluster = source.kind === 'residents'
  const isFleet = source.kind === 'fleet'
  const code = alert.measure ?? (isCluster ? ('no2' as const) : null)
  const proxy = !alert.measure && !!code
  const measure = useMeasure(code ?? null)
  const lon = alert.lon
  const lat = alert.lat

  const hours = useMemo(() => alertHours(alert, concerns, now), [alert, concerns, now])
  const fence = useFenceAtHours(siteId, code, alert.source_id, hours)

  // ~1.2 km box around the alert. The nearest covered street is reported with
  // its distance, because "we measured 900 m away" is a different claim from
  // "we measured right there" and the operator should see which one this is.
  // Not for the fleet's own detection: our cars cannot corroborate our cars.
  const d = 0.008
  const bbox: [number, number, number, number] | null =
    !isFleet && lon != null && lat != null ? [lon - d, lat - d, lon + d, lat + d] : null

  // NOTE: the server applies `limit` BEFORE the bbox filter, so a small limit
  // returns the campaign's top-N by value and then filters them away. The limit
  // has to exceed the campaign's segment count for a local query to be correct.
  //
  // Up to the moment shown (`todate&at`, P5), and the street's detail with it:
  // in replay the record is the passes by then, never one after.
  const segsQ = useStreetGrid(
    { measure: code ?? undefined, metric: 'p90', bbox, min_passes: 4, limit: 5000 },
    { enabled: !!bbox && !!code },
  )
  const at = useSession((x) => timeParam(x.time))
  const nearest = useMemo(() => {
    const feats = segsQ.data?.features ?? []
    if (!feats.length || lon == null || lat == null) return null
    let best: { props: SegmentProps; m: number } | null = null
    for (const f of feats) {
      const coords = f.geometry.coordinates
      const mid = coords[Math.floor(coords.length / 2)]
      if (!mid) continue
      const m = haversine([mid[0], mid[1]], [lon, lat])
      if (!best || m < best.m) best = { props: f.properties, m }
    }
    return best
  }, [segsQ.data, lon, lat])
  const nearProps = nearest?.props ?? null
  const nearM = nearest?.m ?? null
  const farAway = nearM != null && nearM > 700

  const detailQ = useSegmentDetail(nearProps?.id ?? null, { enabled: !!nearProps }, { at })
  const rank = code && detailQ.data ? detailQ.data.rank_pct?.[code] ?? null : null
  const stats = code && detailQ.data ? detailQ.data.stats?.[code] ?? null : null
  // The count and the words naming its moment come from ONE body, never from
  // the clock. The street's detail is asked AT the moment shown, so its count
  // is named from `at`. Until it lands only the grid has a count, and right
  // after a clock move the grid on screen is the previous moment's (held while
  // the next loads), so its words come from the grid body's own `window.to`.
  // While the detail for this moment is loading no count is printed at all:
  // the grid's would be a number from another moment beside this one's words.
  const detailLoading = !!nearProps && detailQ.isPending
  const passes: number | null = detailQ.data
    ? stats?.n_passes ?? nearProps?.n_passes ?? 0
    : detailLoading ? null : nearProps?.n_passes ?? 0
  const countTo: CampaignTime | null = detailQ.data
    ? at ?? null
    : at || segsQ.isPlaceholderData ? segsQ.data?.window?.to ?? at ?? null : null
  // "Whole campaign" is only true at the end of the data.
  const span = countTo ? `To ${when(countTo)}` : 'Whole campaign'
  const streetName = detailQ.data?.name ?? nearProps?.name ?? 'the nearest street'
  // The one windowed thing the street record has: that day's median, when the
  // cars drove it that day — and only for a day wholly before the moment
  // shown, since the day's passes may otherwise be later than it.
  const day = isoDate(hours.from)
  const dayMedian = code && detailQ.data && day < isoDate(now)
    ? detailQ.data.daily?.[code]?.find((p) => p.t === day)?.v ?? null
    : null

  const hasStreet = !isFleet && !!nearProps
  const fenceSays = fence.state === 'ready' && fence.reporting > 0
  const nSources = 1 + (hasStreet ? 1 : 0) + (fenceSays ? 1 : 0)
  const fmtV = (v: number) => (measure ? formatValue(measure, v, { role: 'industry' }) : fmtNum(v, 1))
  const pollutant = measure?.short_label ?? code?.toUpperCase() ?? ''

  const verdict = buildVerdict({
    code, isCluster, isFleet, farAway, nearM, passes, rank, streetName, fence, fmtV, pollutant,
    across: countTo ? `Up to ${when(countTo)}` : null,
  })

  return (
    <Panel
      title="What else was measuring nearby"
      aside={<Caps>{nSources === 1 ? 'one source' : `${nSources} sources`}</Caps>}
    >
      <div className={s.tri}>
        {/* 1 · what raised it */}
        <TriRow
          glyph={isCluster ? '●' : isFleet ? '▲' : '◆'}
          glyphColor={isCluster ? 'var(--actor-community)' : isFleet ? 'var(--fleet, var(--accent))' : 'var(--actor-regulator)'}
          title={isCluster ? 'Residents' : isFleet ? `Aclima fleet · ${shortTitle(alert)}` : shortTitle(alert) || 'Reporting instrument'}
          note={isCluster
            ? `Reports clustered in space and time · ${hours.label} · raised this alert`
            : isFleet
              ? 'Measured on the street by our cars · raised this alert'
              : `${source.noun.charAt(0).toUpperCase()}${source.noun.slice(1)} · raised this alert`}
          value={alert.value == null
            ? '—'
            : alert.unit
              ? `${fmtNum(alert.value, alert.unit === 'reports' ? 0 : 1)} ${alert.unit}`
              : fmtV(alert.value)}
          badge={alert.threshold != null && !isCluster ? `▲ over ${fmtNum(alert.threshold, 0)}` : SEVERITY_LABEL[alert.severity]}
          badgeColor={severityVar(alert.severity)}
        />

        {/* 2 · the street's record — up to the moment shown, and said so */}
        {!isFleet ? (
          <TriRow
            glyph="▲"
            glyphColor="var(--fleet, var(--accent))"
            title={`Aclima fleet · ${nearProps ? streetName : 'streets nearby'}`}
            note={nearProps
              ? [
                  passes == null ? 'Reading the street record at the moment shown…' : `${span}, ${fmtNum(passes, 0)} passes`,
                  detailQ.data?.district ?? nearProps.district ?? null,
                  nearM != null ? `${fmtDistance(nearM, 1)} away` : null,
                  dayMedian != null ? `driven ${fmtDay(hours.from)}, median ${fmtV(dayMedian)} that day` : null,
                  proxy ? `${pollutant} as a proxy` : null,
                ].filter(Boolean).join(' · ')
              : segsQ.isPending && !!bbox ? 'Reading the street record…' : 'No covered street near this alert.'}
            value={measure && stats
              ? formatValue(measure, stats.p90, { role: 'industry' })
              : measure && nearProps?.p90 != null
                ? formatValue(measure, nearProps.p90, { role: 'industry' })
                : '—'}
            badge={rank != null ? `${ordinal(rank)} pctile` : nearProps && passes != null ? 'thin sample' : '—'}
            badgeColor="var(--ink-2)"
          />
        ) : null}

        {/* 3 · your fenceline sensors, at the alert's hours */}
        <TriRow
          glyph="◇"
          glyphColor="var(--tower, var(--accent))"
          title={`Your fenceline sensors · ${hours.label}`}
          note={fenceNote(fence, pollutant)}
          value={fence.top ? fmtV(fence.top.v) : '—'}
          badge={fence.top && fence.level
            ? fence.top.v > fence.level.threshold ? `▲ over ${fmtNum(fence.level.threshold, 0)}` : `under ${fmtNum(fence.level.threshold, 0)}`
            : '—'}
          badgeColor={fence.top && fence.level && fence.top.v > fence.level.threshold ? 'var(--threat)' : 'var(--ink-2)'}
        />
      </div>

      <div className={s.triVerdict}>
        <span className={s.triVerdictWord} style={{ color: verdict.tone }}>{verdict.word}</span>
        <p className={s.triVerdictBody}>{verdict.body}</p>
      </div>
    </Panel>
  )
}

function TriRow({
  glyph, glyphColor, title, note, value, badge, badgeColor,
}: {
  glyph: string
  glyphColor: string
  title: string
  note: ReactNode
  value: ReactNode
  badge: ReactNode
  badgeColor: string
}) {
  return (
    <div className={s.triRow}>
      <span style={{ color: glyphColor }}>{glyph}</span>
      <div>
        <div className={s.triSrc}>{title}</div>
        {/* Sentence case: these are sentences, and caps are for labels. */}
        <div className={s.selSub}>{note}</div>
      </div>
      <span className={`${s.triValue} num`}>{value}</span>
      <span className={s.triState}>
        <span className={s.triBadge} style={{ color: badgeColor }}>{badge}</span>
      </span>
    </div>
  )
}

function fenceNote(f: FenceAtHours, pollutant: string): string {
  if (f.state === 'loading') return 'Reading your fenceline for those hours…'
  if (f.state === 'no_sensors') return 'No fenceline sensors on file for this site.'
  if (f.state === 'no_measure') return `None of your fenceline sensors measures ${pollutant}.`
  if (!f.reporting) return `None of your ${f.carrying} fenceline sensors reported ${pollutant} in those hours.`
  const silent = f.carrying - f.reporting
  const parts = [
    `${f.reporting} of ${f.carrying} reporting`,
    f.level ? `${f.over} over the ${levelWords(f.level.label)}` : null,
    f.top ? `highest at ${f.top.m.name}, ${when(f.top.t)}` : null,
    silent ? `${silent} with no reading then` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

function buildVerdict(o: {
  code: MeasureCode | null
  isCluster: boolean
  isFleet: boolean
  farAway: boolean
  nearM: number | null
  /** null while the street's detail for the moment shown is still loading. */
  passes: number | null
  rank: number | null
  streetName: string
  fence: FenceAtHours
  fmtV: (v: number) => string
  pollutant: string
  /** "Up to Aug 24 06:00" in replay; null paused at the end (the whole campaign). */
  across: string | null
}): { word: string; tone: string; body: string } {
  const { code, isCluster, isFleet, farAway, nearM, passes, rank, streetName, fence, fmtV, pollutant } = o
  const whole = o.across ?? 'Across the whole campaign'
  const over = o.across ?? 'Across the campaign'

  if (!code) {
    return {
      word: 'No single pollutant', tone: 'var(--ink-2)',
      body: 'This alert is not tied to one pollutant, so there is nothing to set beside it instrument to instrument.',
    }
  }

  // What the fenceline did in the same hours — the only row here that is
  // measured at the alert's own time besides the source itself.
  const fenceReady = fence.state === 'ready' && fence.reporting > 0 && !!fence.top && !!fence.level
  const fenceOver = fenceReady && fence.over > 0
  const fenceLine = !fenceReady
    ? ''
    : fenceOver
      ? `In the same hours ${fence.over} of your ${fence.reporting} reporting fenceline sensors read over the ${levelWords(fence.level!.label)}, highest ${fmtV(fence.top!.v)}.`
      : `In the same hours your ${fence.reporting} reporting fenceline sensors stayed under the ${levelWords(fence.level!.label)}, highest ${fmtV(fence.top!.v)}.`

  if (isFleet) {
    return fenceReady
      ? {
          word: fenceOver ? 'Also high' : 'Fleet only',
          tone: fenceOver ? 'var(--sev-warning)' : 'var(--ink-2)',
          body: `${fenceLine} The fleet's number is a measurement on that street; it says what the air there carried, not where it came from.`,
        }
      : {
          word: 'Fleet only', tone: 'var(--ink-2)',
          body: `None of your fenceline sensors reported ${pollutant} in those hours, so nothing on this page can confirm or dismiss the fleet's number. It is a measurement on that street, not a statement about where the air came from.`,
        }
  }

  const where = isCluster ? 'where those reports came from' : 'beside that instrument'
  const ord = rank != null ? ordinal(rank) : ''
  let word: string
  let street: string
  if (nearM == null) {
    word = 'No street record'
    street = 'No street we cover is near enough to say what the air here usually carries.'
  } else if (farAway) {
    word = 'Out of coverage'
    street = `The nearest street we cover is ${fmtDistance(nearM, 1)} away — too far to speak for this block.`
  } else if (passes == null) {
    word = 'Reading the street record'
    street = `Reading the passes on ${streetName} up to the moment shown…`
  } else if (passes < 12 || rank == null) {
    word = 'Too few passes'
    street = `Only ${fmtNum(passes, 0)} passes on ${streetName} — too few to say what it usually carries. Treat this as unverified, not as wrong.`
  } else if (rank >= 75) {
    word = 'Usually high'
    street = isCluster
      ? `${whole} our cars put the streets ${where} in the ${ord} percentile for ${pollutant} (${fmtNum(passes, 0)} passes). That is where they usually sit, not a reading from these hours.`
      : `${whole} our cars put ${streetName} in the ${ord} percentile (${fmtNum(passes, 0)} passes). A high reading is usual for this place, which makes the instrument's number plausible; it does not confirm these hours.`
  } else if (rank <= 40) {
    word = 'Usually typical'
    street = isCluster
      ? `${over} the streets ${where} sit at the ${ord} percentile for ${pollutant} (${fmtNum(passes, 0)} passes), at or below the norm. That does not make the reports wrong: odour and irritation travel on species nobody in this campaign measures.`
      : `${over} ${streetName} sits at the ${ord} percentile (${fmtNum(passes, 0)} passes), at or below the norm, so a high reading is unusual for this place. That is a reason to look at the instrument's own record, not proof that it is wrong.`
  } else {
    word = 'Somewhat raised'
    street = `${over} the streets ${where} sit at the ${ord} percentile (${fmtNum(passes, 0)} passes): raised, not unusual.`
  }
  if (fenceOver) word = 'Also high'
  return {
    word,
    tone: fenceOver ? 'var(--sev-warning)' : 'var(--ink-2)',
    body: [fenceLine, street].filter(Boolean).join(' '),
  }
}

/* ─────────────────────────────────────────────── verify your consultant */

function ModelCheck({ siteId }: { siteId: string | null }) {
  // The campaign, not the last 30 days — see `useCampaignWindow`.
  const verifyWin = useCampaignWindow()
  const verifyQ = useModelVerification(siteId, verifyWin ?? {}, {
    enabled: !!siteId && !!verifyWin,
  })
  const v = verifyQ.data
  return (
    <>
      <Panel
        title="Your dispersion study vs. what we measured"
        aside={v ? <Caps>{fmtCompact(v.n_obs)} fleet wind observations</Caps> : null}
      >
        <ModelVerificationPanel data={v ?? null} roseSize={196} />
      </Panel>
      {v && v.affected_districts.length ? (
        <Panel title="Who the study under-weights">
          <div className={s.tri}>
            {v.affected_districts.map((d) => (
              <TriRow
                key={d.district}
                glyph="●"
                glyphColor="var(--actor-community)"
                title={d.district}
                note="Hours with the wind blowing this way, measured by the fleet."
                value={`${fmtNum(d.observed_freq, 1)}%`}
                badge={`study assumed ${fmtNum(d.assumed_freq, 1)}%`}
                badgeColor="var(--ink-2)"
              />
            ))}
          </div>
          <div className={s.triVerdict}>
            <p className={s.triVerdictBody}>
              The rose the study assumed is not the rose we measured. That is not a reason to
              discount the study's chemistry — it is a reason to re-run it on the observed rose
              before Phase 2 permitting, because the receptor set changes.
            </p>
          </div>
        </Panel>
      ) : null}
    </>
  )
}

/* ──────────────────────────────────────────────── the residents behind it */

/** Only the reports filed by `now` — the caller has already cut the list. */
function ConcernList({ concerns, now }: { concerns: Concern[]; now: CampaignTime }) {
  if (!concerns.length) return null
  return (
    <Panel title={`Resident reports · ${concerns.length}`}>
      <div className={s.tri}>
        {concerns.map((c) => (
          <div key={c.id} className={s.triRow} style={{ gridTemplateColumns: '12px minmax(0,1fr) 96px' }}>
            <span style={{ color: 'var(--actor-community)' }}>●</span>
            <div>
              <div className={s.triSrc}>{c.title}</div>
              <div className={s.triNote}>
                {c.kind} · {c.district ?? c.address_hint ?? 'nearby'} · {relativeShort(c.occurred_at, now)}
                {c.corroborations ? ` · +${c.corroborations} agreed` : ''}
              </div>
            </div>
            <span className={s.triState}>
              <span className={s.triBadge} style={{ color: 'var(--ink-2)' }}>{c.status.replace(/_/g, ' ')}</span>
            </span>
          </div>
        ))}
      </div>
      <div className={s.triVerdict}>
        <p className={s.triVerdictBody}>{WHO_CLOSES}</p>
      </div>
    </Panel>
  )
}

/* ───────────────────────────────────────────────────────── act on it */

function RespondPanel({ alert, siteId, now }: { alert: Alert; siteId: string | null; now: CampaignTime }) {
  const mitigate = useCreateMitigation()
  const post = useCreatePost()
  const user = useSession((x) => x.user)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pct, setPct] = useState('')
  const [sent, setSent] = useState<'none' | 'mitigation' | 'post'>('none')

  if (!siteId) return null
  const disabled = !title.trim() || mitigate.isPending || post.isPending
  // Filed by the moment shown. By FILING time, not `started_at`: a mitigation
  // proposed for later had still been proposed. One filed live is stamped with
  // the server's now, the end of the data, so it appears once the clock is back
  // at the end.
  const filed = (alert.mitigations ?? []).filter((m) => hasStarted({ created_at: m.created_at }, now))

  const submit = (kind: 'mitigation' | 'post') => {
    if (kind === 'mitigation') {
      mitigate.mutate(
        {
          site_id: siteId,
          title: title.trim(),
          body: body.trim() || undefined,
          alert_id: alert.id,
          ...(alert.measure ? { measure: alert.measure } : {}),
          ...(pct.trim() ? { expected_reduction_pct: Number(pct) } : {}),
        },
        { onSuccess: () => { setSent('mitigation'); setTitle(''); setBody(''); setPct('') } },
      )
    } else {
      post.mutate(
        {
          site_id: siteId,
          kind: 'response',
          title: title.trim(),
          body: body.trim() || title.trim(),
          ...(user?.id ? { author_id: user.id } : {}),
        },
        { onSuccess: () => { setSent('post'); setTitle(''); setBody('') } },
      )
    }
  }

  return (
    <Panel title="Respond">
      <div className={s.form}>
        <div className={s.notice}>
          <span className={s.noticeMark}>▲</span>
          <span>
            {WHO_CLOSES} A mitigation is a claim you are making, and it will be read as one.
          </span>
        </div>

        <Field label="What are you doing about it">
          <Input
            value={title}
            placeholder="What you changed, and until when"
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
        </Field>
        <Field label="Detail (optional)">
          <Textarea
            rows={3}
            value={body}
            placeholder="What changed, when it started, when you expect the fenceline to respond."
            onChange={(e) => setBody(e.currentTarget.value)}
          />
        </Field>
        <div className={s.formRow}>
          <Field label="Expected reduction %">
            <Input numeric value={pct} inputMode="numeric" onChange={(e) => setPct(e.currentTarget.value)} />
          </Field>
          <span className={s.spacer} />
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => submit('post')}>
            POST UPDATE
          </Button>
          <Button variant="primary" size="sm" disabled={disabled} onClick={() => submit('mitigation')}>
            PROPOSE MITIGATION
          </Button>
        </div>

        {sent !== 'none' ? (
          <span className={s.selNote}>
            {sent === 'mitigation'
              ? 'Mitigation filed, and posted to the community feed as yours.'
              : 'Posted to the community feed.'}
          </span>
        ) : null}

        {filed.length ? (
          <div className={s.tri}>
            {filed.map((m) => (
              <div key={m.id} className={s.triRow} style={{ gridTemplateColumns: '12px minmax(0,1fr) 96px' }}>
                <span style={{ color: 'var(--scope)' }}>◇</span>
                <div>
                  <div className={s.triSrc}>{m.title}</div>
                  <div className={s.triNote}>
                    {mitigationStatusAt(m, now).replace('_', ' ')} · {fmtDateTime(m.created_at)}
                    {m.expected_reduction_pct != null ? ` · −${fmtPct(m.expected_reduction_pct, 0, false)} expected` : ''}
                  </div>
                </div>
                <span className={s.triState}><Tag>filed</Tag></span>
              </div>
            ))}
          </div>
        ) : null}

        <Link to="/industry/outreach" className={s.stripLink}>
          <Caps>Open outreach →</Caps>
        </Link>
      </div>
    </Panel>
  )
}

