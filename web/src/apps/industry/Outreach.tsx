/**
 * /industry/outreach — what residents see of this site, and a place to answer.
 *
 * A claimed building, a logo, a brand colour, and a place to say something. The
 * one thing this page must be honest about: an operator can post, answer a
 * resident's report and propose a mitigation, and can do nothing else. Only
 * the air agency or Aclima can close a resident's report — the server refuses
 * anyone else with a 403 (routers/concerns.py) — and every industry page says
 * so in the same sentence, `WHO_CLOSES`. (This page used to say "the residents
 * who filed it and DRAQA", which the server does not allow.) The control that
 * would close one is shown, disabled, with the reason: hiding it would let the
 * operator believe they have authority they do not have.
 */

import { useMemo, useState } from 'react'

import { Button, Field, Input, Select, Textarea, Tooltip } from '@/app/ui'
import { hasStarted, happenedBy, isOpenCase } from '@/core/events'
import { fmtDateTime, relativeShort, relativeTime } from '@/core/format'
import { useConcerns, useCreateMitigation, useCreatePost, usePosts } from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type { SitePost } from '@/core/types'

import { Caps, Panel, Tag, styles as s, useSiteLock } from './lib'

type PostKind = SitePost['kind']

/** The one answer to "who can close a resident's report", matching the server (403). */
const WHO_CLOSES = "Only the air agency or Aclima can close a resident's report; you can answer it or propose a mitigation."

