/**
 * /regulator/alerts — the queue, as episodes (docs/PLAN-refocus.md R6).
 *
 * One row per source and pollutant, not one per alert. At the end of the
 * checked-in data nine of the queue's rows were one instrument: every
 * Riverport Road NO2 hour over 100 ppb trips both the 60 ppb watch and the
 * 100 ppb standard, so four mornings and two evenings (Aug 24–27) read as
 * nine identical "Riverport Road · Exceedance" rows. Now:
 *
 *   - an EPISODE is one source's alerts for one pollutant over consecutive
 *     hours — overlapping or touching runs merge, a gap of a full hour starts
 *     a new one — and the highest level tripped wins (the same key and the
 *     same rule as `foldConcurrent`, so the rows and the one count agree);
 *   - a ROW is that source and pollutant's episodes, open ones and closed
 *     ones apart: "NO2 at Riverport Road · 6 episodes Aug 24–27 · peak
 *     121.4 ppb".
 *
 * Everything follows the moment shown (core/events): nothing that had not
 * begun is listed, an alert whose end lies after the moment is still ongoing,
 * and an ended one says "ended 1 d ago" — never "up for 29d", which is what
 * the old age column printed for a one-hour exceedance. The count in the title
 * is `useLiveAlerts('regulator')`, the same number as the nav badge.
 *
 * Acknowledgement follows the moment as well. The server serves each alert's
 * `status` as it stood at `at` (server/statusat.py): 'acknowledged' only from
 * its first acknowledgement's stamp, 'resolved' never before it ended. So at
 * Aug 25 06:00 the NO2 hour acknowledged later that day counts in "not
 * acknowledged". An acknowledgement made here is stamped at the end of the
 * data, so in replay it could not change the moment shown: the sheet sends
 * the reader to the end to make one instead of filing one the page would go
 * on calling unacknowledged.
 *
 * The source column is doing quiet work: reading down it shows which rows a
 * reference monitor raised and which only the mobile fleet or residents could,
 * on channels and streets the reference network does not carry. The detail
 * and the push composer open in a side sheet, so the list keeps the page.
 */

import { useMemo, useState } from 'react'

import { AlertTimeline, SEVERITY_GLYPH, TimeSeries } from '@/components'
import type { TimelineAlert } from '@/components'
import { Button, Segmented, Sheet } from '@/app/ui'
import { isInformational, useLiveAlerts } from '@/core/alerts'
import { addHours, campaignMs, floorTo } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { hasStarted, isOngoing } from '@/core/events'
import { fmtDay, fmtDuration, fmtNum, fmtTime24, relativeTime } from '@/core/format'
import { SEVERITY_LABEL, severityRank, severityVar } from '@/core/measures'
import { useAcknowledgeAlert, useActionLevels, useAlert, useAlerts, useMonitorReadings } from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type { ActionLevel, Alert, AlertStatus, MeasureCode, MeasureDef, Severity } from '@/core/types'

import {
  SOURCE_LABEL, endedBy, knownValue, levelName, sourceOf, subjectFor, unitText, whereOf,
} from './alerting'
import type { PushSource } from './alerting'
import { PushComposer } from './Push'
import { useMeasureMap, useTowers } from './lib'
import { Panel } from './Panel'
import a from './alerts.module.css'
import t from './title.module.css'

// ────────────────────────────────────────────────────────────── who saw it

type Filter = 'all' | 'monitor' | 'fleet' | 'residents' | 'other'

const FILTERS: { value: Filter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Every source' },
  { value: 'monitor', label: 'Reference monitors', title: 'Raised by a DRAQA reference monitor' },
  { value: 'fleet', label: 'Mobile fleet', title: 'Raised by the mobile fleet' },
  { value: 'residents', label: 'Residents', title: 'Clusters of resident reports' },
  { value: 'other', label: 'Other', title: 'Fence sensors, model checks and fleet status' },
]

const SOURCE_TONE: Partial<Record<PushSource, string>> = {
  monitor: 'var(--tower)',
  fleet: 'var(--fleet)',
  residents: 'var(--actor-community)',
}

function filterOf(src: PushSource): Filter {
  return src === 'monitor' || src === 'fleet' || src === 'residents' ? src : 'other'
}

function measureLabel(al: Alert, def: MeasureDef | undefined): string | null {
  return al.measure ? (def?.short_label ?? al.measure.toUpperCase()) : null
}

