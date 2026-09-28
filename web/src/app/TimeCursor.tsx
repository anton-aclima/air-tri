/**
 * air — the campaign timeline: the body of the simulation popover.
 *
 * The owner's complaint about the old panel was that it opened on a datetime
 * field with no idea when the campaign started or ended, and the limits were a
 * scroll away. So this is one track across the WHOLE simulation — the
 * campaign's first day at the left, the end of the data at the right — with
 * where you are drawn on it, and the only ways to move being ones that cannot
 * leave it (the store clamps; at the end it pauses, D1).
 *
 * Three layers share the track's x axis:
 *   - event ticks above it, from the data (S2): residents' report clusters for
 *     everyone, plus alerts for the rooms that receive them;
 *   - the handle, which you drag or click to seek;
 *   - a faint strip of driven days under it, from `by_day` (D11). Days the
 *     fleet did not drive are gaps, not zeros drawn as bars — three of the
 *     eight report clusters fall on such days, and that should be visible.
 *
 * Ticks are fetched for the whole campaign, not as of the cursor, so going
 * back in time still shows what is coming. Ticks the moment on screen has not
 * reached yet are dimmed rather than hidden: the timeline is the one place a
 * future event is allowed to show, because it is where you go to reach it.
 */

import clsx from 'clsx'
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'

import s from '@/app/TimeCursor.module.css'
import { Button, Icon, IconButton, Segmented } from '@/app/ui'
import { campaignMs, floorTo, fromCampaignMs, hoursBetween } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { countOf, fmtDay, fmtNum, fmtTime24 } from '@/core/format'
import { severityRank } from '@/core/measures'
import { useAlerts, useCampaignStats, useConcernClusters } from '@/core/queries'
import { PLAYBACK_SPEEDS, useSession } from '@/core/session'
import type { Severity } from '@/core/types'
import { clamp } from '@/core/util'

// ────────────────────────────────────────────────────────────────── shapes

/** Ticks closer than this merge into one tick with a count (S2). */
const MERGE_PX = 12
/**
 * A merged tick is a count pill up to ~22px wide, centred on its first event,
 * so it keeps this much clear of the next one. At 12px two pills in the
 * regulator's last week (Aug 24–28 is 20 alerts) sat edge to edge and read
 * as one number, "78".
 */
const MERGE_PILL_PX = 22
/** Drag writes the cursor at most this often; the handle itself follows every move. */
const DRAG_WRITE_MS = 250
/** A seek this close to the right edge means the end of the data, not "13:00 on the last day". */
const END_SNAP_MIN = 30
/** Prev/next skip an event the cursor is already sitting on. */
const SAME_MS = 60_000

interface Mark {
  id: string
  kind: 'cluster' | 'alert'
  /** Where the cursor lands when this is the tick you jump to. */
  at: CampaignTime
  ms: number
  label: string
  severity: Severity | null
  /** Model-sourced: an inference, drawn hollow so it never reads as a measurement. */
  hollow: boolean
}

interface Tick {
  x: number
  at: CampaignTime
  ms: number
  marks: Mark[]
  kind: 'cluster' | 'alert' | 'mixed'
  severity: Severity | null
  /** Every event in it is model-sourced: the whole tick is an outline. */
  hollow: boolean
  /** How many of its events are model-sourced — drawn as a notch on a merged pill. */
  model: number
}

// ────────────────────────────────────────────────────────────────── data

/**
 * The event marks for this room, oldest first.
 *
 * Clusters come from `/clusters` for every room — one source, not two: the
 * regulator's alert list also carries a `concern_cluster` alert per cluster,
 * and drawing both put every cluster on the track twice. Community sees the
 * clusters only, labelled by place and count, never with an alert's title.
 *
 * `at: undefined` is "no upper bound" (core/queries `atFor`) — the whole
 * campaign, so replaying June does not hide August's ticks. The server reads
 * no `at` as its own now, which is the end of the data, and it is the same
 * key every page uses at the end, so at the end this costs no request.
 *
 * Industry's alerts are the locked site's (`siteId`, which the industry pages
 * write through `useSiteLock`), as the deck's own lists and the header are:
 * without `site_id`, 10 of Ridgeline's 27 ticks were Riverport exceedances the
 * deck never lists, and jumping to them changed nothing on screen.
 */
