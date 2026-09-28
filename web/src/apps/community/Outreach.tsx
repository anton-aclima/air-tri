/**
 * community — the operators.
 *
 * The companies get a page here, and they get to speak on it. What they do not
 * get is the ability to mark a neighbour's report done. That asymmetry is the
 * first thing on the page, in words a resident cannot misread.
 */

import { Link } from '@tanstack/react-router'

import s from '@/apps/community/community.module.css'
import { KIND_WORD, usePlaces } from '@/apps/community/lib'
import { FootNote, SimNote, VoiceTag } from '@/apps/community/parts'
import { SitePostCard } from '@/apps/community/FeedCards'
import { Badge, Empty } from '@/app/ui'
import { happenedBy } from '@/core/events'
import { bearingBetween, compassWords, distanceBetween, fmtDistanceImperial } from '@/core/format'
import { useBootstrapSites, useConcerns, useOrgs, usePosts } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type { IndustrySite, Position } from '@/core/types'

export function Outreach() {
  const now = useNowCampaign()
  const places = usePlaces()
  const sites = useBootstrapSites()
  const orgs = useOrgs()
  // As of the demo's now (D2). The list's `status` is served as it stood at
  // the clock (server statusat.py): a report reads 'mitigation_proposed' only
  // from the first company reply or mitigation that claims it, so a claim made
  // later no longer marks an earlier report in replay. 400, the map's key: the
  // campaign holds 204 reports.
  const posts = happenedBy(usePosts({ limit: 30 }).data, now)
  const concerns = happenedBy(useConcerns({ limit: 400 }).data, now)

  const claimed = concerns.filter((c) => c.status === 'mitigation_proposed')

  return (
    <div className={s.page}>
      <SimNote>
        Ridgeline Compute, Delta Forge Metals and Riverport Logistics are invented companies. The
        sites, the sizes and the words they say here are all part of the demonstration.
      </SimNote>

      <header style={{ marginBottom: 'var(--s-5)' }}>
        <h1 className={s.hello}>The companies around you</h1>
        <p className={s.helloSub}>
          Three operators sit on three different sides of these neighbourhoods. They can post here,
          they can reply to you, and they can say what they have tried. Here is exactly where the
          line is.
        </p>
      </header>

      {/* ── the asymmetry, stated first ──────────────────────────────── */}
      <div className={s.explainer}>
        <h2 className={s.explainerTitle}>What a company can and cannot do here</h2>
        <ul className={s.rules}>
          <li>
            <span className={s.ruleMark} aria-hidden>
              ✓
            </span>
            <span>
              <strong>They can post</strong> updates about their site, and reply to a report you
              filed.
            </span>
          </li>
          <li>
            <span className={s.ruleMark} aria-hidden>
              ✓
            </span>
            <span>
              <strong>They can say they attempted a fix</strong> — changed a schedule, moved a
              generator, added a filter.
            </span>
          </li>
          <li>
            <span className={s.ruleMark} aria-hidden>
              ✕
            </span>
            <span>
              <strong>They cannot close your report.</strong> Not by replying, not by claiming a
              fix, not by any button they have. A report stays open until the regional air agency
              closes it.
            </span>
          </li>
          <li>
            <span className={s.ruleMark} aria-hidden>
              ✕
            </span>
            <span>
              <strong>They cannot edit or hide what you wrote</strong>, and they cannot see your
              exact address.
            </span>
          </li>
        </ul>
        <p className={s.explainerBody}>
          When you see &ldquo;still open — a company says it tried something&rdquo; on one of your
          reports, that is this rule doing its job.
        </p>
      </div>

      {claimed.length ? (
        <>
          <h2 className={s.sectionLabel}>Reports a company has responded to</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', marginTop: 'var(--s-3)' }}>
            {claimed.map((c) => (
              <Link key={c.id} to={`/community/c/${c.id}`} className={s.concernRow}>
                <span style={{ fontSize: '1.3rem' }} aria-hidden>
                  {c.photo_emoji ?? '📣'}
                </span>
                <span>
                  <span className={s.concernRowTitle}>{c.title}</span>
                  <span className={s.concernRowMeta}>
                    <Badge tone="accent">Still open</Badge>
                    <span>A company replied. The agency has not closed it.</span>
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </>
      ) : null}

      {/* ── the sites ────────────────────────────────────────────────── */}
      <h2 className={s.sectionLabel}>Sites near these neighbourhoods</h2>
      <div className={s.cardGrid} style={{ marginTop: 'var(--s-3)' }}>
        {sites.map((site) => (
          <SiteTile key={site.id} site={site} home={places.home} homeName={places.homeName} />
        ))}
      </div>

      <div className={s.explainer} style={{ marginTop: 'var(--s-5)' }}>
        <h2 className={s.explainerTitle}>Why it is rarely obvious who it is</h2>
        <p className={s.explainerBody}>
          There is a site to the south-west, a factory to the north and a freight terminal to the
          north-east. The wind changes through the day. On any given evening, the smell you noticed
          could plausibly come from more than one of them — and a company can always point at the
          other two. That ambiguity is exactly why somebody measuring every street, independently,
          matters.
        </p>
        <p className={s.explainerBody}>
          Nothing on this page names a culprit, and neither should anyone else without measurements
          to back it up. <Link to="/community/map">Look at the street map</Link> and see for
          yourself where the numbers actually are.
        </p>
      </div>

      {/* ── what they have posted ────────────────────────────────────── */}
      <h2 className={s.sectionLabel}>What the operators have posted</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)', marginTop: 'var(--s-3)' }}>
        {posts.length === 0 ? (
          <Empty icon="megaphone" title="No posts from the operators yet">
            When a company posts an update or replies to a report, it shows up here and in your
            feed — labelled as their own words, every time.
          </Empty>
        ) : null}
        {posts.map((p) => (
          <SitePostCard key={p.id} post={p} now={now} />
        ))}
      </div>

      <FootNote>
        {orgs.length ? `${orgs.length} organisations in this demonstration. ` : ''}All of them are
        fictional. The geography is not.
      </FootNote>
    </div>
  )
}

function SiteTile({
  site,
  home,
  homeName,
}: {
  site: IndustrySite
  home: Position
  homeName: string
}) {
  const c = site.centroid as Position
  const d = distanceBetween(home, c)
  const bearing = bearingBetween(home, c)
  const active = site.emission_points.filter((e) => e.active).length

  return (
    <section className={s.tile}>
      <div className={s.tileHead}>
        <span className={s.tileGlyph} aria-hidden>
          {site.logo_emoji ?? '🏭'}
        </span>
        <span style={{ minWidth: 0 }}>
          <div className={s.tileName}>{site.name}</div>
          <div className={s.tileSub}>
            {fmtDistanceImperial(d)} from {homeName} · to the {compassWords(bearing)} of you
          </div>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        <VoiceTag voice="company">Operator</VoiceTag>
      </div>

      <p className={s.tileBody}>{KIND_WORD[site.kind]}</p>
      {site.blurb ? (
        <div className={s.claim} style={{ marginTop: 0 }}>
          <div className={s.claimHead}>How the company describes itself</div>
          <div className={s.claimBody}>&ldquo;{site.blurb}&rdquo;</div>
        </div>
      ) : null}

      {site.capacity_mw != null ? (
        <div className={s.kv}>
          <span>Size</span>
          <span>{Math.round(site.capacity_mw)} megawatts of power drawn</span>
        </div>
      ) : null}
      {site.generator_count != null ? (
        <div className={s.kv}>
          <span>Engines on site</span>
          <span>
            {site.generator_count}
            {site.generator_fuel ? ` · ${site.generator_fuel}` : ''}
          </span>
        </div>
      ) : null}
      <div className={s.kv}>
        <span>Places air can leave the site</span>
        <span>
          {active} running of {site.emission_points.length}
        </span>
      </div>
      {site.operating_since ? (
        <div className={s.kv}>
          <span>Operating since</span>
          <span>{site.operating_since.slice(0, 4)}</span>
        </div>
      ) : null}
    </section>
  )
}
