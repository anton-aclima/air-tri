/**
 * industry/lib — the pieces every scope screen shares.
 *
 * The operator's whole interface is one question ("what is the problem and
 * where") and one promise ("run at the top of your safe envelope"), so the
 * helpers here are all in service of a one-second read: the worst contact, the
 * envelope number, and an answer that is already on screen before they ask.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import type { LayersList } from 'deck.gl'

import { ALERT_KIND_CODE, ALERT_KIND_LABEL, SEVERITY_GLYPH } from '@/components'
import type { Theme } from '@/components'
import { API_BASE } from '@/core/api'
import { fmtBearing, fmtDistance, fmtDuration, fmtNum } from '@/core/format'
import { SEVERITY_LABEL, severityRank, severityVar } from '@/core/measures'
import { useActiveSite, useAskAdvisor, useBootstrapSites, useCampaignInfo, useOrgs } from '@/core/queries'
import { roleMeta } from '@/core/roles'
import { useDemoClock, useSession } from '@/core/session'
import type {
  Alert, AdvisorReply, BBox, Concern, ConcernCluster, DispersionModel,
  Envelope as EnvelopeT, EnvelopeState, IndustrySite, Monitor,
  Position, Severity,
} from '@/core/types'

import s from './industry.module.css'

// ─────────────────────────────────────────────────────────────── the site lock

/**
 * The scope is always locked onto ONE site: the one this persona's org owns.
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
      // A stale lock on another company's site loses to the persona's org.
      if (picked && (!orgId || picked.org_id === orgId)) return picked
    }
    return (orgId ? sites.find((x) => x.org_id === orgId) : undefined) ?? fallbackSite
  }, [siteId, sites, orgId, fallbackSite])

  useEffect(() => {
    if (site && siteId !== site.id) setSite(site.id)
  }, [site, siteId, setSite])

  return site
}

// ─────────────────────────────────────────────────────────────────── contacts

export interface Contact {
  alert: Alert
  bearing: number
  distance: number
  code: string
  kindLabel: string
  glyph: string
}

const SEV_ORDER: Severity[] = ['critical', 'warning', 'watch', 'info']

/** Threat-first ordering: severity, then range. Nothing else. */
export function toContacts(alerts: Alert[] | undefined): Contact[] {
  return (alerts ?? [])
    .map((a) => ({
      alert: a,
      bearing: a.bearing_deg ?? 0,
      distance: a.distance_m ?? 0,
      code: ALERT_KIND_CODE[a.kind] ?? a.kind.slice(0, 4).toUpperCase(),
      kindLabel: ALERT_KIND_LABEL[a.kind] ?? a.kind,
      glyph: SEVERITY_GLYPH[a.severity],
    }))
    .sort(
      (a, b) =>
        severityRank(b.alert.severity) - severityRank(a.alert.severity) ||
        a.distance - b.distance,
    )
}

export function worstContact(contacts: Contact[]): Contact | undefined {
  return contacts[0]
}

export function countBySeverity(contacts: Contact[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, warning: 0, watch: 0, info: 0 }
  for (const c of contacts) out[c.alert.severity] += 1
  return out
}