/** The row's headline: what, and where. */
function whatOf(al: Alert, src: PushSource, def: MeasureDef | undefined): string {
  const m = measureLabel(al, def)
  const where = whereOf(al)
  if (src === 'residents') return `Resident reports near ${where}`
  if (src === 'fleet') return m ? `${m} on ${where}` : where
  if ((src === 'monitor' || src === 'fence') && m) return `${m} at ${where}`
  return al.title
}

/**
 * The timeline gutter holds 19 characters (AlertTimeline's 140px cap at
 * 6.6px a character), so the street suffix goes before anything is cut.
 */
function gutterCode(al: Alert, src: PushSource, def: MeasureDef | undefined): string {
  const place = whereOf(al).replace(/\s+(Road|Avenue|Drive|Street|Boulevard|Lane)$/i, '')
  const tag = src === 'residents' ? 'Reports' : (measureLabel(al, def) ?? 'Alert')
  const code = src === 'model' ? 'Study vs wind' : src === 'ops' ? 'Fleet status' : `${tag} ${place}`
  return code.length > 19 ? `${code.slice(0, 18).trimEnd()}…` : code
}

// ───────────────────────────────────────────────────────────── episodes

/** Statuses that leave an ended alert waiting on the agency. */
const OPEN_STATUSES = new Set(['active', 'acknowledged'])

/** Highest level first; a tie keeps the one that began first, as the fold does. */
function worse(x: Alert, y: Alert): Alert {
  const d = severityRank(y.severity) - severityRank(x.severity)
  if (d !== 0) return d > 0 ? y : x
  return campaignMs(y.started_at) < campaignMs(x.started_at) ? y : x
}

interface Episode {
  /** The winning alert's id: what the timeline and the sheet select by. */
  id: string
  alerts: Alert[]
  start: CampaignTime
  /** Its end at the moment shown; null while it is still ongoing. */
  end: CampaignTime | null
  winner: Alert
  peak: number | null
  /** Ongoing, or ended but not yet resolved by the agency. */
  open: boolean
  /** Alerts in it nobody has acknowledged. */
  awaiting: Alert[]
}

interface Group {
  id: string
  source: PushSource
  open: boolean
  /** Newest first. */
  episodes: Episode[]
  /** The highest level tripped across them, and the alert that tripped it. */
  winner: Alert
  peak: number | null
  ongoing: Episode | null
  awaiting: Alert[]
  /** The newest activity, for the sort: an ongoing episode is "now". */
  lastMs: number
}

/** The fold's key (core/alerts `foldConcurrent`), so rows and the count agree. */
function keyOf(al: Alert): string {
  return `${al.source_type}|${al.source_id ?? al.id}|${al.measure ?? al.kind}`
}

function makeEpisode(alerts: Alert[], now: CampaignTime, replaying: boolean): Episode {
  const winner = alerts.reduce(worse)
  const ongoing = alerts.some((al) => isOngoing(al, now))
  const ends = alerts.map((al) => al.ended_at).filter((e): e is string => !!e)
  const end = ongoing || !ends.length
    ? null
    : ends.reduce((x, y) => (campaignMs(y) > campaignMs(x) ? y : x))
  const known = alerts.map((al) => knownValue(al, now, replaying)).filter((v): v is number => v != null)
  return {
    id: winner.id,
    alerts,
    start: alerts[0].started_at,
    end,
    winner,
    peak: known.length ? Math.max(...known) : null,
    open: alerts.some((al) => isOngoing(al, now) || OPEN_STATUSES.has(al.status)),
    awaiting: alerts.filter((al) => al.status === 'active'),
  }
}

/**
 * Alerts → episodes → rows. Consecutive hours: an alert that begins at or
 * before the running episode's end joins it (07:00 after a 05:00–07:00 run is
 * the next hour); one that begins later starts a new episode.
 *
 * Operational news (`info`: the fleet's "Redwing out of service") is not a
 * level exceeded and is never counted (core/alerts rule 5). It was an Open row
 * labelled Info, a Duration bar and one of the "not acknowledged" while the
 * title's count left it out; the page mentions it in one line instead.
 */
