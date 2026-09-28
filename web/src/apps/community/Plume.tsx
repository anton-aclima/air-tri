/**
 * community — which way the wind blows.
 *
 * **Climatology is the front door.** A resident opens the map and reads one
 * calm sentence per place: over the last three months the wind blew from
 * Ridgeline toward your streets about one hour in three, from Riverport
 * hardly ever. The map beside it carries one small wind rose for the same
 * three months. The cloud is one tap behind it, and the hour a group of
 * neighbours reported is one more.
 *
 * Why that order, and not the cloud first:
 *
 *  - **Usually is stable.** Open the map at 8am and at 6pm and it says the
 *    same thing. A cloud changes hourly, so a resident who checks twice gets
 *    two stories and believes neither.
 *  - **Usually is reach-independent.** It asks only whether the wind pointed
 *    here, never whether a plume arrived. The dispersion kernel's reach moved
 *    by a factor of five in one sprint; this number did not move at all.
 *  - **Usually is tied to no company on the map.** Its rose sits in a corner
 *    beside the scale, not at a site, so the default view never points a
 *    shape from a named place at a named neighbourhood (PLAN-refocus D3).
 *
 * **The card describes only what is drawn.** Each cloud mode has three states:
 * nothing yet (title and lead), nothing to draw (one sentence saying so), and
 * a cloud on the map (the lead and the one caveat line). It used to carry a
 * "we measured N streets under this shape" count, which counted the 90-day
 * street grid under the model's far band; that went, and nothing replaced it.
 *
 * Every sentence here comes from `PLUME_COPY`. Nothing in this file writes
 * prose, and no number in it is hardcoded.
 */

import { useMemo } from 'react'

import s from '@/apps/community/community.module.css'
import { PLUME_COPY, useMyNeighborhood } from '@/apps/community/lib'
import { FootNote } from '@/apps/community/parts'
import { Segmented } from '@/app/ui'
import type { CampaignTime } from '@/core/clock'
import { fmtDateTime, relativeWords } from '@/core/format'
import { useClimatology } from '@/core/queries'
import type { ConcernCluster, IndustrySite } from '@/core/types'

export type PlumeMode = 'usually' | 'now' | 'when'

/**
 * What the map is drawing in a cloud mode, as the card needs to say it.
 * `hour` is the hour the drawn cloud was worked out for — read from the
 * payload, not the clock, so while the next hour loads the title still names
 * the cloud on screen.
 */
export type CloudState =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'drawn'; hour: CampaignTime }

/**
 * The most recent group of reports — the hour the `when` mode freezes on.
 *
 * Exported because `MapScreen` needs the SAME cluster to pin the plume fetch
 * to. It used to live only in here, so the card said "where the air was going
 * when your neighbours reported" while the map drew the plume for another
 * hour. The label asserted something the map was not showing, which is the
 * one kind of bug this interface cannot afford.
 */
export function latestClusterOf(clusters: ConcernCluster[]): ConcernCluster | null {
  return [...clusters].sort((a, b) => (a.last_at < b.last_at ? 1 : -1))[0] ?? null
}

export interface PlumeProps {
  sites: IndustrySite[]
  clusters: ConcernCluster[]
  mode: PlumeMode
  onMode: (m: PlumeMode) => void
  /** What the cloud modes have on the map. Ignored in `usually`. */
  cloud: CloudState
  /** The demo's now — every age on the card is measured from it. */
  now: CampaignTime
}

/**
 * Short labels on purpose. The rail is 322 px and the control splits it three
 * ways, so "When neighbours reported" rendered as two clipped lines inside a
 * 26 px button. The full sentence lives in the card title and lead, which is
 * where it reads better anyway — a tab is a signpost, not a sentence.
 */
const MODES = [
  { value: 'usually' as const, label: 'Usually', title: PLUME_COPY.usually.title },
  { value: 'now' as const, label: 'Now', title: PLUME_COPY.now.title(null) },
  { value: 'when' as const, label: 'When reported', title: PLUME_COPY.when.title },
]

export function Plume(props: PlumeProps) {
  const { sites, clusters, mode, onMode, cloud, now } = props
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
  const drawnHour = cloud.status === 'drawn' ? fmtDateTime(cloud.hour) : null

  return (
    <section className={s.railCard}>
      <h2 className={s.railTitle}>
        {mode === 'usually' ? PLUME_COPY.usually.title
          : mode === 'now' ? PLUME_COPY.now.title(drawnHour)
            : PLUME_COPY.when.title}
      </h2>

      <Segmented value={mode} options={MODES} onValueChange={onMode} />

      {mode === 'usually' ? (
        <>
          <p className={s.railRowSub}>{PLUME_COPY.usually.lead(place)}</p>
          {climateQ.isLoading ? null
            : mine.length === 0 ? (
              <p className={s.railRowSub}>{PLUME_COPY.usually.none}</p>
            ) : (
              <>
                <div className={`${s.railList} ${s.windList}`}>
                  {mine.map(({ site, d, logo }) => (
                    // Logo BESIDE the name: stacked above it, each place took
                    // three lines and the logo read as a row of its own.
                    <div key={site.site_id} className={s.windRow}>
                      <span className={s.windRowLogo} aria-hidden>{logo}</span>
                      <span>
                        <span className={s.railRowName}>{site.name}</span>
                        {/* The wind is the subject, never the company. */}
                        <span className={s.railRowSub}>
                          {PLUME_COPY.usually.fromHere(place)}{' '}
                          <strong>{PLUME_COPY.usually.often(d.share)}</strong>
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                {/*
                  NOT behind a tap. The front door's caveat is part of the front
                  door: a resident who reads the shares and leaves has still
                  read it.
                */}
                <p className={s.cloudCaveat}>{PLUME_COPY.usually.caveat}</p>
                {climateQ.data ? (
                  <FootNote>{PLUME_COPY.usually.source(climateQ.data.n_hours)}</FootNote>
                ) : null}
              </>
            )}
        </>
      ) : mode === 'when' && !latestCluster ? (
        <p className={s.railRowSub}>{PLUME_COPY.when.noCluster}</p>
      ) : cloud.status === 'none' ? (
        // One sentence, and not the lead: the lead promises a picture, and
        // with nothing on the map that promise is the thing to withdraw.
        <p className={s.railRowSub}>{PLUME_COPY.now.none}</p>
      ) : (
        <>
          <p className={s.railRowSub}>
            {mode === 'now'
              ? PLUME_COPY.now.lead
              : PLUME_COPY.when.lead(relativeWords(latestCluster?.last_at ?? now, now))}
          </p>
          {/*
            With the cloud, never before it. Always shown while a cloud is on
            the map — including the previous hour's, which stays drawn while the
            next one loads — and never dismissible.
          */}
          {cloud.status === 'drawn' ? (
            <p className={s.cloudCaveat}>{PLUME_COPY.cloudCaveat}</p>
          ) : null}
        </>
      )}
    </section>
  )
}
