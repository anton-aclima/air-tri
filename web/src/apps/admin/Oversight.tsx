/**
 * SHEET 06 — /admin/oversight · Everything everyone did.
 *
 * This is the only screen in the product where all three parties are visible at
 * once, and it is built around one idea: take a single event and show it three
 * times — as the community filed it, as the operator answered it, and as the
 * regulator ruled on it. Three lanes, one shared clock, and an asymmetry stated
 * in words underneath, because the asymmetry (industry can propose a mitigation
 * but can never close a concern) is the tension the whole demo is about.
 *
 * The map is the second half of "admins see everything": concerns, clusters,
 * claimed sites and the reference network on one frame, over the road grid.
 */

import { useMemo, useState } from 'react'

import {
  BaseMap, BoundaryLayer, ConcernLayer, LayerToggles, MapOverlay, MapScale,
  MonitorLayer, SegmentLayer, SiteLayer, usePulse, BUBBLE_SPLIT_ZOOM,
} from '@/components'
import { CONCERN_LABEL } from '@/components'
import type { ConcernBubble, MapView } from '@/components'
import { fmtNum, fmtTime, relativeShort } from '@/core/format'
import { useLiveEvents } from '@/core/live'
import { severityVar } from '@/core/measures'
import {
  useActivity, useAdvisories, useAlerts, useBootstrapSites, useCampaignBoundary,
  useCampaignInfo, useClusters, useConcerns, useFeed, useMonitors, usePosts, useSegments,
} from '@/core/queries'
import type { Concern, Role } from '@/core/types'

import {
  ACTOR_VAR, Caps, Sheet, TitleBlock, actorStyle, campaignView, styles as s, useNowTick,
} from './lib'

type LaneKey = 'community' | 'industry' | 'regulator'

interface Entry {
  id: string
  at: string
  title: string
  body?: string | null
  tags: string[]
  severityVar?: string
  ghost?: boolean
}

