/**
 * community — one report, and everything said back to it.
 *
 * The status line is the important part of this screen. A company can appear
 * in this thread; it can never be the thing that ends it.
 */

import { Link } from '@tanstack/react-router'

import s from '@/apps/community/community.module.css'
import {
  distanceFromHome,
  kindEmoji,
  kindLabel,
  nearWords,
  severityWord,
  statusPlain,
  useGroupFormed,
  useMe,
  usePlaces,
  VOICE,
} from '@/apps/community/lib'
import { ResponseLine, corroborationWord } from '@/apps/community/FeedCards'
import { Byline, FootNote, SectionLabel, SimNote } from '@/apps/community/parts'
import { Badge, Button, Chip, Empty, Spinner } from '@/app/ui'
import { happenedBy, hasStarted } from '@/core/events'
import { fmtDateTime, relativeTime } from '@/core/format'
import { useConcern, useConcerns, useCorroborate } from '@/core/queries'
import { useNowCampaign } from '@/core/session'

export function ConcernDetail({ concernId }: { concernId: string }) {
  const now = useNowCampaign()
  const me = useMe()
  const places = usePlaces()
  const { data: concern, isLoading, isError } = useConcern(concernId)
  const corroborate = useCorroborate()
  const all = happenedBy(useConcerns({ limit: 200 }).data, now)
  // "Part of a group" only once the group had formed by now — `cluster_id` is
  // the final grouping, set on a report hours before its group's third arrived.
  const grouped = useGroupFormed(concern?.cluster_id)

  if (isLoading) {
    return (
      <div className={s.page}>
        <div className={s.center}>
          <Spinner large />
        </div>
      </div>
    )
  }

  if (isError || !concern) {
    return (
      <div className={s.page}>
        <SimNote />
        <Empty icon="report" title="We could not find that report">
          It may have been removed, or the demonstration backend may be offline.{' '}
          <Link to="/community">Back to the feed</Link>
        </Empty>
      </div>
    )
  }

  /*
    A link can outrun the clock: a thread opened from a later moment, or a
    report posted during replay (the server stamps it at the end of the data).
    Showing it would put the future on screen and age it "just now", so say
    when it arrives instead.
  */
  if (!hasStarted(concern, now)) {
    return (
      <div className={s.page}>
        <SimNote />
        <Empty icon="report" title="This report comes later">
          It was posted {fmtDateTime(concern.created_at)}, after the moment the demonstration is
          showing. <Link to="/community">Back to the feed</Link>
        </Empty>
      </div>
    )
  }

  const status = statusPlain(concern.status)
  const who = concern.is_anonymous ? 'A neighbour' : (concern.author?.name ?? 'A neighbour')
  const nearby = all
    .filter((c) => c.id !== concern.id)
    .map((c) => ({ c, d: distanceFromHome(c, [concern.lon, concern.lat]) }))
    .filter(({ d }) => d < 1200)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)

  // Replies as of `now` too — a later one is the future on a past report.
  const responses = happenedBy(concern.responses, now)
  const industryReplies = responses.filter((r) => r.role === 'industry')

  return (
    <div className={s.page}>
      <SimNote />

      <Link to="/community" className={s.backLink}>
        ← Back to the feed
      </Link>

      <div className={s.columns}>
        <div className={s.stream}>
          <article className={s.post} style={{ ['--voice' as string]: VOICE.neighbour.token }}>
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
                  <span>{concern.author?.neighborhood ?? concern.district ?? 'Nearby'}</span>
                  <span className={s.bylineDot}>·</span>
                  <span>{nearWords(distanceFromHome(concern, places.home))}</span>
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

            <h1 className={s.postTitle} style={{ fontSize: 'var(--text-xl)' }}>
              {concern.title}
            </h1>
            {concern.body ? <p className={s.postBody}>{concern.body}</p> : null}

            <div className={s.postFoot}>
              <Button
                size="sm"
                variant="primary"
                icon="check"
                loading={corroborate.isPending}
                onClick={() => corroborate.mutate({ id: concern.id, userId: me?.id })}
              >
                This happened to me too
              </Button>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-2)' }}>
                {corroborationWord(concern.corroborations)}
              </span>
            </div>
          </article>

          {/* ── the standing status explanation ───────────────────────── */}
          <div className={s.explainer}>
            <h2 className={s.explainerTitle}>Where this report stands</h2>
            <p className={s.explainerBody}>
              <strong>{status.label}.</strong> {status.hint}.
            </p>
            {industryReplies.length ? (
              <p className={s.explainerBody}>
                {industryReplies.length === 1 ? 'A company has' : 'Companies have'} replied to this
                report {industryReplies.length === 1 ? 'once' : `${industryReplies.length} times`}.
                Replies are claims. They do not change whether this report is open, and nobody
                checks them before they appear.
              </p>
            ) : null}
            <ul className={s.rules}>
              <li>
                <span className={s.ruleMark} aria-hidden>
                  👥
                </span>
                <span>
                  Neighbours can agree with it. Three reports within a few blocks in a day become a
                  group.
                </span>
              </li>
              <li>
                <span className={s.ruleMark} aria-hidden>
                  🏭
                </span>
                <span>An operator can reply and say what it tried. It cannot close this.</span>
              </li>
              <li>
                <span className={s.ruleMark} aria-hidden>
                  🏛️
                </span>
                <span>Only the regional air agency can mark this report done.</span>
              </li>
            </ul>
            <p className={s.explainerBody}>
              <Link to="/community/outreach">More on what a company can and cannot do here</Link>
            </p>
          </div>

          <SectionLabel>Replies</SectionLabel>
          <div className={s.thread}>
            {responses.length === 0 ? (
              <Empty icon="megaphone" title="No replies yet">
                Nobody has responded to this report yet. If the agency or an operator does, it will
                appear here with their name on it.
              </Empty>
            ) : null}
            {responses.map((r) => (
              <ResponseLine key={r.id} response={r} now={now} />
            ))}
          </div>

          <FootNote>
            Simulated data. This report, the person who filed it and anyone replying to it were all
            invented for a demonstration.
          </FootNote>
        </div>

        <aside className={s.rail}>
          <section className={s.railCard}>
            <h2 className={s.railTitle}>Nearby reports</h2>
            <div className={s.railList}>
              {nearby.length === 0 ? (
                <span className={s.railRowSub}>Nothing else reported within a few blocks.</span>
              ) : null}
              {nearby.map(({ c, d }) => (
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
              <Link to="/community/map">See them on the map</Link>
            </div>
          </section>

          {grouped ? (
            <section className={s.railCard}>
              <h2 className={s.railTitle}>Part of a group</h2>
              <p className={s.tileBody}>
                This report has been grouped with others close by. Groups are what the air agency
                triages first, and they show up on the operator&rsquo;s own screen too — you are no
                longer one voice.
              </p>
            </section>
          ) : null}

          <section className={s.railCard}>
            <h2 className={s.railTitle}>Noticed the same thing?</h2>
            <p className={s.tileBody}>
              Post your own. Two reports of the same smell an hour apart carry far more weight than
              one.
            </p>
            <div style={{ marginTop: 'var(--s-3)' }}>
              <Link to="/community/report">
                <Button variant="cta" block>
                  Report a concern
                </Button>
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
