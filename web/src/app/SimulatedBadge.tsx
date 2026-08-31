/**
 * air — the persistent `SIMULATED DATA` marker.
 *
 * CONTRACT §9.1 makes this non-negotiable: it is visible in every interface.
 * The shell mounts one in every role's chrome and on the landing page.
 */

import clsx from 'clsx'

import s from '@/app/SimulatedBadge.module.css'
import { Tooltip } from '@/app/ui'

export interface SimulatedBadgeProps {
  /** Hide the words, keep the hatch + dot — for very tight chrome. */
  compact?: boolean
  className?: string
}

export function SimulatedBadge({ compact, className }: SimulatedBadgeProps) {
  return (
    <Tooltip
      below
      title="Simulated data"
      content="Every number in air is procedurally generated for demonstration. Real geography, fictional operators, plausible thresholds."
    >
      <span
        className={clsx(s.badge, compact && s.compact, className)}
        aria-label="Simulated data"
      >
        <span className={s.hatch} aria-hidden />
        <span className={s.dot} aria-hidden />
        <span className={s.label}>Simulated data</span>
      </span>
    </Tooltip>
  )
}