export function Oversight() {
  const campaign = useCampaignInfo()
  const boundary = useCampaignBoundary(campaign?.id)
  const segments = useSegments({ limit: 2000 })
  // High enough to hold the whole campaign. This screen counts what it fetches
  // and pins every one of them on the map, so a page-sized limit was not a
  // pagination choice — it silently became the headline number (a campaign with
  // 204 reports read "CONCERNS FILED 100") and dropped half the map pins.
  const concerns = useConcerns({ limit: 1000 })
  const clusters = useClusters()
  const posts = usePosts()
  const feed = useFeed({ role: 'admin', limit: 60 })
  const advisories = useAdvisories()
  const alerts = useAlerts({ role: 'admin' })
  const activity = useActivity({ limit: 200 })
  const sites = useBootstrapSites()
  const monitors = useMonitors()
  const events = useLiveEvents()
  const now = useNowTick(20_000)
  const pulse = usePulse(2600)

  const [focus, setFocus] = useState<string | null>(null)
  const [show, setShow] = useState({ grid: true, concerns: true, sites: true, monitors: true })
  // Lifted only so the report layer knows the zoom (it folds at city zoom) and
  // a bubble tap can fly in. Null until the first move: the map starts from
  // `initialView`, which needs the campaign to have loaded.
  const [view, setView] = useState<MapView | null>(null)
  const [actorFilter, setActorFilter] = useState<Role | null>(null)

  const cluster = useMemo(
    () => (clusters.data ?? []).find((c) => c.id === focus) ?? null,
    [clusters.data, focus],
  )

  // ── the three lanes ────────────────────────────────────────────────────
  const laneConcerns = useMemo<Concern[]>(() => {
    const all = concerns.data ?? []
    return (cluster ? all.filter((c) => c.cluster_id === cluster.id) : all)
      .slice()
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
  }, [concerns.data, cluster])

  const concernIds = useMemo(
    () => new Set(laneConcerns.map((c) => c.id)),
    [laneConcerns],
  )

  const community = useMemo<Entry[]>(
    () => laneConcerns.map((c) => ({
      id: c.id,
      at: c.occurred_at,
      title: c.title,
      body: c.body,
      tags: [
        CONCERN_LABEL[c.kind] ?? c.kind,
        `severity ${c.severity}/5`,
        c.district ?? '',
        c.is_anonymous ? 'anonymous' : (c.author?.name ?? ''),
        c.status.replace(/_/g, ' '),
      ].filter(Boolean),
      severityVar: c.status === 'mitigation_proposed' ? ACTOR_VAR.industry : undefined,
    })),
    [laneConcerns],
  )

  const industry = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    for (const p of posts.data ?? []) {
      if (cluster && !(p.concern_id && concernIds.has(p.concern_id))) continue
      out.push({
        id: p.id,
        at: p.created_at,
        title: p.title,
        body: p.body,
        tags: [p.org_name ?? 'operator', p.kind, p.concern_id ? 'answers a concern' : 'unsolicited'],
      })
    }
    for (const item of feed.data ?? []) {
      if (item.type !== 'mitigation') continue
      const m = item.mitigation
      if (cluster && !(m.concern_id && concernIds.has(m.concern_id)) && m.cluster_id !== cluster.id) continue
      out.push({
        id: m.id,
        at: m.created_at,
        title: m.title,
        body: m.body,
        tags: [
          item.site?.name ?? 'site',
          `mitigation · ${m.status}`,
          m.expected_reduction_pct != null ? `−${fmtNum(m.expected_reduction_pct, 0)}% expected` : '',
        ].filter(Boolean),
      })
    }
    // Creating a mitigation mirrors it into a SitePost with the SAME title, so
    // the feed reports the operator's one action twice. Reported; folded here.
    const seen = new Set<string>()
    return out
      .filter((e) => {
        const key = e.title.trim().toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => b.at.localeCompare(a.at))
  }, [posts.data, feed.data, cluster, concernIds])

  const regulator = useMemo<Entry[]>(() => {
    const out: Entry[] = []
    for (const a of advisories.data ?? []) {
      out.push({
        id: a.id,
        at: a.created_at,
        title: a.title,
        body: a.body,
        tags: ['advisory', ...(a.kind === 'advisory' ? [] : [a.kind]), `to ${a.audience.join(' + ')}`],
        severityVar: severityVar(a.severity),
      })
    }
    for (const act of activity.data ?? []) {
      if (act.verb !== 'action_level.updated' && act.verb !== 'action_level.created') continue
      out.push({
        id: `act-${act.id}`,
        at: act.ts,
        title: act.summary ?? act.verb,
        body: 'The backend re-evaluated every alert on this measure immediately.',
        tags: ['action level', act.verb.split('.')[1]],
      })
    }
    for (const a of alerts.data ?? []) {
      if (cluster && a.site_id && cluster.site_id && a.site_id !== cluster.site_id) continue
      if (a.kind !== 'concern_cluster' && cluster) continue
      out.push({
        id: a.id,
        at: a.started_at,
        title: a.title,
        body: a.recommendation,
        tags: [a.kind.replace(/_/g, ' '), a.severity, a.status],
        severityVar: severityVar(a.severity),
        ghost: a.status === 'resolved',
      })
    }
    return out.sort((a, b) => b.at.localeCompare(a.at))
  }, [advisories.data, activity.data, alerts.data, cluster])

  // ── the shared clock under the lanes ──────────────────────────────────
  const marks = useMemo(() => {
    const all: { at: number; role: LaneKey }[] = []
    for (const e of community) all.push({ at: Date.parse(e.at), role: 'community' })
    for (const e of industry) all.push({ at: Date.parse(e.at), role: 'industry' })
    for (const e of regulator) all.push({ at: Date.parse(e.at), role: 'regulator' })
    return all.filter((m) => Number.isFinite(m.at)).sort((a, b) => a.at - b.at)
  }, [community, industry, regulator])

  const span = useMemo(() => {
    if (!marks.length) return null
    const lo = marks[0].at
    const hi = marks[marks.length - 1].at
    return { lo, hi: hi > lo ? hi : lo + 3_600_000 }
  }, [marks])

  const proposed = (concerns.data ?? []).filter((c) => c.status === 'mitigation_proposed')

  const ticker = useMemo(() => {
    const rows = (activity.data ?? [])
      .filter((a) => !actorFilter || a.actor_role === actorFilter)
      .slice(0, 120)
    return rows
  }, [activity.data, actorFilter])

  return (
    <div className={`${s.page} ${s.rowsOversight}`}>
      <TitleBlock
        sheet="oversight"
        subtitle={
          cluster
            ? `Focused on ${cluster.label ?? cluster.id} · ${cluster.count} reports within ${fmtNum(cluster.radius_m, 0)} m`
            : 'Every concern, every operator post, every regulatory action — one clock, three columns.'
        }
        cells={[
          { label: 'concerns', value: fmtNum(concerns.data?.length ?? null, 0) },
          { label: 'operator posts', value: fmtNum(posts.data?.length ?? null, 0) },
          { label: 'reg. actions', value: fmtNum(regulator.length, 0) },
          { label: 'live events', value: fmtNum(events.length, 0), tone: 'accent' },
        ]}
      />

      {/* ── the ledger: what each side has put on the table ─────────── */}
      <div className={s.ledger}>
        <LedgerCell role="community" label="concerns filed" value={fmtNum(concerns.data?.length ?? null, 0)}
          foot={`${(concerns.data ?? []).filter((c) => c.status !== 'resolved' && c.status !== 'closed').length} still open`} />
        <LedgerCell role="community" label="clusters formed" value={fmtNum(clusters.data?.length ?? null, 0)}
          foot="≥3 within 600 m / 24 h" />
        <LedgerCell role="industry" label="sites claimed" value={fmtNum(sites.length, 0)}
          foot={`${sites.filter((x) => x.claimed_by_user_id).length} with an operator`} />
        <LedgerCell role="industry" label="posts + mitigations" value={fmtNum(industry.length, 0)}
          foot={`${proposed.length} concerns answered`} />
        <LedgerCell role="regulator" label="alerts raised" value={fmtNum(alerts.data?.length ?? null, 0)}
          foot={`${(alerts.data ?? []).filter((a) => a.status === 'active').length} active`} />
        <LedgerCell role="regulator" label="advisories" value={fmtNum(advisories.data?.length ?? null, 0)}
          foot={`${monitors.data?.length ?? 0} reference monitors`} />
      </div>

      <div className={s.splitWide}>
        {/* ── everything, on one frame ─────────────────────────────── */}
        <Sheet code="06-A" title="All actors · one map" className={s.mapCard} flat>
          <div className={s.mapBox}>
            <BaseMap
              label="All actors"
              initialView={campaignView(campaign, -0.3)}
              view={view ?? undefined}
              onViewChange={setView}
              layers={(theme) => [
                ...BoundaryLayer({ data: boundary.data, theme, maskStrength: 0.3 }),
                ...(show.grid
                  ? SegmentLayer({
                      data: segments.data,
                      theme,
                      metric: 'persistence',
                      dualEncode: 'none',
                      minPasses: 1,
                      opacity: 0.5,
                      pickable: false,
                    })
                  : []),
                ...(show.monitors
                  ? MonitorLayer({ data: monitors.data, theme, rings: true, labels: false, pulse })
                  : []),
                ...(show.sites
                  ? SiteLayer({ data: sites, theme, labels: true, pulse })
                  : []),
                ...(show.concerns
                  ? ConcernLayer({
                      data: concerns.data,
                      clusters: clusters.data,
                      theme,
                      pulse,
                      labels: true,
                      // The whole record, on purpose — this sheet is "every
                      // concern". It folds by zoom instead of windowing.
                      zoom: view?.zoom ?? campaignView(campaign, -0.3).zoom,
                      onBubbleClick: (info) => {
                        const b = info.object as ConcernBubble | undefined
                        if (!b) return
                        const base = view ?? { ...campaignView(campaign, -0.3), pitch: 0, bearing: 0 }
                        setView({ ...base, longitude: b.position[0], latitude: b.position[1], zoom: Math.max(base.zoom, BUBBLE_SPLIT_ZOOM) })
                      },
                      selectedId: cluster?.id ?? null,
                      onClusterClick: (info) => {
                        const obj = info.object as { id?: string } | null
                        setFocus(obj?.id ?? null)
                      },
                    })
                  : []),
              ]}
            >
              <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
              <MapOverlay place="top-right">
                <LayerToggles
                  title="Everything"
                  items={[
                    { id: 'grid', label: 'Road grid', enabled: show.grid, keyShape: 'line' },
                    { id: 'concerns', label: 'Concerns', enabled: show.concerns, color: ACTOR_VAR.community, keyShape: 'dot', count: concerns.data?.length },
                    { id: 'sites', label: 'Claimed sites', enabled: show.sites, color: ACTOR_VAR.industry, keyShape: 'dot', count: sites.length },
                    { id: 'monitors', label: 'Reference net', enabled: show.monitors, color: ACTOR_VAR.regulator, keyShape: 'dot', count: monitors.data?.length },
                  ]}
                  onToggle={(id, next) => setShow((v) => ({ ...v, [id]: next }))}
                />
              </MapOverlay>
            </BaseMap>
          </div>
        </Sheet>

        {/* ── the cross-examination ────────────────────────────────── */}
        <Sheet
          code="06-B"
          title="The same event, three ways"
          bodyClass={s.sheetBodyFlat}
          aside={
            <div className={s.chips}>
              <button
                type="button"
                className={`${s.chip}${focus === null ? ` ${s.chipOn}` : ''}`}
                onClick={() => setFocus(null)}
              >
                everything
              </button>
              {(clusters.data ?? []).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`${s.chip}${focus === c.id ? ` ${s.chipOn}` : ''}`}
                  onClick={() => setFocus(focus === c.id ? null : c.id)}
                >
                  {c.label ?? c.id}
                </button>
              ))}
            </div>
          }
        >
          <div
            style={{
              position: 'absolute', inset: 0,
              display: 'grid', gridTemplateRows: 'minmax(0, 1fr) auto auto',
            }}
          >
            <div className={s.lanes}>
              <Lane role="community" title="Community" subtitle="filed it" entries={community} now={now} />
              <Lane role="industry" title="Industry" subtitle="answered it" entries={industry} now={now} />
              <Lane role="regulator" title="Regulator" subtitle="ruled on it" entries={regulator} now={now} />
            </div>

            {/* one clock under all three columns */}
            <TimeAxis marks={marks} span={span} />

            <div style={{ padding: 'var(--s-2)' }}>
              <div className={s.asymmetry}>
                <span className={s.asymGlyph} aria-hidden>⚖</span>
                <span className={s.asymText}>
                  {proposed.length
                    ? <>Ridgeline has taken {proposed.length} {proposed.length === 1 ? 'concern' : 'concerns'} to <strong>mitigation proposed</strong> — as far as an operator can go. </>
                    : <>An operator can take a concern as far as <strong>mitigation proposed</strong>. </>}
                  Industry <strong>cannot mark a concern resolved</strong>: the client refuses it and
                  the backend returns 403. Only DRAQA or Aclima can close one. The party being
                  complained about does not get to decide when the complaint is over.
                </span>
              </div>
            </div>
          </div>
        </Sheet>
      </div>

      {/* ── the append-only log ──────────────────────────────────────── */}
      <Sheet
        code="06-C"
        title="Activity log · append-only"
        aside={
          <div className={s.chips}>
            {(['community', 'industry', 'regulator', 'admin'] as Role[]).map((r) => (
              <button
                key={r}
                type="button"
                className={`${s.chip}${actorFilter === r ? ` ${s.chipOn}` : ''}`}
                style={actorFilter === r ? { color: ACTOR_VAR[r], borderColor: ACTOR_VAR[r] } : undefined}
                onClick={() => setActorFilter(actorFilter === r ? null : r)}
              >
                {r}
              </button>
            ))}
            <span className={s.chip}>{ticker.length} rows</span>
          </div>
        }
      >
        <div className={s.ticker}>
          {ticker.length === 0 ? (
            <div className={s.err}>No activity recorded for this filter.</div>
          ) : ticker.map((a) => (
            <div className={s.tickRow} key={a.id}>
              <span className={s.tickTime}>{fmtTime(a.ts)}</span>
              <span
                className={s.tickActor}
                style={{ color: a.actor_role ? ACTOR_VAR[a.actor_role] : 'var(--ink-3)' }}
              >
                {a.actor_role ?? 'system'}
              </span>
              <span className={s.tickText} title={a.summary ?? ''}>
                <span className={s.tickVerb}>{a.verb}</span>{' '}
                {a.summary ?? ''}
              </span>
              <span className={s.tickTime}>{relativeShort(a.ts, now)}</span>
            </div>
          ))}
        </div>
      </Sheet>
    </div>
  )
}