function buildGroups(
  list: Alert[] | undefined,
  now: CampaignTime,
  replaying: boolean,
  monitorIds: Set<string> | null,
): Group[] {
  const byKey = new Map<string, Alert[]>()
  for (const al of list ?? []) {
    if (!hasStarted(al, now) || isInformational(al)) continue
    const k = keyOf(al)
    const arr = byKey.get(k)
    if (arr) arr.push(al)
    else byKey.set(k, [al])
  }

  const groups: Group[] = []
  const nowMs = campaignMs(now)
  for (const [k, alerts] of byKey) {
    alerts.sort((x, y) => campaignMs(x.started_at) - campaignMs(y.started_at))
    const episodes: Episode[] = []
    let run: Alert[] = []
    let runEnd = -Infinity
    for (const al of alerts) {
      const s = campaignMs(al.started_at)
      if (run.length && s > runEnd) {
        episodes.push(makeEpisode(run, now, replaying))
        run = []
        runEnd = -Infinity
      }
      run.push(al)
      runEnd = Math.max(runEnd, endedBy(al, now) ? campaignMs(al.ended_at as string) : Infinity)
    }
    if (run.length) episodes.push(makeEpisode(run, now, replaying))

    const source = sourceOf(alerts[0], monitorIds)
    for (const open of [true, false]) {
      const eps = episodes.filter((e) => e.open === open).reverse()
      if (!eps.length) continue
      const winner = eps.map((e) => e.winner).reduce((x, y) => {
        const d = severityRank(y.severity) - severityRank(x.severity)
        if (d !== 0) return d > 0 ? y : x
        return (y.value ?? 0) > (x.value ?? 0) ? y : x
      })
      const peaks = eps.map((e) => e.peak).filter((v): v is number => v != null)
      const ongoing = eps.find((e) => e.end === null) ?? null
      groups.push({
        id: `${k}|${open ? 'open' : 'closed'}`,
        source,
        open,
        episodes: eps,
        winner,
        peak: peaks.length ? Math.max(...peaks) : null,
        ongoing,
        awaiting: eps.flatMap((e) => e.awaiting),
        lastMs: ongoing ? nowMs : campaignMs(eps[0].end ?? eps[0].start),
      })
    }
  }
  return groups.sort(
    (x, y) =>
      severityRank(y.winner.severity) - severityRank(x.winner.severity)
      || Number(!!y.ongoing) - Number(!!x.ongoing)
      || y.lastMs - x.lastMs,
  )
}

// ──────────────────────────────────────────────────────────────── words

const NOUN: Partial<Record<Alert['kind'], [string, string]>> = {
  exceedance: ['episode', 'episodes'],
  integrated_exposure: ['episode', 'episodes'],
  mobile_detection: ['detection', 'detections'],
  concern_cluster: ['cluster', 'clusters'],
}

function count(n: number, al: Alert): string {
  const [one, many] = NOUN[al.kind] ?? ['alert', 'alerts']
  return `${n} ${n === 1 ? one : many}`
}

/** "Aug 25 05:00–07:00", "since Aug 27 02:20", "Aug 24–27", "Jul 30–Aug 2". */
function spanText(g: Group): string {
  const eps = g.episodes
  if (eps.length === 1) {
    const e = eps[0]
    if (g.source === 'fleet') return `${fmtDay(e.start)} ${fmtTime24(e.start)}`
    if (!e.end) return `since ${fmtDay(e.start)} ${fmtTime24(e.start)}`
    return fmtDay(e.end) === fmtDay(e.start)
      ? `${fmtDay(e.start)} ${fmtTime24(e.start)}–${fmtTime24(e.end)}`
      : `${fmtDay(e.start)} ${fmtTime24(e.start)} – ${fmtDay(e.end)} ${fmtTime24(e.end)}`
  }
  const first = eps[eps.length - 1].start
  const last = eps[0].start
  const [m0, d0] = fmtDay(first).split(' ')
  const [m1, d1] = fmtDay(last).split(' ')
  if (m0 === m1 && d0 === d1) return fmtDay(first)
  return m0 === m1 ? `${m0} ${d0}–${d1}` : `${fmtDay(first)}–${fmtDay(last)}`
}

/** A level is written as issued: "100 ppb", not "100.0 ppb". */
function levelText(v: number, unit: string | null): string {
  const u = unitText(unit)
  return `${fmtNum(v, Number.isInteger(v) ? 0 : 2)}${u ? ` ${u}` : ''}`
}

function valueText(v: number | null, unit: string | null, def: MeasureDef | undefined): string {
  if (v == null) return '—'
  const u = unitText(unit)
  return `${fmtNum(v, def?.decimals ?? 1)}${u ? ` ${u}` : ''}`
}

