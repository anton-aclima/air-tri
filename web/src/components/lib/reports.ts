/**
 * Which resident reports a map draws, and how many it folds together.
 *
 * Every map used to draw all 204 reports from 90 days at full weight, forever,
 * on top of the road grid that is the actual measurement. Two rules, shared by
 * the community, regulator and industry maps so they cannot disagree:
 *
 *   1. A WINDOW. By default, the last 14 days — about 40 reports, the fortnight
 *      a resident actually remembers. "All 90 days" is one tap away and is
 *      never hidden: a report is a person's word and the map does not get to
 *      bury it, only to stop shouting it.
 *
 *   2. AGGREGATION BY ZOOM. At city zoom, reports close together on screen fold
 *      into one count bubble that splits as you zoom in (`ConcernLayer`).
 *
 * THE ANCHOR. "The last 14 days" measured from the wall clock is empty: the
 * campaign's data ends weeks before today, which is also why the community feed
 * says "0 reports from neighbours this week". So the window ends at the DEMO'S
 * now — the cursor, else the end of the data — which is the same instant the
 * rows' ages are measured from. Anchored on the newest report instead, the two
 * disagreed and "Last 14 d" listed a report "27 d ago" (docs/PLAN-refocus.md F1).
 *
 * All times are naive campaign time and compared on its own axis (core/clock),
 * so a report's digits are never shifted by the viewer's zone.
 */

import { useMemo } from 'react'

import { addHours, campaignMs, naive } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { useNowCampaign, useSession } from '@/core/session'
import type { Concern, ConcernCluster } from '@/core/types'

export const REPORT_WINDOW_DAYS = 14

/** Null means every report — the "All 90 days" choice. */
export type ReportWindowDays = number | null

export interface WindowedReports {
  concerns: Concern[]
  clusters: ConcernCluster[]
  /** Start of the window (naive campaign time), or null for all. */
  since: CampaignTime | null
  /** End of the window: the demo's now. */
  anchor: CampaignTime | null
  /** Before windowing, so a toggle can say what it would show. */
  total: number
}

/**
 * The window's end: the demo's now. Pass `useNowCampaign()`.
 *
 * A caller that still passes the bare cursor sends `null` at the end of the
 * data, so `null` reads the clock's end from the store — the anchor is then
 * `cursor ?? bounds.end` either way. Only before the bootstrap has loaded the
 * bounds does it fall back to the newest report. Prefer `useWindowedReports`,
 * which also recomputes when the bounds land.
 */
export function reportAnchor(concerns: Concern[], now: string | null | undefined): CampaignTime | null {
  if (now) return naive(now)
  const end = useSession.getState().time.bounds?.end
  if (end) return end
  let best: string | null = null
  for (const c of concerns) if (!best || campaignMs(c.created_at) > campaignMs(best)) best = c.created_at
  return best ? naive(best) : null
}

/** `now` is the demo's now (see `reportAnchor`). */
export function windowReports(
  concerns: Concern[],
  clusters: ConcernCluster[],
  days: ReportWindowDays,
  now?: string | null,
): WindowedReports {
  const anchor = reportAnchor(concerns, now)
  if (days == null || !anchor) {
    return { concerns, clusters, since: null, anchor, total: concerns.length }
  }
  const since = addHours(anchor, -24 * days)
  const lo = campaignMs(since)
  const hi = campaignMs(anchor)
  const inWindow = (t: string) => {
    const v = campaignMs(t)
    return v >= lo && v <= hi
  }
  return {
    concerns: concerns.filter((c) => inWindow(c.created_at)),
    // A cluster stays if any part of its life overlaps the window.
    clusters: clusters.filter((g) => campaignMs(g.first_at) <= hi && campaignMs(g.last_at) >= lo),
    since,
    anchor,
    total: concerns.length,
  }
}

/** `windowReports` anchored on the demo's now, reactively. */
export function useWindowedReports(
  concerns: Concern[] | undefined,
  clusters: ConcernCluster[] | undefined,
  days: ReportWindowDays,
): WindowedReports {
  const now = useNowCampaign()
  return useMemo(
    () => windowReports(concerns ?? [], clusters ?? [], days, now),
    [concerns, clusters, days, now],
  )
}
