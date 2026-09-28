/**
 * community — shared plain-language helpers.
 *
 * Everything a resident reads passes through here. Two rules:
 *   1. No acronyms, no units, no jargon. Magnitude is always a 0–100 risk score.
 *   2. Industry can never close a concern. `closedBy()` is the single place
 *      that decides who a report belongs to, and it never answers "industry".
 */

import { useMemo } from 'react'

import { CONCERN_EMOJI, CONCERN_LABEL } from '@/components'
import type { CampaignTime } from '@/core/clock'
import { hasStarted, isOngoing } from '@/core/events'
import { distanceBetween, fmtDateTime, fmtDistanceImperial } from '@/core/format'
import { keepSegmentsWhile, useConcernClusters, useSegments, useUsers } from '@/core/queries'
import { DEFAULT_VIEW, useMeasureCode, usePersona, useSession } from '@/core/session'
import type {
  Advisory, Concern, ConcernCluster, ConcernKind, ConcernStatus, FeedItem, Monitor, Position, Role,
  SegmentCollection, SiteKind, User,
} from '@/core/types'

// ───────────────────────────────────────────────────────────────── identity

/**
 * Who am I posting as. The shell's persona when one is chosen, otherwise the
 * Boxtown Air Watch founder — so a cold visit to `/community` still has a face.
 */
export function useMe(): User | null {
  const residents = useUsers('community')
  const persona = usePersona()
  if (persona && persona.role === 'community') return persona
  return residents.find((u) => u.id === 'usr-com-01') ?? residents[0] ?? null
}

/** The neighbourhood a resident's screen defaults to. */
export function useMyNeighborhood(): string {
  return useMe()?.neighborhood ?? 'Boxtown'
}

// ─────────────────────────────────────────────────────── where is that place

/**
 * Real neighbourhood centres, averaged from the road segments we actually
 * drove — geography, not invention. Falls back to the campaign centre.
 */
export function districtCenters(segments: SegmentCollection | undefined): Map<string, Position> {
  const acc = new Map<string, { lon: number; lat: number; n: number }>()
  for (const f of segments?.features ?? []) {
    const d = f.properties.district
    const p = f.geometry.coordinates[0]
    if (!d || !p) continue
    const cur = acc.get(d) ?? { lon: 0, lat: 0, n: 0 }
    cur.lon += p[0]
    cur.lat += p[1]
    cur.n += 1
    acc.set(d, cur)
  }
  const out = new Map<string, Position>()
  for (const [d, v] of acc) out.set(d, [v.lon / v.n, v.lat / v.n])
  return out
}

/**
 * The road grid, always painted by risk — community never sees a raw
 * magnitude — and measured up to the moment shown: `window=todate&at=<the
 * clock>`, so a replayed map colours a street only from the passes driven by
 * then (phase 6, P5). Paused at the end of the data no `at` is sent and
 * `todate` is the stored 'all' window exactly (tests/test_passwindow.py). The
 * body carries `window: {name, from, to, last_pass_at}`; name the grid's moment
 * from that (`gridWords`), never from the clock, so the words and the colours
 * cannot disagree while a step of the clock is loading.
 *
 * A step of the clock keeps the previous grid on screen until the next one
 * lands (same pollutant, same window); a pollutant switch reads as loading.
 */
export function useCommunitySegments() {
  const measure = useMeasureCode()
  return useSegments(
    { metric: 'risk', window: 'todate', limit: 2000 },
    { placeholderData: keepSegmentsWhile((p) => p.measure === measure && p.window === 'todate') },
  )
}

/**
 * What the grid's legend says about its window. Paused at the end of the data
 * the existing words are true ("these three months"); in replay the grid is
 * cut at the moment shown and says so, and before the first pass it says no
 * street had been driven yet rather than drawing an empty ramp.
 */
export function gridWords(
  segments: SegmentCollection | undefined,
  replaying: boolean,
): { title: string; empty: string | null } {
  const w = segments?.window
  if (!replaying || !w) return { title: 'How your street scores · these three months', empty: null }
  const title = `How your street scores · measured to ${fmtDateTime(w.to)}`
  const none = !w.last_pass_at || !segments.features.length
  return { title, empty: none ? 'Our cars had not driven these streets yet' : null }
}

/**
 * Where the neighbourhoods are: geography, not a measurement, so it must not
 * move with the clock — at the first moment of a replay the `todate` grid is
 * empty (no pass before Jun 1 17:30) and every place would fall back to the
 * campaign centre. Only `district` and each street's first vertex are read,
 * never a value. Paused at the end it shares the road grid's own `todate`
 * fetch (identical to 'all' there); in replay it reads the stored grid once.
 */
