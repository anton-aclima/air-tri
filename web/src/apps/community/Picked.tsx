/**
 * community — what you just tapped.
 *
 * The map had three kinds of thing on it and no way to ask any of them a
 * question. Clicking a pin moved a highlight into a list that was usually
 * scrolled somewhere else, roads were not clickable at all, and the pin colours
 * — which carry the most important fact on the screen, whether anybody has
 * answered — were explained nowhere.
 *
 * So: one selection, one card, three branches. A discriminated union on `kind`,
 * the same shape the industry scope settled on, because the lesson there
 * applies here too — the map is one surface, a tap on it means one thing ("tell
 * me about that"), and adding a pickable layer should mean adding a branch here
 * rather than another piece of state in the screen.
 *
 * Community language rules apply throughout: no units, no acronyms, no
 * chemistry. A street has a score out of 100 and a plain-word band; it does not
 * have a p90.
 */

import { Link } from '@tanstack/react-router'

import { Button } from '@/app/ui'
import type { SegmentFeature } from '@/components'
import { relativeTime } from '@/core/format'
import { bearingBetween, compassWords, distanceBetween, fmtDistanceImperial } from '@/core/format'
import type { Concern, ConcernCluster, IndustrySite } from '@/core/types'

import s from './community.module.css'
import { RiskPill } from './parts'
import {
  KIND_WORD, PLUME_COPY, distanceFromHome, kindEmoji, kindLabel, nearWords, severityWord,
  statusPlain,
} from './lib'
import type { Position } from '@/core/types'

export type MapPick =
  /** A neighbour's report. */
  | { kind: 'concern'; id: string }
  /** Three or more reports that landed within a few blocks of each other. */
  | { kind: 'cluster'; id: string }
  /** ~200 m of road our cars have driven. Called a street, never a segment. */
  | { kind: 'street'; id: string }
  /** An industrial site. Shown, never accused — see the branch. */
  | { kind: 'site'; id: string }

export interface PickedProps {
  pick: MapPick | null
  onClear: () => void
  now: Date
  home: Position
  concerns: Concern[]
  clusters: ConcernCluster[]
  segments: SegmentFeature[]
  sites: IndustrySite[]
  /** Plain name of the measure the map is currently painting. */
  measureName: string
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={s.pickRow}>
      <span className={s.pickKey}>{label}</span>
      <span className={s.pickVal}>{value}</span>
    </div>
  )
}

/**
 * How often, in words. `persistence` is the share of drive-bys on which the
 * street was above its reference level — a genuinely useful idea, and one that
 * dies the moment you print it as "0.42".
 */
function oftenWords(persistence: number | null | undefined): string {
  if (persistence == null || !Number.isFinite(persistence)) return 'not enough visits yet'
  const pct = persistence * 100
  if (pct < 10) return 'almost never — nearly every visit was clean'
  if (pct < 30) return 'now and then'
  if (pct < 60) return 'about half the visits'
  if (pct < 85) return 'most visits'
  return 'nearly every visit'
}

