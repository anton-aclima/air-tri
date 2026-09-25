/**
 * industry/lib — the pieces every industry screen shares.
 *
 * The operator's interface is one promise ("run at the top of your safe
 * envelope") and one question ("what is near me, and was the wind carrying my
 * air there at the time"). The helpers here serve those two: the envelope read
 * for the air of the moment, a typical day built from the campaign's weather,
 * alerts described as plain sentences, and the one linking rule (F7) that
 * decides whether anything on the map may be tied to this site.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { LayersList } from 'deck.gl'

import { ALERT_KIND_LABEL, SEVERITY_GLYPH, metersPerPixel, pointInRing } from '@/components'
import type { SegmentFeature, Theme } from '@/components'
import { API_BASE, isAxisFeature, isBandFeature, isOutlineFeature } from '@/core/api'
import { addHours, campaignMs, floorTo } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { hasStarted, isOngoing, isRecent } from '@/core/events'
import { compassPoint, fmtDay, fmtDistance, fmtDuration, fmtNum, fmtTime24 } from '@/core/format'
import { SEVERITY_LABEL, severityRank, severityVar, unitFor } from '@/core/measures'
import {
  useActiveSite, useAskAdvisor, useBootstrapSites, useCampaignInfo, useOrgs, useTouchdown,
} from '@/core/queries'
import { roleMeta } from '@/core/roles'
import { useNowCampaign, useSession } from '@/core/session'
import type {
  ActionLevel, Alert, AdvisorReply, BBox, Concern, ConcernCluster, ConcernKind, DispersionFeature,
  DispersionPlume, DispersionPlumeOutlined, DispersionProps, Envelope as EnvelopeT,
  EnvelopeRegime, EnvelopeState, IndustrySite, MeasureCode, MeasureDef, Mitigation, Monitor, Org,
  Position, Severity, TouchdownState, WindPoint,
} from '@/core/types'

import s from './industry.module.css'

// ─────────────────────────────────────────────────────────────── the site

/**
 * Every industry screen shows ONE site: the one this persona's org owns.
 *
 * `useActiveSite()` falls back to `sites[0]` when nothing is selected, and
 * `sites[0]` is Delta Forge — which is why the shell header could read
 * "Delta Forge Metals Works" while the persona was Ridgeline. Writing the
 * resolved id back into the session fixes the header too, because the shell
 * reads the same hook and `siteId` wins over the fallback.
 */
export function useSiteLock(): IndustrySite | undefined {
  const fallbackSite = useActiveSite()
  const sites = useBootstrapSites()
  const orgs = useOrgs()
  const siteId = useSession((x) => x.siteId)
  const personaOrg = useSession((x) => x.user?.org_id ?? null)
  const setSite = useSession((x) => x.setSite)

  // With no persona picked yet, `useActiveSite()` lands on `sites[0]` — which is
  // Delta Forge, not this role's company. The role's own org is the honest
  // default, so resolve it by name from the shared role metadata.
  const roleOrgId = useMemo(
    () => orgs.find((o) => o.name === roleMeta('industry').org)?.id ?? null,
    [orgs],
  )
  const orgId = personaOrg ?? roleOrgId

  const site = useMemo(() => {
    if (siteId) {
      const picked = sites.find((x) => x.id === siteId)
      // A stale session site that belongs to another company loses to the persona's org.
      if (picked && (!orgId || picked.org_id === orgId)) return picked
    }
    return (orgId ? sites.find((x) => x.org_id === orgId) : undefined) ?? fallbackSite
  }, [siteId, sites, orgId, fallbackSite])

  useEffect(() => {
    if (site && siteId !== site.id) setSite(site.id)
  }, [site, siteId, setSite])

  return site
}

// ──────────────────────────────────────────────────────── alerts near a site

export interface NearAlert {
  alert: Alert
  /**
   * False when the alert has no direction from the site — the
   * dispersion-study-vs-wind alert is about the site as a whole and is placed
   * on its centroid, so the server returns bearing 0 and distance 0. Those are
   * not "000° · 0 m", they are "site-wide": it does not belong on a list sorted
   * by distance.
   */
  sited: boolean
  bearing: number
  distance: number
  kindLabel: string
  glyph: string
}

const SEV_ORDER: Severity[] = ['critical', 'warning', 'watch', 'info']

/** Closer than this to the site centroid, a direction is meaningless. */
const SITE_WIDE_M = 50

/**
 * Does this alert have a direction from the site? One rule, used by every
 * surface that prints a direction.
 */
export function isSited(a: Alert): boolean {
  return a.bearing_deg != null && a.distance_m != null && a.distance_m > SITE_WIDE_M
}

/** Severity first, then distance. Nothing else. */
export function toNearAlerts(alerts: Alert[] | undefined): NearAlert[] {
  return (alerts ?? [])
    .map((a) => ({
      alert: a,
      sited: isSited(a),
      bearing: a.bearing_deg ?? 0,
      distance: a.distance_m ?? 0,
      kindLabel: ALERT_KIND_LABEL[a.kind] ?? a.kind,
      glyph: SEVERITY_GLYPH[a.severity],
    }))
    .sort(
      (a, b) =>
        severityRank(b.alert.severity) - severityRank(a.alert.severity) ||
        a.distance - b.distance,
    )
}

/**
 * The short "what" column: the pollutant when there is one, else a plain word
 * for the source. Replaces the four-letter kind codes (EXCD, COMM, MOBL), which
 * were a cockpit display's abbreviations and read as jargon anywhere else.
 */
export function whatShort(a: Alert): string {
  if (a.measure) return a.measure.toUpperCase()
  if (a.kind === 'concern_cluster' || a.source_type === 'community') return 'Reports'
  if (a.source_type === 'mobile') return 'Fleet'
  if (a.kind === 'wind_shift') return 'Wind'
  return ALERT_KIND_LABEL[a.kind] ?? a.kind
}

export function countBySeverity(list: NearAlert[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, warning: 0, watch: 0, info: 0 }
  for (const c of list) out[c.alert.severity] += 1
  return out
}

