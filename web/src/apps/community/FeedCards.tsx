/**
 * community — the cards in the stream.
 *
 * Four voices share one column: neighbours, the regional air agency, the
 * operators, and us. Each card says who is speaking before it says anything
 * else, and an operator's post can never look like a resolution.
 */

import { Link } from '@tanstack/react-router'

import s from '@/apps/community/community.module.css'
import {
  Byline,
  ClaimNote,
  MeterRow,
  Post,
  RiskPill,
  SectionLabel,
} from '@/apps/community/parts'
import {
  kindEmoji,
  kindLabel,
  monitorVoice,
  nearWords,
  severityWord,
  statusPlain,
  useMe,
  type Voice,
} from '@/apps/community/lib'
import { Badge, Button, Chip } from '@/app/ui'
import { countOf, relativeTime } from '@/core/format'
import { plainName, riskFromValue, SEVERITY_PLAIN } from '@/core/measures'
import { useCorroborate, useMeasure, useOrgs } from '@/core/queries'
import type {
  Advisory,
  CommunityStats,
  Concern,
  ConcernResponse,
  IndustrySite,
  MeasureCode,
  Mitigation,
  Monitor,
  Org,
  SitePost,
} from '@/core/types'

function orgOf(orgs: Org[], id: string | null | undefined): Org | undefined {
  return id ? orgs.find((o) => o.id === id) : undefined
}

/** The agency's own name, never abbreviated to an acronym for residents. */
function agencyName(org: Org | undefined): string {
  return org?.name ?? 'Regional air agency'
}

// ══════════════════════════════════════════════════════════ neighbour posts

export function ConcernCard({
  concern,
  now,
  distanceM,
  compact,
}: {
  concern: Concern
  now: Date
  distanceM?: number | null
  compact?: boolean
}) {
  const me = useMe()
  const corroborate = useCorroborate()
  const status = statusPlain(concern.status)
  const claim = [...concern.responses].reverse().find((r) => r.role === 'industry')
  const agency = [...concern.responses].reverse().find((r) => r.role === 'regulator')
  const who = concern.is_anonymous ? 'A neighbour' : (concern.author?.name ?? 'A neighbour')
  const where = concern.author?.neighborhood ?? concern.district
  const near = distanceM == null ? null : nearWords(distanceM)

  return (
    <Post voice="neighbour">
      <Byline
        voice="neighbour"
        name={who}
        tag="Neighbour"
        emoji={concern.is_anonymous ? '🫥' : concern.author?.avatar_emoji}
        color={concern.is_anonymous ? null : concern.author?.avatar_color}
        at={concern.occurred_at}
        now={now}
        meta={
          <>
            {where ? <span>{where}</span> : null}
            {near ? (
              <>
                <span className={s.bylineDot}>·</span>
                <span>{near}</span>
              </>
            ) : null}
          </>
        }
      />

      <div className={s.postTags}>
        <Chip small>
          <span className={s.kindGlyph}>{kindEmoji(concern.kind)}</span>
          {kindLabel(concern.kind)}
        </Chip>
        <Chip small>{severityWord(concern.severity)}</Chip>
        <Badge tone={status.open ? 'accent' : 'ok'}>{status.label}</Badge>
      </div>

      {concern.photo_emoji ? (
        <span className={s.postMedia} aria-hidden>
          {concern.photo_emoji}
        </span>
      ) : null}

      <h3 className={s.postTitle}>
        <Link to={`/community/c/${concern.id}`}>{concern.title}</Link>
      </h3>
      {concern.body ? <p className={s.postBody}>{concern.body}</p> : null}

      {agency && !compact ? (
        <div className={s.claim} style={{ borderLeftColor: 'var(--actor-regulator)' }}>
          <div className={s.claimHead}>The agency replied</div>
          <div className={s.claimBody}>{agency.body}</div>
        </div>
      ) : null}

      {claim && !compact ? (
        <ClaimNote who={claim.org_name ?? 'The operator'} body={claim.body} />
      ) : null}

      <div className={s.postFoot}>
        <Button
          size="sm"
          variant="secondary"
          icon="check"
          disabled={corroborate.isPending}
          onClick={() => corroborate.mutate({ id: concern.id, userId: me?.id })}
        >
          This happened to me too
          {concern.corroborations > 0 ? ` · ${concern.corroborations}` : ''}
        </Button>
        <Link to={`/community/c/${concern.id}`} style={{ fontSize: 'var(--text-sm)' }}>
          Open the thread
        </Link>
        {concern.cluster_id ? (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
            Part of a group of nearby reports
          </span>
        ) : null}
      </div>
    </Post>
  )
}

