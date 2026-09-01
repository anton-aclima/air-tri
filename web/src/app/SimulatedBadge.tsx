/**
 * air — the persistent `SIMULATED DATA` marker.
 *
 * CONTRACT §9.1 makes this non-negotiable: it is visible in every interface.
 * The shell mounts one in every role's chrome and on the landing page.
 */

import clsx from 'clsx'
import { useState } from 'react'

import s from '@/app/SimulatedBadge.module.css'
import { SimControl } from '@/app/SimControl'
import { Tooltip } from '@/app/ui'

export interface SimulatedBadgeProps {
  /** Hide the words, keep the hatch + dot — for very tight chrome. */
  compact?: boolean
  /**
   * Make the marker open the simulation panel. On the landing page it is a
   * statement of fact; inside a role it is also the way in to the clock.
   */
  control?: boolean
  className?: string
}

export function SimulatedBadge({ compact, control = false, className }: SimulatedBadgeProps) {
  const [open, setOpen] = useState(false)
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
        <span className={clsx(s.badge, compact && s.compact, className)} aria-label="Simulated data">
          {inner}
        </span>
      </Tooltip>
    )
  }

  return (
    <>
      <Tooltip
        below
        title="Simulated data"
        content="Every number here is generated. Open the simulation panel to set the clock, run it, and see what this dataset actually covers."
      >
        <button
          type="button"
          className={clsx(s.badge, s.badgeButton, compact && s.compact, className)}
          aria-label="Simulated data — open simulation control"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {inner}
        </button>
      </Tooltip>
      <SimControl open={open} onClose={() => setOpen(false)} />
    </>
  )
}
