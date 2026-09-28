/**
 * /industry/community — what the neighbours are saying.
 *
 * The operator's fenceline and their consultant's model already tell them about
 * their *emissions*. That is the part of this product they did not need. What
 * they cannot see coming — and what actually decides whether a campus gets to
 * expand — is **backlash**: residents filing, reports clustering, and a
 * regulator starting to treat the pile as a case.
 *
 * So this screen is the inbound half of the outreach loop, and `Outreach` is
 * the outbound half. Here they read; there they answer. The one thing they can
 * never do, from either screen, is close a report.
 *
 * Everything is measured from *their* site: direction and distance. A report
 * is tagged "downwind then" only under the one linking rule every room uses
 * (F7): the wind at the time carried from this site to it, AND the site's
 * measured downwind test passed its rotation check — and only for the kinds an
 * air test can speak to (smell, smoke, dust, health; never noise, vibration or
 * light). It used to be tagged
 * "downwind of you" or "off your axis" by TODAY's wind, for reports up to three
 * weeks old — a statement about this afternoon's weather printed as if it were
 * about the report.
 */

import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { Sparkline } from '@/components'
import { Button } from '@/app/ui'
import { campaignMs } from '@/core/clock'
import { happenedBy } from '@/core/events'
import { compassPoint, fmtDistance, fmtNum, relativeShort, relativeTime } from '@/core/format'
import { useConcernClusters, useConcerns, useDispersion, useTouchdown } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type { Concern } from '@/core/types'

import {
  Caps, Panel, Readout, Tag, bearingFrom, clusterLinked, placeReports, plumeFacts, reportLinked,
  styles as s, useSiteLock,
} from './lib'

const DAYS = 21