export function severityCountLine(counts: Record<Severity, number>): string {
  return SEV_ORDER.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${SEVERITY_LABEL[k]}`)
    .join(' · ')
}

/**
 * The alert's end AS IT STOOD AT `now`. An `ended_at` after the moment on
 * screen had not happened yet, so in replay that alert was still up — and
 * drawing it to its real end would show the future (D2).
 */
export function endedBy(alert: Alert, now: CampaignTime): string | null {
  return alert.ended_at && campaignMs(alert.ended_at) <= campaignMs(now) ? alert.ended_at : null
}

/**
 * How long an alert was up at `now`: to its end if it had ended by then, else
 * to now. It used to take `ended_at` whenever one was set, so in replay an
 * alert still up at the moment shown read its final duration — the future —
 * and one with no end measured to the wall clock and read about a month.
 */
export function upMs(alert: Alert, now: CampaignTime): number {
  return Math.max(0, campaignMs(endedBy(alert, now) ?? now) - campaignMs(alert.started_at))
}

/** `upMs` in words a glance can finish. */
export function upFor(alert: Alert, now: CampaignTime): string {
  return fmtDuration(upMs(alert, now))
}

/**
 * One row per episode, not one per tripped rule. A watch and a warning from
 * the same instrument for the same pollutant on the same day are the same
 * event seen twice; the higher severity is kept.
 *
 * Keyed by DAY, not only by instrument + pollutant as it was. Measured on
 * Ridgeline at the end of the data: the old key folded Riverport Road's Aug 24
 * warning and its Aug 27 watch into one row, so the later episode vanished
 * from the list while its marker was still on the map.
 */
export function foldEpisodes(list: NearAlert[]): { alerts: NearAlert[]; folded: number } {
  const byKey = new Map<string, NearAlert>()
  for (const c of list) {
    const where = c.alert.source_id ?? `${c.bearing.toFixed(0)}|${c.distance.toFixed(0)}`
    const key = `${where}|${c.alert.measure ?? c.alert.kind}|${c.alert.started_at.slice(0, 10)}`
    const prev = byKey.get(key)
    if (!prev || severityRank(c.alert.severity) > severityRank(prev.alert.severity)) byKey.set(key, c)
  }
  const kept = [...byKey.values()].sort(
    (a, b) => severityRank(b.alert.severity) - severityRank(a.alert.severity) || a.distance - b.distance,
  )
  return { alerts: kept, folded: list.length - kept.length }
}

/** "Riverport Road" — the place, not the rule that fired. Titles all start alike. */
export function shortTitle(a: Alert): string {
  if (a.kind === 'wind_shift') return 'Dispersion study vs measured wind'
  const at = a.title.split(/ at /i)
  if (at.length > 1) return at[at.length - 1]
  const colon = a.title.split(': ')
  if (colon.length > 1) return colon[colon.length - 1]
  return a.title.replace(/^Community concern cluster · /, '').replace(/^Observed wind diverges from /, '')
}

/** What an alert row needs to name an instrument's owner and a pollutant. */
export interface AlertContext {
  monitors: Monitor[]
  orgs: Org[]
  measures: MeasureDef[]
  siteId: string
}

/**
 * An alert as one plain sentence — "NO2 over the 1-hour standard at DRAQA's
 * Riverport Road monitor".
 *
 * The owner's instrument is named, because a reading on a DRAQA reference
 * monitor 6 km away and one on this site's own fenceline are different
 * afternoons. It says "DRAQA's … monitor", not "DRAQA's standard": the 100 ppb
 * level is the national standard, and fusing the fictional agency with it
 * was flagged in review. Nothing here says where the air came from — the list
 * orders by the wind at the time, it does not attribute.
 */
export function alertSentence(a: Alert, ctx: AlertContext): string {
  const def = a.measure ? ctx.measures.find((m) => m.code === a.measure) : undefined
  const pollutant = def?.short_label ?? a.measure?.toUpperCase() ?? ''

  if (a.kind === 'concern_cluster' || a.source_type === 'community') {
    const near = a.title.match(/ near (.+)$/i)?.[1]
    const n = a.value != null ? fmtNum(a.value, 0) : null
    return `${n ? `${n} resident reports` : 'Resident reports'}${near ? ` near ${near}` : ''}`
  }

  if (a.source_type === 'mobile') {
    const [what, road] = a.title.includes(': ') ? a.title.split(': ') : [a.title, null]
    return road ? `${what}, on ${road}` : what
  }

  const m = a.title.match(/^(.+?) exceeded at (.+)$/i)
  if (m) {
    // "NO2 1-hour standard" -> "1-hour standard": the pollutant leads the
    // sentence already. Ozone's labels start with the word, not the code.
    const level = levelName(m[1], def, a.measure)
    const mon = a.source_id ? ctx.monitors.find((x) => x.id === a.source_id) : undefined
    const place = mon?.name ?? m[2]
    let where: string
    if (mon?.site_id === ctx.siteId) where = `your fenceline sensor ${place}`
    else if (mon?.owner_type === 'regulator') {
      const org = ctx.orgs.find((o) => o.id === mon.org_id)
      where = `${org?.short_name ? `${org.short_name}'s ` : ''}${place} monitor`
    } else where = place
    return `${pollutant || 'Reading'} over the ${level} at ${where}`
  }
  return a.title
}

/**
 * "6.3 km NE · Aug 24, 1 h" — where, and when, as of the moment shown. An
 * ongoing alert reads "since Aug 27": its running duration is in the detail,
 * and in a 280 px panel it pushed every row to three lines.
 */
export function alertWhere(a: NearAlert, now: CampaignTime): string {
  const place = a.sited ? `${fmtDistance(a.distance, 1)} ${compassPoint(a.bearing)}` : 'site-wide'
  return isOngoing(a.alert, now)
    ? `${place} · since ${fmtDay(a.alert.started_at)}`
    : `${place} · ${fmtDay(a.alert.started_at)}, ${upFor(a.alert, now)}`
}

/**
 * A mitigation's status as it stood at `now`. `status` is the row's FINAL one:
 * at Aug 12 mt-003 on al-cluster-05's alert read "completed", though its
 * `completed_at` is Aug 18. Completed only once that stamp is on or before
 * now (a null one — the server blanks a stamp after `at` — is not yet); until
 * then it was in progress. `started_at` equals `created_at` on every row in the
 * checked-in data, so "proposed" needs no rebuilding.
 */
export function mitigationStatusAt(m: Mitigation, now: CampaignTime): Mitigation['status'] {
  if (m.status !== 'completed') return m.status
  return hasStarted({ started_at: m.completed_at }, now) ? 'completed' : 'in_progress'
}

// ───────────────────────────────────────────────────── the wind at the time

/**
 * The hourly observation in force at `t`: the latest at or before it, within
 * two hours. `/wind` holds one row per hour, so a wider gap is a hole in the
 * record, and a stale direction would put an alert on the wrong side.
 */
export function windAt(series: WindPoint[] | undefined, t: string): WindPoint | undefined {
  if (!series?.length) return undefined
  const at = campaignMs(t)
  let best: WindPoint | undefined
  for (const w of series) {
    const ms = campaignMs(w.ts)
    if (ms > at) break
    best = w
  }
  if (!best || at - campaignMs(best.ts) > 2 * 3_600_000) return undefined
  return best
}

/** Degrees between two compass bearings, 0–180. */
export function offAxis(bearing: number, transportDeg: number): number {
  return Math.abs((((bearing - transportDeg + 180) % 360) + 360) % 360 - 180)
}

/**
 * What the wind was doing when something began — a description of the wind
 * at the time, never of whose air it was. The three old branches here said
 * "On the geometry, this is yours", "unlikely to be your plume" and "across the
 * wind … attribution is genuinely ambiguous", from the LATEST wind: attribution
 * by proximity and today's weather, which CONTRACT §10a.3 forbids.
 */
export function windThen(
  wind: WindPoint[] | undefined, t: string, bearing: number | null,
): string {
  const w = windAt(wind, t)
  if (!w) return 'No wind observation in the record for that hour.'
  const toward = (w.dir_deg + 180) % 360
  const base = `At ${fmtTime24(w.ts)} the wind blew from ${compassPoint(w.dir_deg)} at ${fmtNum(w.speed_ms, 1)} m/s, `
    + `carrying air from your campus toward ${compassPoint(toward)}`
  if (bearing == null) return `${base}.`
  const off = offAxis(bearing, toward)
  return off < 50
    ? `${base}; this place lay downwind of you then.`
    : off > 130
      ? `${base}; this place lay upwind of you then.`
      : `${base}; this place lay across the wind from you then.`
}

/**
 * The half-angle of "downwind" when there is no plume shape to test against.
 * Generous on purpose: a plume is not a laser, and the question is only
 * whether the wind was carrying this way at all.
 */
export const DOWNWIND_HALF_ANGLE = 35

/**
 * Was the wind carrying air from the site toward this alert when it BEGAN?
 * Null when the record has no observation then. This orders the deck's list:
 * an alert rises only if it was downwind at the time, which is what stops
 * another operator's monitor from headlining this site's deck.
 */
export function wasDownwindAtStart(a: NearAlert, series: WindPoint[] | undefined): boolean | null {
  if (!a.sited) return null
  const w = windAt(series, a.alert.started_at)
  if (!w) return null
  return offAxis(a.bearing, (w.dir_deg + 180) % 360) <= DOWNWIND_HALF_ANGLE
}

// ────────────────────────────────────────────── a stable time window

/**
 * A trailing window ending at the DEMO's now, for the wind hooks.
 *
 * This used to tick off the wall clock, which put `to` a month past the end of
 * the data — the wind came back empty, and the downwind readout went with it.
 * The demo's now is the cursor, or the end of the data when paused there (D1),
 * so the window now ends where the data is.
 *
 * `to` snaps to the wind's own resolution, an hour. Nothing ticks when paused,
 * so the key is already stable; while playing the cursor moves every 250 ms
 * and an hourly grid refetches only when there is a new observation to show.
 */
export function useStableWindow(hours = 24, bucketMin = 60): { from: string; to: string } {
  const now = useNowCampaign()
  return useMemo(() => {
    const to = floorTo(now, bucketMin)
    return { from: addHours(to, -hours), to }
  }, [now, bucketMin, hours])
}

/**
 * The WHOLE campaign, as a query window — for anything comparing a filed model
 * against the campaign's measured record, and for the typical day.
 *
 * `useStableWindow` above is "what is happening now"; this is "was the
 * consultant's study correct", which is a question about the whole record.
 * `/sites/{id}/model-verification` defaults to the last 30 days ending at
 * `domain.data_now`, and that default used to follow the wall clock off the
 * end of the data a day at a time.
 *
 * Measured 2026-09-10, with data ending 2026-08-28: the default window saw
 * 6,346 of 28,324 fleet wind observations and returned `consistent` for ALL
 * THREE sites. The same call over the campaign returns `understates`, +5.8
 * points on the SW bearing, over Boxtown and White Chapel. `data_now` is now the
 * build instant, so the default no longer slides — but 30 days is still a third
 * of the record, and the flagship "verify your consultant" claim should not
 * rest on a default parameter.
 *
 * Naive campaign time (core/clock), no `Z`. Anchored to `campaign.start_date`/
 * `end_date` rather than to literal dates so a rebuild with a different
 * `--now` still asks the right question. Deliberately NOT cut at the cursor:
 * like the envelope, the verdict is a climatology of the campaign, not an
 * event, and re-running it on every playback step would cost a refetch per
 * step for a number that should not move.
 */
export function useCampaignWindow(): { from: string; to: string } | undefined {
  const campaign = useCampaignInfo()
  const start = campaign?.start_date
  const end = campaign?.end_date
  return useMemo(
    () => (start && end ? { from: `${start}T00:00:00`, to: `${end}T23:59:59` } : undefined),
    [start, end],
  )
}

// ──────────────────────────────────────────────────────────── the envelope

export type Regime = 'unstable' | 'neutral' | 'stable'

export interface EnvelopeRead {
  /** Which regime this reading describes. */
  regime: Regime
  state: EnvelopeState
  /** One short phrase for a big readout. Never a bare number without its condition. */
  headline: string
  /** The condition the headline is true under, and the evidence behind it. */
  detail: string
  /** How much of the site's own contribution has to go. Null when nothing does. */
  cutPct: number | null
  /** The same thing in megawatts. MODELLED — see `Envelope.headroom_is_modelled`. */
  capMw: number | null
  loadMw: number | null
  /** True when the typical episode in this regime already needs a cut. */
  binding: boolean
  /** Share of campaign hours in this regime, 0–1. */
  shareOfHours: number
  /** Episodes the estimate rests on. Small numbers are stated, not hidden. */
  episodes: number
}

const REGIME_WORD: Record<Regime, string> = {
  unstable: 'well-mixed air',
  neutral: 'neutral air',
  stable: 'stable air',
}

/** "Stable air" — the regime as the line's opening word. */
export function regimeWord(regime: Regime): string {
  const w = REGIME_WORD[regime] ?? regime
  return w.charAt(0).toUpperCase() + w.slice(1)
}

/** The lowest action level in a regime: the one that binds first. */
function lowestLevel(r: EnvelopeRegime) {
  return r.thresholds.length
    ? r.thresholds.reduce((a, b) => (a.threshold <= b.threshold ? a : b))
    : null
}

/**
 * The operating envelope, read for one regime — **the industry tier's spine**.
 *
 * This used to be `envelopeOf(site)`, computed from `site.headroom_pct`: a
 * constant baked into the generator (79 / 61 / 44), identical on every screen
 * and every day, that an operator could neither verify nor improve. The
 * promise on this interface is "run at the top of your safe envelope", and a
 * constant cannot be run at the top of.
 *
 * What replaces it is measured — the site's own fenceline against class-matched
 * roads at least 2 km from every site — and it moves with the weather, which is
 * what makes it manageable. Measured on the shipped build, Ridgeline:
 *
 *     well-mixed   +13.2 ppb over comparable roads    0% of passes over the line
 *     stable       +55.7 ppb                         76% over the line
 *
 * `insufficient` is a FIRST-CLASS outcome, not an error. Across four seeds the
 * magnitude barely moves (+55.2 to +63.7) but one seed in four cannot form
 * three paired episodes at all — the fleet drove the fenceline on five nights
 * and covered enough comparison roads on only two of them. Saying so is the
 * argument for targeted driving; hiding it behind a dash is not.
 *
 * The headline never says "Clear": that reads as an all-clear, and every
 * non-binding state here is a measured excess or a statement of no difference,
 * not a clean bill.
 */
export function envelopeRead(env: EnvelopeT | undefined, regime: Regime): EnvelopeRead | null {
  const r = env?.regimes.find((x) => x.regime === regime)
  if (!env || !r) return null
  const word = REGIME_WORD[regime] ?? regime
  const watch = lowestLevel(r)
  const cutPct = watch?.cut_pct_typical ?? null
  const capMw = watch?.headroom_mw_typical ?? null
  const binding = r.state === 'binding'

  let headline: string
  let detail: string
  if (r.state === 'insufficient') {
    headline = 'Not enough passes'
    detail = `We have not driven your fenceline on enough ${word} nights to say. `
      + `${r.n_fenceline} passes over ${r.n_episodes} usable episodes.`
  } else if (r.state === 'indistinct') {
    headline = 'Like other roads'
    detail = `In ${word} your fenceline is not measurably different from comparable roads `
      + `elsewhere. ${r.n_fenceline} passes over ${r.n_episodes} episodes.`
  } else if (binding && capMw != null && env.load_mw != null) {
    // "(modelled)" in the headline itself, not only the sentence under it: a
    // big readout is read on its own, and SiteConfig prints it as one.
    headline = `${fmtNum(capMw, 0)} MW (modelled)`
    detail = `In ${word} the air has room for about ${fmtNum(capMw, 0)} MW (modelled) against the `
      + `${watch?.threshold} ${watch?.unit} ${watch?.severity} level. You are running `
      + `${fmtNum(env.load_mw, 0)}.`
  } else if (binding && cutPct != null) {
    headline = `−${fmtNum(cutPct, 0)}% (modelled)`
    detail = `In ${word} about ${fmtNum(cutPct, 0)}% of your own contribution has to go to `
      + `hold the ${watch?.threshold} ${watch?.unit} level.`
  } else {
    headline = 'No cut needed'
    detail = `In ${word} your fenceline runs about ${fmtNum(r.excess ?? 0, 0)} ${env.unit} `
      + `over comparable roads, and the typical episode needs no cut.`
  }

  return {
    regime, state: r.state, headline, detail, cutPct, capMw,
    loadMw: env.load_mw, binding,
    shareOfHours: r.share_of_hours, episodes: r.n_episodes,
  }
}

/** Pasquill class -> the regime the envelope is reported in. */
export function regimeOf(stability: string | null | undefined): Regime {
  const c = (stability ?? 'D').toUpperCase()
  if (c === 'A' || c === 'B') return 'unstable'
  if (c === 'E' || c === 'F') return 'stable'
  return 'neutral'
}

export interface EnvelopeLine {
  /**
   * The operating answer, said FIRST: "Hold near 210 MW (modelled) until
   * ~06:00", "Run at full load (modelled)", "No cut needed at current activity
   * (modelled)". Every MW and every cut carries "(modelled)" inline.
   */
  answer: string
  /** Why, after it: "stable air", "running 268 MW". Lower case, joined by " · ". */
  reasons: string[]
  /** `hold` = the typical episode needs a cut; `room` = it does not; `unknown`. */
  tone: 'hold' | 'room' | 'unknown'
}

/**
 * "~06:00" — when the air of the moment usually gives way, from the typical
 * day. Null when the hour shown is not in its regime's usual run (a stable
 * afternoon is not "until 06:00"), or when the regime holds all day.
 */
export function typicalUntil(
  hours: EnvelopeHour[] | null | undefined, nowHour: number | null | undefined, regime: Regime,
): string | null {
  if (!hours?.length || nowHour == null || hours[nowHour]?.regime !== regime) return null
  for (let k = 1; k < 24; k++) {
    const h = (nowHour + k) % 24
    if (hours[h].regime !== regime) return `~${String(h).padStart(2, '0')}:00`
  }
  return null
}

/** "~20:00" — the next hour of the typical day that needs a hold, or null. */
export function nextHold(hours: EnvelopeHour[] | null | undefined, nowHour: number | null | undefined): string | null {
  if (!hours?.length || nowHour == null || hours[nowHour]?.hold) return null
  for (let k = 1; k < 24; k++) {
    const h = (nowHour + k) % 24
    if (hours[h].hold) return `~${String(h).padStart(2, '0')}:00`
  }
  return null
}

/**
 * The deck's one line, answer first — "Hold near 210 MW (modelled) until
 * ~06:00 · stable air · running 268 MW".
 *
 * Measured on the review of phase 3: for Delta Forge and Riverport (no MW
 * rating: `load_mw` null) the line never said how hard the site could run —
 * it compared the fenceline with "comparable roads" and ended on "the typical
 * episode needs no cut", ~90 characters of the Evidence page's vocabulary.
 * CONTRACT §6 asks for one line saying how hard they can run, so a site with
 * no rating is answered against its own normal operations instead ("No cut
 * needed at current activity"), and the road comparison stays on Evidence.
 *
 * The state is the ENVELOPE's for the air of the moment shown, never the worst
 * alert's (another operator's monitor headlined the old banner). What the
 * envelope cannot see — the site's own fence sensors now, and a reference
 * monitor the F7 rule ties to this site — is added by the deck as a second
 * clause (`fenceNow`, `downwindCrossing`), and the tone follows the worst.
 *
 * Words it never uses: "clear", "safe", "within limits", "compliant".
 */
export function envelopeLine(
  env: EnvelopeT | undefined,
  regime: Regime,
  capacityMw: number | null | undefined,
  hours?: EnvelopeHour[] | null,
  nowHour?: number | null,
): EnvelopeLine | null {
  const r = env?.regimes.find((x) => x.regime === regime)
  if (!env || !r) return null
  const air = REGIME_WORD[regime] ?? regime
  const watch = lowestLevel(r)
  const capMw = watch?.headroom_mw_typical ?? null
  const cut = watch?.cut_pct_typical ?? null
  const load = env.load_mw
  const running = load != null ? `running ${fmtNum(load, 0)} MW` : null
  const until = typicalUntil(hours, nowHour, regime)
  const why = (...xs: (string | null)[]) => xs.filter((x): x is string => !!x)

  if (r.state === 'insufficient') {
    return { answer: 'Not enough fenceline passes to say', reasons: why(air, running), tone: 'unknown' }
  }
  if (r.state === 'binding') {
    const tail = until ? ` until ${until}` : ''
    if (capMw != null && load != null) {
      return { answer: `Hold near ${fmtNum(capMw, 0)} MW (modelled)${tail}`, reasons: why(air, running), tone: 'hold' }
    }
    if (cut != null && cut > 0) {
      return {
        answer: `Cut needed: about ${fmtNum(cut, 0)}% of your own contribution (modelled)${tail}`,
        reasons: why(air), tone: 'hold',
      }
    }
    return { answer: `Cut needed on the typical ${regime === 'stable' ? 'night' : 'episode'} (modelled)${tail}`, reasons: why(air), tone: 'hold' }
  }
  // Elevated but not binding, or indistinct: the typical episode needs no cut.
  if (capMw != null && load != null) {
    // Past nameplate the MW figure is an extrapolation the plant cannot run
    // at; Ridgeline's neutral-air figure is 1,382 MW on a 352 MW campus.
    const full = capacityMw != null && capMw >= capacityMw
    const hold = nextHold(hours, nowHour)
    return {
      answer: full ? 'Run at full load (modelled)' : `Run up to about ${fmtNum(capMw, 0)} MW (modelled)`,
      reasons: why(air, running, hold ? `typical hold from ${hold}` : null),
      tone: 'room',
    }
  }
  return {
    answer: load == null ? 'No cut needed at current activity (modelled)' : 'No cut needed (modelled)',
    reasons: why(air, running),
    tone: 'room',
  }
}

// ──────────────────────────────── what the envelope cannot see: the fence now

/**
 * Nothing past this distance is reportable (CLAUDE.md, PLAN-plume phase 2):
 * beyond it `field.py` clips the truth field to zero, and an estimator run
 * there passed both rotation tests on a plume that does not exist.
 */
export const REPORTABLE_M = 4200

/** A reading older than this is not "now": `/monitors` latest is the last row at or before `at`. */
const FRESH_MS = 2 * 3_600_000

/**
 * "1-hour standard", "1-hour watch level" — an action level's name with the
 * pollutant taken off the front, because the sentence already leads with it.
 */
export function levelName(label: string, def?: MeasureDef, code?: string | null): string {
  let level = label.trim()
  for (const lead of [def?.short_label, def?.label, code?.toUpperCase()]) {
    if (lead && level.toLowerCase().startsWith(lead.toLowerCase())) {
      level = level.slice(lead.length).trim()
      break
    }
  }
  return /watch$/i.test(level) ? `${level} level` : level
}

export interface FenceRead {
  monitor: Monitor
  /** "NE" — the sensor's side of the campus, from its name ("Ridgeline fenceline NE"). */
  side: string
  measure: MeasureCode
  value: number
  unit: string
  /** The worst 1-hour action level the reading is over, or null. */
  level: ActionLevel | null
}

export interface FenceNow {
  /** The site's own fence sensors, whatever their state. */
  total: number
  /** Sensors with a reading in the last two hours before the moment shown. */
  reporting: number
  /** Of those, how many read over a 1-hour action level on any channel. */
  over: number
  /** The worst reading over a level — severity first, then how far over. */
  worst: FenceRead | null
  /** The highest reading of `measure` among the reporting sensors, over a level or not. */
  highest: FenceRead | null
}

/** "NE" out of "Ridgeline fenceline NE"; the whole name when it has no side. */
function fenceSide(m: Monitor): string {
  const side = m.name.match(/fence(?:line)?\s+(.+)$/i)?.[1]
  return side?.trim() || m.name
}

/**
 * The site's own fence sensors, as of the moment shown (`/monitors?at=`).
 *
 * Measured at Ridgeline on Aug 27 02:00: six of seven sensors read 90–157 ppb
 * NO2, five over the 100 ppb 1-hour standard, while the deck's line said only
 * "hold near 210 MW" and the panel "Nothing began downwind". The database
 * holds no alert on any `mon-rlfl-*` sensor, so nothing else on the deck would
 * ever say it.
 *
 * Only 1-hour levels: a sensor's latest value is an hourly reading, and
 * comparing it with an 8-hour level is the "O3 ▲ beside Ozone 8-hour" error
 * the regulator review found. An offline sensor, or a reading more than two
 * hours old, is not "now" (mon-rlfl-07 has been offline since Jul 25, and its
 * month-old value topped a sorted list on the alert detail).
 */
export function fenceNow(
  monitors: Monitor[],
  siteId: string,
  levels: ActionLevel[] | undefined,
  now: CampaignTime,
  measure: MeasureCode,
  measures: MeasureDef[],
): FenceNow | null {
  const own = monitors.filter((m) => m.site_id === siteId)
  if (!own.length) return null
  const nowMs = campaignMs(now)
  const hourly = (levels ?? []).filter((l) => l.enabled && l.averaging_hours === 1)
  const unitOf = (code: string) => unitFor(measures.find((d) => d.code === code)) || hourly.find((l) => l.measure === code)?.unit || ''
  const score = (f: FenceRead) => (f.level ? severityRank(f.level.severity) * 1000 + f.value / f.level.threshold : 0)
  let reporting = 0
  let over = 0
  let worst: FenceRead | null = null
  let highest: FenceRead | null = null
  for (const m of own) {
    if (m.status === 'offline') continue
    let fresh = false
    let isOver = false
    for (const [code, r] of Object.entries(m.latest ?? {})) {
      if (!r || r.value == null || !Number.isFinite(r.value)) continue
      const age = nowMs - campaignMs(r.ts)
      if (age < 0 || age > FRESH_MS) continue
      fresh = true
      const level = hourly
        .filter((l) => l.measure === code && r.value > l.threshold)
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.threshold - a.threshold)[0] ?? null
      const read: FenceRead = {
        monitor: m, side: fenceSide(m), measure: code as MeasureCode, value: r.value, unit: unitOf(code), level,
      }
      if (level) {
        isOver = true
        if (!worst || score(read) > score(worst)) worst = read
      }
      if (code === measure && (!highest || read.value > highest.value)) highest = read
    }
    if (fresh) reporting += 1
    if (isOver) over += 1
  }
  return { total: own.length, reporting, over, worst, highest }
}

/** "your fence NE reads NO2 157 ppb against the 100 ppb 1-hour standard" */
export function fenceClause(f: FenceRead, measures: MeasureDef[]): string {
  const def = measures.find((d) => d.code === f.measure)
  const pollutant = def?.short_label ?? f.measure.toUpperCase()
  const lv = f.level
  const against = lv ? ` against the ${fmtNum(lv.threshold, 0)} ${lv.unit} ${levelName(lv.label, def, f.measure)}` : ''
  return `your fence ${f.side} reads ${pollutant} ${fmtNum(f.value, 0)} ${f.unit}${against}`.replace(/\s+/g, ' ')
}

// ─────────────────── what the envelope cannot see: a reference monitor, by F7

export interface DownwindCrossing {
  monitor: Monitor
  /** The owner's short name, "DRAQA". */
  owner: string | null
  distanceM: number
  measure: MeasureCode
  /** "1-hour standard". */
  level: string
  severity: Severity
  /** Distinct days in the window on which it crossed that level. */
  days: number
  windowDays: number
  /** Every one of those crossings began in stable air — say "nights". */
  nights: boolean
}

/**
 * A reference monitor this site's air may be named at (F7), and how often it
 * crossed a level in the last `windowDays`.
 *
 * Measured at Riverport on Aug 27 02:54: the line said "the typical episode
 * needs no cut" in green while DRAQA's Riverport Road monitor, 425 m away,
 * had crossed the NO2 1-hour standard at 06:00 on Aug 24, 25 and 26 — each
 * time on a class-F wind from 152–157°, carrying the terminal's air toward
 * it, and Riverport's own NO2 downwind test is `elevated_downwind`. Both F7
 * conditions held, so the deck may name it — and must, or "within responsible
 * environmental constraints" is a claim the deck cannot back.
 *
 * Every condition, all at once: a reference monitor (not the site's own); the
 * wind at the alert's START carried from the site to it (`wasDownwindAtStart`);
 * the site's placebo-checked downwind test for THAT pollutant is
 * `elevated_downwind`; within `REPORTABLE_M`; begun in the window. A monitor
 * failing any of them is not named — the rule that keeps another operator's
 * monitor off this deck still holds.
 */
export function downwindCrossing(
  near: NearAlert[],
  ctx: AlertContext,
  wind: WindPoint[] | undefined,
  tested: Partial<Record<MeasureCode, TouchdownState>>,
  now: CampaignTime,
  windowDays = 7,
): DownwindCrossing | null {
  type Group = { mon: Monitor; c: NearAlert; alerts: Alert[] }
  const groups = new Map<string, Group>()
  for (const c of near) {
    const a = c.alert
    if (a.source_type !== 'monitor' || !a.measure || !a.source_id) continue
    const mon = ctx.monitors.find((m) => m.id === a.source_id)
    if (!mon || mon.owner_type !== 'regulator') continue
    if (!(isOngoing(a, now) || isRecent(a, now, windowDays * 24))) continue
    if (!c.sited || c.distance > REPORTABLE_M) continue
    if (tested[a.measure] !== 'elevated_downwind') continue
    if (wasDownwindAtStart(c, wind) !== true) continue
    const key = `${a.source_id}|${a.measure}`
    const g = groups.get(key) ?? { mon, c, alerts: [] }
    g.alerts.push(a)
    groups.set(key, g)
  }
  let best: DownwindCrossing | null = null
  for (const g of groups.values()) {
    const top = g.alerts.reduce((x, y) => (severityRank(y.severity) > severityRank(x.severity) ? y : x))
    const atTop = g.alerts.filter((a) => a.severity === top.severity)
    const days = new Set(atTop.map((a) => a.started_at.slice(0, 10))).size
    const nights = atTop.every((a) => regimeOf(windAt(wind, a.started_at)?.stability) === 'stable')
    const def = ctx.measures.find((m) => m.code === top.measure)
    const levelLabel = top.title.match(/^(.+?) exceeded at /i)?.[1] ?? SEVERITY_LABEL[top.severity]
    const org = ctx.orgs.find((o) => o.id === g.mon.org_id)
    const cand: DownwindCrossing = {
      monitor: g.mon, owner: org?.short_name ?? null, distanceM: g.c.distance,
      measure: top.measure as MeasureCode, level: levelName(levelLabel, def, top.measure),
      severity: top.severity, days, windowDays, nights,
    }
    if (!best || severityRank(cand.severity) > severityRank(best.severity)
      || (cand.severity === best.severity && cand.days > best.days)) best = cand
  }
  return best
}

/** "DRAQA's Riverport Road monitor, 425 m downwind, crossed the NO2 1-hour standard on 3 of the last 7 nights" */
export function crossingClause(x: DownwindCrossing, measures: MeasureDef[]): string {
  const pollutant = measures.find((d) => d.code === x.measure)?.short_label ?? x.measure.toUpperCase()
  const who = x.owner ? `${x.owner}'s ` : ''
  return `${who}${x.monitor.name} monitor, ${fmtDistance(x.distanceM, 1)} downwind, crossed the ${pollutant} ${x.level}`
    + ` on ${x.days} of the last ${x.windowDays} ${x.nights ? 'nights' : 'days'}`
}