function useMarks(): Mark[] {
  const role = useSession((st) => st.role)
  const siteId = useSession((st) => st.siteId)
  const industry = role === 'industry'
  const clusters = useConcernClusters({ at: undefined })
  const alerts = useAlerts(
    industry ? { at: undefined, site_id: siteId ?? undefined } : { at: undefined },
    { enabled: role != null && role !== 'community' && (!industry || siteId != null) },
  )
  const alertRows = role === 'community' ? undefined : alerts.data

  return useMemo(() => {
    const out: Mark[] = []
    for (const c of clusters.data ?? []) {
      // Land on the moment the cluster's last report was POSTED. The server
      // builds clusters from reports posted by `at`, and posting runs hours
      // behind noticing: landing on `last_at` (noticed) found 2 or 3 of 5–9
      // reports posted, and 4 of the 8 clusters not formed at their own tick
      // (cl-00, "9 reports", showed one "2" pin and no cluster).
      const at = c.last_posted_at || c.last_at || c.first_at
      out.push({
        id: `c:${c.id}`,
        kind: 'cluster',
        at,
        ms: campaignMs(at),
        label: `${c.label ?? 'Reports near each other'} — ${countOf(c.count, 'report')}`,
        severity: null,
        hollow: false,
      })
    }
    for (const a of alertRows ?? []) {
      if (a.kind === 'concern_cluster') continue
      out.push({
        id: `a:${a.id}`,
        kind: 'alert',
        at: a.started_at,
        ms: campaignMs(a.started_at),
        label: a.title,
        severity: a.severity,
        hollow: a.source_type === 'model',
      })
    }
    return out.filter((m) => Number.isFinite(m.ms)).sort((a, b) => a.ms - b.ms)
  }, [clusters.data, alertRows])
}

/**
 * Where "Start" lands: 06:00 on the first day the fleet drove. The campaign's
 * nominal first day is an empty May 31 midnight — nothing moves on the map
 * there, which made Start look broken.
 */
function useDrive(): { startAt: CampaignTime | null; days: { date: string; passes: number }[] } {
  const stats = useCampaignStats()
  const boundsStart = useSession((st) => st.time.bounds?.start ?? null)
  return useMemo(() => {
    const days = [...(stats.data?.by_day ?? [])]
      .filter((d) => d.passes > 0)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
    const first = days[0]?.date
    return { startAt: first ? `${first}T06:00:00` : boundsStart, days }
  }, [stats.data, boundsStart])
}

/** Group marks that would sit within `MERGE_PX` of each other at this width. */
function toTicks(marks: Mark[], xOf: (ms: number) => number): Tick[] {
  const out: Tick[] = []
  for (const m of marks) {
    const x = xOf(m.ms)
    const last = out[out.length - 1]
    if (last && x - last.x < (last.marks.length > 1 ? MERGE_PILL_PX : MERGE_PX)) last.marks.push(m)
    else out.push({ x, at: m.at, ms: m.ms, marks: [m], kind: m.kind, severity: null, hollow: false, model: 0 })
  }
  for (const t of out) {
    const alerts = t.marks.filter((m) => m.kind === 'alert')
    t.kind = alerts.length === 0 ? 'cluster' : alerts.length === t.marks.length ? 'alert' : 'mixed'
    t.severity = alerts.reduce<Severity | null>(
      (best, m) => (m.severity && (!best || severityRank(m.severity) > severityRank(best)) ? m.severity : best),
      null,
    )
    // A merged pill is filled when any of its events is measured, so the
    // count of model ones is kept: the dataset's only model alert
    // (al-windshift-00, Aug 26) always merges into the Aug 24–28 pill, and
    // `every` alone never drew it as an inference.
    t.model = t.marks.filter((m) => m.hollow).length
    t.hollow = t.model === t.marks.length
  }
  return out
}

const speedWord = (minPerSec: number) =>
  minPerSec >= 1440 ? '1 day' : `${fmtNum(minPerSec / 60, 0)} h`