function usePlaceSegments() {
  const replaying = useSession((st) => st.time.cursor != null)
  // Any previous grid will do while the other one loads: only geography is read.
  return useSegments(
    { metric: 'risk', window: replaying ? 'all' : 'todate', limit: 2000 },
    { placeholderData: (previous) => previous },
  )
}

export interface Places {
  /** Neighbourhood name → centre, ordered by how much road we drove there. */
  centers: Map<string, Position>
  names: string[]
  /** The signed-in resident's own neighbourhood centre. */
  home: Position
  homeName: string
}

export function usePlaces(): Places {
  const { data } = usePlaceSegments()
  const homeName = useMyNeighborhood()
  return useMemo(() => {
    const centers = districtCenters(data)
    const counts = new Map<string, number>()
    for (const f of data?.features ?? []) {
      const d = f.properties.district
      if (d) counts.set(d, (counts.get(d) ?? 0) + 1)
    }
    const names = [...centers.keys()].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0))
    const home =
      centers.get(homeName) ?? ([DEFAULT_VIEW.longitude, DEFAULT_VIEW.latitude] as Position)
    return { centers, names, home, homeName }
  }, [data, homeName])
}

// ────────────────────────────────────────────────────────── concern language

/**
 * What an industrial site IS, for someone who has never read a permit. Lives
 * here rather than in Outreach because the map explains sites too now, and two
 * copies of a sentence like this drift.
 */
export const KIND_WORD: Record<SiteKind, string> = {
  datacenter: 'A data centre — rooms of computers, with generators to keep them running',
  logistics: 'A freight yard — trucks and containers moving through, day and night',
  manufacturing: 'A factory — furnaces and finishing lines',
  power: 'A power plant',
  other: 'An industrial site',
}

export const CONCERN_KINDS: ConcernKind[] = [
  'smell',
  'noise',
  'smoke',
  'dust',
  'health',
  'light',
  'traffic',
  'vibration',
  'other',
]

/** The five a resident reaches for first. The rest live behind "something else". */
export const PRIMARY_KINDS: ConcernKind[] = ['smell', 'noise', 'smoke', 'dust', 'health']

export function kindLabel(kind: ConcernKind | string): string {
  if (kind === 'health') return 'Feeling unwell'
  return CONCERN_LABEL[kind] ?? 'Something else'
}

export function kindEmoji(kind: ConcernKind | string): string {
  return CONCERN_EMOJI[kind] ?? '❓'
}

/** What a resident is actually saying when they pick a kind. */
export const KIND_PROMPT: Record<ConcernKind, string> = {
  smell: 'A smell in the air',
  noise: 'A hum, roar or rumble',
  smoke: 'Smoke or haze you can see',
  dust: 'Dust settling on things',
  health: 'Headache, cough, burning eyes',
  light: 'Lights or flaring at night',
  traffic: 'Trucks or heavy traffic',
  vibration: 'The house is shaking',
  other: 'Something else entirely',
}

export const SEVERITY_WORDS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: 'Barely there',
  2: 'Noticeable',
  3: 'Strong',
  4: 'Hard to ignore',
  5: 'Could not stay outside',
}

export function severityWord(sev: number): string {
  const s = Math.min(5, Math.max(1, Math.round(sev))) as 1 | 2 | 3 | 4 | 5
  return SEVERITY_WORDS[s]
}

// ─────────────────────────────────────────── the asymmetry, in one function

/**
 * Who a report currently belongs to, in a resident's words.
 *
 * `mitigation_proposed` is deliberately NOT a closing state: a company can say
 * it tried something, and the report stays open until the agency closes it.
 */
export function statusPlain(status: ConcernStatus): {
  label: string
  hint: string
  open: boolean
  actor: Role
} {
  switch (status) {
    case 'new':
      return { label: 'Posted', hint: 'Your neighbours can see this', open: true, actor: 'community' }
    case 'corroborated':
      return {
        label: 'Neighbours agree',
        hint: 'More than one household reported this',
        open: true,
        actor: 'community',
      }
    case 'under_review':
      return {
        label: 'With the agency',
        hint: 'The regional air agency is looking into it',
        open: true,
        actor: 'regulator',
      }
    case 'mitigation_proposed':
      return {
        label: 'Still open · a company says it tried something',
        hint: 'Only the regional air agency can close a report',
        open: true,
        actor: 'industry',
      }
    case 'resolved':
      return { label: 'Closed by the agency', hint: 'The agency marked this done', open: false, actor: 'regulator' }
    case 'closed':
      return { label: 'Closed', hint: 'No longer being tracked', open: false, actor: 'regulator' }
  }
}

