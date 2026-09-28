/**
 * air — the clock's two jobs that run whether or not a control is on screen:
 * load the simulation's limits, and play.
 *
 * Mounted once by the shell.
 */

import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

import { addHours, campaignMs, floorTo } from '@/core/clock'
import { useBootstrap } from '@/core/queries'
import { useSession } from '@/core/session'

/**
 * How often the driver looks at the clock while playing. Looking is free; a
 * WRITE is what costs, because the cursor drives every time-aware query key.
 */
const TICKS_PER_SECOND = 4

/**
 * The request budget of one playing tab, per real second, averaged over
 * steps. A step that set off N fetches holds the next write for at least
 * N / budget seconds (and until they all landed): ~10 on the regulator's
 * Network is one step every ~2.5 s, a page with 3 clock-keyed layers steps
 * more often. Measured against the deployed demo, where every request costs
 * ~130–200 ms of front-end overhead whatever the server does: an open loop of
 * ~24/s drew 429 "Rate exceeded".
 */
const REQUESTS_PER_SECOND = 4

/** Never write faster than this, however cheap the page. */
const MIN_STEP_MS = 500

/** Playback snaps to this grid: the fleet's resolution, finer than wind's. */
const SNAP_MIN = 10

/** Fetches begun since the playback last wrote a moment (module state: one clock). */
let stepFetches = 0

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
 * Drives playback. Advances simulated time by `speed` minutes per real second
 * and at the end of the data stops and pauses there (D1).
 *
 * BACKPRESSURE. Every written moment is a new key for ~10 clock-keyed queries
 * (streets ×2, network, monitors, fleet, alerts, concerns, clusters, wind,
 * plumes). Writing four moments a second whatever the server was doing was
 * ~24 requests a second from one tab: the deployed single-instance service
 * (--max-instances 1, one CPU, ~180 ms a request) serves ~5, so the queue
 * grew until Cloud Run answered 429 "Rate exceeded" and superseded requests
 * were aborted after the server had already done the work (a 60 s capture:
 * 422 API calls, 19 × 429, 13 aborted). Now a moment is written only when
 * nothing is fetching, and not before the last step's fetches fit the
 * budget (`REQUESTS_PER_SECOND`, floor `MIN_STEP_MS`). Simulated time keeps
 * running meanwhile, so the speed is honoured and a slow server or a heavy
 * page shows as larger steps, never as a queue.
 */
export function useTimePlayback(): void {
  const playing = useSession((st) => st.time.playing)
  const speed = useSession((st) => st.time.speed)
  const qc = useQueryClient()

  // Fetches begun since the last write: what the last step cost.
  useEffect(() => {
    return qc.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'fetch') stepFetches += 1
    })
  }, [qc])

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
    let wroteAt = -Infinity
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
      // Backpressure: the previous moment's requests have not all landed, or
      // it was written too recently. Time runs on; the next write catches up.
      const hold = Math.max(MIN_STEP_MS, (stepFetches / REQUESTS_PER_SECOND) * 1000)
      if (t - wroteAt < hold || qc.isFetching() > 0) return
      const next = floorTo(addHours(bounds.start, (simMs - campaignMs(bounds.start)) / 3_600_000), SNAP_MIN)
      if (next !== st.time.cursor) {
        written = next
        wroteAt = t
        stepFetches = 0
        st.setTimeCursor(next)
      }
    }, 1000 / TICKS_PER_SECOND)
    return () => clearInterval(id)
  }, [playing, speed, qc])
}