/** "6 episodes Aug 24–27 · peak 121.4 ppb · 1.21× NO2 1-hour standard" */
function summaryLine(g: Group, def: MeasureDef | undefined, levels: Map<string, ActionLevel>): string {
  const parts = [`${count(g.episodes.length, g.winner)} ${spanText(g)}`]
  if (g.source === 'residents') {
    if (g.peak != null) parts.push(`${fmtNum(g.peak, 0)} reports`)
  } else if (g.winner.measure) {
    // A fleet detection's value is the street's 90th percentile, not a peak.
    const word = g.source === 'fleet' ? 'flagged' : 'peak'
    if (g.peak != null) {
      parts.push(`${word} ${valueText(g.peak, g.winner.unit, def)}`)
      const thr = g.winner.threshold
      const name = levelName(g.winner, levels)
      if (thr && thr > 0) parts.push(`${fmtNum(g.peak / thr, 2)}× ${name ?? 'the action level'}`)
    } else if (g.ongoing) {
      parts.push(`${g.source === 'fleet' ? 'flagged value' : 'peak'} not known yet at this moment`)
    }
  }
  return parts.join(' · ')
}

/**
 * Acknowledgement is counted in episodes, like the rows. Riverport Road's six
 * Aug 24–27 episodes hold seven unacknowledged alerts (the watch and the
 * standard are acknowledged separately), and "7 not acknowledged" under
 * "6 episodes" read as a seventh episode.
 */
function ackWord(e: Episode): string {
  if (!e.open) return 'closed'
  if (!e.awaiting.length) return 'acknowledged'
  return e.awaiting.length < e.alerts.length ? 'partly acknowledged' : 'not acknowledged'
}

function unacked(g: Group): number {
  return g.episodes.filter((e) => e.awaiting.length > 0).length
}

/**
 * The alert's status at the end of the data, which the server sends beside a
 * replayed `status` (`status_at_end`, routers/alerts.py). Absent only when
 * paused at the end, where this is never asked; taken then as still waiting,
 * which is what the sheet said before the field existed.
 */
function statusAtEnd(al: Alert): AlertStatus {
  return al.status_at_end ?? 'active'
}

/**
 * What became of an episode waiting at the moment shown, by the end of the
 * data. Replay walks a stored 'resolved' back to 'active', so an episode not
 * acknowledged at Aug 25 06:00 may be closed at the end, where the sheet
 * offers no Acknowledge: sending the reader there to make one promised a
 * button that is not there. Only a 'waiting' episode is sent.
 */
function laterOf(e: Episode): 'waiting' | 'acknowledged' | 'closed' {
  const ends = e.awaiting.map(statusAtEnd)
  if (ends.includes('active')) return 'waiting'
  return ends.includes('acknowledged') ? 'acknowledged' : 'closed'
}

/** The replay note under "Act on it": what can still be done, and where. */
function replayActText(g: Group, now: CampaignTime, dataEnd: CampaignTime | null): { text: string; toEnd: boolean } {
  const waiting = g.episodes.filter((e) => e.awaiting.length > 0)
  const fate = waiting.map(laterOf)
  const still = fate.filter((f) => f === 'waiting').length
  const acked = fate.filter((f) => f === 'acknowledged').length
  const closed = fate.length - still - acked
  const one = g.episodes.length === 1
  const at = `${fmtDay(now)} ${fmtTime24(now)}`
  const end = dataEnd ? ` (${fmtDay(dataEnd)} ${fmtTime24(dataEnd)})` : ''
  // "fully" when some alert in a waiting episode is acknowledged: the rows
  // above read "partly acknowledged", and a bare "not acknowledged" beside
  // them read as a contradiction.
  const partly = waiting.some((e) => e.awaiting.length < e.alerts.length)
  const verb = partly ? 'not fully acknowledged' : 'not acknowledged'
  const head = `${one ? verb[0].toUpperCase() + verb.slice(1) : `${waiting.length} of ${g.episodes.length} episodes ${verb}`} as of ${at}.`
  const stamp = `An acknowledgement is stamped at the end of the data${end}, so it is made from there.`
  if (still === waiting.length) return { text: `${head} ${stamp}`, toEnd: true }
  if (one || waiting.length === 1) {
    const later = acked
      ? 'It was acknowledged later.'
      : 'It closed later, so at the end of the data there is nothing left to acknowledge.'
    return { text: `${head} ${later}`, toEnd: false }
  }
  const parts = [
    acked ? `${acked} ${acked === 1 ? 'was' : 'were'} acknowledged later` : '',
    closed ? `${closed} closed later` : '',
  ].filter(Boolean)
  const rest = still
    ? ` ${still} ${still === 1 ? 'is' : 'are'} still not acknowledged at the end of the data${end}; an acknowledgement is stamped there, so it is made from there.`
    : ' At the end of the data there is nothing left to acknowledge.'
  return { text: `${head} Of those, ${parts.join(' and ')}.${rest}`, toEnd: still > 0 }
}

