/**
 * community — which way the wind blows.
 *
 * **Climatology is the front door.** A resident opens the map and reads one
 * calm sentence per place: over the last three months the wind blew from
 * Ridgeline toward your streets about one hour in three, from Riverport
 * hardly ever. The live cloud is one tap behind it, and the hour a group of
 * neighbours reported is one more.
 *
 * Why that order, and not the cloud first:
 *
 *  - **Usually is stable.** Open the map at 8am and at 6pm and it says the
 *    same thing. A live cone changes hourly, so a resident who checks twice
 *    gets two stories and believes neither.
 *  - **Usually is reach-independent.** It asks only whether the wind pointed
 *    here, never whether a plume arrived. The dispersion kernel's reach moved
 *    by a factor of five in one sprint; this number did not move at all.
 *  - **Usually draws nothing over anyone.** The whole narrative lands without
 *    a shape crossing a named neighbourhood, which is the one place this
 *    product could put a boundary into a house listing.
 *
 * Every sentence here comes from `PLUME_COPY`. Nothing in this file writes
 * prose, and no number in it is hardcoded.
 */

import { useMemo } from 'react'

import s from '@/apps/community/community.module.css'
import { PLUME_COPY, useMyNeighborhood } from '@/apps/community/lib'
import { FootNote } from '@/apps/community/parts'
import { Segmented } from '@/app/ui'
import { relativeTime } from '@/core/format'
import { useClimatology } from '@/core/queries'
import type { ConcernCluster, IndustrySite } from '@/core/types'

export type PlumeMode = 'usually' | 'now' | 'when'

/**
 * The most recent group of reports — the hour the `when` mode freezes on.
 *
 * Exported because `MapScreen` needs the SAME cluster to pin the plume fetch
 * to. It used to live only in here, so the card said "where the air was going
 * when your neighbours reported" while the map drew the plume for right now.
 * The label asserted something the map was not showing, which is the one kind
 * of bug this interface cannot afford.
 */
export function latestClusterOf(clusters: ConcernCluster[]): ConcernCluster | null {
  return [...clusters].sort((a, b) => (a.last_at < b.last_at ? 1 : -1))[0] ?? null
}

export interface PlumeProps {
  sites: IndustrySite[]
  clusters: ConcernCluster[]
  mode: PlumeMode
  onMode: (m: PlumeMode) => void
  /** Streets measured under the live cloud this hour, or null when not asked. */
  measuredStreets: number | null
  now: Date
}

/**
 * Short labels on purpose. The rail is 322 px and the control splits it three
 * ways, so "When neighbours reported" rendered as two clipped lines inside a
 * 26 px button. The full sentence lives in the card title and lead, which is
 * where it reads better anyway — a tab is a signpost, not a sentence.
 */
const MODES = [
  { value: 'usually' as const, label: 'Usually', title: 'How the wind usually blows' },
  { value: 'now' as const, label: 'Now', title: 'Where the air is going right now' },
  { value: 'when' as const, label: 'When reported', title: 'When your neighbours reported' },
]

/**
 * How thin is too thin to state a count. Hour-window coverage runs 90 to 407
 * of 1,307 segments, so a "we measured N streets" line can be computed from a
 * handful and read as though the whole neighbourhood had been checked.
 */
const MIN_STREETS = 8

export function Plume(props: PlumeProps) {
  const { sites, clusters, mode, onMode, measuredStreets, now } = props
  const place = useMyNeighborhood()
  const climateQ = useClimatology()

  /** Every site's share for the resident's own district, worst first. */
  const mine = useMemo(() => {
    const byId = new Map(sites.map((x) => [x.id, x]))
    return (climateQ.data?.sites ?? [])
      .map((site) => {
        const d = site.districts.find((x) => x.district === place)
        return d ? { site, d, logo: byId.get(site.site_id)?.logo_emoji ?? '🏭' } : null
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => b.d.share - a.d.share)
  }, [climateQ.data, place, sites])

  const latestCluster = latestClusterOf(clusters)

  return (
    <section className={s.railCard}>
      <h2 className={s.railTitle}>
        {mode === 'usually' ? PLUME_COPY.usually.title
          : mode === 'now' ? PLUME_COPY.now.title
            : PLUME_COPY.when.title}
      </h2>

      <Segmented value={mode} options={MODES} onValueChange={onMode} />

      {mode === 'usually' ? (
        <>
          <p className={s.railRowSub}>{PLUME_COPY.usually.lead(place)}</p>
          {mine.length === 0 ? (
            <p className={s.railRowSub}>We do not have enough weather records yet to say.</p>
          ) : (
            <div className={s.railList}>
              {mine.map(({ site, d, logo }) => (
                <div key={site.site_id} className={s.railRow}>
                  <span aria-hidden>{logo}</span>
                  <span>
                    <span className={s.railRowName}>{site.name}</span>
                    {/* The wind is the subject, never the company. */}
                    <span className={s.railRowSub}>
                      the wind blew from here toward {place}{' '}
                      <strong>{PLUME_COPY.usually.often(d.share)}</strong>
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {/*
            NOT behind a tap. The front door's caveat is part of the front
            door: a resident who reads the shares and leaves has still read it.
          */}
          <p className={s.railRowSub}>{PLUME_COPY.usually.caveat}</p>
          {climateQ.data ? (
            <FootNote>{PLUME_COPY.usually.source(climateQ.data.n_hours)}</FootNote>
          ) : null}
        </>
      ) : mode === 'now' ? (
        <>
          <p className={s.railRowSub}>{PLUME_COPY.now.lead}</p>
          {/*
            Non-dismissible, and above the measured count rather than below it.
            If it can be closed, the cloud outlives it on somebody's screen.
          */}
          <ul className={s.plumeLimits}>
            {PLUME_COPY.now.notSaying.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className={s.railRowSub}>
            {measuredStreets == null || measuredStreets < MIN_STREETS
              ? PLUME_COPY.now.tooThin
              : PLUME_COPY.now.measured(measuredStreets)}
          </p>
        </>
      ) : (
        <>
          {latestCluster ? (
            <>
              <p className={s.railRowSub}>
                {PLUME_COPY.when.lead(relativeTime(latestCluster.last_at, now))}
              </p>
              <ul className={s.plumeLimits}>
                {PLUME_COPY.now.notSaying.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className={s.railRowSub}>{PLUME_COPY.when.noCluster}</p>
          )}
        </>
      )}
    </section>
  )
}