/**
 * The downwind tests F7 (b) can read. `/touchdown` is calibrated for these two
 * only — any other measure returns `measure_not_calibrated`, which is an honest
 * "cannot say", so nothing in it is ever linked.
 */
const TESTED_MEASURES = ['no2', 'pm25'] as const

/** The site's placebo-checked downwind test, per pollutant that has one. */
export function useDownwindTests(siteId: string | null | undefined): Partial<Record<MeasureCode, TouchdownState>> {
  const no2 = useTouchdown(siteId, { measure: TESTED_MEASURES[0] }).data?.site.state
  const pm25 = useTouchdown(siteId, { measure: TESTED_MEASURES[1] }).data?.site.state
  return useMemo(() => ({ no2, pm25 }), [no2, pm25])
}

export interface EnvelopeHour {
  hour: number
  /** The regime most of this hour's campaign record was in. */
  regime: Regime
  /** Share of this hour's campaign record in stable air, 0–1. */
  pStable: number
  /** Hours of record behind it. */
  n: number
  /** Typical modelled MW the air has room for; null = not characterised. */
  mw: number | null
  hold: boolean
  /** The envelope has a result for this hour's regime (not missing, not insufficient). */
  known: boolean
}

/**
 * A typical day: which regime each hour of the day usually sits in, from the
 * campaign's own met record, and what the envelope allows in that regime.
 *
 * NOT from `EnvelopeRegime.hours_of_day`. That field is the hours at which the
 * fleet happened to drive the fenceline in the regime — measured on Ridgeline,
 * hour 3 is listed under both neutral and stable, and eight hours of the day
 * (2, 5, 7, 8, 15–17, 22) appear under none. As a clock it describes the drive
 * plan, not the air. The met record has all 24 hours: stable air in 75–77% of
 * campaign hours from 20:00 to 05:00 and in none from 07:00 to 18:00.
 *
 * A climatology of this campaign, not a forecast.
 */