function stateText(g: Group, now: CampaignTime): { head: string; sub: string } {
  const n = unacked(g)
  const sub = !g.open
    ? 'closed'
    : g.episodes.length === 1
      ? ackWord(g.episodes[0])
      : n
        ? `${n} of ${g.episodes.length} not acknowledged`
        : 'acknowledged'
  if (g.ongoing) {
    // A mobile detection is a finding raised at one moment ("Highest diesel
    // … on the network"), not a reading that stays high: its alert has no
    // end, so a duration would claim twelve hours of exposure nobody measured.
    const since = g.source === 'fleet'
      ? `raised ${relativeTime(g.ongoing.start, now)}`
      : fmtDuration(campaignMs(now) - campaignMs(g.ongoing.start))
    return { head: `ongoing · ${since}`, sub }
  }
  const lastEnd = g.episodes[0].end
  return { head: lastEnd ? `ended ${relativeTime(lastEnd, now)}` : 'ended', sub }
}

/**
 * Critical, Warning or Watch. Anything still graded `info` keeps its column
 * but prints no word: Info is not a severity (CONTRACT §10a rule 7).
 */
function SevWord({ severity }: { severity: Severity }) {
  if (severity === 'info') return <span className={a.sev} aria-hidden />
  return (
    <span className={a.sev} style={{ color: severityVar(severity) }}>
      <span aria-hidden>{SEVERITY_GLYPH[severity]}</span> {SEVERITY_LABEL[severity]}
    </span>
  )
}

/**
 * The source in neutral ink with a square in its actor colour. The fleet's
 * yellow is the Watch yellow, so a coloured word read "Watch · Mobile fleet"
 * as one yellow phrase; a swatch keeps the column scannable without that.
 */
