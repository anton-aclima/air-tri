/**
 * The two buttons the whole role exists for.
 *
 * When a reading crosses a line DRAQA owns, the agency has exactly two moves:
 * warn the people who breathe it, and put the operator on notice. Both land in
 * interfaces that are already built — the advisory shows up in the community
 * feed, the notice shows up on the operator's scope — so this composer stays
 * deliberately small. It drafts the text from the exceedance itself, because a
 * regulator who has to write prose at 03:00 does not send the message.
 */

import { useMemo, useState } from 'react'

import { Button, Textarea } from '@/app/ui'
import { fmtNum } from '@/core/format'
import { useCreateAdvisory } from '@/core/queries'
import { useSession } from '@/core/session'
import type { ActionLevel, Alert, Role, Severity } from '@/core/types'

import { Caps, Tag, levelUnit, shortWhere, styles as s } from './lib'

export interface PushSubject {
  measure: string | null
  severity: Severity
  /** Where the exceedance is, in words. */
  where: string
  value: number | null
  threshold: number | null
  unit: string | null
  alertId?: string
  levelLabel?: string
}

export function subjectFromAlert(a: Alert): PushSubject {
  return {
    measure: a.measure,
    severity: a.severity,
    where: shortWhere(a),
    value: a.value,
    threshold: a.threshold,
    unit: a.unit,
    alertId: a.id,
    levelLabel: a.title,
  }
}

export function subjectFromLevel(level: ActionLevel, worst: Alert | undefined): PushSubject {
  return {
    measure: level.measure,
    severity: level.severity,
    where: worst ? shortWhere(worst) : 'the monitored area',
    value: worst?.value ?? null,
    threshold: level.threshold,
    unit: levelUnit(level),
    alertId: worst?.id,
    levelLabel: level.label,
  }
}

function num(v: number | null, unit: string | null): string {
  if (v == null) return '—'
  return `${fmtNum(v, v >= 100 ? 0 : 1)}${unit ? ` ${unit}` : ''}`
}

/**
 * Residents get no units and no acronyms — that rule holds even when the
 * regulator is the author, because the community skin is where this lands.
 */
function communityDraft(x: PushSubject): string {
  const over = x.value != null && x.threshold != null && x.threshold > 0
    ? `about ${fmtNum(x.value / x.threshold, 1)} times`
    : 'above'
  return [
    `Our monitoring is showing ${over} the level we act on near ${x.where}.`,
    'If you are sensitive to air quality, consider keeping windows closed and limiting time outdoors until this clears.',
    'We have put the operator on notice and are following up.',
  ].join(' ')
}

/** The operator gets the numbers, the rule, and what happens next. */
function industryDraft(x: PushSubject): string {
  const m = x.measure ? x.measure.toUpperCase() : 'The monitored pollutant'
  return [
    `${m} measured ${num(x.value, x.unit)} against the ${x.levelLabel ?? 'action level'} of ${num(x.threshold, x.unit)} at ${x.where}.`,
    'DRAQA requires a written account of operating conditions during this window, and any mitigation applied, within 24 hours.',
    'A community advisory may be issued for the same period.',
  ].join(' ')
}

export function PushComposer({ subject, compact }: { subject: PushSubject; compact?: boolean }) {
  const create = useCreateAdvisory()
  const authorId = useSession((x) => x.user?.id ?? undefined)
  const [audience, setAudience] = useState<Role | null>(null)
  const [body, setBody] = useState('')
  const [sent, setSent] = useState<Role | null>(null)

  const drafts = useMemo(
    () => ({ community: communityDraft(subject), industry: industryDraft(subject) }),
    [subject],
  )

  const open = (who: Role) => {
    setAudience(who)
    setBody(who === 'community' ? drafts.community : drafts.industry)
    setSent(null)
  }

  const send = () => {
    if (!audience) return
    const m = subject.measure ? subject.measure.toUpperCase() : null
    create.mutate(
      {
        kind: audience === 'community' ? 'advisory' : 'notice',
        severity: subject.severity,
        title:
          audience === 'community'
            ? `Air quality advisory · ${subject.where}`
            : `DRAQA notice · ${m ?? 'action level'} over ${subject.levelLabel ?? 'action level'}`,
        body,
        ...(subject.measure ? { measure: subject.measure as never } : {}),
        ...(subject.alertId ? { alert_id: subject.alertId } : {}),
        audience: [audience],
        ...(authorId ? { author_id: authorId } : {}),
      },
      {
        onSuccess: () => { setSent(audience); setAudience(null) },
      },
    )
  }

  return (
    <div className={s.push}>
      {sent ? (
        <div className={s.pushSent}>
          <span className={s.towerInk}>✓</span>
          {sent === 'community'
            ? 'Advisory published to the community feed — plain language, no units.'
            : 'Notice delivered to the operator. It is on their scope now.'}
        </div>
      ) : null}

      {audience === null ? (
        <>
          <div className={s.pushRow}>
            <Button size="sm" variant="primary" icon="megaphone" onClick={() => open('community')}>
              Advisory to community
            </Button>
            <Button size="sm" icon="factory" onClick={() => open('industry')}>
              Notice to industry
            </Button>
          </div>
          {compact ? null : (
            <span className={s.subTight}>
              Both land live in the other two interfaces. Residents see plain language with no
              units; the operator sees the concentration, the rule and the deadline.
            </span>
          )}
        </>
      ) : (
        <>
          <div className={s.pushRow}>
            <Tag tone={audience === 'community' ? 'community' : 'invader'}>
              to {audience === 'community' ? 'residents' : 'operator'}
            </Tag>
            <Caps>{audience === 'community' ? 'no units · no acronyms' : 'concentrations · rule · deadline'}</Caps>
          </div>
          <Textarea
            value={body}
            rows={compact ? 4 : 5}
            onChange={(e) => setBody(e.currentTarget.value)}
            style={{ fontSize: 'var(--text-xs)' }}
          />
          <div className={s.pushRow}>
            <Button size="sm" variant="primary" loading={create.isPending} onClick={send}>
              Publish
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAudience(null)}>Cancel</Button>
            <span className={s.spacer} />
            {create.isError ? <Caps>send failed</Caps> : null}
          </div>
        </>
      )}
    </div>
  )
}