export function isOpen(status: ConcernStatus): boolean {
  return statusPlain(status).open
}

// ───────────────────────────────────────────────────────────── actor voices

export type Voice = 'neighbour' | 'agency' | 'company' | 'aclima'

export const VOICE: Record<Voice, { who: string; note: string; token: string }> = {
  neighbour: {
    who: 'A neighbour',
    note: 'Posted by someone who lives here',
    token: 'var(--actor-community)',
  },
  agency: {
    who: 'Regional air agency',
    note: 'The public agency that sets and enforces the limits',
    token: 'var(--actor-regulator)',
  },
  company: {
    who: 'Operator',
    note: 'A company that runs a site nearby. Their own words.',
    token: 'var(--actor-industry)',
  },
  aclima: {
    who: 'Aclima',
    note: 'Measured from our cars as they drive your streets',
    token: 'var(--actor-aclima)',
  },
}

/** Who owns a monitor, said honestly — this is half the trust story. */
export function monitorVoice(m: Monitor): { voice: Voice; who: string } {
  switch (m.owner_type) {
    case 'regulator':
      return { voice: 'agency', who: 'A regional air agency monitor' }
    case 'industry':
      return { voice: 'company', who: "A company's own fence-line sensor" }
    case 'community':
      return { voice: 'neighbour', who: "A neighbour's porch sensor" }
    default:
      return { voice: 'aclima', who: 'An Aclima sensor' }
  }
}

// ──────────────────────────────────────────────────────────────── distances

/** "3 blocks away" beats "412 m" for someone who has never opened a GIS. */
export function nearWords(metres: number | null): string {
  if (metres == null || !Number.isFinite(metres)) return ''
  if (metres < 150) return 'on your block'
  if (metres < 500) return 'a few blocks away'
  if (metres < 1200) return 'a short walk away'
  return `${fmtDistanceImperial(metres)} away`
}

export function distanceFromHome(c: Pick<Concern, 'lon' | 'lat'>, home: Position): number {
  return distanceBetween(home, [c.lon, c.lat])
}

// ─────────────────────────────────────────────── what had happened by now
//
// Replay rewinds events too (docs/PLAN-refocus.md D2). The server bounds the
// feed, the reports and the groups by `at` before its LIMIT; these are the
// view's own guard on top, because a timed query keeps the PREVIOUS moment's
// rows on screen while the next one loads — scrub back from Aug 28 to Aug 12
// and, for one fetch, every row on the page is in the future.

/**
 * The stream as of `now`. A feed item carries its moment as `at` — a report's
 * or post's `created_at`, a reading's `ts` (routers/feed.py) — so that is what
 * is tested, with the same rule as every other event.
 */
export function feedBy(items: readonly FeedItem[] | null | undefined, now: CampaignTime): FeedItem[] {
  return (items ?? []).filter((it) => hasStarted({ created_at: it.at }, now))
}

/**
 * A notice in force at `now`: issued, and not yet expired. The same test the
 * server's `advisory_count_active` makes, so the rail and the headline count
 * agree. At the end of the data four of the five notices have expired.
 */
export function inForce(a: Advisory, now: CampaignTime): boolean {
  return isOngoing({ created_at: a.created_at, ended_at: a.expires_at }, now)
}

/** Three reports within a few blocks in a day make a group (the copy says so). */
const GROUP_MIN = 3

/**
 * A group of reports as it stood at `now`, or null if it had not formed yet.
 *
 * The cluster row is the group's FINAL shape. Its count includes reports filed
 * after the moment on screen, and `first_at`/`last_at` are when things were
 * noticed (`occurred_at`), which runs about 3 h ahead of posting and up to
 * 6.7 h (cl-01: first noticed 05:43, first posted 07:38). So when the report
 * list in hand shows members posted after `now`, the group is recounted
 * without them, and dropped below three. With no later members in hand the
 * row stands, once its first report had been noticed.
 */
