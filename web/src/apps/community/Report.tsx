/**
 * community — report a concern.
 *
 * This should feel like posting, not like filing. Five short steps, big
 * targets, plain words, and a location that is already right before you touch
 * it. Nobody is asked what PM2.5 is.
 */

import { Link, useNavigate } from '@tanstack/react-router'
import { useMemo, useState } from 'react'

import s from '@/apps/community/community.module.css'
import {
  CONCERN_KINDS,
  KIND_PROMPT,
  kindEmoji,
  kindLabel,
  PRIMARY_KINDS,
  SEVERITY_WORDS,
  useMe,
  usePlaces,
} from '@/apps/community/lib'
import { FootNote, SimNote } from '@/apps/community/parts'
import { Button, Chip, Field, Input, Textarea, Toggle } from '@/app/ui'
import { BaseMap, ConcernLayer, SegmentLayer, makeColorScale } from '@/components'
import { addHours, campaignMs, naive } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { fmtTime } from '@/core/format'
import { useCommunitySegments } from '@/apps/community/lib'
import { useCreateConcern } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type { Concern, ConcernKind, Position } from '@/core/types'

type WhenChoice = 'now' | 'hours' | 'night' | 'custom'

const WHEN_LABEL: Record<WhenChoice, string> = {
  now: 'Right now',
  hours: 'A few hours ago',
  night: 'Last night',
  custom: 'Another time',
}

/**
 * When it happened, as naive campaign time counted back from the DEMO's now.
 *
 * This was `toISOString()` off a `Date`: UTC digits, which the server reads as
 * Chicago time, so "Right now" was stamped five to seven hours away from the
 * moment on screen. And "Last night" before 6 a.m. set 22:30 on the SAME date —
 * later that night — so a report filed at 3 a.m. landed in the future and no
 * screen showed it. Nothing here can be later than now: a custom time past it
 * is pulled back to now, and the picker's `max` says so up front.
 */
function whenToCampaign(choice: WhenChoice, custom: string, now: CampaignTime): CampaignTime {
  if (choice === 'custom' && custom) {
    const t = naive(custom)
    const ms = campaignMs(t)
    if (Number.isFinite(ms)) return ms > campaignMs(now) ? now : t
  }
  if (choice === 'hours') return addHours(now, -4)
  // The evening before today's date, whatever the hour: on the digits, so a
  // daylight-saving night cannot move it.
  if (choice === 'night') return `${addHours(now, -24).slice(0, 10)}T22:30:00`
  return now
}

