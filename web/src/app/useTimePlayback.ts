/**
 * air — the clock's two jobs that run whether or not a control is on screen:
 * load the simulation's limits, and play.
 *
 * Mounted once by the shell.
 */

import { useEffect } from 'react'

import { addHours, campaignMs, floorTo } from '@/core/clock'
import { useBootstrap } from '@/core/queries'
import { useSession } from '@/core/session'

/**
 * Query updates per real second while playing. The cursor drives every
 * time-aware query key, so a per-frame cursor was sixty refetches a second;
 * four is smooth enough to watch and cheap enough to keep up with.
 */
const UPDATES_PER_SECOND = 4

/** Playback snaps to this grid: the fleet's resolution, finer than wind's. */
const SNAP_MIN = 10

/** Load `[campaign start, end of data]` into the clock once the bootstrap lands. */
export function useClockBounds(): void {
  const boot = useBootstrap().data
  const setTimeBounds = useSession((st) => st.setTimeBounds)
  const start = boot?.campaign?.start_date
  const end = boot?.flags?.generated_at ?? boot?.flags?.now
  useEffect(() => {
    if (start && end) setTimeBounds(`${start}T00:00:00`, end)
  }, [start, end, setTimeBounds])
}

/**
 * Drives playback. Advances the cursor by `speed` simulated minutes per real
 * second, writes it at most `UPDATES_PER_SECOND` times a second on a 10-minute
 * grid, and at the end of the data stops and pauses there (D1).
 */
export function useTimePlayback(): void {
  const playing = useSession((st) => st.time.playing)
  const speed = useSession((st) => st.time.speed)

  useEffect(() => {
    if (!playing) return
    const { time } = useSession.getState()
    const bounds = time.bounds
    if (!bounds) return
    // Playing from the end restarts from the beginning — there is nothing
    // after the end to play.
    let written = time.cursor ?? bounds.start
    let simMs = campaignMs(written)
    const endMs = campaignMs(bounds.end)
    if (!time.cursor) useSession.getState().setTimeCursor(written)

    let last = performance.now()
    const id = setInterval(() => {
      const t = performance.now()
      const st = useSession.getState()
      // Someone sought or stepped onto the end while it played: that is the
      // end, not a position to overwrite. (The store pauses there too; this
      // holds even for a writer that does not.)
      if (st.time.cursor == null) {
        st.goToEnd()
        return
      }
      // Someone scrubbed while it played: continue from where they put it.
      if (st.time.cursor !== written) simMs = campaignMs(st.time.cursor)
      simMs += ((t - last) / 1000) * speed * 60_000
      last = t
      if (simMs >= endMs) {
        st.goToEnd()
        return
      }
      const next = floorTo(addHours(bounds.start, (simMs - campaignMs(bounds.start)) / 3_600_000), SNAP_MIN)
      if (next !== st.time.cursor) {
        written = next
        st.setTimeCursor(next)
      }
    }, 1000 / UPDATES_PER_SECOND)
    return () => clearInterval(id)
  }, [playing, speed])
}