function Lane({
  role, title, subtitle, entries, now,
}: {
  role: LaneKey
  title: string
  subtitle: string
  entries: Entry[]
  now: Date
}) {
  return (
    <div className={s.lane} style={actorStyle(role)}>
      <div className={s.laneHead}>
        <span className={s.laneName}>{title}</span>
        <span className={s.noteDim}>{subtitle}</span>
        <span className={s.laneCount}>{entries.length}</span>
      </div>
      <div className={s.laneBody}>
        {entries.length === 0 ? (
          <span className={s.noteDim} style={{ padding: 'var(--s-2)' }}>
            Nothing from this side.
          </span>
        ) : entries.map((e) => (
          <article
            key={e.id}
            className={`${s.entry}${e.ghost ? ` ${s.entryGhost}` : ''}`}
            style={e.severityVar ? { ['--laneColor' as string]: e.severityVar } : undefined}
          >
            <div className={s.entryTop}>
              <span className={s.entryTitle}>{e.title}</span>
              <span className={s.entryTime}>{relativeShort(e.at, now)}</span>
            </div>
            {e.body ? (
              <p className={s.entryBody}>
                {e.body.length > 180 ? `${e.body.slice(0, 180)}…` : e.body}
              </p>
            ) : null}
            <div className={s.entryFoot}>
              {/* Deduped: an advisory whose kind is also "advisory" produced the
                  tag twice, which rendered a doubled chip and — because the tag
                  is the key — spammed React's duplicate-key warning on every
                  render of every entry. */}
              {Array.from(new Set(e.tags)).map((t) => (
                <span className={s.chip} key={t}>{t}</span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

function TimeAxis({
  marks, span,
}: {
  marks: { at: number; role: LaneKey }[]
  span: { lo: number; hi: number } | null
}) {
  if (!span) return <div className={s.timeAxis} />
  const width = span.hi - span.lo
  const ticks = 6
  return (
    <div className={s.timeAxis} aria-hidden>
      {Array.from({ length: ticks + 1 }, (_, i) => {
        const t = span.lo + (width * i) / ticks
        const left = (100 * i) / ticks
        return (
          <span key={i}>
            <span className={s.timeTick} style={{ left: `${left}%` }} />
            <span
              className={s.timeLabel}
              style={{ left: `${Math.min(97, Math.max(3, left))}%` }}
            >
              {fmtTime(new Date(t))}
            </span>
          </span>
        )
      })}
      {marks.map((m, i) => (
        <span
          key={i}
          className={s.timeMark}
          style={{
            left: `${(100 * (m.at - span.lo)) / width}%`,
            background: ACTOR_VAR[m.role],
          }}
        />
      ))}
    </div>
  )
}

function LedgerCell({
  role, label, value, foot,
}: {
  role: LaneKey
  label: string
  value: string
  foot: string
}) {
  return (
    <div className={s.ledgerCell} style={{ ['--cellColor' as string]: ACTOR_VAR[role] }}>
      <Caps>{label}</Caps>
      <span className={s.ledgerValue}>{value}</span>
      <span className={s.readoutFoot}>{foot}</span>
    </div>
  )
}
