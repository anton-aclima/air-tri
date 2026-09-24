/**
 * air — the simulation control: a popover hung from the SIMULATED DATA chip.
 *
 * Every number in this product is generated, and the demo is driven by one
 * variable: what moment it is showing. The marker the contract already puts on
 * every screen is therefore also the door to that variable — being able to
 * say "this is generated, and here is its clock" is a stronger honesty claim
 * than a badge alone.
 *
 * What it replaced, and why each piece went (docs/PLAN-refocus.md S1, S5):
 *   - a full-screen modal with a blurred backdrop, which hid the map that the
 *     clock exists to move. A popover with no scrim keeps it in view;
 *   - a datetime field that accepted any year, six ±h step buttons and an
 *     analysis-window select no screen read — the timeline replaces all three,
 *     and it cannot be set outside the simulation;
 *   - "Follow the clock", "Pinned", the drift banner and "Pin to end of data".
 *     There is no wall clock to follow or drift from any more: at the end of
 *     the data the demo is simply paused (D1);
 *   - the Advisor and community-fleet-delay rows, which were facts about the
 *     server, not about the data.
 *
 * While playing it stays open but folds to a ~56px bar (pause and track), so
 * the map can be watched moving under it; pausing unfolds it, and so does a
 * mouse resting on the bar off its controls (see `UNFOLD_MS`).
 */

import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'

import { TimeCursor } from '@/app/TimeCursor'
import { IconButton, Popover } from '@/app/ui'
import { fmtDay } from '@/core/format'
import { useCampaignInfo } from '@/core/queries'
import { useSession } from '@/core/session'

import s from '@/app/SimControl.module.css'

/** S1: about 560px, never wider than the viewport less its gutters. */
const WIDTH = 560

/**
 * How long a mouse rests on the folded bar, off its controls, before it
 * unfolds. Unfolding on pointer-enter moved the bar out from under the mouse:
 * any approach to the bar's Pause crossed the popover's edge first, it grew
 * from 58 to 244px, and the point the mouse was aiming at became the readout
 * text. Over Pause or the track (`[data-bar-control]`) it never unfolds.
 */
const UNFOLD_MS = 400

export interface SimControlProps {
  open: boolean
  onClose: () => void
  /** The chip it opens from. */
  anchor: RefObject<HTMLElement | null>
}

export function SimControl({ open, onClose, anchor }: SimControlProps) {
  const playing = useSession((x) => x.time.playing)
  const [hover, setHover] = useState(false)
  const collapsed = playing && !hover

  const timer = useRef<number | null>(null)
  const cancelUnfold = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])
  useEffect(() => cancelUnfold, [cancelUnfold])

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    // Touch has no hover: a tap is a press, and Pause unfolds it anyway.
    if (e.pointerType === 'touch' || hover) return
    // Unfolded (paused), the pointer on it counts at once: nothing moves under
    // it then, and pressing Play with the mouse there keeps the full controls
    // up until it leaves, as before.
    if (!collapsed) {
      setHover(true)
      return
    }
    if ((e.target as Element).closest('[data-bar-control]')) {
      cancelUnfold()
      return
    }
    if (timer.current == null) {
      timer.current = window.setTimeout(() => {
        timer.current = null
        setHover(true)
      }, UNFOLD_MS)
    }
  }
  const onPointerLeave = () => {
    cancelUnfold()
    setHover(false)
  }

  // Forget the hover on the way out: Esc with the pointer over the popover
  // fires no pointerleave, and the next opening would start unfolded.
  const close = useCallback(() => {
    cancelUnfold()
    setHover(false)
    onClose()
  }, [onClose, cancelUnfold])

  return (
    <Popover
      open={open}
      onClose={close}
      anchor={anchor}
      align="end"
      width={WIDTH}
      label="Simulation clock"
      className={clsx(s.pop, collapsed && s.collapsed)}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <TimeCursor
        collapsed={collapsed}
        keyboard={open}
        aside={<IconButton icon="close" label="Close (Esc)" size="sm" onClick={close} />}
      />
      {collapsed ? null : <DatasetFacts />}
    </Popover>
  )
}

/**
 * One line of what this dataset is, and one of what the map colours cover.
 * The second is there because the clock moves the wind, the fleet and the
 * events, but the street colours are a whole-campaign summary — without it,
 * pressing Start and seeing August-coloured streets reads as a bug. So it is
 * set as legibly as the first (both in --ink-2), not as a footnote.
 */
function DatasetFacts() {
  const campaign = useCampaignInfo()
  const bounds = useSession((x) => x.time.bounds)
  return (
    <footer className={s.facts}>
      <p
        className={s.fact}
        title="Real streets and real neighbourhood names. Every person, company, agency, reading and alert is invented."
      >
        {campaign?.name ?? 'This campaign'}
        {bounds ? (
          <> · <span className="num">{fmtDay(bounds.start)} – {fmtDay(bounds.end)}</span></>
        ) : null}
        {campaign ? <> · <span className="num">{campaign.fleet_size}</span> vehicles</> : null}
      </p>
      <p className={s.fact}>Street colours on the maps cover the whole campaign.</p>
    </footer>
  )
}
