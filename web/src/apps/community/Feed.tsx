/**
 * community — the feed. The hero screen.
 *
 * One scrolling column where four voices sit side by side: neighbours, the
 * regional air agency, the operators who run the sites, and our own
 * measurements. An operator's claim can land directly under three neighbours
 * reporting the same smell, and it never looks like the last word.
 */

import { Link, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'

import s from '@/apps/community/community.module.css'
import {
  AclimaCard,
  AdvisoryCard,
  ConcernCard,
  MitigationCard,
  ReadingCard,
  SitePostCard,
} from '@/apps/community/FeedCards'
import {
  adviceFor,
  distanceFromHome,
  kindEmoji,
  kindLabel,
  nearWords,
  PRIMARY_KINDS,
  trendWords,
  useMe,
  usePlaces,
  VOICE,
} from '@/apps/community/lib'
import {
  Byline,
  DelayNote,
  FootNote,
  MeterRow,
  Post,
  RiskPill,
  SimNote,
} from '@/apps/community/parts'
import { Avatar, Button, Skeleton, SkeletonText } from '@/app/ui'
import { RiskDial } from '@/components'
import { countOf, relativeTime } from '@/core/format'
import {
  useAdvisories,
  useCommunityStats,
  useConcernClusters,
  useConcerns,
  useFeed,
  useFleet,
  useFlags,
} from '@/core/queries'
import { resolveNow, useTime } from '@/core/session'
import type { FeedItem } from '@/core/types'

function greeting(now: Date): string {
  const h = now.getHours()
  if (h < 5) return 'Still up'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function Feed() {
  const navigate = useNavigate()
  const time = useTime()
  const now = resolveNow(time)
  const me = useMe()
  const places = usePlaces()

  const feed = useFeed({ limit: 40 })
  const stats = useCommunityStats().data
  const clusters = useConcernClusters().data ?? []
  const concerns = useConcerns({ limit: 60 }).data ?? []
  const advisories = useAdvisories({ audience: 'community' }).data ?? []
  const fleet = useFleet().data ?? []
  const delayMin = useFlags()?.community_fleet_delay_min ?? 180

  const items = feed.data ?? []

  /**
   * One card per moment. Two measures from the same sensor is one story, and
   * the backend mirrors a mitigation into a site post — a resident should see
   * an operator's claim once, not twice.
   */
  const stream = useMemo(() => {
    const mitigationTitles = new Set(
      items.filter((i) => i.type === 'mitigation').map((i) => i.mitigation.title.toLowerCase()),
    )
    const seen = new Set<string>()
    const out: FeedItem[] = []
    for (const it of items) {
      if (it.type === 'reading') {
        const key = `${it.monitor.id}:${it.at}`
        if (seen.has(key)) continue
        seen.add(key)
      }
      if (it.type === 'post') {
        if (mitigationTitles.has(it.post.title.toLowerCase())) continue
        if (seen.has(it.post.id)) continue
        seen.add(it.post.id)
      }
      out.push(it)
    }
    return out
  }, [items])

  const activeCluster = clusters.find((c) => c.status === 'active') ?? clusters[0]
  const firstName = me?.name?.split(' ')[0] ?? 'neighbour'
  const risk = stats?.overall_risk ?? null

  const nearMe = useMemo(
    () =>
      concerns
        .map((c) => ({ c, d: distanceFromHome(c, places.home) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 4),
    [concerns, places.home],
  )

  return (
    <div className={s.page}>
      <SimNote />

      <div className={s.columns}>
        <div className={s.stream}>
          <header>
            <h1 className={s.hello}>
              {greeting(now)}, {firstName}.
            </h1>
            <p className={s.helloSub}>
              Here is what people around {places.homeName} are noticing, what the air agency has
              said, and what the companies nearby say they are doing about it.
            </p>
          </header>

          {/* ── today ───────────────────────────────────────────────── */}
          <section className={s.today}>
            <RiskDial
              risk={risk}
              size={148}
              label="Today"
              footer={
                <div className={s.todayKicker} style={{ textAlign: 'center' }}>
                  {places.homeName}
                </div>
              }
              bandLabel={stats?.overall_label}
              trendPct={stats?.trend_pct ?? null}
            />
            <div className={s.todayBody}>
              <div className={s.todayKicker}>How the air is scoring</div>
              <h2 className={s.todayHead}>
                {stats ? `${stats.overall_label} — ${trendWords(stats.trend_pct)}` : 'Measuring…'}
              </h2>
              <p className={s.todayLine}>{adviceFor(risk)}</p>
              <div className={s.todayChips}>
                <RiskPill risk={risk} label="out of 100 · lower is better" />
                {stats ? (
                  <span className={s.riskPill}>
                    <b className="num">{stats.concern_count_7d}</b>
                    <span>reports from neighbours this week</span>
                  </span>
                ) : null}
                {stats ? (
                  <span className={s.riskPill}>
                    <b className="num">{stats.advisory_count_active}</b>
                    <span>notices from the air agency</span>
                  </span>
                ) : null}
              </div>
            </div>
          </section>

          {/* ── the cluster: three-way tension made visible ──────────── */}
          {activeCluster && activeCluster.count >= 3 ? (
            <Link to="/community/map" className={s.banner}>
              <span className={s.bannerGlyph} aria-hidden>
                📍
              </span>
              <span>
                <div className={s.bannerTitle}>
                  {countOf(activeCluster.count, 'neighbour has', 'neighbours have')} reported the
                  same thing within a few blocks
                </div>
                <div className={s.bannerSub}>
                  {activeCluster.label ?? 'Nearby reports'} · started{' '}
                  {relativeTime(activeCluster.first_at, now)}. When reports pile up like this they
                  stop being one person&rsquo;s word: the air agency and the operator both see them.
                </div>
              </span>
              <span className={s.bannerCta}>See it on the map →</span>
            </Link>
          ) : null}

          {/* ── composer ────────────────────────────────────────────── */}
          <div className={s.composer}>
            <Avatar user={me} size="md" ring={VOICE.neighbour.token} />
            <div>
              <button
                type="button"
                className={s.composerPrompt}
                onClick={() => navigate({ to: '/community/report' })}
              >
                Noticed something in the air, {firstName}? Tell your neighbours.
              </button>
              <div className={s.composerKinds}>
                {PRIMARY_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={s.kindPill}
                    onClick={() => navigate({ to: '/community/report', search: { kind: k } })}
                  >
                    <span className={s.kindGlyph} aria-hidden>
                      {kindEmoji(k)}
                    </span>
                    {kindLabel(k)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── the stream ──────────────────────────────────────────── */}
          {feed.isLoading ? (
            <>
              <div className={s.post}>
                <SkeletonText lines={3} />
              </div>
              <div className={s.post}>
                <SkeletonText lines={4} />
              </div>
            </>
          ) : null}

          {stream.map((item, i) => (
            <div key={`${item.type}-${item.at}-${i}`} style={{ display: 'contents' }}>
              <FeedRow item={item} now={now} home={places.home} />
              {i === 2 ? <AclimaCard stats={stats} now={now} /> : null}
            </div>
          ))}

          {!feed.isLoading && stream.length === 0 ? (
            <Post voice="aclima">
              <Byline voice="aclima" name="Aclima" tag="Measured" emoji="🚗" />
              <h3 className={s.postTitle}>Nothing has been posted yet</h3>
              <p className={s.postBody}>
                Be the first. If you have smelled, heard or seen something in the air near you, your
                neighbours want to know.
              </p>
              <div className={s.postFoot}>
                <Button size="sm" variant="cta" onClick={() => navigate({ to: '/community/report' })}>
                  Report a concern
                </Button>
              </div>
            </Post>
          ) : null}

          {stream.length > 0 && stream.length < 4 ? <AclimaCard stats={stats} now={now} /> : null}

          <FootNote>
            Everything on this page is simulated for a demonstration. The streets and neighbourhood
            names are real Southwest Memphis; the people, companies and agency are invented.
          </FootNote>
        </div>

        {/* ══════════════════════════════════════════════ the quiet rail */}
        <aside className={s.rail}>
          <section className={s.railCard}>
            <h2 className={s.railTitle}>Closest to you</h2>
            <div className={s.railList}>
              {nearMe.length === 0 ? (
                <span className={s.railRowSub}>No reports near {places.homeName} yet.</span>
              ) : null}
              {nearMe.map(({ c, d }) => (
                <Link key={c.id} to={`/community/c/${c.id}`} className={s.railRow}>
                  <span>
                    <span className={s.railRowName}>
                      {kindEmoji(c.kind)} {c.title}
                    </span>
                    <span className={s.railRowSub}>
                      {nearWords(d)} · {relativeTime(c.occurred_at, now)}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
            <div className={s.railFoot}>
              <Link to="/community/map">See every report on the map</Link>
            </div>
          </section>

          <section className={s.railCard}>
            <h2 className={s.railTitle}>What we measure on your streets</h2>
            {stats ? (
              stats.by_measure.slice(0, 5).map((m) => (
                <MeterRow key={m.measure} name={m.plain_name} risk={m.risk} sub={m.label} tight />
              ))
            ) : (
              <Skeleton height={96} />
            )}
            <div className={s.railFoot}>
              Every number is a score out of 100. Lower is better. No units, on purpose.
            </div>
          </section>

          <section className={s.railCard}>
            <h2 className={s.railTitle}>Where our cars have been</h2>
            <div className={s.railList}>
              {fleet.length === 0 ? (
                <span className={s.railRowSub}>No cars out on this stretch right now.</span>
              ) : null}
              {fleet.slice(0, 5).map((v) => (
                <div key={v.vehicle_id} className={s.railRow}>
                  <span>
                    <span className={s.railRowName}>🚗 {v.call_sign ?? v.label}</span>
                    <span className={s.railRowSub}>
                      {v.status === 'driving'
                        ? 'was driving your streets'
                        : v.status === 'charging'
                          ? 'was charging'
                          : v.status === 'maintenance'
                            ? 'was in the shop'
                            : 'was parked'}{' '}
                      · {relativeTime(v.ts, now)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <div className={s.railFoot}>
              <DelayNote minutes={delayMin} />
            </div>
          </section>

          <section className={s.railCard}>
            <h2 className={s.railTitle}>Who is talking here</h2>
            <div className={s.railList}>
              {(['neighbour', 'agency', 'company', 'aclima'] as const).map((v) => (
                <div key={v} className={s.railRow}>
                  <span>
                    <span className={s.railRowName}>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 8,
                          height: 8,
                          borderRadius: 2,
                          background: VOICE[v].token,
                          marginRight: 8,
                        }}
                      />
                      {VOICE[v].who}
                    </span>
                    <span className={s.railRowSub}>{VOICE[v].note}</span>
                  </span>
                </div>
              ))}
            </div>
            <div className={s.railFoot}>
              A company can say it tried to fix something. It can never mark your report done — only
              the air agency can. <Link to="/community/outreach">How that works</Link>
            </div>
          </section>

          {advisories.length ? (
            <section className={s.railCard}>
              <h2 className={s.railTitle}>Notices in force</h2>
              <div className={s.railList}>
                {advisories.slice(0, 3).map((a) => (
                  <Link key={a.id} to="/community/status" className={s.railRow}>
                    <span>
                      <span className={s.railRowName}>{a.title}</span>
                      <span className={s.railRowSub}>{relativeTime(a.created_at, now)}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  )
}

function FeedRow({
  item,
  now,
  home,
}: {
  item: FeedItem
  now: Date
  home: [number, number]
}) {
  switch (item.type) {
    case 'concern':
      return (
        <ConcernCard
          concern={item.concern}
          now={now}
          distanceM={distanceFromHome(item.concern, home)}
        />
      )
    case 'advisory':
      return <AdvisoryCard advisory={item.advisory} now={now} />
    case 'post':
      return <SitePostCard post={item.post} now={now} />
    case 'mitigation':
      return <MitigationCard mitigation={item.mitigation} site={item.site} now={now} />
    case 'reading':
      return (
        <ReadingCard
          monitor={item.monitor}
          measure={item.measure}
          value={item.value}
          exceeds={item.exceeds}
          at={item.at}
          now={now}
        />
      )
  }
}
