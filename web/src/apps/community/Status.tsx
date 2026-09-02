/**
 * community — what the agency is doing.
 *
 * The regulator's fixed monitors and its public notices, in plain language.
 * Including the honest part: there are things in the air here that none of the
 * agency's own instruments can see.
 */

import { Link } from '@tanstack/react-router'

import s from '@/apps/community/community.module.css'
import { usePlaces } from '@/apps/community/lib'
import { FootNote, RiskPill, SimNote, VoiceTag } from '@/apps/community/parts'
import { Badge, Empty } from '@/app/ui'
import { distanceBetween, fmtDistanceImperial, relativeTime } from '@/core/format'
import { plainName, riskFromValue, SEVERITY_PLAIN } from '@/core/measures'
import { useAdvisories, useBootstrap, useMeasures, useMonitors, useOrgs } from '@/core/queries'
import { resolveNow, useTime } from '@/core/session'
import type { MeasureCode, Monitor, Position } from '@/core/types'

const STATUS_WORD: Record<Monitor['status'], string> = {
  online: 'Working',
  degraded: 'Working, but not at its best',
  offline: 'Not reporting right now',
  maintenance: 'Being serviced',
}

const STATUS_TONE: Record<Monitor['status'], 'ok' | 'watch' | 'critical' | 'neutral'> = {
  online: 'ok',
  degraded: 'watch',
  offline: 'critical',
  maintenance: 'neutral',
}

export function Status() {
  const time = useTime()
  const now = resolveNow(time)
  const places = usePlaces()
  const orgs = useOrgs()
  // 'modality', deliberately NOT PICKABLE. This screen asks what the agency's
  // instruments do and do not cover, and `uncovered` below turns that into
  // "nothing measures X". A derived index belongs in neither list: no instrument
  // carries it and none was ever supposed to, so listing it here would accuse
  // DRAQA of a gap that does not exist.
  const measures = useMeasures('modality')
  const bootstrap = useBootstrap().data
  const monitors = useMonitors().data ?? []
  const advisories = useAdvisories({ audience: 'community' }).data ?? []

  const agencyMonitors = monitors.filter((m) => m.owner_type === 'regulator')
  const otherMonitors = monitors.filter((m) => m.owner_type !== 'regulator')
  const agency = orgs.find((o) => o.kind === 'agency')

  const covered = new Set<MeasureCode>()
  for (const m of agencyMonitors) for (const c of m.measures) covered.add(c)
  const uncovered = measures.filter((d) => !covered.has(d.code))

  const measureName = (code: MeasureCode) =>
    plainName(
      measures.find((m) => m.code === code),
      'community',
    )

  return (
    <div className={s.page}>
      <SimNote>
        The agency here — {agency?.name ?? 'the regional air agency'} — is invented for this
        demonstration, as is everything it says. The streets are real.
      </SimNote>

      <header style={{ marginBottom: 'var(--s-5)' }}>
        <h1 className={s.hello}>What the air agency is saying</h1>
        <p className={s.helloSub}>
          {agency?.name ?? 'The regional air agency'} sets the limits, runs a small number of very
          accurate fixed monitors, and is the only party that can close a report you file. Here is
          everything it has posted, and where its instruments actually are.
        </p>
      </header>

      {/* ── notices ──────────────────────────────────────────────────── */}
      <h2 className={s.sectionLabel}>Notices in force</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', marginTop: 'var(--s-3)' }}>
        {advisories.length === 0 ? (
          <Empty icon="megaphone" title="No notices right now">
            When the agency issues a warning or an all-clear, it appears here and in your feed.
          </Empty>
        ) : null}
        {advisories.map((a) => (
          <article key={a.id} className={s.post} style={{ ['--voice' as string]: 'var(--actor-regulator)' }}>
            <div className={s.postTags}>
              <VoiceTag voice="agency">Air agency</VoiceTag>
              <Badge tone={a.severity}>{SEVERITY_PLAIN[a.severity]}</Badge>
              {a.measure ? <Badge tone="neutral">About {measureName(a.measure)}</Badge> : null}
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
                {relativeTime(a.created_at, now)}
              </span>
            </div>
            <h3 className={s.postTitle}>{a.title}</h3>
            <p className={s.postBody}>{a.body}</p>
          </article>
        ))}
      </div>

      {/* ── the agency's own instruments ─────────────────────────────── */}
      <h2 className={s.sectionLabel}>The agency&rsquo;s fixed monitors</h2>
      <p className={s.helloSub} style={{ margin: 'var(--s-3) 0 var(--s-4)' }}>
        These are the reference instruments — the most accurate air measurements the region has.
        There are only {agencyMonitors.length} of them for the whole area, which is why a single one
        cannot tell you what is happening on your block.
      </p>
      <div className={s.cardGrid}>
        {agencyMonitors.map((m) => (
          <MonitorTile
            key={m.id}
            monitor={m}
            home={places.home}
            places={places.homeName}
            measureName={measureName}
          />
        ))}
      </div>

      {/* ── the honest gap ───────────────────────────────────────────── */}
      {uncovered.length ? (
        <div className={s.explainer} style={{ marginTop: 'var(--s-5)' }}>
          <h2 className={s.explainerTitle}>What the agency&rsquo;s monitors cannot see</h2>
          <p className={s.explainerBody}>
            Not every instrument measures every thing. Across all {agencyMonitors.length} of the
            agency&rsquo;s monitors, nothing measures{' '}
            <strong>{uncovered.map((d) => plainName(d, 'community')).join(', ')}</strong>. That is
            not an accusation — it is simply what the equipment covers. Those things still show up
            in what our cars measure on your street, which is how a gap like this becomes visible at
            all.
          </p>
          <p className={s.explainerBody}>
            <Link to="/community/map">See them on the street map</Link>
          </p>
        </div>
      ) : null}

      {/* ── everybody else's sensors ─────────────────────────────────── */}
      <h2 className={s.sectionLabel}>Other sensors nearby</h2>
      <p className={s.helloSub} style={{ margin: 'var(--s-3) 0 var(--s-4)' }}>
        Some sensors around here belong to the companies themselves, and some belong to neighbours.
        We show you all of them, labelled with who owns them, and we never relabel a company&rsquo;s
        number as an independent one.
      </p>
      <div className={s.cardGrid}>
        {otherMonitors.map((m) => (
          <MonitorTile
            key={m.id}
            monitor={m}
            home={places.home}
            places={places.homeName}
            measureName={measureName}
          />
        ))}
      </div>

      <FootNote>
        {bootstrap?.campaign.name ?? 'This campaign'} · simulated for a demonstration. Real streets,
        invented agency, invented people.
      </FootNote>
    </div>
  )
}

