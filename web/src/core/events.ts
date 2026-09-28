/**
 * air — what had happened by the moment on screen.
 *
 * Replay rewinds events too (docs/PLAN-refocus.md D2): an alert, a report, a
 * post exists on screen only once the demo's now has reached it. These are the
 * shared tests, so "live", "open" and "recent" mean one thing in every room.
 *
 * `status` is served as it stood at the moment shown (server/statusat.py): the
 * stored status walked back past every step taken after it; what cannot be
 * rebuilt is listed there. The time tests here do not depend on it;
 * `isOpenCase` does, and says so.
 */

import { campaignMs } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'

interface Timed {
  started_at?: string | null
  ended_at?: string | null
  created_at?: string | null
  status?: string | null
}

const at = (t: string | null | undefined) => (t ? campaignMs(t) : NaN)

/** The event's own start: `started_at`, else `created_at`. */
function startOf(e: Timed): number {
  return at(e.started_at ?? e.created_at)
}

/** It had begun by `now`. Anything after `now` is the future and is not shown. */
export function hasStarted(e: Timed, now: CampaignTime): boolean {
  const s = startOf(e)
  return Number.isFinite(s) && s <= campaignMs(now)
}

/**
 * Begun, and not yet ended, at `now`. This — not `status === 'active'` — is
 * what "live" means: several "active" alerts ended days before the end of the
 * data, and a status field cannot say when.
 */
export function isOngoing(e: Timed, now: CampaignTime): boolean {
  if (!hasStarted(e, now)) return false
  const end = at(e.ended_at)
  return !Number.isFinite(end) || end > campaignMs(now)
}

/**
 * Still someone's open case: begun, and not resolved or closed. Uses `status`,
 * served as it stood at the moment shown (server/statusat.py), so it is exact
 * at the end of the data; in replay it is as good as that rebuild, whose gaps
 * (when an alert resolved or expired) are listed there. A status fetched for
 * an earlier moment is stale once the moment moves — refetch, do not reuse.
 */
export function isOpenCase(e: Timed, now: CampaignTime): boolean {
  if (!hasStarted(e, now)) return false
  return !['resolved', 'closed', 'dismissed', 'archived'].includes(String(e.status ?? ''))
}

/** Begun within the last `hours` before `now`. */
export function isRecent(e: Timed, now: CampaignTime, hours: number): boolean {
  const s = startOf(e)
  const n = campaignMs(now)
  return Number.isFinite(s) && s <= n && s > n - hours * 3_600_000
}

/** Keep only what had begun by `now`. */
export function happenedBy<T extends Timed>(list: readonly T[] | null | undefined, now: CampaignTime): T[] {
  return (list ?? []).filter((e) => hasStarted(e, now))
}
