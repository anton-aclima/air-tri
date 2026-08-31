/**
 * community — the small pieces every screen shares.
 *
 * A resident should be able to read any one of these in a glance and never
 * meet a unit, an acronym or an axis.
 */

import { Link } from '@tanstack/react-router'
import type { CSSProperties, ReactNode } from 'react'

import s from '@/apps/community/community.module.css'
import { VOICE, type Voice } from '@/apps/community/lib'
import { Avatar } from '@/app/ui'
import { riskColorVar, riskLabel } from '@/core/measures'
import { relativeTime } from '@/core/format'

/** The standing reminder that every person and company here is invented. */
export function SimNote({ children }: { children?: ReactNode }) {
  return (
    <p className={s.simNote}>
      <strong>Simulated data</strong>
      <span>
        {children ??
          'Real streets and real neighbourhood names. Every person, company and agency on this page is fictional.'}
      </span>
    </p>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className={s.sectionLabel}>{children}</h2>
}

/** The only magnitude a resident ever sees: a 0–100 score with a word. */
export function RiskPill({
  risk,
  label,
  caption,
}: {
  risk: number | null | undefined
  label?: string
  caption?: string
}) {
  if (risk == null || !Number.isFinite(risk)) {
    return (
      <span className={s.riskPill}>
        <span className={s.riskSwatch} style={{ background: 'var(--line-strong)' }} />
        <span>Not measured yet</span>
      </span>
    )
  }
  return (
    <span className={s.riskPill} title={caption ?? `${Math.round(risk)} out of 100`}>
      <span className={s.riskSwatch} style={{ background: riskColorVar(risk) }} />
      <b className="num">{Math.round(risk)}</b>
      <span>{label ?? riskLabel(risk)}</span>
    </span>
  )
}

/** Who is speaking. Colour is the stripe; the words carry the meaning. */
export function VoiceTag({ voice, children }: { voice: Voice; children?: ReactNode }) {
  return (
    <span className={s.voiceTag} style={{ ['--voice' as string]: VOICE[voice].token }}>
      {children ?? VOICE[voice].who}
    </span>
  )
}

export interface BylineProps {
  voice: Voice
  name: string
  /** "Boxtown · 20 min ago" — the second line under the name. */
  meta?: ReactNode
  at?: string | null
  now?: Date
  emoji?: string | null
  color?: string | null
  tag?: string
  actions?: ReactNode
}

export function Byline({ voice, name, meta, at, now, emoji, color, tag, actions }: BylineProps) {
  return (
    <div className={s.byline}>
      <Avatar
        emoji={emoji ?? undefined}
        name={name}
        color={color ?? undefined}
        size="md"
        ring={VOICE[voice].token}
      />
      <div className={s.bylineNames}>
        <span className={s.bylineName}>
          <span className="truncate">{name}</span>
          <VoiceTag voice={voice}>{tag}</VoiceTag>
        </span>
        <span className={s.bylineMeta}>
          {meta}
          {meta && at ? <span className={s.bylineDot}>·</span> : null}
          {at ? <span>{relativeTime(at, now ?? new Date())}</span> : null}
        </span>
      </div>
      {actions ? <span style={{ marginLeft: 'auto' }}>{actions}</span> : null}
    </div>
  )
}

export interface PostProps {
  voice: Voice
  children: ReactNode
  to?: string
  className?: string
  style?: CSSProperties
}

/** One card in the stream. The left stripe says who is talking. */
export function Post({ voice, children, to, className, style }: PostProps) {
  const css: CSSProperties = { ['--voice' as string]: VOICE[voice].token, ...style }
  const cls = [s.post, to ? s.postInteractive : '', className ?? ''].filter(Boolean).join(' ')
  if (to) {
    return (
      <Link to={to} className={cls} style={css}>
        {children}
      </Link>
    )
  }
  return (
    <article className={cls} style={css}>
      {children}
    </article>
  )
}

/**
 * A company's claim, rendered so nobody could mistake it for a resolution.
 * This is the asymmetry from the brief, in one component.
 */
export function ClaimNote({ who, body }: { who: string; body: ReactNode }) {
  return (
    <div className={s.claim}>
      <div className={s.claimHead}>{who} says it attempted a fix</div>
      <div className={s.claimBody}>{body}</div>
      <span className={s.stillOpen}>Still open — only the agency can close a report</span>
    </div>
  )
}

/** A named thing with a risk bar. Stands in for a chart, reads faster. */
export function MeterRow({
  name,
  sub,
  risk,
  tight,
  onClick,
}: {
  name: string
  sub?: string
  risk: number | null
  /** Narrow variant for the 320 px rail. */
  tight?: boolean
  onClick?: () => void
}) {
  const cls = [s.meterRow, tight ? s.meterRowTight : ''].filter(Boolean).join(' ')
  const pct = risk == null ? 0 : Math.max(2, Math.min(100, risk))
  const body = (
    <>
      <span>
        <span className={s.meterName}>{name}</span>
        {sub ? <div className={s.meterSub}>{sub}</div> : null}
      </span>
      <span className={s.meter} aria-hidden>
        <span
          className={s.meterFill}
          style={{ width: `${pct}%`, background: risk == null ? 'var(--line-strong)' : riskColorVar(risk) }}
        />
      </span>
      <span className={s.meterValue}>{risk == null ? '—' : Math.round(risk)}</span>
    </>
  )
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick} style={{ background: 'none', border: 0 }}>
        {body}
      </button>
    )
  }
  return <div className={cls}>{body}</div>
}

/** The anti-stalking promise, said out loud wherever a car appears. */
export function DelayNote({ minutes }: { minutes: number }) {
  const hours = Math.max(3, Math.round(minutes / 60))
  return (
    <span className={s.delayNote} title="An anti-stalking measure, on purpose.">
      🕒 Car positions are at least {hours} hours old, on purpose
    </span>
  )
}

export function FootNote({ children }: { children: ReactNode }) {
  return <p className={s.footNote}>{children}</p>
}