function SourceWord({ source }: { source: PushSource }) {
  const tone = SOURCE_TONE[source]
  return (
    <span className={a.source}>
      <span className={a.swatch} style={tone ? { background: tone } : undefined} aria-hidden />
      {SOURCE_LABEL[source]}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────── the page

export function AlertsQueue() {
  const now = useNowCampaign()
  const replaying = useSession((x) => x.time.cursor != null)
  const live = useLiveAlerts('regulator')
  // The same role and `at` as the hook, so one cache entry and one list.
  const alertsQ = useAlerts({ role: 'regulator' })
  const towers = useTowers().data
  const monitorIds = useMemo(() => (towers ? new Set(towers.map((m) => m.id)) : null), [towers])
  const measures = useMeasureMap()
  const levelsQ = useActionLevels()
  const levels = useMemo(() => new Map((levelsQ.data ?? []).map((l) => [l.id, l])), [levelsQ.data])

  const [filter, setFilter] = useState<Filter>('all')
  const [showClosed, setShowClosed] = useState(false)
  const [sheet, setSheet] = useState<{ group: string; episode: string | null } | null>(null)

  const groups = useMemo(
    () => buildGroups(alertsQ.data, now, replaying, monitorIds),
    [alertsQ.data, now, replaying, monitorIds],
  )
  const { open, closed } = useMemo(() => {
    const shown = groups.filter((g) => filter === 'all' || filterOf(g.source) === filter)
    return { open: shown.filter((g) => g.open), closed: shown.filter((g) => !g.open) }
  }, [groups, filter])
  const awaiting = groups.reduce((n, g) => n + (g.open ? unacked(g) : 0), 0)
  // Live operational news, uncounted: one quiet line, no severity word. It is
  // fleet status, so it shows under All and Other only.
  const noticeLine = live.notices.length && (filter === 'all' || filter === 'other')
    ? `Also: ${live.notices
      .map((n) => `${n.title} · since ${fmtDay(n.started_at)} ${fmtTime24(n.started_at)}`)
      .join('; ')}`
    : null

  const timeline = useMemo<TimelineAlert[]>(
    () =>
      open.flatMap((g) =>
        g.episodes.map((e) => ({
          id: e.id,
          label: `${whatOf(g.winner, g.source, measures.get(g.winner.measure as MeasureCode))} · ${fmtDay(e.start)}`,
          code: gutterCode(g.winner, g.source, measures.get(g.winner.measure as MeasureCode)),
          severity: e.winner.severity,
          startedAt: e.start,
          // A mobile detection draws as a tick at the moment it was raised,
          // not as an open bar to now (see `stateText`).
          endedAt: g.source === 'fleet' ? e.start : e.end,
          acknowledged: e.awaiting.length === 0,
        })),
      ),
    [open, measures],
  )

  const active = sheet ? groups.find((g) => g.id === sheet.group) ?? null : null
  const openGroupOf = (episodeId: string | null) => {
    if (!episodeId) return
    const g = groups.find((x) => x.episodes.some((e) => e.id === episodeId))
    if (g) setSheet({ group: g.id, episode: episodeId })
  }

  return (
    <div className={active ? `${a.page} ${a.pageBeside}` : a.page}>
      <header className={t.head}>
        <h1 className={t.title}>Alerts</h1>
        <span className={t.summary}>
          {live.count} ongoing · {awaiting} not acknowledged
        </span>
        <span className={t.aside}>
          <Segmented value={filter} options={FILTERS} onValueChange={setFilter} />
        </span>
      </header>

      {timeline.length ? (
        <Panel title="Duration" aside={<span className={a.hint}>one bar per episode, open ones</span>}>
          <AlertTimeline
            alerts={timeline}
            rowHeight={14}
            maxRows={12}
            labels
            selectedId={active?.episodes.some((e) => e.id === sheet?.episode) ? sheet?.episode ?? null : null}
            onSelect={openGroupOf}
            style={{ padding: '4px 10px 6px' }}
          />
        </Panel>
      ) : <div />}

      <Panel title={`Open · ${open.length}`} aside={<span className={a.hint}>highest level first</span>}>
        {noticeLine ? <p className={a.notice}>{noticeLine}</p> : null}
        <div className={a.list} role="list">
          {open.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              now={now}
              def={measures.get(g.winner.measure as MeasureCode)}
              levels={levels}
              active={active?.id === g.id}
              onOpen={() => setSheet({ group: g.id, episode: null })}
            />
          ))}
          {open.length === 0 ? (
            <p className={a.empty}>
              {alertsQ.isPending ? 'Loading alerts…' : 'Nothing open at the moment shown.'}
            </p>
          ) : null}

          {closed.length ? (
            <>
              <button
                type="button"
                className={a.fold}
                aria-expanded={showClosed}
                onClick={() => setShowClosed((v) => !v)}
              >
                <span aria-hidden>{showClosed ? '▾' : '▸'}</span> Closed earlier · {closed.length}
              </button>
              {showClosed
                ? closed.map((g) => (
                  <GroupRow
                    key={g.id}
                    group={g}
                    now={now}
                    def={measures.get(g.winner.measure as MeasureCode)}
                    levels={levels}
                    active={active?.id === g.id}
                    onOpen={() => setSheet({ group: g.id, episode: null })}
                  />
                ))
                : null}
            </>
          ) : null}
          {replaying ? (
            <p className={a.foot}>
              Acknowledged and closed are shown as they stood at this moment. An acknowledgement
              made now is stamped at the end of the data.
            </p>
          ) : null}
        </div>
      </Panel>

      {/* Non-modal: the list stays readable, scrollable and clickable beside
          the detail, and picking another row just changes what it shows. */}
      <Sheet
        open={!!active}
        modal={false}
        onClose={() => setSheet(null)}
        title={active ? whatOf(active.winner, active.source, measures.get(active.winner.measure as MeasureCode)) : ''}
        className={a.sheet}
      >
        {active ? (
          <GroupDetail
            key={active.id}
            group={active}
            initialEpisode={sheet?.episode ?? null}
            now={now}
            levels={levels}
            def={measures.get(active.winner.measure as MeasureCode)}
          />
        ) : null}
      </Sheet>
    </div>
  )
}

function GroupRow({
  group: g, now, def, levels, active, onOpen,
}: {
  group: Group
  now: CampaignTime
  def: MeasureDef | undefined
  levels: Map<string, ActionLevel>
  active: boolean
  onOpen(): void
}) {
  const st = stateText(g, now)
  const line = summaryLine(g, def, levels)
  return (
    <button
      type="button"
      role="listitem"
      className={`${a.row}${active ? ` ${a.rowActive}` : ''}${g.open ? '' : ` ${a.rowClosed}`}`}
      onClick={onOpen}
    >
      <SevWord severity={g.winner.severity} />
      <SourceWord source={g.source} />
      <span className={a.what}>
        <span className={a.whatHead}>{whatOf(g.winner, g.source, def)}</span>
        <span className={a.whatSub} title={line}>{line}</span>
      </span>
      <span className={a.state}>
        <span className={g.ongoing ? a.stateOn : a.stateHead}>{st.head}</span>
        <span className={a.stateSub}>{st.sub}</span>
      </span>
    </button>
  )
}

