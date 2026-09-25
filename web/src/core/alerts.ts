/**
 * air — the alerts live at the moment on screen. ONE hook, every surface.
 *
 * docs/PLAN-refocus.md F3: one industry screen showed four alert counts at
 * once — rail badge 9, header strip 4, deck banner 3, Alerts page 5 — because
 * each surface ran its own query with its own filter (network-wide vs one
 * site, `status: 'active'` vs active-or-acknowledged, folded vs raw). The
 * regulator showed 13 next to 15 the same way. The cure is not better
 * filters, it is one: the nav badge, the page status and the alert pages all
 * read `useLiveAlerts(role)`, and a number printed anywhere is its `count`.
 *
 * What "live" means, in the order the tests apply:
 *
 *   1. It had begun and had not ended at the demo's now — `isOngoing`
 *      (core/events), the Phase 2 definition. NOT `status`: that is the row's
 *      final status, and several "active" alerts ended days before the end of
 *      the data, while an acknowledged one that is still running is still up
 *      (acknowledging is not ending). So this counts active AND acknowledged
 *      alerts, and ended ones never, whatever their status says.
 *   2. The room's own alerts. Industry's are ONE site's: the site the
 *      industry pages lock (`siteId`, written by `useSiteLock`), sent as
 *      `site_id` so the server adds each alert's bearing and distance from
 *      it (it applies no radius unless asked; rule 4 applies the deck's).
 *      Not `useActiveSite`'s fallback, which lands on another
 *      company's site until the lock is written; until then the hook waits
 *      rather than count someone else's. Every other room gets what the server
 *      sends its role.
 *   3. One row per problem. When one source trips two levels of the same
 *      pollutant in the same hours (Riverport Road's NO2 watch AND its
 *      1-hour standard, Aug 24 06:00–07:00), that is one exceedance, and the
 *      highest level tripped wins — the rule R6 sets for the regulator's
 *      episodes and the deck already applied (`foldContacts`). Without it the
 *      badge said 2 over a deck row saying 1. `folded` says how many rows it
 *      absorbed, and `all` keeps them for a detail view that needs both.
 *   4. Industry counts places, not models (decided 2026-09-23, phase 3
 *      review). The count has to equal the rows the deck and the Alerts page
 *      mark as ongoing, and the deck lists what is happening somewhere around
 *      the site. The wind-shift alert ("Measured wind disagrees with the
 *      dispersion study", `source_type: 'model'`) is about the filed study as
 *      a whole: it has no place (the server puts it at the centroid, 0 m),
 *      the deck leaves it out (PLAN-refocus I4), and its verdict lives on
 *      /industry/site (D9: "verify your consultant" is supporting, not the
 *      headline). Counting it put "1 ongoing" and a rail badge of 1 over a
 *      deck saying nothing began downwind (Ridgeline, Aug 27 02:54). So for
 *      industry a model alert, or one with no bearing from the site, is a
 *      NOTICE — returned in `notices`, never in `count` — and one past the
 *      deck's reach (`INDUSTRY_NEAR_M`) is not the room's. The regulator and
 *      admin rooms count everything else the server sends them: the
 *      regulator's Alerts page lists the study alert as a row.
 *   5. `info` is not an alert now, in any room (phase 5 follow-up). The
 *      level exists for operational news — the one in the data
 *      is the fleet_anomaly "Redwing out of service" (al-fleet-00, Aug 27
 *      16:33, no end) — which is true and worth a line, but nothing on the
 *      network is over anything because of it. Counted, it was one of the
 *      regulator's "ongoing" at the end of the data (measured in phase 5:
 *      the 4th of 6), beside real exceedances. So an ongoing info alert goes
 *      to `notices`, never to `alerts`, `all`, `count`, `bySeverity` or
 *      `worst`; `bySeverity.info` is therefore always 0.
 *
 * Mobile detections stay ongoing with no `ended_at`, and that is deliberate:
 * a fleet detection is a standing finding — a car measured an excess on a
 * street and nothing has measured that street clean since — not an episode
 * with a clock on it. It stops being ongoing when the data gives it an end;
 * this hook never invents one. They remain in the count (in phase 5, 3 of the
 * regulator's ongoing at the end of the data).
 *
 * Severity has one vocabulary in every room — Critical / Warning / Watch
 * (`SEVERITY_LABEL`, CONTRACT §10a.7) — so `bySeverity` is keyed by the
 * data's own levels and a surface never translates them into a second set
 * (the CAUTION / ADVISORY / NORMAL ladder that sat beside the page's words).
 */

import { useMemo } from 'react'

import { isOngoing } from '@/core/events'
import { campaignMs } from '@/core/clock'
import { SEVERITY_ORDER, severityRank } from '@/core/measures'
import { useAlerts } from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type { Alert, Role, Severity } from '@/core/types'

