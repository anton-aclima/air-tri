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
 * says "0 reports from neighbours this week". So the window ends at the demo
 * cursor when one is set, and at the newest report otherwise.
 */

import type { Concern, ConcernCluster } from '@/core/types'

export const REPORT_WINDOW_DAYS = 14

/** Null means every report — the "All 90 days" choice. */
export type ReportWindowDays = number | null

export interface WindowedReports {
  concerns: Concern[]
  clusters: ConcernCluster[]
  /** ISO start of the window, or null for all. */
  since: string | null
  /** ISO end of the window: the cursor, or the newest report. */
  anchor: string | null
  /** Before windowing, so a toggle can say what it would show. */
  total: number
}

/** The window's end: the cursor if pinned, else the newest report. */
export function reportAnchor(concerns: Concern[], cursor: string | null | undefined): string | null {
  if (cursor) return cursor
  let best: string | null = null
  for (const c of concerns) if (!best || c.created_at > best) best = c.created_at
  return best
}

export function windowReports(
  concerns: Concern[],
  clusters: ConcernCluster[],
  days: ReportWindowDays,
  cursor?: string | null,
): WindowedReports {
  const anchor = reportAnchor(concerns, cursor)
  if (days == null || !anchor) {
    return { concerns, clusters, since: null, anchor, total: concerns.length }
  }
  const end = new Date(anchor).getTime()
  const since = new Date(end - days * 86_400_000).toISOString()
  const inWindow = (iso: string) => {
    const t = new Date(iso).getTime()
    return t >= end - days * 86_400_000 && t <= end
  }
  return {
    concerns: concerns.filter((c) => inWindow(c.created_at)),
    // A cluster stays if any part of its life overlaps the window.
    clusters: clusters.filter((g) => (
      new Date(g.first_at).getTime() <= end
      && new Date(g.last_at).getTime() >= end - days * 86_400_000
    )),
    since,
    anchor,
    total: concerns.length,
  }
}