// ───────────────────────────────────────────────────────────── the sheet

/**
 * The 48 h around an episode, never past the moment shown. A window trailing
 * the moment missed every episode that ended more than two days before it,
 * and the queue holds those: at the end of the checked-in data, Riverport
 * Road's Aug 25 NO2 episode ended three days earlier and is still open.
 * Hour-floored so the key holds still while the cursor plays.
 */
function traceWindow(e: Episode, now: CampaignTime): { from: CampaignTime; to: CampaignTime } {
  const after = e.end ? addHours(e.end, 12) : now
  const end = campaignMs(after) < campaignMs(now) ? after : now
  const to = floorTo(end, 60)
  return { from: addHours(to, -48), to }
}

function GroupDetail({
  group: g, initialEpisode, now, levels, def,
}: {
  group: Group
  initialEpisode: string | null
  now: CampaignTime
  levels: Map<string, ActionLevel>
  def: MeasureDef | undefined
}) {
  // The episode that tripped the highest level, unless one was picked on the
  // timeline: for Riverport Road that is Aug 25, not the weakest, newest one.
  const byWinner = g.episodes.find((e) => e.alerts.some((al) => al.id === g.winner.id)) ?? g.episodes[0]
  const [pick, setPick] = useState<string | null>(initialEpisode)
  const ep = g.episodes.find((e) => e.id === pick) ?? byWinner

  const ack = useAcknowledgeAlert()
  const userId = useSession((x) => x.user?.id)
  const replaying = useSession((x) => x.time.cursor != null)
  const dataEnd = useSession((x) => x.time.bounds?.end ?? null)
  const setTimeCursor = useSession((x) => x.setTimeCursor)
  const [acking, setAcking] = useState(false)
  const acknowledgeAll = async () => {
    setAcking(true)
    try {
      for (const al of g.awaiting) await ack.mutateAsync({ id: al.id, userId })
    } finally {
      setAcking(false)
    }
  }

  const level = levelName(g.winner, levels)
  const thr = g.winner.threshold
  const first = g.episodes[g.episodes.length - 1]
  const replayAct = replayActText(g, now, dataEnd)

  return (
    <div className={a.detail}>
      <div className={a.meta}>
        <SevWord severity={g.winner.severity} />
        <span className={a.dot} aria-hidden>·</span>
        <SourceWord source={g.source} />
        {level ? (
          <>
            <span className={a.dot} aria-hidden>·</span>
            <span className={a.metaText}>{level}</span>
          </>
        ) : null}
      </div>

      <p className={a.lead}>
        {g.episodes.length === 1
          ? `One ${count(1, g.winner).split(' ')[1]}, ${spanText(g)}.`
          : `${count(g.episodes.length, g.winner)} between ${fmtDay(first.start)} and ${fmtDay(g.episodes[0].start)}.`}
        {g.winner.measure && g.peak != null
          ? ` ${g.source === 'fleet' ? 'The flagged value' : `The highest reading${g.ongoing ? ' so far' : ''}`} was ${valueText(g.peak, g.winner.unit, def)}${
            thr && thr > 0 ? `, ${fmtNum(g.peak / thr, 2)}× ${level ?? 'the action level'} (${levelText(thr, g.winner.unit)})` : ''
          }.`
          : ''}
        {g.ongoing
          ? g.source === 'fleet'
            ? ` Raised ${relativeTime(g.ongoing.start, now)}; still open.`
            : ` Ongoing for ${fmtDuration(campaignMs(now) - campaignMs(g.ongoing.start))}.`
          : g.episodes[0].end
            // No break inside "1 d ago": the sheet wrapped it as "1 / d ago".
            ? ` The last one ended ${relativeTime(g.episodes[0].end, now).replace(/ /g, '\u00a0')}.`
            : ''}
      </p>

      {g.episodes.length > 1 ? (
        <section className={a.block}>
          <h3 className={a.blockHead}>Episodes</h3>
          <div className={a.epList} role="list">
            {g.episodes.map((e) => (
              <button
                key={e.id}
                type="button"
                role="listitem"
                className={`${a.epRow}${e.id === ep.id ? ` ${a.epRowOn}` : ''}`}
                onClick={() => setPick(e.id)}
              >
                <span className={a.epWhen}>
                  {fmtDay(e.start)} {fmtTime24(e.start)}{e.end ? `–${fmtTime24(e.end)}` : ' – now'}
                </span>
                <SevWord severity={e.winner.severity} />
                <span className={a.epVal}>{e.peak != null ? fmtNum(e.peak, def?.decimals ?? 1) : '—'}</span>
                <span className={a.epState}>{ackWord(e)}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <Trace episode={ep} source={g.source} now={now} def={def} levelLabel={levelName(ep.winner, levels)} />

      {/* A monitor's own text restates the figures above in the server's
          words ("1 hour over the line"); the other kinds' text carries what
          the fields cannot — the street's context, the wind at the time. */}
      {g.source !== 'monitor' && g.source !== 'fence' && ep.winner.body ? (
        <p className={a.body}>{ep.winner.body}</p>
      ) : null}

      <section className={a.block}>
        <h3 className={a.blockHead}>Act on it</h3>
        {g.open && replaying && g.awaiting.length ? (
          <>
            <p className={a.actNote}>{replayAct.text}</p>
            {replayAct.toEnd ? (
              <div className={a.actRow}>
                <Button size="sm" variant="secondary" onClick={() => setTimeCursor(null)}>
                  Go to the end of the data
                </Button>
              </div>
            ) : null}
          </>
        ) : g.open ? (
          <div className={a.actRow}>
            <Button
              size="sm"
              variant={g.awaiting.length ? 'secondary' : 'ghost'}
              disabled={!g.awaiting.length}
              loading={acking}
              onClick={() => { void acknowledgeAll() }}
            >
              {!g.awaiting.length
                ? 'Acknowledged'
                : g.episodes.length === 1
                  ? 'Acknowledge'
                  : `Acknowledge all ${unacked(g)} episodes`}
            </Button>
          </div>
        ) : null}
        <PushComposer
          key={ep.id}
          subject={subjectFor(ep.winner, {
            source: g.source,
            value: ep.peak,
            startedAt: ep.start,
            endedAt: ep.end,
            levelLabel: levelName(ep.winner, levels),
            def,
          })}
        />
      </section>
    </div>
  )
}

function Trace({
  episode: e, source, now, def, levelLabel,
}: {
  episode: Episode
  source: PushSource
  now: CampaignTime
  def: MeasureDef | undefined
  levelLabel: string | null
}) {
  const w = e.winner
  const win = useMemo(() => traceWindow(e, now), [e, now])
  // A monitor's alert carries a few samples; the instrument's own hourly
  // trace is what puts the episode in its day.
  const isMonitor = (source === 'monitor' || source === 'fence') && !!w.source_id
  const readings = useMonitorReadings(
    isMonitor ? w.source_id : null,
    { measure: w.measure ?? undefined, from: win.from, to: win.to, interval: 'hour' },
    { enabled: isMonitor },
  ).data
  const detail = useAlert(isMonitor ? null : w.id).data
  // Samples run past the alert's end; in replay the ones after the moment
  // shown are the future.
  const samples = useMemo(
    () => (detail?.samples ?? []).filter((pt) => campaignMs(pt.t) <= campaignMs(now)),
    [detail, now],
  )

  const series = readings?.points?.length
    ? [{ id: 'inst', label: 'Hourly reading', points: readings.points }]
    : samples.length
      ? [{ id: 'alert', label: def?.short_label ?? 'value', points: samples }]
      : []

  const thresholds = [
    ...(w.threshold != null
      ? [{ id: 'al', label: levelLabel ?? 'Action level', value: w.threshold, severity: w.severity, shade: true }]
      : []),
    ...(readings?.action_levels ?? [])
      .filter((l) => w.threshold == null || Math.abs(l.threshold - w.threshold) > 1e-9)
      .map((l) => ({ id: l.id, label: l.label, value: l.threshold, severity: l.severity, shade: false })),
  ]

  if (!w.measure) return null
  return (
    <section className={a.block}>
      <h3 className={a.blockHead}>
        {readings?.points?.length ? 'The monitor’s hourly readings, 48 h' : 'Readings on this alert'}
      </h3>
      {series.length ? (
        <TimeSeries
          series={series}
          thresholds={thresholds}
          unit={unitText(readings?.unit ?? w.unit)}
          decimals={def?.decimals ?? 1}
          height={150}
          exceedanceSeriesId={series[0].id}
        />
      ) : (
        <p className={a.empty}>No readings to draw for this source.</p>
      )}
    </section>
  )
}