// ═══════════════════════════════════════════════════════════ agency notices

export function AdvisoryCard({ advisory, now }: { advisory: Advisory; now: Date }) {
  const orgs = useOrgs()
  const org = orgOf(orgs, advisory.org_id)
  const def = useMeasure(advisory.measure)

  return (
    <Post voice="agency">
      <Byline
        voice="agency"
        name={agencyName(org)}
        tag="Air agency"
        emoji={org?.logo_emoji ?? '🏛️'}
        at={advisory.created_at}
        now={now}
        meta={<span>Public notice for this neighbourhood</span>}
      />

      <div className={s.postTags}>
        <Badge tone={advisory.severity}>{SEVERITY_PLAIN[advisory.severity]}</Badge>
        {def ? <Chip small>About {plainName(def, 'community')}</Chip> : null}
        {advisory.pinned ? <Chip small>Pinned</Chip> : null}
      </div>

      <h3 className={s.postTitle}>{advisory.title}</h3>
      <p className={s.postBody}>{advisory.body}</p>

      <div className={s.postFoot}>
        <Link to="/community/status" style={{ fontSize: 'var(--text-sm)' }}>
          See what the agency measures
        </Link>
        {advisory.expires_at ? (
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
            In force until {relativeTime(advisory.expires_at, now)}
          </span>
        ) : null}
      </div>
    </Post>
  )
}

// ═════════════════════════════════════════════════════════════ operator posts

const POST_KIND_WORD: Record<SitePost['kind'], string> = {
  update: 'Update from the operator',
  mitigation: 'The operator says it changed something',
  event: 'Something happening at the site',
  response: 'A reply to neighbours',
  intro: 'Introducing themselves',
}

export function SitePostCard({ post, now }: { post: SitePost; now: Date }) {
  return (
    <Post voice="company">
      <Byline
        voice="company"
        name={post.org_name ?? 'Operator'}
        tag="Operator"
        emoji={post.logo_emoji ?? '🏭'}
        color={post.brand_color}
        at={post.created_at}
        now={now}
        meta={<span>A company that runs a site near you</span>}
      />

      <div className={s.postTags}>
        <Chip small>{POST_KIND_WORD[post.kind]}</Chip>
      </div>

      {post.media_emoji ? (
        <span className={s.postMedia} aria-hidden>
          {post.media_emoji}
        </span>
      ) : null}

      <h3 className={s.postTitle}>{post.title}</h3>
      <p className={s.postBody}>{post.body}</p>

      {post.concern_id ? (
        <ClaimNote
          who={post.org_name ?? 'The operator'}
          body={
            <>
              This post is attached to a neighbour&rsquo;s report.{' '}
              <Link to={`/community/c/${post.concern_id}`}>Read the report</Link> and decide for
              yourself.
            </>
          }
        />
      ) : (
        <div className={s.postFoot}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
            The operator&rsquo;s own words. Nobody has checked them.
          </span>
        </div>
      )}
    </Post>
  )
}

export function MitigationCard({
  mitigation,
  site,
  now,
}: {
  mitigation: Mitigation
  site: IndustrySite | null
  now: Date
}) {
  const state =
    mitigation.status === 'completed'
      ? 'says it has finished'
      : mitigation.status === 'in_progress'
        ? 'says it is working on'
        : mitigation.status === 'withdrawn'
          ? 'has withdrawn'
          : 'has proposed'
  return (
    <Post voice="company">
      <Byline
        voice="company"
        name={site?.name ?? 'Operator'}
        tag="Operator"
        emoji={site?.logo_emoji ?? '🏭'}
        color={site?.brand_color}
        at={mitigation.created_at}
        now={now}
        meta={<span>{`The operator ${state} a change`}</span>}
      />
      <h3 className={s.postTitle}>{mitigation.title}</h3>
      {mitigation.body ? <p className={s.postBody}>{mitigation.body}</p> : null}
      <ClaimNote
        who={site?.name ?? 'The operator'}
        body={
          mitigation.concern_id ? (
            <>
              Attached to a neighbour&rsquo;s report.{' '}
              <Link to={`/community/c/${mitigation.concern_id}`}>Read the report</Link>.
            </>
          ) : (
            'Attached to a group of nearby reports.'
          )
        }
      />
    </Post>
  )
}

// ═════════════════════════════════════════════════════ measurement moments

