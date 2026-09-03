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
import { distanceBetween, fmtDistanceImperial } from '@/core/format'
import { useSegments, useUsers } from '@/core/queries'
import { DEFAULT_VIEW, usePersona } from '@/core/session'
import type {
  Concern, ConcernKind, ConcernStatus, Monitor, Position, Role, SegmentCollection, SiteKind, User,
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

/** The road grid, always painted by risk — community never sees a raw magnitude. */
export function useCommunitySegments() {
  return useSegments({ metric: 'risk', limit: 2000 })
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
  const { data } = useCommunitySegments()
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
  if (risk == null) return 'We do not have enough measurements yet to say.'
  if (risk < 20) return 'Nothing unusual in the air on your streets right now.'
  if (risk < 40) return 'Fine for most people. Open a window if you like.'
  if (risk < 55)
    return 'If you have asthma or a heart condition, take it easy outdoors today.'
  if (risk < 70)
    return 'Sensitive groups should keep outdoor time short. Everyone else, go easy.'
  if (risk < 85) return 'Keep windows closed and limit time outdoors if you can.'
  return 'Stay indoors with windows closed if that is possible for you.'
}