export function envelopeByHour(
  env: EnvelopeT | undefined,
  wind: WindPoint[] | undefined,
  capacityMw: number | null | undefined,
): EnvelopeHour[] | null {
  if (!env || !wind?.length) return null
  const counts = Array.from({ length: 24 }, () => ({ unstable: 0, neutral: 0, stable: 0 }))
  for (const w of wind) {
    const h = Number(w.ts.slice(11, 13))
    if (Number.isFinite(h) && h >= 0 && h < 24) counts[h][regimeOf(w.stability)] += 1
  }
  const full = capacityMw ?? env.load_mw ?? null
  return counts.map((c, hour) => {
    const n = c.unstable + c.neutral + c.stable
    const regime: Regime = (['stable', 'neutral', 'unstable'] as Regime[])
      .reduce((a, b) => (c[b] > c[a] ? b : a), 'stable')
    const r = env.regimes.find((x) => x.regime === regime)
    const watch = r ? lowestLevel(r) : null
    const cap = watch?.headroom_mw_typical ?? null
    const hold = r?.state === 'binding'
    const mw = !r || r.state === 'insufficient'
      ? null
      : hold
        ? cap
        : full != null && cap != null ? Math.min(cap, full) : full
    return { hour, regime, pStable: n ? c.stable / n : 0, n, mw, hold, known: !!r && r.state !== 'insufficient' }
  })
}