export function ReadingCard({
  monitor,
  measure,
  value,
  exceeds,
  at,
  now,
}: {
  monitor: Monitor
  measure: MeasureCode
  value: number
  exceeds: boolean
  at: string
  now: Date
}) {
  const orgs = useOrgs()
  const def = useMeasure(measure)
  const { voice, who } = monitorVoice(monitor)
  const org = orgOf(orgs, monitor.org_id)
  const risk = riskFromValue(def, value)
  const name = plainName(def, 'community')

  return (
    <Post voice={voice}>
      <Byline
        voice={voice}
        name={who}
        tag="Sensor"
        emoji={monitor.owner_type === 'industry' ? '📡' : monitor.owner_type === 'community' ? '🏠' : '🏛️'}
        at={at}
        now={now}
        meta={
          <>
            <span>{monitor.name}</span>
            {org ? (
              <>
                <span className={s.bylineDot}>·</span>
                <span>run by {org.name}</span>
              </>
            ) : null}
          </>
        }
      />

      <div className={s.postTags}>
        <RiskPill risk={risk} />
        {exceeds ? <Badge tone="warning">Above the agency&rsquo;s line</Badge> : null}
      </div>

      <h3 className={s.postTitle}>
        {exceeds ? 'Higher than usual: ' : 'Latest reading: '}
        {name}
      </h3>
      <p className={s.postBody}>
        {monitor.owner_type === 'industry'
          ? 'This sensor belongs to the company itself. We show you their number unchanged, next to what our cars measured on the street.'
          : monitor.owner_type === 'community'
            ? 'A neighbour hosts this sensor on their own property.'
            : 'A public reference monitor, the highest grade of instrument in the region.'}
      </p>
      <div className={s.postFoot}>
        <Link to="/community/status" style={{ fontSize: 'var(--text-sm)' }}>
          Where the monitors are
        </Link>
      </div>
    </Post>
  )
}

/** Us. What the cars have been doing on these streets. */
export function AclimaCard({ stats, now }: { stats: CommunityStats | undefined; now: Date }) {
  void now
  const worst = stats?.worst_streets?.slice(0, 3) ?? []
  return (
    <Post voice="aclima">
      <Byline
        voice="aclima"
        name="Aclima"
        tag="Measured"
        emoji="🚗"
        meta={<span>Our cars drive every street here, over and over</span>}
      />
      <h3 className={s.postTitle}>We measured your block, not just the city</h3>
      <p className={s.postBody}>
        {stats
          ? `${Math.round(stats.monitored_km)} kilometres of your streets, driven again and again — ${stats.passes_total.toLocaleString()} separate passes so far. That is how a single street can get its own score instead of sharing one with the whole county.`
          : 'Our cars drive every street in the neighbourhood repeatedly, so a single street gets its own score instead of sharing one with the whole county.'}
      </p>
      {worst.length ? (
        <div style={{ marginTop: 'var(--s-3)' }}>
          <SectionLabel>Highest-scoring streets right now</SectionLabel>
          {worst.map((w) => (
            <MeterRow key={w.segment_id} name={w.name} sub={w.district ?? undefined} risk={w.risk} />
          ))}
        </div>
      ) : null}
      <div className={s.postFoot}>
        <Link to="/community/map" style={{ fontSize: 'var(--text-sm)' }}>
          Open the street map
        </Link>
        <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
          Lower is better. 0 to 100, no units.
        </span>
      </div>
    </Post>
  )
}

// ══════════════════════════════════════════════════════════════ small parts

export function ResponseLine({ response, now }: { response: ConcernResponse; now: Date }) {
  const voice: Voice =
    response.role === 'industry' ? 'company' : response.role === 'regulator' ? 'agency' : 'neighbour'
  return (
    <div className={s.reply} style={{ ['--voice' as string]: `var(--actor-${response.role})` }}>
      <div className={s.replyHead}>
        <span className={s.replyWho}>{response.org_name ?? (voice === 'agency' ? 'The agency' : 'A neighbour')}</span>
        <span className={s.bylineDot}>·</span>
        <span>{relativeTime(response.created_at, now)}</span>
        {response.role === 'industry' ? (
          <span style={{ marginLeft: 'auto' }}>
            <Badge tone="neutral">A claim, not a resolution</Badge>
          </span>
        ) : null}
      </div>
      <div className={s.replyBody}>{response.body}</div>
    </div>
  )
}

export function corroborationWord(n: number): string {
  return n === 0 ? 'No one else yet' : countOf(n, 'neighbour agrees', 'neighbours agree')
}