export function Community() {
  const site = useSiteLock()
  const now = useNowCampaign()
  // Reports filed by the moment shown (D2). The server already cuts at `at`;
  // the second cut is for the frames in between — a clock-keyed query keeps
  // the previous moment's list on screen while the next loads, and scrubbing
  // back, that list is the future.
  const allConcerns = useConcerns({ limit: 400 }).data
  const concerns = useMemo(() => happenedBy(allConcerns, now), [allConcerns, now])
  // Cut at `at` by the server, which also rebuilds a cluster still forming
  // then from the reports it had so far.
  const clustersData = useConcernClusters().data
  const clusters = useMemo(() => clustersData ?? [], [clustersData])
  // F7's (b): the site's measured downwind test, for its plume's species.
  const facts = plumeFacts(useDispersion({ site_id: site?.id }).data)
  const tdState = useTouchdown(site?.id, { measure: facts?.measure ?? 'no2' }).data?.site.state
  const [picked, setPicked] = useState<string | null>(null)

  /** Every report placed relative to this campus, nearest first. */
  const near = useMemo(
    () => (site ? placeReports(site.centroid, concerns, (c) => reportLinked(c, site.id, tdState)) : []),
    [concerns, site, tdState],
  )

  /**
   * Reports per day for three weeks.
   *
   * The count is not the point — the *slope* is. A steady trickle is life near
   * an industrial river; a rising line two weeks before a permit hearing is the
   * thing worth acting on while it is still cheap.
   */
  const trend = useMemo(() => {
    const buckets = new Array<number>(DAYS).fill(0)
    const end = campaignMs(now)
    for (const { concern: c } of near) {
      const age = (end - campaignMs(c.created_at)) / 86_400_000
      if (age >= 0 && age < DAYS) buckets[DAYS - 1 - Math.floor(age)] += 1
    }
    return buckets
  }, [near, now])

  const recentWeek = trend.slice(-7).reduce((a, b) => a + b, 0)
  const priorWeek = trend.slice(-14, -7).reduce((a, b) => a + b, 0)
  const rising = recentWeek > priorWeek

  /** Clusters within reach, nearest first. */
  const nearClusters = useMemo(() => {
    if (!site) return []
    return clusters
      .map((cl) => ({ cl, ...bearingFrom(site.centroid, cl.centroid[0], cl.centroid[1]) }))
      .filter((r) => r.distanceM <= 6000)
      .sort((a, b) => a.distanceM - b.distanceM)
  }, [clusters, site])

  const chosen: Concern | null = picked ? near.find((r) => r.concern.id === picked)?.concern ?? null : null
  const chosenGeo = picked ? near.find((r) => r.concern.id === picked) ?? null : null

  if (!site) {
    return <div className={`${s.page}`}><div className={s.err}>No site for this persona.</div></div>
  }

  return (
    <div className={s.page}>
      <div className={`${s.banner} ${rising ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.bannerLine}>
          <span className={s.bannerHead}>
            {near.length} report{near.length === 1 ? '' : 's'} within 6 km of this campus
          </span>
          <span className={s.bannerSub}>
            {rising
              ? `Rising — ${recentWeek} in the last seven days against ${priorWeek} the week before.`
              : `Steady — ${recentWeek} in the last seven days against ${priorWeek} the week before.`}
            {' '}Your fenceline and your model already describe your emissions. This is the part
            they do not measure.
          </span>
        </div>
        <div className={s.bannerStats}>
          <Readout label="Last 7 days" value={fmtNum(recentWeek, 0)} big tone={rising ? 'threat' : 'accent'} />
          <Readout label="Clusters near you" value={fmtNum(nearClusters.length, 0)} />
          <Readout label="Nearest" value={near[0] ? fmtDistance(near[0].distanceM, 1) : '—'} />
        </div>
      </div>

      <div className={s.twoPane}>
        <Panel title="Reports near this campus" aside={<Caps>nearest first</Caps>}>
          <div className={s.trendWrap}>
            <Caps>Reports per day · {DAYS} days</Caps>
            <Sparkline
              points={trend}
              width={520}
              height={44}
              showEndDot
              ariaLabel={`${near.length} reports over ${DAYS} days`}
            />
          </div>
          <div className={s.rows}>
            {near.length === 0 ? (
              <span className={s.reportNote}>No resident reports within 6 km.</span>
            ) : near.slice(0, 40).map(({ concern: c, distanceM, bearing, linked }) => {
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`${s.reportRow}${picked === c.id ? ` ${s.reportRowOn}` : ''}`}
                  onClick={() => setPicked(c.id === picked ? null : c.id)}
                >
                  <span className={s.reportGlyph}>{c.photo_emoji ?? '•'}</span>
                  <span className={s.reportBody}>
                    <span className={s.reportTitle}>{c.title}</span>
                    <span className={s.reportSub}>
                      {c.district ?? 'unknown'} · {fmtDistance(distanceM, 1)} {compassPoint(bearing)}
                      {' · '}{relativeShort(c.created_at, now)}
                    </span>
                  </span>
                  {/* Only when both F7 tests agree. No tag is the honest
                      default: most reports cannot be tied to any one site. */}
                  {linked ? <LinkedTag /> : null}
                </button>
              )
            })}
          </div>
        </Panel>

        <div className={s.stack}>
          <Panel title="Clusters" aside={<Caps>3+ within 600 m in a day</Caps>}>
            <div className={s.rows}>
              {nearClusters.length === 0 ? (
                <span className={s.reportNote}>No clusters have formed near this campus.</span>
              ) : nearClusters.map(({ cl, distanceM, bearing }) => (
                <div key={cl.id} className={s.reportRow}>
                  <span className={s.reportCount}>{cl.count}</span>
                  <span className={s.reportBody}>
                    <span className={s.reportTitle}>{cl.label ?? 'Cluster'}</span>
                    {/* A compass point, not "NNW 338°": the degrees were
                        instrument talk, and they pushed the age onto two
                        lines in the 324 px column at 1080. The age is
                        `relativeTime` ("latest 1 d ago"), not "last" glued to
                        a bare `relativeShort`, and it does not wrap. */}
                    <span className={s.reportSub}>
                      {fmtDistance(distanceM, 1)} {compassPoint(bearing)} ·{' '}
                      <span style={{ whiteSpace: 'nowrap' }}>latest {relativeTime(cl.last_at, now)}</span>
                    </span>
                  </span>
                  {clusterLinked(cl, concerns, site.id, tdState) ? <LinkedTag /> : null}
                </div>
              ))}
            </div>
          </Panel>

          {chosen ? (
            <Panel title="Report">
              <div className={s.reportDetail}>
                <span className={s.reportTitle}>{chosen.title}</span>
                <span className={s.reportSub}>
                  {chosen.kind} · severity {chosen.severity}/5
                  {chosenGeo ? ` · ${fmtDistance(chosenGeo.distanceM, 1)} ${compassPoint(chosenGeo.bearing)}` : ''}
                  {chosen.corroborations ? ` · ${chosen.corroborations} neighbours agreed` : ''}
                </span>
                {chosen.body ? <p className={s.reportQuote}>“{chosen.body}”</p> : null}
                <div className={s.reportActions}>
                  <Link to="/industry/outreach">
                    <Button size="sm" variant="secondary">Answer in outreach</Button>
                  </Link>
                </div>
                <span className={s.reportNote}>
                  A reply moves this to “mitigation proposed”. It does not close the report —
                  only the air agency or Aclima can do that.
                </span>
              </div>
            </Panel>
          ) : (
            <Panel title="Report">
              <span className={s.reportNote}>Pick a report to read it in the resident's words.</span>
            </Panel>
          )}
        </div>
      </div>
    </div>
  )
}

/** The F7 link, said as the wind at the time plus the test, never as "yours". */
function LinkedTag() {
  return (
    <Tag
      tone="accent"
      title="The wind at the time carried from your campus to here, and your measured downwind test passed its rotation check."
    >
      downwind then
    </Tag>
  )
}
