/**
 * /industry/outreach — the community-facing portal, in nano scale.
 *
 * A claimed building, a logo, a brand colour, and a place to say something. The
 * one thing this page must be honest about: an operator can post, and can
 * propose a mitigation, and can do nothing else. Concerns close when the
 * community and the regulator say they close. The control that would close one
 * is shown, disabled, with the reason — hiding it would let the operator
 * believe they have authority they do not have.
 */

import { useState } from 'react'

import { Button, Field, Input, Select, Textarea, Tooltip } from '@/app/ui'
import { fmtDateTime, relativeShort } from '@/core/format'
import { useConcerns, useCreateMitigation, useCreatePost, usePosts } from '@/core/queries'
import { useSession } from '@/core/session'
import type { SitePost } from '@/core/types'

import { Caps, Panel, Tag, styles as s, useSiteLock } from './lib'

type PostKind = SitePost['kind']

export function Outreach() {
  const site = useSiteLock()
  const user = useSession((x) => x.user)
  const postsQ = usePosts({ site_id: site?.id }, { enabled: !!site })
  const concernsQ = useConcerns({ limit: 12 })
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

  const openConcerns = (concernsQ.data ?? []).filter((c) => c.status !== 'resolved' && c.status !== 'closed')

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
                  {site.claimed_by_user_id ? `Claimed ${relativeShort(site.claimed_at)} ago` : 'Unclaimed'}
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
                    { value: 'response', label: 'Response to a concern' },
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
                      { value: '', label: '— pick a concern —' },
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
                  A mitigation you file moves a concern to <b>MITIGATION PROPOSED</b> and no
                  further. Only the residents who filed it and DRAQA can close it. This is not a
                  UI limitation — the API returns 403.
                </span>
              </div>
              <Tooltip content="Industry accounts cannot resolve a community concern. The residents and the regulator decide when it is over.">
                <span style={{ display: 'inline-block' }}>
                  <Button variant="ghost" size="sm" disabled>
                    MARK CONCERN RESOLVED
                  </Button>
                </span>
              </Tooltip>
            </div>
          </Panel>
        </div>

        {/* ── what is out there ──────────────────────────────────────── */}
        <div className={s.scrollStack}>
          <Panel title="Open concerns near you" aside={<Caps>{openConcerns.length} open</Caps>}>
            <div className={s.tri}>
              {openConcerns.slice(0, 10).map((c) => (
                <div key={c.id} className={s.triRow} style={{ gridTemplateColumns: '12px minmax(0,1fr) 120px' }}>
                  <span style={{ color: 'var(--actor-community)' }}>●</span>
                  <div>
                    <div className={s.triSrc}>{c.title}</div>
                    <div className={s.triNote}>
                      {c.kind} · {c.district ?? 'nearby'} · {relativeShort(c.occurred_at)}
                      {c.corroborations ? ` · +${c.corroborations}` : ''}
                    </div>
                  </div>
                  <span className={s.triState}>
                    <span className={s.triBadge} style={{ color: 'var(--ink-2)' }}>
                      {c.status.replace('_', ' ')}
                    </span>
                  </span>
                </div>
              ))}
              {!openConcerns.length ? <div className={s.err}>No open concerns right now.</div> : null}
            </div>
          </Panel>

          <Panel title="Your posts" className={s.stackGrow} aside={<Caps>{(postsQ.data ?? []).length} published</Caps>}>
            {(postsQ.data ?? []).length ? (
              (postsQ.data ?? []).map((p) => (
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
