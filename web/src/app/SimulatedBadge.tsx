/**
 * air — the persistent `SIMULATED DATA` marker, and inside a role, the clock.
 *
 * CONTRACT §9.1 makes the marker non-negotiable: it is visible in every
 * interface. The shell mounts one in every role's chrome and on the landing
 * page. Its words are set so they never clip — the chip does not shrink, and
 * there is no compact variant any more, because the one that existed hid the
 * words and kept a dot, which is not a marker anyone can read.
 *
 * Inside a role the chip is also the clock (docs/PLAN-refocus.md S3): after
 * the words it says what the moment on screen is, and pressing it opens the
 * timeline. Three states, in neutral ink — this is not an alert:
 *
 *   · Paused · end of data     at the end of the data (D1: time pauses there)
 *   · Paused · Aug 12 13:00    replaying, stopped
 *   · ▶ Aug 12 13:00           playing
 *
 * It replaced a separate LIVE chip whose "live" meant the wall clock, and
 * whose unseen-event counter only ever grew.
 */

import clsx from 'clsx'
import { useCallback, useRef, useState, type ReactNode } from 'react'

import s from '@/app/SimulatedBadge.module.css'
import { SimControl } from '@/app/SimControl'
import { Icon, Tooltip } from '@/app/ui'
import { fmtDay, fmtTime24 } from '@/core/format'
import { useSession } from '@/core/session'

export interface SimulatedBadgeProps {
  /**
   * Make the marker the clock: show the moment after the words and open the
   * simulation popover. On the landing page it is a statement of fact; inside
   * a role it is also the way in to time.
   */
  control?: boolean
  className?: string
}

export function SimulatedBadge({ control = false, className }: SimulatedBadgeProps) {
  const inner = (
    <>
      <span className={s.hatch} aria-hidden />
      <span className={s.dot} aria-hidden />
      <span className={s.label}>Simulated data</span>
    </>
  )

  if (!control) {
    return (
      <Tooltip
        below
        title="Simulated data"
        content="Every number in air is procedurally generated for demonstration. Real geography, fictional operators, plausible thresholds."
      >
        <span className={clsx(s.badge, className)} aria-label="Simulated data">
          {inner}
        </span>
      </Tooltip>
    )
  }

  return <ClockBadge className={className}>{inner}</ClockBadge>
}

function ClockBadge({ className, children }: { className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)
  const cursor = useSession((x) => x.time.cursor)
  const playing = useSession((x) => x.time.playing)
  const end = useSession((x) => x.time.bounds?.end ?? null)
  const close = useCallback(() => setOpen(false), [])

  // The moment on screen: the cursor, else the end of the data. At the end the
  // chip says so in words (D1), not with the date: "Paused · Aug 28" and a
  // replay stopped on Aug 28 read the same but for the hour, so nothing said
  // this was as far as the data goes. The date is in the popover and the label.
  const at = cursor ?? end
  const day = at ? fmtDay(at) : null
  const hour = cursor ? fmtTime24(cursor) : null
  const said = playing
    ? `playing, ${day ?? ''} ${hour ?? ''}`
    : cursor ? `paused at ${day} ${hour}` : `paused at the end of the data${day ? `, ${day}` : ''}`

  return (
    <>
      {/* Shut while the popover is open: it painted under the popover and
          stuck out ~11px past its right edge, and opened on the chip's focus
          it stayed there for as long as the popover did. */}
      <Tooltip
        below
        suppressed={open}
        title="Simulated data"
        content="Every number here is generated. Open the timeline to see the whole campaign, go back to its start, and play it."
      >
        <button
          ref={ref}
          type="button"
          className={clsx(s.badge, s.badgeButton, open && s.badgeOpen, className)}
          aria-label={`Simulated data — ${said.trim()}. Open the timeline.`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {children}
          {day ? (
            <span className={s.state}>
              <span className={s.sep} aria-hidden>·</span>
              {playing ? (
                <Icon name="play" size={9} weight={2.4} className={s.playing} />
              ) : (
                <>
                  <span>Paused</span>
                  <span className={s.sep} aria-hidden>·</span>
                </>
              )}
              {cursor || playing ? (
                <span className={clsx(s.when, 'num')}>
                  {day}
                  {hour ? <span className={s.hour}> {hour}</span> : null}
                </span>
              ) : (
                <span className={s.when}>end of data</span>
              )}
            </span>
          ) : null}
        </button>
      </Tooltip>
      <SimControl open={open} onClose={close} anchor={ref} />
    </>
  )
}