export function Report({ initialKind }: { initialKind?: ConcernKind }) {
  const navigate = useNavigate()
  const now = useNowCampaign()
  const me = useMe()
  const places = usePlaces()
  const segments = useCommunitySegments().data
  const create = useCreateConcern()

  const [kind, setKind] = useState<ConcernKind>(initialKind ?? 'smell')
  const [showAllKinds, setShowAllKinds] = useState(
    !!initialKind && !PRIMARY_KINDS.includes(initialKind),
  )
  const [severity, setSeverity] = useState<1 | 2 | 3 | 4 | 5>(3)
  const [where, setWhere] = useState<string>(places.homeName)
  const [pin, setPin] = useState<Position | null>(null)
  const [when, setWhen] = useState<WhenChoice>('now')
  const [customWhen, setCustomWhen] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [anon, setAnon] = useState(false)
  const [posted, setPosted] = useState<Concern | null>(null)

  const center: Position = pin ?? places.centers.get(where) ?? places.home
  const occurredAt = whenToCampaign(when, customWhen, now)

  const draft: Concern = useMemo(
    () => ({
      id: 'draft',
      author: null,
      kind,
      severity,
      title: title || 'Your report',
      body: null,
      lon: center[0],
      lat: center[1],
      address_hint: null,
      district: where,
      occurred_at: occurredAt,
      created_at: occurredAt,
      status: 'new',
      cluster_id: null,
      corroborations: 0,
      is_anonymous: anon,
      photo_emoji: kindEmoji(kind),
      suspected_site_id: null,
      responses: [],
    }),
    [kind, severity, title, center, where, occurredAt, anon],
  )

  const kindsShown = showAllKinds ? CONCERN_KINDS : PRIMARY_KINDS
  const canPost = title.trim().length > 2

  function submit() {
    create.mutate(
      {
        kind,
        severity,
        title: title.trim(),
        body: body.trim() || undefined,
        lon: center[0],
        lat: center[1],
        occurred_at: occurredAt,
        is_anonymous: anon,
        address_hint: where,
        photo_emoji: kindEmoji(kind),
        author_id: anon ? undefined : (me?.id ?? undefined),
      },
      { onSuccess: (c) => setPosted(c) },
    )
  }

  if (posted) {
    return (
      <div className={s.page}>
        <SimNote />
        <div className={s.posted}>
          <div className={s.postedGlyph} aria-hidden>
            {kindEmoji(posted.kind)}
          </div>
          <h1 className={s.postedTitle}>Posted. Your neighbours can see it now.</h1>
          <p className={s.postedBody}>
            It is in the feed, on the map, and in the queue the regional air agency reads. If two
            more people within a few blocks report something like this in the next day, the three
            reports are grouped together — and a group is much harder to wave away than one person.
          </p>
          <p className={s.postedBody}>
            An operator nearby may reply saying they tried something. That reply will never close
            your report. Only the air agency can do that.
          </p>
          <div className={s.postedActions}>
            <Button variant="primary" onClick={() => navigate({ to: '/community' })}>
              Back to the feed
            </Button>
            <Button variant="secondary" onClick={() => navigate({ to: `/community/c/${posted.id}` })}>
              See your report
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={s.page}>
      <SimNote>
        Nothing you post here reaches a real agency or a real company — this is a demonstration
        with invented actors.
      </SimNote>

      <header style={{ marginBottom: 'var(--s-5)' }}>
        <h1 className={s.hello}>Tell your neighbours what you noticed</h1>
        <p className={s.helloSub}>
          No forms, no jargon. Five quick answers and it is up. You can post without your name on
          it.
        </p>
      </header>

      <div className={s.form}>
        {/* ── 1 · what ─────────────────────────────────────────────── */}
        <section className={s.step}>
          <div className={s.stepHead}>
            <span className={s.stepNum}>1</span>
            <h2 className={s.stepTitle}>What did you notice?</h2>
          </div>
          <div className={s.kindGrid}>
            {kindsShown.map((k) => (
              <button
                key={k}
                type="button"
                className={[s.kindTile, k === kind ? s.kindTileActive : ''].join(' ')}
                aria-pressed={k === kind}
                onClick={() => setKind(k)}
              >
                <span className={s.kindTileGlyph} aria-hidden>
                  {kindEmoji(k)}
                </span>
                <span className={s.kindTileName}>{kindLabel(k)}</span>
                <span className={s.kindTileHint}>{KIND_PROMPT[k]}</span>
              </button>
            ))}
          </div>
          {!showAllKinds ? (
            <div style={{ marginTop: 'var(--s-3)' }}>
              <Button size="sm" variant="quiet" onClick={() => setShowAllKinds(true)}>
                Something else — lights, trucks, shaking…
              </Button>
            </div>
          ) : null}
        </section>

        {/* ── 2 · how bad ──────────────────────────────────────────── */}
        <section className={s.step}>
          <div className={s.stepHead}>
            <span className={s.stepNum}>2</span>
            <h2 className={s.stepTitle}>How bad was it?</h2>
            <span className={s.stepHint}>{SEVERITY_WORDS[severity]}</span>
          </div>
          <div className={s.sevScale}>
            <div className={s.sevTrack}>
              {([1, 2, 3, 4, 5] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={v === severity}
                  className={[s.sevStep, v === severity ? s.sevStepActive : ''].join(' ')}
                  onClick={() => setSeverity(v)}
                >
                  <span
                    className={s.sevBar}
                    style={{
                      background:
                        v <= severity ? `var(--ramp-aqi-${Math.min(6, v)})` : 'var(--bg-sunk)',
                    }}
                  />
                  {SEVERITY_WORDS[v]}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* ── 3 · where ────────────────────────────────────────────── */}
        <section className={s.step}>
          <div className={s.stepHead}>
            <span className={s.stepNum}>3</span>
            <h2 className={s.stepTitle}>Where?</h2>
            <span className={s.stepHint}>
              {pin ? 'Using the spot you tapped' : `Defaulting to ${where}`}
            </span>
          </div>
          <div className={s.whereGrid}>
            <div>
              <div className={s.whenRow} style={{ marginBottom: 'var(--s-3)' }}>
                {places.names.slice(0, 7).map((n) => (
                  <Chip
                    key={n}
                    small
                    active={n === where && !pin}
                    onClick={() => {
                      setWhere(n)
                      setPin(null)
                    }}
                  >
                    {n}
                  </Chip>
                ))}
              </div>
              <p className={s.tileBody}>
                Your neighbourhood is filled in already. Tap the map if it happened somewhere else —
                a corner, a park, outside work. The exact spot matters: reports within a few blocks
                of each other get grouped.
              </p>
              {pin ? (
                <div style={{ marginTop: 'var(--s-3)' }}>
                  <Button size="sm" variant="quiet" onClick={() => setPin(null)}>
                    Use {where} instead
                  </Button>
                </div>
              ) : null}
            </div>
            <div className={s.miniMap}>
              <BaseMap
                label="Choose where it happened"
                initialView={{ longitude: center[0], latitude: center[1], zoom: 13.2 }}
                view={{ longitude: center[0], latitude: center[1], zoom: 13.2 }}
                gridOverlay={false}
                attribution={false}
                onClick={(info) => {
                  const c = info.coordinate
                  if (c && c.length >= 2) setPin([c[0], c[1]])
                }}
                layers={(t) => [
                  ...SegmentLayer({
                    data: segments,
                    theme: t,
                    metric: 'risk',
                    scale: makeColorScale(t, { domain: [0, 100], ramp: 'aqi' }),
                    dualEncode: 'none',
                    pickable: false,
                    widthMinPixels: 1,
                    opacity: 0.75,
                  }),
                  ...ConcernLayer({ data: [draft], theme: t, labels: false, pickable: false }),
                ]}
              />
              <span className={s.mapHint}>Tap to move the pin</span>
            </div>
          </div>
        </section>

        {/* ── 4 · when ─────────────────────────────────────────────── */}
        <section className={s.step}>
          <div className={s.stepHead}>
            <span className={s.stepNum}>4</span>
            <h2 className={s.stepTitle}>When?</h2>
            <span className={s.stepHint}>{fmtTime(occurredAt)}</span>
          </div>
          <div className={s.whenRow}>
            {(['now', 'hours', 'night', 'custom'] as const).map((w) => (
              <Chip key={w} active={w === when} onClick={() => setWhen(w)}>
                {WHEN_LABEL[w]}
              </Chip>
            ))}
            {when === 'custom' ? (
              <Input
                type="datetime-local"
                max={now.slice(0, 16)}
                value={customWhen}
                onChange={(e) => setCustomWhen(e.currentTarget.value)}
                aria-label="When it happened"
              />
            ) : null}
          </div>
        </section>

        {/* ── 5 · words ────────────────────────────────────────────── */}
        <section className={s.step}>
          <div className={s.stepHead}>
            <span className={s.stepNum}>5</span>
            <h2 className={s.stepTitle}>In your own words</h2>
          </div>
          <Field label="One line your neighbours will see" required>
            <Input
              value={title}
              maxLength={90}
              placeholder={
                kind === 'smell'
                  ? 'Burnt metal smell down the block'
                  : kind === 'noise'
                    ? 'Low hum shaking the windows'
                    : kind === 'health'
                      ? 'Headache and burning eyes all evening'
                      : 'What you noticed, in a few words'
              }
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
          </Field>
          <div style={{ height: 'var(--s-4)' }} />
          <Field label="Anything else? (optional)" hint="What it smelled like, how long it lasted, who else noticed.">
            <Textarea
              rows={3}
              value={body}
              placeholder="It started around the same time as last night and lasted about an hour."
              onChange={(e) => setBody(e.currentTarget.value)}
            />
          </Field>
          <div style={{ marginTop: 'var(--s-4)' }}>
            <Toggle
              checked={anon}
              onChange={setAnon}
              label="Post without my name (your neighbourhood still shows)"
            />
          </div>
        </section>

        <div className={s.submitBar}>
          <span className={s.submitNote}>
            Posting as <strong>{anon ? 'a neighbour in ' + where : (me?.name ?? 'a neighbour')}</strong>
            . Your report goes to your neighbours and to the regional air agency at the same time.
          </span>
          <span style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center' }}>
            <Link to="/community" style={{ fontSize: 'var(--text-sm)' }}>
              Cancel
            </Link>
            <Button
              variant="cta"
              size="lg"
              disabled={!canPost}
              loading={create.isPending}
              onClick={submit}
            >
              Post to your neighbours
            </Button>
          </span>
        </div>

        {create.isError ? (
          <p className={s.footNote} style={{ color: 'var(--sev-critical)' }}>
            We could not post that just now. The demonstration backend may be offline — try again in
            a moment.
          </p>
        ) : null}
      </div>

      <FootNote>
        Reports are public to the neighbourhood. Your exact address is never shown — only the block
        and the neighbourhood name.
      </FootNote>
    </div>
  )
}