export function severityCountLine(counts: Record<Severity, number>): string {
  return SEV_ORDER.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${SEVERITY_LABEL[k].toUpperCase()}`)
    .join(' · ')
}

/** "NO2 · W 260° · 430 m · up 24 m" — the whole contact in one line. */
export function contactLine(c: Contact, now?: Date): string {
  const measure = c.alert.measure ? c.alert.measure.toUpperCase() : c.kindLabel
  return [
    measure,
    fmtBearing(c.bearing),
    fmtDistance(c.distance, 1),
    `up ${upFor(c.alert, now)}`,
  ].join('  ·  ')
}

/** How long a contact has been up, in words a glance can finish. */
export function upFor(alert: Alert, now?: Date): string {
  const end = alert.ended_at ? new Date(alert.ended_at) : (now ?? new Date())
  return fmtDuration(end.getTime() - new Date(alert.started_at).getTime())
}

// ───────────────────────────────────────────────────── a stable time window

/**
 * `timeRange()` in `core/session` re-derives `to` from `new Date()` on every
 * call, so any hook that defaults its window (`useWind`, `useWindField`,
 * `useMobileWind`, `useMonitorReadings`, `useFleet`, `useDispersion`) gets a new
 * query key on EVERY RENDER and refetches forever. Quantising the window to a
 * bucket makes the key stable, which is the difference between a wind field
 * that renders and a request storm that never settles.
 */
export function useStableWindow(hours = 24, bucketMin = 5): { from: string; to: string } {
  const cursor = useSession((x) => x.time.cursor)
  const bucketMs = bucketMin * 60_000
  const [tick, setTick] = useState(() => Math.floor(Date.now() / bucketMs))
  useEffect(() => {
    const t = setInterval(() => setTick(Math.floor(Date.now() / bucketMs)), 30_000)
    return () => clearInterval(t)
  }, [bucketMs])
  return useMemo(() => {
    const end = cursor ? new Date(cursor) : new Date(tick * bucketMs)
    return {
      from: new Date(end.getTime() - hours * 3_600_000).toISOString(),
      to: end.toISOString(),
    }
  }, [cursor, tick, bucketMs, hours])
}

/**
 * The WHOLE campaign, as a query window — for anything comparing a filed model
 * against the campaign's measured record.
 *
 * `useStableWindow` above is anchored to the wall clock, which is right for
 * "what is happening now" and wrong for "was the consultant's study correct".
 * `/sites/{id}/model-verification` defaults to the last 30 days ending at
 * `domain.data_now`, and `data_now` returns `max(latest_row, wall_clock)` — so
 * once the machine's clock runs past the end of the generated data, that
 * default window slides off the record a day at a time.
 *
 * Measured 2026-09-10, with data ending 2026-08-28: the default window saw
 * 6,346 of 28,324 fleet wind observations and returned `consistent` for ALL
 * THREE sites. The same call over the campaign returns `understates`, +5.8
 * points on the SW bearing, over Boxtown and White Chapel. The flagship
 * "verify your consultant" claim was switched off by a default parameter, and
 * it degrades further every day — past 2026-09-28 the window holds no
 * observations at all.
 *
 * Anchored to `campaign.start_date`/`end_date` rather than to literal dates so
 * a rebuild with a different `--now` still asks the right question.
 */
export function useCampaignWindow(): { from: string; to: string } | undefined {
  const campaign = useCampaignInfo()
  const start = campaign?.start_date
  const end = campaign?.end_date
  return useMemo(
    () => (start && end ? { from: `${start}T00:00:00Z`, to: `${end}T23:59:59Z` } : undefined),
    [start, end],
  )
}

/**
 * The scope carries one contact per real threat, not one per tripped rule. A
 * watch and a warning from the same instrument for the same pollutant are the
 * same problem seen twice; folding them keeps the dial readable and the count
 * honest. The folded rows are still reachable from the contact list.
 */
export function foldContacts(contacts: Contact[]): { contacts: Contact[]; folded: number } {
  const byKey = new Map<string, Contact>()
  for (const c of contacts) {
    const key = `${c.alert.source_id ?? `${c.bearing.toFixed(0)}|${c.distance.toFixed(0)}`}|${c.alert.measure ?? c.alert.kind}`
    const prev = byKey.get(key)
    if (!prev || severityRank(c.alert.severity) > severityRank(prev.alert.severity)) byKey.set(key, c)
  }
  const kept = [...byKey.values()].sort(
    (a, b) => severityRank(b.alert.severity) - severityRank(a.alert.severity) || a.distance - b.distance,
  )
  return { contacts: kept, folded: contacts.length - kept.length }
}

/** "FENCELINE E" — the place, not the rule that fired. Titles all start alike. */
export function shortTitle(a: Alert): string {
  if (a.kind === 'wind_shift') return 'Dispersion study vs measured wind'
  const at = a.title.split(/ at /i)
  if (at.length > 1) return at[at.length - 1]
  return a.title.replace(/^Community concern cluster · /, '').replace(/^Observed wind diverges from /, '')
}

// ────────────────────────────────────────────────────────────── the envelope

export interface EnvelopeRead {
  /** Which regime this reading describes. */
  regime: 'unstable' | 'neutral' | 'stable'
  state: EnvelopeState
  /** One line for the big readout. Never a bare number without its condition. */
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

const REGIME_WORD: Record<string, string> = {
  unstable: 'well-mixed air',
  neutral: 'neutral air',
  stable: 'stable air',
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
 */
export function envelopeRead(
  env: EnvelopeT | undefined,
  regime: 'unstable' | 'neutral' | 'stable',
): EnvelopeRead | null {
  const r = env?.regimes.find((x) => x.regime === regime)
  if (!env || !r) return null
  const word = REGIME_WORD[regime] ?? regime
  const watch = r.thresholds.length
    ? r.thresholds.reduce((a, b) => (a.threshold <= b.threshold ? a : b))
    : null
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
    headline = 'Clear'
    detail = `In ${word} your fenceline is not measurably different from comparable roads `
      + `elsewhere. ${r.n_fenceline} passes over ${r.n_episodes} episodes.`
  } else if (binding && capMw != null && env.load_mw != null) {
    headline = `${fmtNum(capMw, 0)} MW`
    detail = `In ${word} the air has room for about ${fmtNum(capMw, 0)} MW against the `
      + `${watch?.threshold} ${watch?.unit} ${watch?.severity} level. You are running `
      + `${fmtNum(env.load_mw, 0)}.`
  } else if (binding && cutPct != null) {
    headline = `−${fmtNum(cutPct, 0)}%`
    detail = `In ${word} about ${fmtNum(cutPct, 0)}% of your own contribution has to go to `
      + `hold the ${watch?.threshold} ${watch?.unit} level.`
  } else {
    headline = 'Clear'
    detail = `In ${word} your fenceline runs about ${fmtNum(r.excess ?? 0, 0)} ${env.unit} `
      + `over comparable roads and crosses no action level.`
  }

  return {
    regime, state: r.state, headline, detail, cutPct, capMw,
    loadMw: env.load_mw, binding,
    shareOfHours: r.share_of_hours, episodes: r.n_episodes,
  }
}

/** Pasquill class -> the regime the envelope is reported in. */
export function regimeOf(stability: string | null | undefined): 'unstable' | 'neutral' | 'stable' {
  const c = (stability ?? 'D').toUpperCase()
  if (c === 'A' || c === 'B') return 'unstable'
  if (c === 'E' || c === 'F') return 'stable'
  return 'neutral'
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

export function Tag({ tone, children }: { tone?: 'threat' | 'accent'; children: ReactNode }) {
  const cls = tone === 'threat' ? `${s.tag} ${s.tagThreat}`
    : tone === 'accent' ? `${s.tag} ${s.tagAccent}` : s.tag
  return <span className={cls}>{children}</span>
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
      {SEVERITY_GLYPH[severity]} {SEVERITY_LABEL[severity].toUpperCase()}
    </span>
  )
}

/** The demo's clock. Honours a pinned simulation cursor — see `useDemoClock`. */
export function useNowTick(ms = 1000): Date {
  return useDemoClock(ms)
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

export function useSelectedContact(contacts: Contact[]): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(null)
  const resolved = useMemo(
    () => (id && contacts.some((c) => c.alert.id === id) ? id : null),
    [id, contacts],
  )
  return [resolved, setId]
}

// ───────────────────────────────────────────────────── the MFD radar overlay

/**
 * The RWR's geometry, drawn on the moving map.
 *
 * The scope answers "which way and how far" but deliberately shows nothing
 * else — that is what makes it readable in one second and what makes it
 * useless the moment you need to know *what is actually there*. The MFD keeps
 * the same geometry (range rings centred on you, a bearing line to every
 * contact) and puts it over real ground, so the two instruments read as one
 * system rather than two unrelated pictures of the same air.
 *
 * Rings are hairlines and lines are thin on purpose: this sits on top of the
 * road grid and the site, and it must not compete with them.
 */
export function radarOverlay(opts: {
  theme: Theme
  origin: Position
  contacts: Contact[]
  selectedId?: string | null
  ranges?: number[]
  /** Where the wind is carrying, degrees. Draws the plume track. */
  transportDeg?: number | null
  trackM?: number
  onSelect?: (id: string | null) => void
}): LayersList {
  const {
    theme, origin, contacts, selectedId, onSelect,
    // Out to 6 km, because that is where the regulator's instruments are. The
    // fenceline exists so the operator never trips those; a scope that stops at
    // 3 km cannot show the thing they are actually managing against.
    ranges = [1000, 2000, 4000, 6000],
    transportDeg = null, trackM = 9000,
  } = opts
  const [olon, olat] = origin
  const layers: LayersList = []

  layers.push(new PathLayer<{ path: Position[] }>({
    id: 'mfd-rings',
    data: ranges.map((r) => ({ path: ringPath(olon, olat, r) })),
    pickable: false,
    widthUnits: 'pixels',
    getPath: (d) => d.path,
    getWidth: 1,
    getColor: theme.color('scope-dim', 0.55),
  }))

  layers.push(new TextLayer<{ r: number }>({
    id: 'mfd-ring-labels',
    data: ranges.map((r) => ({ r })),
    pickable: false,
    getPosition: (d) => [olon, olat + d.r / 110540] as Position,
    getText: (d) => `${(d.r / 1000).toFixed(0)} km`,
    getSize: 10,
    getColor: theme.color('ink-3', 0.9),
    getPixelOffset: [0, -7],
    fontFamily: theme.css('font-mono') || 'monospace',
    characterSet: 'auto',
    background: true,
    getBackgroundColor: theme.color('bg', 0.6),
    backgroundPadding: [3, 1],
  }))

  // Where this site's plume is going right now.
  //
  // This is the operator's actual question. Not "am I over a limit" -- they run
  // a fenceline precisely so they never get that far -- but "is the wind
  // pointing me at somebody's reference instrument this afternoon". Dashed,
  // because it is derived from the observed wind rather than measured along it.
  if (transportDeg != null && Number.isFinite(transportDeg)) {
    layers.push(new PathLayer<{ path: Position[] }>({
      id: 'mfd-track',
      data: dashes(olon, olat, transportDeg, trackM),
      pickable: false,
      widthUnits: 'pixels',
      getPath: (d) => d.path,
      getWidth: 1.5,
      getColor: theme.color('accent-2', 0.5),
    }))
    const [tlon, tlat] = project(olon, olat, transportDeg, trackM * 0.55)
    layers.push(new TextLayer<{ p: Position }>({
      id: 'mfd-track-label',
      data: [{ p: [tlon, tlat] }],
      pickable: false,
      getPosition: (d) => d.p,
      getText: () => 'PLUME TRACK',
      getSize: 9,
      getColor: theme.color('accent-2', 0.85),
      fontFamily: theme.css('font-mono') || 'monospace',
      characterSet: 'auto',
      background: true,
      getBackgroundColor: theme.color('bg', 0.7),
      backgroundPadding: [4, 2],
    }))
  }

  const placed = contacts.filter(
    (c) => c.alert.lon != null && c.alert.lat != null,
  )
  if (!placed.length) return layers

  // A bearing line, not a great circle: over three kilometres the difference is
  // invisible and a straight line is what the scope draws.
  layers.push(new PathLayer<Contact>({
    id: 'mfd-bearings',
    data: placed,
    pickable: false,
    widthUnits: 'pixels',
    getPath: (c) => [origin, [c.alert.lon as number, c.alert.lat as number]] as Position[],
    getWidth: (c) => (c.alert.id === selectedId ? 2 : 1),
    getColor: (c) => theme.color(
      severityToken(c.alert.severity),
      c.alert.id === selectedId ? 0.9 : 0.4,
    ),
    updateTriggers: { getWidth: selectedId, getColor: selectedId },
  }))

  layers.push(new ScatterplotLayer<Contact>({
    id: 'mfd-contacts',
    data: placed,
    pickable: true,
    stroked: true,
    filled: true,
    radiusUnits: 'pixels',
    lineWidthUnits: 'pixels',
    getPosition: (c) => [c.alert.lon as number, c.alert.lat as number] as Position,
    getRadius: (c) => (c.alert.id === selectedId ? 9 : 6),
    getFillColor: (c) => theme.color(severityToken(c.alert.severity), 0.28),
    getLineColor: (c) => theme.color(severityToken(c.alert.severity), 1),
    getLineWidth: 1.6,
    onClick: (info) => onSelect?.((info.object as Contact | undefined)?.alert.id ?? null),
    updateTriggers: { getRadius: selectedId, getFillColor: selectedId },
  }))

  // Only the designated contact is labelled. Nine fenceline sensors sit within a
  // few hundred metres of each other, so labelling all of them stacked six
  // unreadable chips on the same pixel and buried the site underneath. The rail
  // already lists every contact by name; the map only has to say which one is
  // selected.
  const labelled = placed.filter((c) => c.alert.id === selectedId)
  if (!labelled.length) return layers

  layers.push(new TextLayer<Contact>({
    id: 'mfd-contact-labels',
    data: labelled,
    pickable: false,
    getPosition: (c) => [c.alert.lon as number, c.alert.lat as number] as Position,
    getText: (c) => (c.alert.measure ? c.alert.measure.toUpperCase() : c.code),
    getSize: 10,
    getColor: (c) => theme.color(severityToken(c.alert.severity), 1),
    getPixelOffset: [0, -14],
    fontFamily: theme.css('font-mono') || 'monospace',
    characterSet: 'auto',
    background: true,
    getBackgroundColor: theme.color('bg', 0.72),
    backgroundPadding: [4, 2],
  }))

  return layers
}

function severityToken(sev: Severity): string {
  return sev === 'critical' || sev === 'warning' ? 'threat' : 'sev-watch'
}

/** Move `distM` along `bearing` from a lon/lat. */
function project(lon: number, lat: number, bearing: number, distM: number): Position {
  const a = (bearing * Math.PI) / 180
  return [
    lon + (distM * Math.sin(a)) / (111320 * Math.cos((lat * Math.PI) / 180)),
    lat + (distM * Math.cos(a)) / 110540,
  ]
}

/** A dashed ray, as a list of short paths — deck.gl has no dash pattern. */
function dashes(
  lon: number, lat: number, bearing: number, lengthM: number,
  dashM = 260, gapM = 190,
): { path: Position[] }[] {
  const out: { path: Position[] }[] = []
  for (let d = 0; d < lengthM; d += dashM + gapM) {
    out.push({ path: [project(lon, lat, bearing, d), project(lon, lat, bearing, Math.min(d + dashM, lengthM))] })
  }
  return out
}

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

export interface DownwindHit {
  monitor: Monitor
  distanceM: number
  bearing: number
  /** Degrees between the plume track and the instrument. */
  offAxis: number
}

/**
 * Which reference instruments lie in this site's plume track.
 *
 * The half-angle is deliberately generous. A plume is not a laser and the
 * operator is not trying to decide whether they are *definitely* being measured
 * — they are deciding whether today is a day to hold the load. Being roughly
 * pointed at a regulator's instrument is the whole signal.
 */
export function downwindOf(
  origin: Position, monitors: Monitor[], transportDeg: number | null | undefined,
  halfAngle = 35,
): DownwindHit[] {
  if (transportDeg == null || !Number.isFinite(transportDeg)) return []
  const [olon, olat] = origin
  const mLon = 111320 * Math.cos((olat * Math.PI) / 180)
  const hits: DownwindHit[] = []
  for (const m of monitors) {
    const dx = (m.lon - olon) * mLon
    const dy = (m.lat - olat) * 110540
    const distanceM = Math.hypot(dx, dy)
    if (distanceM < 50) continue
    const bearing = (Math.atan2(dx, dy) * 180) / Math.PI
    const b = (bearing + 360) % 360
    const offAxis = Math.abs(((b - transportDeg + 180) % 360 + 360) % 360 - 180)
    if (offAxis <= halfAngle) hits.push({ monitor: m, distanceM, bearing: b, offAxis })
  }
  return hits.sort((a, b) => a.distanceM - b.distanceM)
}

// ─────────────────────────────────────────────── performance bars

/**
 * A horizontal performance bar.
 *
 * This started as a vertical tape read like an N1 gauge, and the metaphor was
 * right: the operator lives near the top of the green and watches the redline.
 * But a tape needs a narrow column of its own, and that column pushed the wind
 * panel off the screen. Turned on its side, the same instrument shares a column
 * with the wind and gains room for a real number and a caption.
 *
 * What survives from the tape is what mattered: graduations, a redline band you
 * are not meant to enter, and a marker at the current value. A progress bar has
 * none of those — and progress is the wrong verb, because this is something you
 * want to sit just below rather than complete.
 */
export function Gauge(props: {
  label: string
  value: number | null | undefined
  max: number
  redline?: number
  readout: string
  sub?: string
  over?: boolean
}): ReactNode {
  const { label, value, max, redline, readout, sub, over = false } = props
  const frac = value == null || !Number.isFinite(value)
    ? null
    : Math.max(0, Math.min(1, value / max))
  const redFrac = redline == null ? null : Math.max(0, Math.min(1, redline / max))

  return (
    <div className={s.gauge}>
      <div className={s.gaugeHead}>
        <span className={s.gaugeLabel}>{label}</span>
        <span className={`${s.gaugeValue} num${over ? ` ${s.gaugeValueOver}` : ''}`}>{readout}</span>
      </div>
      <div className={s.gaugeTrack} role="img" aria-label={`${label} ${readout}`}>
        {frac != null && (
          <div
            className={`${s.gaugeFill}${over ? ` ${s.gaugeFillOver}` : ''}`}
            style={{ inlineSize: `${frac * 100}%` }}
          />
        )}
        {/* Over the fill, not under it. Beneath, a red fill hid the band
            completely and the bar read as uniformly red — losing the one thing
            it exists to show, which is where the line actually is. */}
        {redFrac != null && (
          <div className={s.gaugeRed} style={{ insetInlineStart: `${redFrac * 100}%` }} />
        )}
        <div className={s.gaugeTicks} aria-hidden />
        {frac != null && (
          <div
            className={`${s.gaugeNeedle}${over ? ` ${s.gaugeNeedleOver}` : ''}`}
            style={{ insetInlineStart: `${frac * 100}%` }}
          />
        )}
      </div>
      {sub ? <span className={s.gaugeSub}>{sub}</span> : null}
    </div>
  )
}

// ────────────────────────────────────────────── the two different "models"

/**
 * The consultant's permit study, drawn as an outline on the map.
 *
 * There are two dispersion pictures in this product and they are not the same
 * object, which is confusing until it is labelled:
 *
 *   PERMIT — this one. The consultant's deliverable, contoured from the wind
 *            rose they *assumed*, integrated over every sector. It is a
 *            long-run average footprint, so it comes out as one smooth lobe
 *            around the whole site and it does not move with today's weather.
 *
 *   PLUME  — `GET /wind/dispersion`. A cone per active stack at *this hour's*
 *            wind, banded by concentration. Many small shapes, one per emission
 *            point, reaching a kilometre or two — which is what a near-field
 *            plume actually does at 3 m/s.
 *
 * Drawing them together is the point: when today's cones fall outside the
 * permit lobe, the study under-predicts that direction, and the operator can
 * see the thing the `MODEL UNDERSTATES` verdict is asserting.
 *
 * Outline only, no fill — an assumption should not look like a measurement.
 */
export function permitFootprintLayer(opts: {
  theme: Theme
  contours: DispersionModel['contours'] | null | undefined
  id?: string
}): LayersList {
  const { theme, contours, id = 'permit' } = opts
  if (!contours?.length) return []

  type Ring = { ring: Position[]; band: number }
  const rings: Ring[] = []
  for (const c of contours) {
    const g = c.geometry
    if (g.type === 'Polygon') {
      for (const r of g.coordinates) rings.push({ ring: r as Position[], band: c.band })
    } else if (g.type === 'MultiPolygon') {
      for (const poly of g.coordinates) {
        for (const r of poly) rings.push({ ring: r as Position[], band: c.band })
      }
    }
  }
  if (!rings.length) return []

  return [
    new PolygonLayer<Ring>({
      id: `${id}-fill`,
      data: rings,
      pickable: false,
      stroked: true,
      filled: true,
      lineWidthUnits: 'pixels',
      getPolygon: (d) => d.ring,
      // Barely there. The outline carries it; the wash only keeps the shape
      // readable where it crosses the road grid.
      getFillColor: theme.color('accent-2', 0.05),
      getLineColor: (d) => theme.color('accent-2', d.band === 0 ? 0.85 : 0.45),
      getLineWidth: (d) => (d.band === 0 ? 1.6 : 1),
    }),
  ]
}

// ─────────────────────────────────────────────── community reports, placed

export interface PlacedReport {
  concern: Concern
  distanceM: number
  bearing: number
  /** Within `halfAngle` of where the wind is actually carrying. */
  downwind: boolean
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

/**
 * Place every report relative to this campus and say whether it is downwind.
 *
 * The operator's fenceline and their consultant's model already describe their
 * emissions. Reports are the signal they do *not* have — but only some of them
 * are plausibly theirs, and a screen that implies every neighbour is their fault
 * is one they will stop trusting. Wind at the time decides, and the ones that
 * fail the test are still drawn, just quietly.
 */
export function placeReports(
  origin: Position,
  concerns: Concern[],
  transportDeg: number | null | undefined,
  opts: { radiusM?: number; halfAngle?: number } = {},
): PlacedReport[] {
  const { radiusM = 6000, halfAngle = 40 } = opts
  const out: PlacedReport[] = []
  for (const c of concerns) {
    const { distanceM, bearing } = bearingFrom(origin, c.lon, c.lat)
    if (distanceM > radiusM) continue
    const downwind = transportDeg == null || !Number.isFinite(transportDeg)
      ? false
      : Math.abs((((bearing - transportDeg + 180) % 360) + 360) % 360 - 180) <= halfAngle
    out.push({ concern: c, distanceM, bearing, downwind })
  }
  return out.sort((a, b) => a.distanceM - b.distanceM)
}

/**
 * Resident reports on the moving map, split by whether the wind points at them.
 *
 * Downwind reports are filled and labelled; the rest are hollow. Same data, two
 * weights — which is the honest way to draw a claim the operator can neither
 * dismiss nor fully own.
 */
export function reportsOverlay(opts: {
  theme: Theme
  reports: PlacedReport[]
  clusters: ConcernCluster[]
  selectedId?: string | null
  onSelect?: (id: string | null) => void
}): LayersList {
  const { theme, reports, clusters, selectedId, onSelect } = opts
  if (!reports.length && !clusters.length) return []
  const layers: LayersList = []

  if (clusters.length) {
    layers.push(new PathLayer<ConcernCluster>({
      id: 'mfd-report-clusters',
      data: clusters,
      pickable: false,
      widthUnits: 'pixels',
      getPath: (cl) => ringPath(cl.centroid[0], cl.centroid[1], Math.max(cl.radius_m, 150)),
      getWidth: 1.2,
      getColor: theme.color('actor-community', 0.7),
    }))
    layers.push(new TextLayer<ConcernCluster>({
      id: 'mfd-report-cluster-labels',
      data: clusters,
      pickable: false,
      getPosition: (cl) => cl.centroid,
      getText: (cl) => `${cl.count} REPORTS`,
      getSize: 9,
      getColor: theme.color('actor-community', 0.95),
      getPixelOffset: [0, -10],
      fontFamily: theme.css('font-mono') || 'monospace',
      characterSet: 'auto',
      background: true,
      getBackgroundColor: theme.color('bg', 0.72),
      backgroundPadding: [4, 2],
    }))
  }

  layers.push(new ScatterplotLayer<PlacedReport>({
    id: 'mfd-reports',
    data: reports,
    pickable: true,
    stroked: true,
    filled: true,
    radiusUnits: 'pixels',
    lineWidthUnits: 'pixels',
    getPosition: (r) => [r.concern.lon, r.concern.lat] as Position,
    getRadius: (r) => (r.concern.id === selectedId ? 7 : r.downwind ? 5 : 3.5),
    getFillColor: (r) => theme.color(
      'actor-community',
      r.concern.id === selectedId ? 0.95 : r.downwind ? 0.55 : 0.06,
    ),
    getLineColor: (r) => theme.color('actor-community', r.downwind ? 0.95 : 0.4),
    getLineWidth: (r) => (r.downwind ? 1.5 : 1),
    onClick: (info) => onSelect?.((info.object as PlacedReport | undefined)?.concern.id ?? null),
    updateTriggers: {
      getRadius: selectedId, getFillColor: selectedId, getLineColor: selectedId,
    },
  }))

  return layers
}
