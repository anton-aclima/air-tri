/**
 * air — the global time cursor.
 *
 * The demo has a scrubbable "now". Everything time-aware in `core/queries`
 * (fleet positions, monitor readings, wind, dispersion) defaults to it, so
 * dragging this scrubber moves the entire application through the campaign.
 *
 * Mount it anywhere: `<TimeCursor />`. The state lives in `core/session`.
 */

import clsx from 'clsx'
import { useMemo } from 'react'

import s from '@/app/TimeCursor.module.css'
import { IconButton, Segmented, Slider, Tooltip } from '@/app/ui'
import { useCampaignInfo } from '@/core/queries'
import { PLAYBACK_SPEEDS, resolveNow, useSession } from '@/core/session'
import { fmtDayFull, fmtTime24, isoDate, relativeTime } from '@/core/format'
import { useFlags } from '@/core/queries'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

interface Bounds {
  start: number
  end: number
  hours: number
}

/**
 * The scrubbable window: the campaign's own start_date → the server's canonical
 * "now" (`flags.now`). Falls back to a trailing 90 days when the API is down, so
 * nothing here is hardcoded to a particular fixture.
 */
function useBounds(): Bounds {
  const campaign = useCampaignInfo()
  const nowIso = useFlags()?.now
  const startIso = campaign?.start_date
  const endIso = campaign?.end_date
  return useMemo(() => {
    const stamp = (iso: string | undefined): number => {
      const t = iso ? new Date(iso).getTime() : NaN
      return Number.isFinite(t) ? t : NaN
    }
    const wall = Date.now()
    const declaredEnd = stamp(nowIso)
    const campaignEnd = stamp(endIso)
    // Never scrub past the wall clock, and never past the campaign's own end.
    const end = Number.isFinite(declaredEnd)
      ? declaredEnd
      : Number.isFinite(campaignEnd)
        ? Math.min(campaignEnd, wall)
        : wall
    const declaredStart = stamp(startIso)
    const start = Number.isFinite(declaredStart) ? declaredStart : end - 90 * DAY_MS
    return { start, end, hours: Math.max(1, Math.round((end - start) / HOUR_MS)) }
  }, [startIso, endIso, nowIso])
}

export interface TimeCursorProps {
  /** No frame — for a bar already sitting inside a panel or toolbar. */
  flush?: boolean
  /** Hide the playback transport (just the readout + scrubber). */
  minimal?: boolean
  className?: string
}

export function TimeCursor({ flush, minimal, className }: TimeCursorProps) {
  const time = useSession((st) => st.time)
  const setTimeCursor = useSession((st) => st.setTimeCursor)
  const stepTime = useSession((st) => st.stepTime)
  const goLive = useSession((st) => st.goLive)
  const togglePlaying = useSession((st) => st.togglePlaying)
  const setSpeed = useSession((st) => st.setSpeed)

  const bounds = useBounds()
  const now = resolveNow(time)
  const live = time.cursor == null
  const offsetHours = Math.round((now.getTime() - bounds.start) / HOUR_MS)

  const ticks = useMemo(() => {
    const days = Math.max(1, Math.round((bounds.end - bounds.start) / DAY_MS))
    const stepDays = days > 60 ? 15 : days > 21 ? 7 : days > 7 ? 2 : 1
    const out: { pct: number; major: boolean; label: string | null }[] = []
    for (let d = 0; d <= days; d += stepDays) {
      const t = bounds.start + d * DAY_MS
      const pct = ((t - bounds.start) / (bounds.end - bounds.start)) * 100
      const major = d % (stepDays * 2) === 0
      out.push({ pct, major, label: major ? isoDate(new Date(t)).slice(5) : null })
    }
    return out
  }, [bounds.start, bounds.end])

  return (
    <div className={clsx(s.bar, flush && s.flush, className)}>
      <div className={s.readout}>
        <span className={s.stamp}>
          {fmtDayFull(now)} · {fmtTime24(now)}
        </span>
        <span className={s.sub}>
          <span className={clsx(s.liveDot, !live && s.pastDot)} />
          {live ? 'Live' : relativeTime(now)}
        </span>
      </div>

      {minimal ? null : (
        <div className={s.controls}>
          <IconButton
            icon="skip"
            label="Back 1 hour"
            size="sm"
            style={{ rotate: '180deg' }}
            onClick={() => stepTime(-1)}
          />
          <IconButton
            icon={time.playing ? 'pause' : 'play'}
            label={time.playing ? 'Pause playback' : 'Play through time'}
            size="sm"
            active={time.playing}
            onClick={togglePlaying}
          />
          <IconButton icon="skip" label="Forward 1 hour" size="sm" onClick={() => stepTime(1)} />
        </div>
      )}

      <div className={s.track}>
        <Slider
          aria-label="Time cursor"
          min={0}
          max={bounds.hours}
          step={1}
          value={Math.min(bounds.hours, Math.max(0, offsetHours))}
          display={null}
          onValueChange={(h) => {
            if (h >= bounds.hours) goLive()
            else setTimeCursor(new Date(bounds.start + h * HOUR_MS).toISOString())
          }}
        />
        <div className={s.ticks} aria-hidden>
          {ticks.map((t) => (
            <span key={t.pct} className={clsx(s.tick, t.major && s.tickMajor)} style={{ left: `${t.pct}%` }}>
              {t.label ? <span className={s.tickLabel}>{t.label}</span> : null}
            </span>
          ))}
        </div>
      </div>

      {minimal ? null : (
        <>
          <Segmented
            className={s.speed}
            value={String(time.speed)}
            options={PLAYBACK_SPEEDS.map((sp) => ({
              value: String(sp),
              label: sp >= 60 ? `${sp / 60}h/s` : `${sp}m/s`,
              title: `${sp} simulated minutes per second`,
            }))}
            onValueChange={(v) => setSpeed(Number(v))}
          />
          <Tooltip below content="Snap back to the wall clock">
            <IconButton
              icon="clock"
              label="Go live"
              size="sm"
              bordered
              active={live}
              onClick={goLive}
            />
          </Tooltip>
        </>
      )}
    </div>
  )
}