export function clusterAsOf(
  cl: ConcernCluster,
  concerns: readonly Concern[],
  now: CampaignTime,
): ConcernCluster | null {
  const members = concerns.filter((c) => c.cluster_id === cl.id)
  const later = members.filter((c) => !hasStarted(c, now))
  if (!later.length) return hasStarted({ started_at: cl.first_at }, now) ? cl : null
  const posted = members.filter((c) => hasStarted(c, now))
  const count = cl.count - later.length
  if (count < GROUP_MIN || !posted.length) return null
  const noticed = posted.map((c) => c.occurred_at).sort()
  // Every member in hand: the group can be rebuilt exactly. Otherwise the list
  // was cut at its oldest end, so the row's first report and kinds stand.
  const whole = posted.length === count
  return {
    ...cl,
    count,
    first_at: whole ? noticed[0] : cl.first_at,
    last_at: noticed[noticed.length - 1],
    kinds: whole ? [...new Set(posted.map((c) => c.kind))] : cl.kinds,
  }
}

export function clustersAsOf(
  clusters: readonly ConcernCluster[] | null | undefined,
  concerns: readonly Concern[],
  now: CampaignTime,
): ConcernCluster[] {
  const out: ConcernCluster[] = []
  for (const cl of clusters ?? []) {
    const at = clusterAsOf(cl, concerns, now)
    if (at) out.push(at)
  }
  return out
}

/**
 * Whether a report's group had formed by the demo's now.
 *
 * `cluster_id` is the report's FINAL group. At Jun 17 08:30 the feed labelled
 * cn-0100-0009 "part of a group" while 2 of cl-01's 7 reports had been posted,
 * and /clusters at that moment listed only cl-00 — cl-01 formed at 08:51, with
 * its third. `useConcernClusters` asks for the groups as of the clock, counted
 * from reports posted by then, so the id has to be on that list. The query is
 * the same one the feed and the map already hold, so a card costs no request.
 */
export function useGroupFormed(clusterId: string | null | undefined): boolean {
  const clusters = useConcernClusters().data
  return !!clusterId && (clusters ?? []).some((g) => g.id === clusterId)
}

// ─────────────────────────────────────────────────────────── risk from data

/** Plain "how does today compare" phrasing for a trend in percent. */
export function trendWords(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'about the same as usual'
  if (pct > 12) return 'worse than the last few weeks'
  if (pct > 3) return 'a little worse than usual'
  if (pct < -12) return 'better than the last few weeks'
  if (pct < -3) return 'a little better than usual'
  return 'about the same as usual'
}

/** One sentence a resident can act on, keyed off the headline risk score. */
export function adviceFor(risk: number | null | undefined): string {
  // What was measured, over what window — never advice and never an
  // all-clear. The score is the street picture for the stat window (the whole
  // campaign by default), not the latest hour, so nothing here says "today"
  // or "right now". Health guidance is the air agency's to give: the upper
  // bands point to its notices instead of inventing their own.
  if (risk == null) return 'We do not have enough measurements yet to say.'
  if (risk < 20) return 'The streets near you have scored clean over these three months.'
  if (risk < 40) return 'Most streets near you have scored fair over these three months.'
  if (risk < 55) return 'Some streets near you have scored elevated over these three months.'
  if (risk < 70)
    return 'Several streets near you have scored high over these three months. The air agency posts advice when it is needed.'
  if (risk < 85)
    return 'Many streets near you have scored high over these three months. Check the notices from the air agency.'
  return 'The streets near you have scored very high over these three months. Check the notices from the air agency.'
}

// ─────────────────────────────────────────────────── the wind, in plain words

/**
 * EVERY SENTENCE THIS APP SAYS ABOUT THE WIND AND THE PLUME, IN ONE OBJECT.
 *
 * Not a style choice. The community interface is the one place in this product
 * where a wrong sentence is a defamation surface rather than a bug: a named
 * company, a named neighbourhood, and a resident with a screenshot. CONTRACT
 * §10a is a list of things never to say, and a list is only reviewable if the
 * things it governs are in one screen. Grepping JSX for them is not review.
 *
 * The same trick `statusPlain` already uses to keep "industry can never close
 * a report" in exactly one place.
 *
 * Three rules hold across all of it:
 *
 *  1. **The wind is the subject, never the company.** "The wind carried from
 *     Ridgeline over your streets" — not "Ridgeline polluted your streets".
 *     The first is a fact about the weather; the second is an accusation this
 *     product cannot support and has no business making.
 *  2. **No units, no acronyms, no chemistry** (non-negotiable 3).
 *  3. **Every number is generated from the payload**, never written down.
 *     Measured across four seeds, the same quantity moves by a factor of two.
 */