export interface LiveAlerts {
  /** One per live problem at the moment shown, worst first, then newest. */
  alerts: Alert[]
  /**
   * Live but not counted, for a surface that mentions them in one line:
   * every room's `info` alerts (rule 5 — the fleet's "Redwing out of
   * service"), and industry's site-wide model alerts (rule 4 — the wind-shift
   * study alert). Worst first, then newest.
   */
  notices: Alert[]
  /** `alerts.length`. THE number: every count on screen is this one. */
  count: number
  /**
   * `alerts` by severity. Every level is present, zero included — `info`
   * too, and it is always 0 (rule 5).
   */
  bySeverity: Record<Severity, number>
  /** The highest level among `alerts`, or null when nothing is live. */
  worst: Severity | null
  /** Every ongoing alert before the fold — for a detail that lists both levels. */
  all: Alert[]
  /** Rows the fold absorbed: `all.length - count`. */
  folded: number
  /** Nothing to count yet: no site locked (industry) or the list is loading. */
  loading: boolean
  /**
   * The list could not be read. `count` is then 0 by default, not by
   * measurement: a surface that prints the number prints a dash instead.
   */
  error: boolean
}

const EMPTY: readonly Alert[] = []

/**
 * How far from the site an industry alert is still the room's: the deck's
 * reach ("Elsewhere within 7 km"). The server's industry list has no radius
 * unless asked, so the count applies the deck's. Import this rather than
 * restating 7000 — the count and the list must agree.
 */
export const INDUSTRY_NEAR_M = 7000

/**
 * An industry alert that is about a model rather than a place — the study's
 * wind-shift alert — or has no bearing from the site. Rule 4: live, shown as
 * a notice if at all, never counted.
 */
export function isSiteWideNotice(a: Alert): boolean {
  return a.source_type === 'model' || a.distance_m == null || a.bearing_deg == null
}

/**
 * Operational news rather than a level exceeded — rule 5. Live, shown as a
 * notice if at all, never counted, in every room.
 */
export function isInformational(a: Alert): boolean {
  return a.severity === 'info'
}

function emptyBySeverity(): Record<Severity, number> {
  return { critical: 0, warning: 0, watch: 0, info: 0 }
}

/**
 * The fold, on its own so a page can apply it to a list it already holds.
 * Keyed by source and pollutant (the kind when there is no pollutant); an
 * alert with no source keys on itself and is never merged. A tie keeps the
 * one that began first — it is the one that has been running.
 */
export function foldConcurrent(alerts: readonly Alert[]): Alert[] {
  const byKey = new Map<string, Alert>()
  for (const a of alerts) {
    const key = `${a.source_type}|${a.source_id ?? a.id}|${a.measure ?? a.kind}`
    const prev = byKey.get(key)
    if (
      !prev
      || severityRank(a.severity) > severityRank(prev.severity)
      || (a.severity === prev.severity && campaignMs(a.started_at) < campaignMs(prev.started_at))
    ) {
      byKey.set(key, a)
    }
  }
  return [...byKey.values()].sort(
    (x, y) =>
      severityRank(y.severity) - severityRank(x.severity)
      || campaignMs(y.started_at) - campaignMs(x.started_at),
  )
}

/**
 * The live alerts for `role` at the moment on screen. Pass the room you are
 * drawing — the shell passes the URL's role, a page passes its own — so the
 * answer never depends on which persona the session last held.
 */
export function useLiveAlerts(role: Role | null): LiveAlerts {
  const siteId = useSession((st) => st.siteId)
  const now = useNowCampaign()
  const industry = role === 'industry'
  const waiting = industry && siteId == null
  // Keys only when set: `useAlerts` spreads the params over its role default,
  // so `{ role: undefined }` would erase it rather than leave it alone.
  const q = useAlerts(
    { ...(role ? { role } : {}), ...(industry && siteId ? { site_id: siteId } : {}) },
    { enabled: role != null && !waiting },
  )
  const data = q.data ?? EMPTY

  return useMemo(() => {
    const ongoing = data.filter((a) => isOngoing(a, now))
    const notice = (a: Alert) => isInformational(a) || (industry && isSiteWideNotice(a))
    const notices = ongoing.filter(notice).sort(
      (x, y) =>
        severityRank(y.severity) - severityRank(x.severity)
        || campaignMs(y.started_at) - campaignMs(x.started_at),
    )
    const counted = ongoing.filter((a) => !notice(a))
    const all = industry
      ? counted.filter((a) => (a.distance_m ?? 0) <= INDUSTRY_NEAR_M)
      : counted
    const alerts = foldConcurrent(all)
    const bySeverity = emptyBySeverity()
    for (const a of alerts) bySeverity[a.severity] += 1
    const worst = [...SEVERITY_ORDER].reverse().find((sev) => bySeverity[sev] > 0) ?? null
    return {
      alerts,
      notices,
      count: alerts.length,
      bySeverity,
      worst,
      all,
      folded: all.length - alerts.length,
      loading: waiting || q.isPending,
      error: q.isError,
    }
  }, [data, now, industry, waiting, q.isPending, q.isError])
}