function MonitorTile({
  monitor,
  home,
  places,
  measureName,
}: {
  monitor: Monitor
  home: Position
  places: string
  measureName: (c: MeasureCode) => string
}) {
  const measures = useMeasures('modality')
  const d = distanceBetween(home, [monitor.lon, monitor.lat])
  const grade =
    monitor.grade === 'reference'
      ? 'A reference-grade instrument — the most accurate kind there is.'
      : monitor.grade === 'fem'
        ? 'An approved instrument, checked against the reference ones.'
        : 'A small, inexpensive sensor. Useful for spotting changes, less exact than the big ones.'
  const owner =
    monitor.owner_type === 'regulator'
      ? 'Run by the air agency'
      : monitor.owner_type === 'industry'
        ? 'Run by the company itself'
        : monitor.owner_type === 'community'
          ? 'Hosted by a neighbour'
          : 'Run by Aclima'

  const latest = Object.entries(monitor.latest) as [
    MeasureCode,
    { value: number; ts: string; exceeds: boolean },
  ][]

  return (
    <section className={s.tile}>
      <div className={s.tileHead}>
        <span className={s.tileGlyph} aria-hidden>
          {monitor.owner_type === 'industry' ? '📡' : monitor.owner_type === 'community' ? '🏠' : '🏛️'}
        </span>
        <span style={{ minWidth: 0 }}>
          <div className={s.tileName}>{monitor.name}</div>
          <div className={s.tileSub}>
            {owner} · {fmtDistanceImperial(d)} from {places}
          </div>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <Badge tone={STATUS_TONE[monitor.status]}>{STATUS_WORD[monitor.status]}</Badge>
        <Badge tone="neutral">
          Watches {monitor.measures.length}{' '}
          {monitor.measures.length === 1 ? 'thing' : 'things'} in the air
        </Badge>
      </div>

      <p className={s.tileBody}>{grade}</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
        {latest.length === 0 ? (
          <span className={s.tileSub}>No recent readings.</span>
        ) : null}
        {latest.map(([code, r]) => (
          <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
            <RiskPill
              risk={riskFromValue(
                measures.find((m) => m.code === code),
                r.value,
              )}
            />
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-2)', minWidth: 0 }}>
              {measureName(code)}
            </span>
            {r.exceeds ? (
              <span style={{ marginLeft: 'auto' }}>
                <Badge tone="warning">Over the line</Badge>
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}