/** "6 h/s", "1 day/s" — the speed control's own labels. */
const speedShort = (minPerSec: number) => `${speedWord(minPerSec)}/s`

/** "36 min", "6 min", "90 s" — how long the whole campaign takes at a speed. */
function playDuration(hours: number, minPerSec: number): string {
  const secs = (hours * 60) / minPerSec
  return secs >= 90 * 1.5 ? `${fmtNum(secs / 60, 0)} min` : `${fmtNum(secs, 0)} s`
}

// ──────────────────────────────────────────────────────────── the component

export interface TimeCursorProps {
  /**
   * The ~56px bar shown while playing: track and pause only, so the map
   * stays visible under it.
   */
  collapsed?: boolean
  /** Take the timeline's keys on the window — only while its popover is open. */
  keyboard?: boolean
  /** Rendered at the end of the readout row (the popover's close button). */
  aside?: ReactNode
  className?: string
}

export function TimeCursor({ collapsed, keyboard, aside, className }: TimeCursorProps) {
  const time = useSession((st) => st.time)
  const setTimeCursor = useSession((st) => st.setTimeCursor)
  const stepTime = useSession((st) => st.stepTime)
  const goToEnd = useSession((st) => st.goToEnd)
  const setSpeed = useSession((st) => st.setSpeed)

  const bounds = time.bounds
  const t0 = bounds ? campaignMs(bounds.start) : 0
  const t1 = bounds ? campaignMs(bounds.end) : 1
  const span = Math.max(1, t1 - t0)
  const now: CampaignTime | null = time.cursor ?? bounds?.end ?? null
  const nowMs = now ? campaignMs(now) : t1
  const atEnd = time.cursor == null

  const marks = useMarks()
  const { startAt, days } = useDrive()

  // The rail's width decides which ticks merge, so it is measured, not assumed.
  const [rail, setRail] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!rail) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(rail)
    return () => ro.disconnect()
  }, [rail])

  const frac = useCallback((ms: number) => clamp((ms - t0) / span, 0, 1), [t0, span])
  const ticks = useMemo(
    () => (width > 0 ? toTicks(marks, (ms) => frac(ms) * width) : []),
    [marks, width, frac],
  )
  // Previous/Next step one EVENT, not one drawn tick: a merged pill is only a
  // drawing (its events sit within a few pixels at this width), and stepping
  // by pill jumped from the end of the data to Aug 24 05:00 over 13 events.
  // `marks` is oldest first; events sharing a time are one step.
  const prev = useMemo(() => {
    for (let i = marks.length - 1; i >= 0; i--) if (marks[i].ms < nowMs - SAME_MS) return marks[i]
    return undefined
  }, [marks, nowMs])
  const next = useMemo(() => marks.find((m) => m.ms > nowMs + SAME_MS), [marks, nowMs])

  // ── actions ────────────────────────────────────────────────────────────
  const goStart = useCallback(() => {
    if (startAt) setTimeCursor(startAt)
  }, [startAt, setTimeCursor])

  const togglePlay = useCallback(() => {
    const st = useSession.getState()
    if (st.time.playing) {
      st.setPlaying(false)
      return
    }
    // From the end there is nothing to play, so it starts again — from Start,
    // the first driven morning, not from the empty midnight the playback hook
    // would fall back to.
    if (st.time.cursor == null && startAt) st.setTimeCursor(startAt)
    st.setPlaying(true)
  }, [startAt])

  // ── seeking: the handle follows the pointer, the cursor follows at 4/s ──
  const [dragMs, setDragMs] = useState<number | null>(null)
  const [peek, setPeek] = useState<{ x: number; ms: number } | null>(null)
  const lastWrite = useRef(0)

  const msAt = (clientX: number): number => {
    if (!rail) return nowMs
    const r = rail.getBoundingClientRect()
    return t0 + clamp((clientX - r.left) / Math.max(1, r.width), 0, 1) * span
  }
  const write = (ms: number) => {
    if (!bounds) return
    lastWrite.current = performance.now()
    // Hour steps: the wind, the readings and the plume are hourly, so a
    // minute-exact cursor only makes every query key unique.
    if (ms >= t1 - END_SNAP_MIN * 60_000) setTimeCursor(bounds.end)
    else setTimeCursor(floorTo(fromCampaignMs(ms), 60))
  }
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !bounds) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const ms = msAt(e.clientX)
    setDragMs(ms)
    setPeek(null)
    write(ms)
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const ms = msAt(e.clientX)
    if (dragMs == null) {
      if (e.pointerType === 'mouse') setPeek({ x: frac(ms) * width, ms })
      return
    }
    setDragMs(ms)
    if (performance.now() - lastWrite.current >= DRAG_WRITE_MS) write(ms)
  }
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragMs == null) return
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    write(msAt(e.clientX))
    setDragMs(null)
  }

  // ── keyboard, while the popover is open ────────────────────────────────
  useEffect(() => {
    if (!keyboard) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
      switch (e.key) {
        case 'ArrowLeft': stepTime(e.shiftKey ? -24 : -1); break
        case 'ArrowRight': stepTime(e.shiftKey ? 24 : 1); break
        case 'Home': goStart(); break
        case 'End': goToEnd(); break
        case ' ':
          // A focused button already answers Space natively; toggling here too
          // would press Play and then undo it.
          if (t?.closest('button')) return
          togglePlay()
          break
        default: return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [keyboard, stepTime, goStart, goToEnd, togglePlay])

  // Folding and unfolding moves the track between the two layouts, and a
  // focused handle or transport button goes with it, which drops the focus to
  // <body>. The handle is in both layouts, so it takes the focus back. (The
  // play toggle is the same node in both and keeps its own focus.)
  const handleRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!keyboard) return
    const a = document.activeElement
    if (!a || a === document.body) handleRef.current?.focus({ preventScroll: true })
  }, [collapsed, keyboard])

  // ── derived drawing ────────────────────────────────────────────────────
  const shownMs = dragMs ?? nowMs
  const pos = frac(shownMs)
  const totalHours = bounds ? hoursBetween(bounds.start, bounds.end) : 0
  const passesOn = useMemo(() => new Map(days.map((d) => [d.date, d.passes])), [days])
  const maxPasses = useMemo(() => Math.max(1, ...days.map((d) => d.passes)), [days])
  const DAY = 86_400_000

  // The edge labels carry the limits, so month labels keep clear of them —
  // by their measured width: industry sets them in spaced capitals, and a
  // fixed allowance let "AUG 1" run into "AUG 28 · END OF DATA".
  const startLabel = useRef<HTMLSpanElement>(null)
  const endLabel = useRef<HTMLSpanElement>(null)
  const [edges, setEdges] = useState<[number, number]>([56, 128])
  const startText = bounds?.start
  const endText = bounds?.end
  useLayoutEffect(() => {
    const a = startLabel.current?.offsetWidth
    const b = endLabel.current?.offsetWidth
    if (a && b) setEdges((e) => (e[0] === a && e[1] === b ? e : [a, b]))
  }, [width, startText, endText, collapsed])

  const months = useMemo(() => {
    if (!bounds || width <= 0) return []
    const out: { x: number; label: string }[] = []
    const d = new Date(t0)
    // Month starts on the campaign axis (UTC fields of campaignMs = the digits).
    let m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    while (m < t1) {
      const x = frac(m) * width
      // A month label is ~40px wide and centred; keep 8px clear of each edge label.
      if (x > edges[0] + 28 && x < width - edges[1] - 28) out.push({ x, label: fmtDay(fromCampaignMs(m)) })
      const md = new Date(m)
      m = Date.UTC(md.getUTCFullYear(), md.getUTCMonth() + 1, 1)
    }
    return out
  }, [bounds, width, t0, t1, frac, edges])

  const [hot, setHot] = useState<number | null>(null)
  const hotTick = hot != null ? ticks[hot] : null

  const stamp = (t: CampaignTime) => `${fmtDay(t)} ${fmtTime24(t)}`
  const valueText = now ? (atEnd ? `${stamp(now)}, the end of the data` : stamp(now)) : 'loading'

  const handle = (
    <div
      ref={handleRef}
      className={s.handle}
      role="slider"
      tabIndex={0}
      data-autofocus
      aria-label="Moment shown"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalHours)}
      aria-valuenow={Math.round(((shownMs - t0) / 3_600_000))}
      aria-valuetext={valueText}
      title="Drag, or ← → for an hour and shift for a day (, and . also step)"
    />
  )

  const track = (
    <div
      className={s.scrub}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => setPeek(null)}
    >
      <div className={clsx(s.track, time.playing && dragMs == null && s.gliding)}>
        {/* Moved with transforms, not width/left: during playback these update
            four times a second and a layout property would re-lay the popover
            every step. The rail spans the track, so translateX(100%) is the end. */}
        <span className={s.fill} style={{ transform: `scaleX(${pos})` }} />
        <div className={s.handleRail} style={{ transform: `translateX(${pos * 100}%)` }}>
          {handle}
        </div>
      </div>
      {collapsed ? null : (
        <div className={s.strip} title="Street passes driven each day. Gaps are days the fleet did not drive.">
          {days.map((d) => {
            const a = frac(campaignMs(d.date))
            const b = frac(campaignMs(d.date) + DAY)
            return (
              <span
                key={d.date}
                className={s.day}
                style={{
                  left: `${a * 100}%`,
                  width: `${(b - a) * 100}%`,
                  height: `${25 + 75 * (d.passes / maxPasses)}%`,
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )

  // Play / pause is the first thing in the top row in BOTH layouts, the same
  // element in the same place. It used to be the bar's own button folded, and
  // the transport's Play unfolded: a mouse on its way to the bar's Pause
  // unfolded the popover, and the button under the pointer turned into the
  // readout text. Being one element, it also keeps the focus across a fold.
  const toggle = (
    <Button size="sm" variant="primary" icon={time.playing ? 'pause' : 'play'}
      className={s.play} onClick={togglePlay} disabled={!bounds} data-bar-control
      title={time.playing ? 'Pause (Space)' : atEnd ? 'Play from Start (Space)' : 'Play from here (Space)'}>
      {/* Both words laid in one cell, the other one invisible, so the button
          is one width in every room's type: sized for "Play", it grew 1.8px
          on the right when it turned into "Pause". */}
      <span className={s.playWord}>
        <span>{time.playing ? 'Pause' : 'Play'}</span>
        <span aria-hidden>{time.playing ? 'Play' : 'Pause'}</span>
      </span>
    </Button>
  )

  // ── collapsed: pause and the track, nothing else ───────────────────────
  // Same outer element and same first row as the unfolded layout, so React
  // keeps the toggle's node when it folds.
  if (collapsed) {
    return (
      <div className={clsx(s.mini, className)}>
        <div className={s.bar}>
          {toggle}
          <div className={s.rail} ref={setRail} data-bar-control>{track}</div>
          <span className={clsx(s.miniWhen, 'num')}>{now ? stamp(now) : '—'}</span>
        </div>
      </div>
    )
  }

  // Where you are is in the readout while it plays too: unfolded mid-play it
  // said only "Playing · 6 h per second", so the moment was on the chip and
  // the handle and nowhere a sentence says it.
  const readout = !bounds || !now
    ? 'Loading the campaign…'
    : time.playing
      ? <>Playing · <span className="num">{stamp(now)}</span> · {speedShort(time.speed)}</>
      : atEnd
        ? <>Paused at the end of the data · <span className="num">{stamp(now)}</span></>
        : <>Paused · <span className="num">{stamp(now)}</span></>

  const peekDay = peek ? fromCampaignMs(peek.ms).slice(0, 10) : null
  const peekPasses = peekDay ? passesOn.get(peekDay) ?? 0 : 0
  const tipAt = hotTick ? hotTick.x : peek?.x ?? null
  const tipSide = tipAt == null ? 'mid' : tipAt < width * 0.25 ? 'left' : tipAt > width * 0.75 ? 'right' : 'mid'
  const tipHiddenModel = hotTick ? hotTick.marks.slice(4).filter((m) => m.hollow).length : 0

  return (
    <div className={clsx(s.body, className)}>
      <div className={s.head}>
        {toggle}
        <p className={s.readout} aria-live="polite">{readout}</p>
        {aside}
      </div>

      <div className={s.timeline}>
        <div className={s.rail} ref={setRail}>
          {tipAt != null ? (
            <div className={clsx(s.tip, s[`tip_${tipSide}`])} style={{ left: tipAt }} role="tooltip">
              {hotTick ? (
                <>
                  {hotTick.marks.slice(0, 4).map((m) => (
                    <span key={m.id} className={s.tipLine}>
                      <span className={clsx(s.tipWhen, 'num')}>{fmtDay(m.at)}</span>
                      <span>
                        {m.label}
                        {m.hollow ? <span className={s.tipModel}> · from the model</span> : null}
                      </span>
                    </span>
                  ))}
                  {hotTick.marks.length > 4 ? (
                    <span className={s.tipMore}>
                      and {hotTick.marks.length - 4} more
                      {tipHiddenModel ? `, ${tipHiddenModel === 1 ? 'one' : fmtNum(tipHiddenModel, 0)} from the model` : ''}
                    </span>
                  ) : null}
                </>
              ) : peek ? (
                <span className={s.tipLine}>
                  <span className={clsx(s.tipWhen, 'num')}>{stamp(floorTo(fromCampaignMs(peek.ms), 60))}</span>
                  {peekPasses > 0 ? `${countOf(peekPasses, 'street pass', 'street passes')} that day` : 'no driving that day'}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className={s.ticks} onPointerLeave={() => setHot(null)}>
            {ticks.map((t, i) => (
              <button
                key={t.marks[0].id}
                type="button"
                tabIndex={-1}
                className={clsx(
                  s.tick,
                  s[`tick_${t.kind}`],
                  t.marks.length > 1 && s.tickGroup,
                  t.hollow && s.tickHollow,
                  t.model > 0 && !t.hollow && s.tickModel,
                  t.ms > shownMs && s.tickAhead,
                )}
                data-sev={t.severity ?? undefined}
                style={{ left: t.x }}
                aria-label={t.marks
                  .map((m) => `${fmtDay(m.at)}: ${m.label}${m.hollow ? ' (from the model)' : ''}`)
                  .join('; ')}
                onPointerEnter={() => setHot(i)}
                onClick={() => setTimeCursor(t.at)}
              >
                <span className={s.mark}>{t.marks.length > 1 ? t.marks.length : null}</span>
              </button>
            ))}
          </div>

          {track}

          <div className={s.axis} aria-hidden>
            <span ref={startLabel} className={clsx(s.edge, 'num')}>{bounds ? fmtDay(bounds.start) : '—'}</span>
            {months.map((m) => (
              <span key={m.label} className={clsx(s.month, 'num')} style={{ left: m.x }}>{m.label}</span>
            ))}
            <span ref={endLabel} className={clsx(s.edge, s.edgeEnd)}>
              <span className="num">{bounds ? fmtDay(bounds.end) : '—'}</span> · end of data
            </span>
          </div>
        </div>
      </div>

      <div className={s.transport}>
        <div className={s.buttons}>
          <Button size="sm" variant="ghost" className={s.jump} onClick={goStart} disabled={!startAt}
            title="The morning of the first day the fleet drove (Home)">
            <Icon name="skip" size={15} style={{ rotate: '180deg' }} />
            Start
          </Button>
          <IconButton icon="chevron" label="Previous event" style={{ rotate: '180deg' }}
            disabled={!prev} onClick={() => prev && setTimeCursor(prev.at)} />
          <IconButton icon="chevron" label="Next event"
            disabled={!next} onClick={() => next && setTimeCursor(next.at)} />
          <Button size="sm" variant="ghost" iconEnd="skip" className={s.jump} onClick={goToEnd}
            disabled={atEnd && !time.playing} title="The end of the data (End, or L)">
            End
          </Button>
        </div>
        <Segmented
          className={s.speed}
          value={String(time.speed)}
          onValueChange={(v) => setSpeed(Number(v))}
          options={PLAYBACK_SPEEDS.map((sp) => ({
            value: String(sp),
            label: speedShort(sp),
            title: `${speedWord(sp)} per second: the whole campaign in ${playDuration(totalHours, sp)}`,
          }))}
        />
      </div>
    </div>
  )
}
