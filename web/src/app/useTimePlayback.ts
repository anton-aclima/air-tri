/**
 * air — time-cursor playback.
 *
 * Split out of `TimeCursor.tsx` so the scrubber file only exports a component
 * (fast refresh) and so the shell can run the clock even when no scrubber is
 * mounted.
 */

import { useEffect } from 'react'

import { useSession } from '@/core/session'

/**
 * Drives playback. Mounted once by the shell so the clock keeps running even
 * when no scrubber is on screen.
 */
export function useTimePlayback(): void {
  const playing = useSession((st) => st.time.playing)
  const speed = useSession((st) => st.time.speed)
  const setTimeCursor = useSession((st) => st.setTimeCursor)
  const setPlaying = useSession((st) => st.setPlaying)

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (t: number) => {
      const dt = (t - last) / 1000
      last = t
      const { time } = useSession.getState()
      const cursor = time.cursor ? new Date(time.cursor).getTime() : Date.now()
      const next = cursor + dt * speed * 60_000
      if (next >= Date.now()) {
        setTimeCursor(null)
        setPlaying(false)
        return
      }
      setTimeCursor(new Date(next).toISOString())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, setTimeCursor, setPlaying])
}