export function Outreach() {
  const site = useSiteLock()
  const user = useSession((x) => x.user)
  const now = useNowCampaign()
  const postsQ = usePosts({ site_id: site?.id }, { enabled: !!site })
  // Cut at the moment shown by the server (`at`, before its LIMIT), so these
  // are that moment's newest 12, not the end of the data's.
  const concernsQ = useConcerns({ limit: 12 })
  // Only what had happened by the moment shown (D2). `/posts` has no `at`, so
  // this cut is the only one; `isOpenCase` below repeats the server's for the
  // frames where the previous moment's list is still on screen. A post
  // published here is stamped with the server's now, the end of the data, so
  // it shows once the clock is back at the end.
  const posts = useMemo(() => happenedBy(postsQ.data, now), [postsQ.data, now])
  const openConcerns = useMemo(
    () => (concernsQ.data ?? []).filter((c) => isOpenCase(c, now)),
    [concernsQ.data, now],
  )
  const createPost = useCreatePost()
  const mitigate = useCreateMitigation()

  const [kind, setKind] = useState<PostKind>('update')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [emoji, setEmoji] = useState('')
  const [replyTo, setReplyTo] = useState<string>('')

  if (!site) {
    return <div className={`${s.page} ${s.outreachPage}`}><div className={s.err}>No site claimed.</div></div>
  }

  const submit = () => {
    if (!title.trim()) return
    createPost.mutate(
      {
        site_id: site.id,
        kind,
        title: title.trim(),
        body: body.trim() || title.trim(),
        ...(emoji.trim() ? { media_emoji: emoji.trim() } : {}),
        ...(replyTo ? { concern_id: replyTo } : {}),
        ...(user?.id ? { author_id: user.id } : {}),
      },
      { onSuccess: () => { setTitle(''); setBody(''); setEmoji('') } },
    )
  }

  return (
    <div className={`${s.page} ${s.outreachPage}`}>
      <div className={s.outreachBody}>
        {/* ── identity + compose ─────────────────────────────────────── */}
        <div className={s.scrollStack}>
          <Panel title="Your building on the map">
            <div className={s.brand}>
              <span
                className={s.brandMark}
                style={site.brand_color ? { color: site.brand_color, borderColor: site.brand_color } : undefined}
              >
                {site.logo_emoji ?? '▲'}
              </span>
              <div className={s.bannerLine}>
                <span className={s.brandName}>{site.name}</span>
                <span className={s.bannerSub}>
                  {site.claimed_by_user_id && site.claimed_at && hasStarted({ created_at: site.claimed_at }, now)
                    ? `Claimed ${relativeTime(site.claimed_at, now)}`
                    : 'Unclaimed'}
                  {' · '}{site.kind} · {site.status}
                </span>
              </div>
            </div>
            <div className={s.form}>
              <span className={s.postBody}>{site.blurb}</span>
              <div className={s.strip} style={{ padding: 0, borderTop: 0 }}>
                <Tag tone="accent">{site.emission_points.length} emission points</Tag>
                <Tag>{site.generator_fuel ?? 'generation'}</Tag>
              </div>
            </div>
          </Panel>

          <Panel title="Post to the community feed">
            <div className={s.form}>
              <Field label="Kind">
                <Select
                  value={kind}
                  options={[
                    { value: 'update', label: 'Operational update' },
                    { value: 'mitigation', label: 'Mitigation' },
                    { value: 'event', label: 'Planned event' },
                    { value: 'response', label: "Reply to a resident's report" },
                    { value: 'intro', label: 'Introduction' },
                  ]}
                  onValueChange={(v) => setKind(v as PostKind)}
                />
              </Field>
              {kind === 'response' ? (
                <Field label="Responding to" hint="Residents see your reply under their report.">
                  <Select
                    value={replyTo}
                    options={[
                      { value: '', label: '— pick a report —' },
                      ...openConcerns.map((c) => ({ value: c.id, label: `${c.title} · ${c.district ?? ''}` })),
                    ]}
                    onValueChange={(v) => setReplyTo(v)}
                  />
                </Field>
              ) : null}
              <Field label="Headline">
                <Input value={title} onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Turbine test window moved to daylight hours" />
              </Field>
              <Field label="Message" hint="Plain language. No acronyms — residents do not read in ppb.">
                <Textarea rows={4} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
              </Field>
              <div className={s.formRow}>
                <Field label="Emoji">
                  <Input value={emoji} onChange={(e) => setEmoji(e.currentTarget.value)} placeholder="🛠" />
                </Field>
                <span className={s.spacer} />
                <Button variant="primary" size="sm" disabled={!title.trim() || createPost.isPending} onClick={submit}>
                  PUBLISH
                </Button>
              </div>
              {createPost.isError ? <Caps>post rejected · {createPost.error.message}</Caps> : null}
            </div>
          </Panel>

          <Panel title="What you may not do">
            <div className={s.form}>
              <div className={s.notice}>
                <span className={s.noticeMark}>▲</span>
                <span>
                  {WHO_CLOSES} Either one moves the report to “mitigation proposed” and no
                  further; the server refuses anything else.
                </span>
              </div>
              <Tooltip content={WHO_CLOSES}>
                <span style={{ display: 'inline-block' }}>
                  <Button variant="ghost" size="sm" disabled>
                    CLOSE REPORT
                  </Button>
                </span>
              </Tooltip>
            </div>
          </Panel>
        </div>

        {/* ── what is out there ──────────────────────────────────────── */}
        <div className={s.scrollStack}>
          <Panel title="Open resident reports" aside={<Caps>{openConcerns.length} open</Caps>}>
            <div className={s.tri}>
              {openConcerns.slice(0, 10).map((c) => (
                <div key={c.id} className={s.triRow} style={{ gridTemplateColumns: '12px minmax(0,1fr) 120px' }}>
                  <span style={{ color: 'var(--actor-community)' }}>●</span>
                  <div>
                    <div className={s.triSrc}>{c.title}</div>
                    <div className={s.triNote}>
                      {c.kind} · {c.district ?? 'nearby'} · {relativeShort(c.occurred_at, now)}
                      {c.corroborations ? ` · +${c.corroborations}` : ''}
                    </div>
                  </div>
                  <span className={s.triState}>
                    <span className={s.triBadge} style={{ color: 'var(--ink-2)' }}>
                      {c.status.replace(/_/g, ' ')}
                    </span>
                  </span>
                </div>
              ))}
              {!openConcerns.length ? <div className={s.err}>No open reports at the moment shown.</div> : null}
            </div>
          </Panel>

          <Panel title="Your posts" className={s.stackGrow} aside={<Caps>{posts.length} published</Caps>}>
            {posts.length ? (
              posts.map((p) => (
                <article key={p.id} className={s.post}>
                  <div className={s.postHead}>
                    <span>{p.media_emoji ?? p.logo_emoji ?? '▲'}</span>
                    <span className={s.postTitle}>{p.title}</span>
                    <span className={s.spacer} />
                    <Tag tone={p.kind === 'mitigation' ? 'accent' : undefined}>{p.kind}</Tag>
                  </div>
                  <span className={s.postBody}>{p.body}</span>
                  <Caps>{fmtDateTime(p.created_at)}{p.concern_id ? ' · reply to a resident report' : ''}</Caps>
                </article>
              ))
            ) : (
              <div className={s.err}>
                Nothing published yet. Residents can see your building on the map; right now it
                says nothing back.
              </div>
            )}
          </Panel>

          {mitigate.isError ? <Caps>mitigation rejected · {mitigate.error.message}</Caps> : null}
        </div>
      </div>
    </div>
  )
}