export function Picked(props: PickedProps) {
  const { pick, onClear, now, home, concerns, clusters, segments, sites, measureName } = props
  if (!pick) return null

  let body: React.ReactNode = null
  let heading = 'On the map'

  if (pick.kind === 'concern') {
    const c = concerns.find((x) => x.id === pick.id)
    heading = 'A neighbour’s report'
    body = !c ? (
      <p className={s.pickNote}>That report is not in view any more.</p>
    ) : (
      <>
        <div className={s.pickHead}>
          <span className={s.pickEmoji} aria-hidden>{c.photo_emoji ?? kindEmoji(c.kind)}</span>
          <span>
            <span className={s.pickTitle}>{c.title}</span>
            <span className={s.pickSub}>
              {[kindLabel(c.kind), severityWord(c.severity)].join(' · ')}
            </span>
          </span>
        </div>

        {/* The resident's own words, when they left any. This is the whole
            reason a report is worth more than a number. */}
        {c.body ? <p className={s.pickQuote}>“{c.body}”</p> : null}

        <Row label="When" value={relativeTime(c.occurred_at, now)} />
        <Row label="Where" value={c.address_hint ?? c.district ?? 'nearby'} />
        <Row label="From you" value={nearWords(distanceFromHome(c, home))} />
        <Row
          label="Who has it"
          value={
            <>
              <span
                className={s.pickDot}
                style={{ background: `var(--${statusDot(c.status)})` }}
                aria-hidden
              />
              {statusPlain(c.status).label}
            </>
          }
        />
        {c.corroborations > 0 ? (
          <Row
            label="Also reported by"
            value={`${c.corroborations} ${c.corroborations === 1 ? 'neighbour' : 'neighbours'}`}
          />
        ) : null}

        {/*
          WHERE THE AIR CAME FROM, or an admission that we do not know.

          137 of 204 reports have no site attached, and the honest branch is
          the one that matters more: an app willing to say "we could not
          connect this to anywhere on the map" is one you believe when it says
          the opposite. Both sentences live in `PLUME_COPY` so the never-say
          list is reviewable in one screen — see the rules there. The named
          branch is careful to say the wind came from somewhere, never that
          somewhere did something.
        */}
        <p className={s.pickNote}>
          {c.suspected_site_id
            ? PLUME_COPY.concern.attributed(
                sites.find((x) => x.id === c.suspected_site_id)?.name ?? 'a place on the map',
              )
            : PLUME_COPY.concern.unattributed}
        </p>

        <p className={s.pickNote}>{statusPlain(c.status).hint}.</p>

        <div className={s.pickActions}>
          <Link to={`/community/c/${c.id}`}>
            <Button size="sm" variant="secondary">Open the thread</Button>
          </Link>
        </div>
      </>
    )
  } else if (pick.kind === 'cluster') {
    const cl = clusters.find((x) => x.id === pick.id)
    const members = cl ? concerns.filter((c) => c.cluster_id === cl.id) : []
    heading = 'A group of reports'
    body = !cl ? (
      <p className={s.pickNote}>That group is not in view any more.</p>
    ) : (
      <>
        <div className={s.pickHead}>
          <span className={s.pickEmoji} aria-hidden>📍</span>
          <span>
            <span className={s.pickTitle}>{cl.label ?? 'Nearby reports'}</span>
            <span className={s.pickSub}>
              {cl.count} {cl.count === 1 ? 'report' : 'reports'} ·{' '}
              {cl.kinds.map(kindLabel).join(', ').toLowerCase()}
            </span>
          </span>
        </div>

        <Row label="Newest" value={relativeTime(cl.last_at, now)} />
        <Row label="First one" value={relativeTime(cl.first_at, now)} />
        <Row label="From you" value={nearWords(distanceFromHome({ lon: cl.centroid[0], lat: cl.centroid[1] }, home))} />

        {/* The individual reports inside it, so the group is not a black box. */}
        {members.length ? (
          <div className={s.pickList}>
            {members.slice(0, 5).map((c) => (
              <Link key={c.id} to={`/community/c/${c.id}`} className={s.pickListRow}>
                <span aria-hidden>{c.photo_emoji ?? kindEmoji(c.kind)}</span>
                <span className={s.pickListTitle}>{c.title}</span>
                <span className={s.pickListWhen}>{relativeTime(c.occurred_at, now)}</span>
              </Link>
            ))}
            {members.length > 5 ? (
              <span className={s.pickNote}>…and {members.length - 5} more.</span>
            ) : null}
          </div>
        ) : null}

        <p className={s.pickNote}>
          Three or more reports within a few blocks on the same day become a group. Groups go into
          the air agency’s queue and show up on the operator’s own screen — one report is easy to
          set aside, a group is not.
        </p>
      </>
    )
  } else if (pick.kind === 'site') {
    const site = sites.find((x) => x.id === pick.id)
    heading = 'A place that reports its emissions'
    body = !site ? (
      <p className={s.pickNote}>That place is not in view any more.</p>
    ) : (
      <>
        <div className={s.pickHead}>
          <span className={s.pickEmoji} aria-hidden>{site.logo_emoji ?? '🏭'}</span>
          <span>
            <span className={s.pickTitle}>{site.name}</span>
            <span className={s.pickSub}>{KIND_WORD[site.kind]}</span>
          </span>
        </div>

        <Row
          label="From you"
          value={`${fmtDistanceImperial(distanceBetween(home, site.centroid))} to the ${compassWords(
            bearingBetween(home, site.centroid),
          )}`}
        />
        {site.operating_since ? (
          <Row label="Operating since" value={site.operating_since.slice(0, 4)} />
        ) : null}

        {site.blurb ? (
          <>
            <div className={s.railSubLabel}>How the company describes itself</div>
            <p className={s.pickQuote}>“{site.blurb}”</p>
          </>
        ) : null}

        {/*
          THE IMPORTANT PARAGRAPH ON THIS SCREEN.

          A named company pin sitting beside a red street reads as an accusation,
          and the rest of this product is careful not to make one it cannot
          support — a report is only ever attributed to a site when the wind
          actually carried from it, and an operator can never close a neighbour's
          report. Putting places on the map without saying this would quietly
          undo that discipline. Being near something is not evidence it did
          anything.
        */}
        <p className={s.pickNote}>
          This is where the place is — not a finding about it. Air moves with the wind, so what
          you smell may come from somewhere else entirely, and a place being close by is not
          evidence it caused anything. If you think it did, the useful thing is to report what
          you noticed and when: that is what lets the agency line reports up against the wind.
        </p>

        <div className={s.pickActions}>
          <Link to="/community/outreach">
            <Button size="sm" variant="secondary">Who runs it, and what they have said</Button>
          </Link>
        </div>
      </>
    )
  } else {
    const f = segments.find((x) => x.properties.id === pick.id)
    const p = f?.properties
    heading = 'A street we drove'
    body = !p ? (
      <p className={s.pickNote}>That street is not in view any more.</p>
    ) : (
      <>
        <div className={s.pickHead}>
          <span className={s.pickEmoji} aria-hidden>🛣️</span>
          <span>
            <span className={s.pickTitle}>{p.name || 'Unnamed street'}</span>
            <span className={s.pickSub}>{p.district ?? 'your area'}</span>
          </span>
        </div>

        <div className={s.pickScore}>
          <RiskPill risk={p.value} />
          <span className={s.pickScoreCaption}>out of 100, for {measureName}</span>
        </div>

        <Row label="Bad air here" value={oftenWords(p.persistence)} />
        {/* The first question a resident has about a street is whether it is
            theirs. The geometry is a polyline; its first vertex is close enough
            for "a few blocks away". */}
        {f?.geometry?.coordinates?.[0] ? (
          <Row
            label="From you"
            value={nearWords(distanceFromHome(
              { lon: f.geometry.coordinates[0][0], lat: f.geometry.coordinates[0][1] },
              home,
            ))}
          />
        ) : null}
        <Row
          label="Times we drove it"
          value={p.n_passes == null ? '—' : `${p.n_passes}`}
        />

        {/* The honest provenance, which is also the product's whole argument. */}
        <p className={s.pickNote}>
          There is no permanent sensor on this street. This score exists because our cars drove it{' '}
          {p.n_passes ?? 'several'} times and measured the air each time.
        </p>
      </>
    )
  }

  return (
    <section className={`${s.railCard} ${s.pickCard}`} aria-live="polite">
      <div className={s.pickBar}>
        <h2 className={s.railTitle}>{heading}</h2>
        <Button size="sm" variant="quiet" onClick={onClear} aria-label="Close">
          Close
        </Button>
      </div>
      {body}
    </section>
  )
}

/**
 * The token behind a report's pin colour. Deliberately duplicated from
 * `ConcernLayer.concernStatusToken` in words rather than imported: the map
 * layer is drawing with deck.gl `theme.color()` and this is a CSS variable in a
 * DOM node. Keeping them in step matters — see the pin key on the map screen.
 */
function statusDot(status: string): string {
  switch (status) {
    case 'mitigation_proposed': return 'actor-industry'
    case 'under_review': return 'actor-regulator'
    case 'resolved':
    case 'closed': return 'sev-ok'
    default: return 'actor-community'
  }
}