/** "20:00–06:00" — the longest run of hours where `test` holds, wrapping midnight. */
export function hourRun(hours: EnvelopeHour[], test: (h: EnvelopeHour) => boolean): string | null {
  const on = hours.map(test)
  if (!on.some(Boolean)) return null
  if (on.every(Boolean)) return 'all day'
  // Start the scan just after an "off" hour, so a run across midnight is whole.
  const start = on.findIndex((v, i) => !v && on[(i + 1) % 24])
  let best: [number, number] | null = null
  let runStart = -1
  for (let k = 1; k <= 24; k++) {
    const i = (start + k) % 24
    if (on[i] && runStart < 0) runStart = i
    if ((!on[i] || k === 24) && runStart >= 0) {
      const end = on[i] ? (i + 1) % 24 : i
      const len = (end - runStart + 24) % 24 || 24
      if (!best || len > ((best[1] - best[0] + 24) % 24 || 24)) best = [runStart, end]
      runStart = -1
    }
  }
  if (!best) return null
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`
  return `${hh(best[0])}–${hh(best[1])}`
}

// ─────────────────────────────────────────── naming a site: one rule (F7)

/**
 * May a resident's report be tied to THIS site? Only when both hold (F7, D7):
 *
 *   (a) the wind at the time carried from the site to it — the report's
 *       `suspected_site_id`, which the data sets only then (datagen
 *       narrative.py: "a concern gets suspected_site_id only when the wind at
 *       the time actually carried from that site to that point");
 *   (b) the site's measured downwind test for the pollutant is
 *       `elevated_downwind`, i.e. it passed the rotated-bearing placebo.
 *
 * Either alone is not enough. Delta Forge's reports carry (a), but its test is
 * `no_detection` (1.78 ppb under a 3.28 floor, placebo ratio 0.73), so none of
 * them may be drawn as its own. The old rule filled a report when TODAY's wind
 * pointed at it, for reports up to 14 days old.
 */
export function reportLinked(c: Concern, siteId: string, touchdown: TouchdownState | undefined): boolean {
  return isAirKind(c.kind) && c.suspected_site_id === siteId && touchdown === 'elevated_downwind'
}

/**
 * The report kinds an AIR test can speak to. Noise, vibration, light and
 * traffic are never linked by a downwind test for a pollutant (CONTRACT §10b):
 * measured on Ridgeline, "House shakes when the generators start" and
 * "Roaring sound from the west" were tagged "downwind then" and drawn filled
 * on the NO2 test. "Other" is not either — it says nothing about the air.
 */
const AIR_KINDS: ReadonlySet<ConcernKind> = new Set<ConcernKind>(['smell', 'smoke', 'dust', 'health'])

export function isAirKind(kind: ConcernKind | string | null | undefined): boolean {
  return !!kind && AIR_KINDS.has(kind as ConcernKind)
}

/**
 * The cluster version: at least half of the cluster's reports on screen are
 * linked by the same rule, else — when none of its reports are in view — the
 * cluster's own `site_id` (the generator's wind majority) on a cluster whose
 * kinds include an air kind.
 */
export function clusterLinked(
  cl: ConcernCluster, concerns: Concern[], siteId: string, touchdown: TouchdownState | undefined,
): boolean {
  if (touchdown !== 'elevated_downwind') return false
  const members = concerns.filter((c) => c.cluster_id === cl.id)
  if (!members.length) return cl.site_id === siteId && cl.kinds.some(isAirKind)
  return members.filter((c) => reportLinked(c, siteId, touchdown)).length * 2 >= members.length
}

/**
 * May an alert be drawn filled — linked to this site by F7? The wind at the
 * alert's START carried from the site to it, AND the site's downwind test for
 * the alert's pollutant is `elevated_downwind`, AND it is within the
 * reportable distance. A resident cluster is linked by `clusterLinked`. A
 * fleet detection on a street, the study-vs-wind alert and anything with no
 * calibrated test are never linked: they are measurements or model checks,
 * not a claim about whose air it was.
 */
export function alertLinked(
  c: NearAlert,
  wind: WindPoint[] | undefined,
  tested: Partial<Record<MeasureCode, TouchdownState>>,
  clusterOk?: (clusterId: string) => boolean,
): boolean {
  if (!c.sited || c.distance > REPORTABLE_M) return false
  const a = c.alert
  if (a.kind === 'concern_cluster' || a.source_type === 'community') {
    return !!a.source_id && (clusterOk?.(a.source_id) ?? false)
  }
  if (a.source_type !== 'monitor' || !a.measure) return false
  if (tested[a.measure] !== 'elevated_downwind') return false
  return wasDownwindAtStart(c, wind) === true
}

// ───────────────────────────────────────────────────────── the advisor answer

/** The `upgrade` envelope `POST /advisor` adds on top of `AdvisorReply`. */
interface AdvisorUpgrade {
  pending: boolean
  request_id?: string
  result_url?: string
  model?: string
  reason?: string
}
type AdvisorEnvelope = AdvisorReply & { upgrade?: AdvisorUpgrade }

export interface AdvisorState {
  reply: AdvisorReply | null
  /** True while a better answer is still on its way. Never blocks the screen. */
  upgrading: boolean
  /** Bumped when the model's answer replaces the rules answer, to flash it. */
  revision: number
  error: string | null
}

const POLL_MS = 900
const POLL_MAX = 40

/**
 * Ask once, show the rules answer immediately, then quietly upgrade it in place.
 *
 * There is deliberately no spinner: the backend's first response is already a
 * complete, actionable recommendation. Polling (rather than a second SSE) keeps
 * headless screenshots reachable and survives a reconnect.
 */
export function useAdvisor(alertId: string | null, siteId: string | null): AdvisorState {
  const ask = useAskAdvisor()
  const askRef = useRef(ask)
  askRef.current = ask
  const [state, setState] = useState<AdvisorState>({
    reply: null, upgrading: false, revision: 0, error: null,
  })

  useEffect(() => {
    if (!alertId && !siteId) return
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({ reply: null, upgrading: false, revision: 0, error: null })

    const poll = (url: string, tries: number) => {
      if (dead || tries > POLL_MAX) {
        if (!dead && tries > POLL_MAX) setState((p) => ({ ...p, upgrading: false }))
        return
      }
      timer = setTimeout(() => {
        void fetch(url)
          .then((r) => (r.ok ? r.json() : null))
          .then((snap: { status?: string; reply?: AdvisorReply } | null) => {
            if (dead || !snap) return
            const done = snap.status === 'complete' || snap.status === 'failed'
            if (snap.reply && snap.reply.source === 'llm') {
              setState((p) => ({
                reply: snap.reply as AdvisorReply,
                upgrading: !done,
                revision: p.revision + 1,
                error: null,
              }))
            }
            if (done) setState((p) => ({ ...p, upgrading: false }))
            else poll(url, tries + 1)
          })
          .catch(() => { if (!dead) setState((p) => ({ ...p, upgrading: false })) })
      }, POLL_MS)
    }

    askRef.current
      .mutateAsync({
        ...(alertId ? { alert_id: alertId } : {}),
        ...(siteId ? { site_id: siteId } : {}),
      })
      .then((raw) => {
        if (dead) return
        const env = raw as AdvisorEnvelope
        const pending = !!env.upgrade?.pending
        setState({ reply: env, upgrading: pending, revision: 0, error: null })
        const rid = env.upgrade?.request_id
        if (pending && rid) poll(`${API_BASE}/advisor/${encodeURIComponent(rid)}`, 0)
      })
      .catch((e: Error) => {
        if (!dead) setState({ reply: null, upgrading: false, revision: 0, error: e.message })
      })

    return () => { dead = true; if (timer) clearTimeout(timer) }
  }, [alertId, siteId])

  return state
}

// ─────────────────────────────────────────────────────────── presentational

export function Caps({ children, ink }: { children: ReactNode; ink?: boolean }) {
  return <span className={ink ? `${s.caps} ${s.capsInk}` : s.caps}>{children}</span>
}

export function Tag({ tone, children, title }: { tone?: 'threat' | 'accent'; children: ReactNode; title?: string }) {
  const cls = tone === 'threat' ? `${s.tag} ${s.tagThreat}`
    : tone === 'accent' ? `${s.tag} ${s.tagAccent}` : s.tag
  return <span className={cls} title={title}>{children}</span>
}

export function Readout({
  label, value, unit, tone, big,
}: {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  tone?: 'threat' | 'accent'
  big?: boolean
}) {
  const color = tone === 'threat' ? 'var(--threat)' : tone === 'accent' ? 'var(--scope)' : undefined
  return (
    <div className={s.readout}>
      <span className={`${s.readoutValue} num${big ? ` ${s.readoutBig}` : ''}`} style={{ color }}>
        {value}
        {unit ? <span className={s.caps} style={{ marginLeft: 4 }}>{unit}</span> : null}
      </span>
      <Caps>{label}</Caps>
    </div>
  )
}

export function Panel({
  title, aside, children, bodyClass, className,
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  bodyClass?: string
  className?: string
}) {
  return (
    <section className={className ? `${s.panel} ${className}` : s.panel}>
      {title ? (
        <header className={s.panelHead}>
          <Caps>{title}</Caps>
          <span className={s.spacer} />
          {aside}
        </header>
      ) : null}
      <div className={bodyClass ? `${s.panelBody} ${bodyClass}` : s.panelBody}>{children}</div>
    </section>
  )
}

/** Severity as glyph + label + colour — never colour alone. */
export function Sev({ severity }: { severity: Severity }) {
  return (
    <span className={s.triBadge} style={{ color: severityVar(severity) }}>
      {SEVERITY_GLYPH[severity]} {SEVERITY_LABEL[severity]}
    </span>
  )
}

/** Percent of a value against a limit, guarded — used for the fenceline read. */
export function ratio(value: number | null, ref: number | null): number | null {
  if (value == null || ref == null || ref === 0) return null
  return value / ref
}

export function fmtRatio(r: number | null): string {
  return r == null ? '—' : `${fmtNum(r, 2)}×`
}

export const styles = s

// ─────────────────────────────────────────────────────── geometry helpers

/** A circle on the ground, as a lon/lat ring. */
function ringPath(lon: number, lat: number, radiusM: number, n = 72): Position[] {
  const out: Position[] = []
  const mLat = 110540
  const mLon = 111320 * Math.cos((lat * Math.PI) / 180)
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2
    out.push([lon + (radiusM * Math.sin(a)) / mLon, lat + (radiusM * Math.cos(a)) / mLat])
  }
  return out
}

/** A bbox around a point, in degrees, for a local segment fetch. */
export function bboxAround(center: Position, radiusM: number): BBox {
  const [lon, lat] = center
  const dLat = radiusM / 110540
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180))
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat]
}

/** Bearing and range from a point, in metres and compass degrees. */
export function bearingFrom(
  origin: Position, lon: number, lat: number,
): { distanceM: number; bearing: number } {
  const mLon = 111320 * Math.cos((origin[1] * Math.PI) / 180)
  const dx = (lon - origin[0]) * mLon
  const dy = (lat - origin[1]) * 110540
  return {
    distanceM: Math.hypot(dx, dy),
    bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360,
  }
}

// ───────────────────────────────────────────── today's plume, as the server draws it

type PlumeData = DispersionPlumeOutlined | DispersionPlume | null | undefined
const featuresOf = (data: PlumeData): DispersionFeature[] => (data?.features ?? []) as DispersionFeature[]

/** The site's band properties — reach, envelope, stability — or undefined. */
export function plumeFacts(data: PlumeData): DispersionProps | undefined {
  return featuresOf(data).find(isBandFeature)?.properties
}

/**
 * Anything drawn past the detection envelope? The outline's `beyond` part when
 * the server sends it, else a band flagged `beyond_envelope`. The dashes alone
 * are not a caption: CONTRACT §10b requires the legend line with them.
 */
export function plumeHasBeyond(data: PlumeData): boolean {
  return featuresOf(data).some((f) => (isOutlineFeature(f)
    ? f.properties.part === 'beyond'
    : isBandFeature(f) && Boolean(f.properties.beyond_envelope)))
}

/** The plume's axis as the server draws it: origin, transport bearing, envelope. */
function plumeAxis(data: PlumeData): { origin: Position; toward: number; envelope: number } | null {
  const feats = featuresOf(data)
  const axis = feats.find(isAxisFeature)
  const band = feats.find(isBandFeature)?.properties
  const origin = axis?.geometry.coordinates?.[0] as Position | undefined
  const dir = axis?.properties.wind_dir_deg ?? band?.wind_dir_deg
  const envelope = axis?.properties.envelope_m ?? band?.detection_envelope_m
  if (!origin || dir == null || envelope == null) return null
  return { origin, toward: (dir + 180) % 360, envelope }
}

/** Every outer ring of a polygon feature, whatever its declared type says. */
function outerRings(f: DispersionFeature): Position[][] {
  const g = f.geometry as { type: string; coordinates: unknown }
  if (g.type === 'LineString') return []
  const polys = (g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) as Position[][][]
  return polys.map((poly) => poly?.[0]).filter((r): r is Position[] => !!r?.length)
}

/**
 * Where a point sits against today's plume: `inside` (the solid part — inside
 * the detection envelope and within the reportable 4,200 m), `beyond` (under
 * the dashed, model-only part), or null (outside the outline).
 *
 * Only `inside` counts as "downwind now". Measured by scanning the outline
 * every 3 h from Aug 14 to Aug 28: 15 moments put a DRAQA monitor under the
 * dashed part only — Ridgeline → Riverport Road 6.2–6.3 km out, past the
 * reportable limit — and the old test, which took both parts, lit it at full
 * strength. The dashed part says we do not know (CONTRACT §10b: nothing is
 * judged from it).
 *
 * The server splits each source's cone at the envelope separately, so the
 * `inside` ring runs up to ~140 m past it; the along-axis cut here is the
 * same line the map's clip draws.
 */
export function plumePartAt(data: PlumeData, p: Position): 'inside' | 'beyond' | null {
  const feats = featuresOf(data)
  const ax = plumeAxis(data)
  let along: number | null = null
  let dist: number | null = null
  if (ax) {
    const b = bearingFrom(ax.origin, p[0], p[1])
    dist = b.distanceM
    along = b.distanceM * Math.cos((offAxis(b.bearing, ax.toward) * Math.PI) / 180)
  }
  const limit = Math.min(ax?.envelope ?? REPORTABLE_M, REPORTABLE_M)
  const near = (along == null || along <= limit) && (dist == null || dist <= REPORTABLE_M)
  const hit = (f: DispersionFeature) => outerRings(f).some((ring) => pointInRing(ring, p))

  const outlines = feats.filter(isOutlineFeature)
  if (outlines.length) {
    const inInside = outlines.some((f) => f.properties.part === 'inside' && hit(f))
    const inBeyond = outlines.some((f) => f.properties.part === 'beyond' && hit(f))
    if (inInside && near) return 'inside'
    return inInside || inBeyond ? 'beyond' : null
  }
  const bands = feats.filter(isBandFeature)
  const inNear = bands.some((f) => !f.properties.beyond_envelope && hit(f))
  if (inNear && near) return 'inside'
  return inNear || bands.some(hit) ? 'beyond' : null
}

/**
 * Is a point under the SOLID part of today's plume — the part the map draws
 * as a measurement-range claim? The same outline the reader can see, not the
 * old 35° wedge of unlimited length from the latest wind (which lit Riverport
 * Road 6.3 km out on an afternoon whose plume stopped at 2.2 km).
 */
export function insidePlume(data: PlumeData, p: Position): boolean {
  return plumePartAt(data, p) === 'inside'
}

/**
 * The points the deck's camera fits: the solid part of today's plume, cut at
 * the envelope along the axis, plus its origin. The dashed part is left out
 * on purpose — at night it runs to the model's 8 km limit, and a camera fitted
 * to it shows a campus the size of a stamp.
 */
export function plumeFitPositions(data: PlumeData): Position[] {
  const feats = featuresOf(data)
  const ax = plumeAxis(data)
  const keep = (p: Position) => {
    if (!ax) return true
    const b = bearingFrom(ax.origin, p[0], p[1])
    return b.distanceM * Math.cos((offAxis(b.bearing, ax.toward) * Math.PI) / 180) <= ax.envelope + 50
  }
  const outlines = feats.filter(isOutlineFeature).filter((f) => f.properties.part === 'inside')
  const shapes = outlines.length ? outlines : feats.filter((f) => isBandFeature(f) && !f.properties.beyond_envelope)
  const out = shapes.flatMap(outerRings).flat().filter(keep)
  if (ax) out.push(ax.origin)
  return out
}

// ──────────────────────────────────────────────────────────── map layers

/**
 * The fenceline road, highlighted: the road the envelope is measured on.
 *
 * A phosphor casing drawn UNDER the street grid, so the measured colour of the
 * road stays the only ink on it and the highlight reads as "this one" rather
 * than as a second measurement. The label goes on top in `fencelineLabel`.
 */
export function fencelineCasing(opts: {
  theme: Theme
  segments: SegmentFeature[]
  selected?: boolean
  id?: string
}): LayersList {
  const { theme, segments, selected = false, id = 'fenceline-road' } = opts
  if (!segments.length) return []
  return [
    new PathLayer<SegmentFeature>({
      id,
      data: segments,
      pickable: true,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPath: (f) => f.geometry.coordinates as unknown as Position[],
      getWidth: selected ? 12 : 9,
      getColor: theme.color('scope', selected ? 0.5 : 0.3),
      updateTriggers: { getWidth: selected, getColor: selected },
    }),
  ]
}

/** The fenceline road's name, once, at the middle of its longest run. */
export function fencelineLabel(opts: {
  theme: Theme
  segments: SegmentFeature[]
  text: string
}): LayersList {
  const { theme, segments, text } = opts
  if (!segments.length || !text) return []
  const coords = segments.flatMap((f) => f.geometry.coordinates as unknown as Position[])
  const mid = coords[Math.floor(coords.length / 2)]
  if (!mid) return []
  return [
    new TextLayer<{ p: Position }>({
      id: 'fenceline-road-label',
      data: [{ p: mid }],
      pickable: false,
      getPosition: (d) => d.p,
      getText: () => text,
      getSize: 11,
      getColor: theme.color('scope', 1),
      // To the WEST of the road: the campus and its own label sit east of
      // it, and centred the two labels printed over each other.
      getTextAnchor: 'end',
      getAlignmentBaseline: 'center',
      getPixelOffset: [-12, 0],
      fontFamily: theme.css('font-mono') || 'monospace',
      characterSet: 'auto',
      background: true,
      getBackgroundColor: theme.color('bg', 0.78),
      backgroundPadding: [4, 2],
    }),
  ]
}

/**
 * Alert markers at their real locations. No rings of range, no bearing lines,
 * no plume track: the map is the geometry now, and the RWR that needed those
 * lines to agree with it is retired (D8).
 *
 * FILL MEANS F7 (CONTRACT §10b): a marker is filled only when `isLinked` says
 * the wind at the time and the site's downwind test agree. Everything else is
 * a ring — an ongoing alert a heavier ring, an ended one a lighter one. It
 * used to fill every ongoing alert, so on Aug 4 Delta Forge's resident
 * cluster (its test is `no_detection`) drew as a red disc while every report
 * in it was hollow. Selection is a halo, never fill.
 *
 * One marker per place — Riverport Road's four exceedances sit on one pixel —
 * keeping the most severe. Labelled only when hovered or selected: the panel
 * already names every one of them.
 */
export function alertMarkers(opts: {
  theme: Theme
  alerts: NearAlert[]
  now: CampaignTime
  selectedId?: string | null
  hoveredId?: string | null
  isLinked?: (c: NearAlert) => boolean
  onSelect?: (id: string | null) => void
}): LayersList {
  const { theme, alerts, now, selectedId, hoveredId, isLinked, onSelect } = opts
  const rank = (c: NearAlert) =>
    (c.alert.id === selectedId || c.alert.id === hoveredId ? 100 : 0)
    + (isOngoing(c.alert, now) ? 10 : 0)
    + severityRank(c.alert.severity)
  const byPlace = new Map<string, NearAlert>()
  for (const a of alerts) {
    if (!a.sited || a.alert.lon == null || a.alert.lat == null) continue
    const key = `${a.alert.lon.toFixed(4)}|${a.alert.lat.toFixed(4)}`
    const prev = byPlace.get(key)
    if (!prev || rank(a) > rank(prev)) byPlace.set(key, a)
  }
  const placed = [...byPlace.values()]
  if (!placed.length) return []
  const linked = new Set(placed.filter((c) => isLinked?.(c)).map((c) => c.alert.id))
  const linkKey = [...linked].sort().join(',')
  const tok = (sev: Severity) => (sev === 'critical' || sev === 'warning' ? 'threat' : 'sev-watch')
  const at = (c: NearAlert) => [c.alert.lon as number, c.alert.lat as number] as Position
  const layers: LayersList = [
    new ScatterplotLayer<NearAlert>({
      id: 'deck-alerts',
      data: placed,
      pickable: true,
      stroked: true,
      filled: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: at,
      getRadius: (c) => (c.alert.id === hoveredId ? 7 : 6),
      getFillColor: (c) => theme.color(tok(c.alert.severity), linked.has(c.alert.id) ? 0.45 : 0),
      getLineColor: (c) => theme.color(tok(c.alert.severity), isOngoing(c.alert, now) ? 1 : 0.6),
      getLineWidth: (c) => (isOngoing(c.alert, now) ? 2.2 : 1.2),
      onClick: (info) => onSelect?.((info.object as NearAlert | undefined)?.alert.id ?? null),
      updateTriggers: {
        getRadius: hoveredId, getFillColor: linkKey, getLineColor: now, getLineWidth: now,
      },
    }),
  ]
  const sel = placed.filter((c) => c.alert.id === selectedId)
  if (sel.length) {
    layers.push(new ScatterplotLayer<NearAlert>({
      id: 'deck-alert-halo',
      data: sel,
      pickable: false,
      stroked: true,
      filled: false,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: at,
      getRadius: 11,
      getLineWidth: 1.5,
      getLineColor: theme.color('ink', 0.9),
    }))
  }
  const labelled = placed.filter((c) => c.alert.id === selectedId || c.alert.id === hoveredId)
  if (labelled.length) {
    layers.push(new TextLayer<NearAlert>({
      id: 'deck-alert-labels',
      data: labelled,
      pickable: false,
      getPosition: at,
      getText: (c) => `${whatShort(c.alert)} · ${shortTitle(c.alert)}`,
      getSize: 11,
      getColor: theme.color('ink', 1),
      getPixelOffset: [0, -18],
      getAlignmentBaseline: 'bottom',
      fontFamily: theme.css('font-mono') || 'monospace',
      characterSet: 'auto',
      background: true,
      getBackgroundColor: theme.color('bg', 0.8),
      backgroundPadding: [4, 2],
    }))
  }
  return layers
}

// ─────────────────────────────────────────────── resident reports, placed

export interface PlacedReport {
  concern: Concern
  distanceM: number
  bearing: number
  /** F7: the wind at the time AND the placebo-checked downwind test agree. */
  linked: boolean
}

/** Every report within `radiusM` of this campus, nearest first, with its F7 link. */
export function placeReports(
  origin: Position,
  concerns: Concern[],
  isLinked: (c: Concern) => boolean,
  opts: { radiusM?: number } = {},
): PlacedReport[] {
  const { radiusM = 6000 } = opts
  const out: PlacedReport[] = []
  for (const c of concerns) {
    const { distanceM, bearing } = bearingFrom(origin, c.lon, c.lat)
    if (distanceM > radiusM) continue
    out.push({ concern: c, distanceM, bearing, linked: isLinked(c) })
  }
  return out.sort((a, b) => a.distanceM - b.distanceM)
}

/** Below this zoom a cluster's ground ring is noise on top of the report dots. */
const CLUSTER_RING_ZOOM = 14

/**
 * Resident reports on the map. Filled only when F7 links a report to this
 * site; every other report is hollow. Same data, two weights — the honest way
 * to draw a claim the operator can neither dismiss nor fully own. Selection is
 * a halo: a selected report used to fill at 0.95 whether or not it was linked,
 * so a click made a hollow report read as this site's.
 *
 * Cluster counts go on TOP, above the cluster's own dots. They were drawn
 * under the dots, centred 18 px above the centroid, so at the deck's scale a
 * member dot covered the number and the map showed a stray word "reports".
 */
export function reportsOverlay(opts: {
  theme: Theme
  reports: PlacedReport[]
  clusters: ConcernCluster[]
  /** Map zoom. Cluster rings show from `CLUSTER_RING_ZOOM`; labels thin out below 14. */
  zoom?: number
  selectedId?: string | null
  onSelect?: (id: string | null) => void
}): LayersList {
  const { theme, reports, clusters, zoom, selectedId, onSelect } = opts
  if (!reports.length && !clusters.length) return []
  const layers: LayersList = []

  if (clusters.length && zoom != null && zoom >= CLUSTER_RING_ZOOM) {
    layers.push(new PathLayer<ConcernCluster>({
      id: 'deck-report-clusters',
      data: clusters,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (cl) => ringPath(cl.centroid[0], cl.centroid[1], Math.max(cl.radius_m, 150)),
      getWidth: 1.2,
      getColor: theme.color('actor-community', 0.7),
    }))
  }

  const at = (r: PlacedReport) => [r.concern.lon, r.concern.lat] as Position
  layers.push(new ScatterplotLayer<PlacedReport>({
    id: 'deck-reports',
    data: reports,
    pickable: true,
    stroked: true,
    filled: true,
    radiusUnits: 'pixels',
    lineWidthUnits: 'pixels',
    getPosition: at,
    getRadius: (r) => (r.linked ? 5 : 3.5),
    getFillColor: (r) => theme.color('actor-community', r.linked ? 0.6 : 0),
    getLineColor: (r) => theme.color('actor-community', r.linked ? 0.95 : 0.6),
    getLineWidth: (r) => (r.linked ? 1.5 : 1),
    onClick: (info) => onSelect?.((info.object as PlacedReport | undefined)?.concern.id ?? null),
  }))
  const sel = reports.filter((r) => r.concern.id === selectedId)
  if (sel.length) {
    layers.push(new ScatterplotLayer<PlacedReport>({
      id: 'deck-report-halo',
      data: sel,
      pickable: false,
      stroked: true,
      filled: false,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: at,
      getRadius: 9,
      getLineWidth: 1.5,
      getLineColor: theme.color('ink', 0.9),
    }))
  }

  if (clusters.length) {
    const z = zoom ?? 13
    // `metersPerPixel` counts 256-px tiles; the map's are 512 px, one zoom up.
    const mpp = metersPerPixel(clusters[0].centroid[1], z + 1)
    // Three halos at the campus printed "6 reports" three times over. Below
    // zoom 14 a label that would land within ~60 px of a bigger one is dropped.
    const reachM = z < 14 ? 60 * mpp : 0
    const labelled: { cl: ConcernCluster; dy: number }[] = []
    for (const cl of [...clusters].sort((a, b) => b.count - a.count)) {
      if (labelled.some((k) => bearingFrom(k.cl.centroid, cl.centroid[0], cl.centroid[1]).distanceM < reachM)) continue
      // Clear of the cluster's own dots: above the northernmost member, and
      // never closer than the alert marker the cluster carries at its centroid.
      const northM = reports
        .filter((r) => r.concern.cluster_id === cl.id)
        .reduce((mx, r) => Math.max(mx, (r.concern.lat - cl.centroid[1]) * 110540), 0)
      labelled.push({ cl, dy: -Math.max(14, northM / mpp + 9) })
    }
    layers.push(new TextLayer<{ cl: ConcernCluster; dy: number }>({
      id: 'deck-report-cluster-labels',
      data: labelled,
      pickable: false,
      getPosition: (d) => d.cl.centroid,
      getText: (d) => `${d.cl.count} reports`,
      getSize: 10,
      getColor: theme.color('actor-community', 1),
      getPixelOffset: (d) => [0, d.dy],
      getAlignmentBaseline: 'bottom',
      fontFamily: theme.css('font-mono') || 'monospace',
      characterSet: 'auto',
      background: true,
      getBackgroundColor: theme.color('bg', 0.82),
      backgroundPadding: [4, 2],
      updateTriggers: { getPixelOffset: [z, reports.length] },
    }))
  }

  return layers
}