export const PLUME_COPY = {
  /** The front door. `share` is 0–1, from `DistrictWind.share`. */
  usually: {
    title: 'Which way the wind usually blows',
    lead: (place: string) =>
      `Over the last three months, here is how often the wind blew from each of these places toward ${place}.`,
    /**
     * The caption under the map's wind rose. The rose is the whole campaign's
     * wind record, drawn in a corner beside the scale and at no site, so it
     * says where the wind came from and nothing about who is upwind of whom.
     */
    // No time claim: in replay 'the last three months' would include hours
    // after the moment on screen. It is the campaign's usual wind.
    mapKey: 'Where the wind usually comes from',
    /** One place's line, before `often(share)`. The wind is the subject. */
    fromHere: (place: string) => `the wind blew from here toward ${place}`,
    /** The tapped place's line on its own card, where the lead is not above it. */
    fromHereOver: (place: string) =>
      `Over the last three months, the wind blew from here toward ${place}`,
    /** Deliberately coarse. A resident does not need three significant figures. */
    often: (share: number): string => {
      if (!Number.isFinite(share) || share <= 0) return 'almost never'
      if (share < 0.02) return 'hardly ever'
      if (share < 0.06) return 'about one hour in twenty'
      if (share < 0.12) return 'about one hour in ten'
      if (share < 0.2) return 'about one hour in six'
      if (share < 0.3) return 'about one hour in four'
      if (share < 0.42) return 'about one hour in three'
      if (share < 0.6) return 'about half the time'
      return 'most of the time'
    },
    /** What the front door does NOT say. Shown, not hidden behind a tap. */
    caveat:
      'This is about the wind, not about what anyone put into it. A place being upwind of you does not mean it sent anything your way — it means that if it did, this is where the air was going.',
    source: (hours: number) =>
      `From ${hours.toLocaleString()} hours of weather records across the whole three months.`,
    none: 'We do not have enough weather records yet to say.',
  },

  /**
   * The cloud, one tap behind. `hour` is the hour the drawn cloud was worked
   * out for (the payload's own `ts`), so the title names what is on the map
   * even while the next hour loads. Past tense and no "right now" or "this
   * hour": a model of an hour is never the present (PLAN-refocus C4, D5).
   */
  now: {
    title: (hour: string | null) =>
      hour ? `Where the wind was carrying air · ${hour}` : 'Where the wind was carrying air',
    lead: 'Where air from each place would have been carried, worked out from the wind in that hour.',
    /** Said instead of the lead's promise when nothing could be drawn. */
    none: 'Nothing is drawn: we could not work out the wind for that hour.',
  },

  /**
   * The one caveat under the cloud, in both cloud modes (PLAN-refocus D5).
   * Always shown and never dismissible: if it can be closed, the cloud
   * outlives it on somebody's screen. It replaced three bullets whose
   * boundary words ("inside this shape", "just outside it") drew the edge
   * they were denying. This one denies an edge without naming one, and never
   * says where anything stops.
   */
  cloudCaveat:
    'A guess from the wind, not a measurement. It has no edge, and it does not mean anything was released.',

  /** Frozen on the hour a group of neighbours reported. */
  when: {
    title: 'When your neighbours reported',
    lead: (when: string) =>
      `Where the air was going ${when}, when several people nearby reported something.`,
    noCluster: 'No group of reports close enough together in time to line up with the wind yet.',
  },

  /**
   * The two sentences a report gets. The NULL branch matters most: 137 of 204
   * reports have no site attached, and an app willing to say "we could not
   * connect this to anywhere on the map" is one you believe when it says the
   * opposite.
   */
  concern: {
    attributed: (site: string) =>
      `When this was reported, the wind was blowing from ${site} toward here. That is why it is named — it is where the air came from, not a finding that ${site} caused it.`,
    unattributed:
      'We could not connect this to any of the industrial places on the map. The wind was not coming from any of them at the time, or we did not have enough wind readings that hour to tell.',
    /** The wind came from a site, but that site's measured downwind test for
     *  this kind of air is not elevated — so it is not named (D7). */
    unlinked:
      'The wind was coming from one of the industrial places on the map, but our street measurements do not show that place\'s air reaching this far, so we do not name it.',
    /** Sounds, shaking and light are not carried by the wind the way air is. */
    notByWind:
      'We do not link sounds, shaking or light to a place by the wind. The report stays on the map for everyone to see.',
  },
} as const

/**
 * Which measured test can back naming a site for a report of this kind — the
 * server's `naming.REPORT_MEASURE`, kept in step. A kind that is not here is
 * never linked by the wind (CONTRACT §10b, "Naming a site").
 */
export const REPORT_MEASURE: Partial<Record<string, 'no2' | 'pm25'>> = {
  smell: 'no2', health: 'no2', other: 'no2', smoke: 'pm25', dust: 'pm25',
}
