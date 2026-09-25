/**
 * The two messages the agency can send about an alert.
 *
 * An advisory to the residents who breathe it, and a request for information
 * to operators. Both land in screens that already exist — the advisory in the
 * residents' feed, the request in the industry feed — so this composer stays
 * small. It drafts the text from the alert's own fields, because a regulator
 * who has to write prose at 03:00 does not send the message.
 *
 * What the drafts will not say, and why (CONTRACT §10a, PLAN-plume "Never
 * say"):
 *
 *   - No site and no operator is named or implied as the cause. The previous
 *     resident draft ended "We have put the operator on notice", which names a
 *     culprit the alert does not establish (§10a.3) and claims a notice that
 *     may never have been sent. The request to operators says in its own words
 *     that it is not a finding about any site.
 *   - No all-clear. Nothing here says the air is safe, cleared or back to
 *     normal, including for an episode that has ended.
 *   - No present tense for the past. The old draft read "Our monitoring is
 *     showing …" for Riverport Road's Aug 25 exceedance, three days after it
 *     ended. An ended episode is written as what happened, with its times.
 *   - Residents get no units and no acronyms (non-negotiable 3), so the
 *     pollutant is its plain name ("traffic and engine fumes", not NO2).
 *   - A resident cluster is a count of reports, not a concentration. The old
 *     draft divided 6 reports by a threshold of 3 and told residents the air
 *     was "about 2 times the level we act on".
 *   - DRAQA is the fictional agency. No real agency or standards body is named
 *     in anything sent.
 */

import { useMemo, useState } from 'react'

import { Button, Textarea } from '@/app/ui'
import { campaignMs } from '@/core/clock'
import { fmtDay, fmtDuration, fmtNum, fmtTime, fmtTime24 } from '@/core/format'
import { useCreateAdvisory } from '@/core/queries'
import { useSession } from '@/core/session'
import type { Role } from '@/core/types'

import { unitText } from './alerting'
import type { PushSubject } from './alerting'
import p from './push.module.css'

/** Which audiences a subject can be written to at all. */
function audiencesFor(x: PushSubject): Role[] {
  // A vehicle out of service, or the agency's own notice, is the agency's
  // business, not news about the air.
  if (x.source === 'ops' || x.source === 'agency') return []
  // A model check is about a filed study, not the air on anyone's street.
  if (x.source === 'model') return ['industry']
  return ['community', 'industry']
}

/**
 * When, in words, as a leading phrase ("On Aug 25, from 5:00 AM to 7:00 AM").
 * A mobile detection is a finding raised at one moment — "Highest diesel …
 * on the network" is the street's campaign 90th percentile, flagged at 01:29
 * — and its alert stays open with no end. It is written as when it was
 * flagged, never as "since 01:29", which would claim the street read high for
 * the twelve hours after, nor as a reading taken at 01:29.
 */
function when(x: PushSubject, clock: (t: string) => string): string {
  const day = fmtDay(x.startedAt)
  if (x.source === 'fleet') return `on ${day} at ${clock(x.startedAt)}`
  if (!x.endedAt) return `Since ${clock(x.startedAt)} on ${day}`
  return fmtDay(x.endedAt) === day
    ? `On ${day}, from ${clock(x.startedAt)} to ${clock(x.endedAt)}`
    : `From ${day} ${clock(x.startedAt)} to ${fmtDay(x.endedAt)} ${clock(x.endedAt)}`
}

function times(x: PushSubject): string | null {
  if (x.value == null || x.threshold == null || x.threshold <= 0) return null
  return fmtNum(x.value / x.threshold, 1)
}

/** Plain words for residents: no units, no acronyms, no culprit, no all-clear. */
function communityDraft(x: PushSubject): string {
  const what = x.plainName ?? 'air pollution'
  const n = times(x)
  const level = n ? `at about ${n} times the level we act on` : 'above the level we act on'
  const close = 'We are looking into it and will post what we learn here.'
  const at = when(x, fmtTime)
  if (x.source === 'residents') {
    const verb = x.endedAt ? 'reported' : 'have been reporting'
    return `${at}, several neighbours ${verb} air concerns near ${x.where}. ${close}`
  }
  if (x.source === 'fleet') {
    return `Street measurements on ${x.where}, flagged ${at}, found ${what} ${level}. ${close}`
  }
  // A fence sensor belongs to an operator, not to the agency writing this.
  const who = x.source === 'fence' ? 'an air monitor' : 'our air monitor'
  if (!x.endedAt) {
    return [
      `${at}, ${who} near ${x.where} has been reading ${what} ${level}.`,
      'If you are sensitive to air quality, you may want to keep windows closed and spend less time outdoors for now.',
      close,
    ].join(' ')
  }
  return `${at}, ${who} near ${x.where} read ${what} ${level}. ${close}`
}

/**
 * The operator's version: the reading, the level, the window and the ask —
 * and that it is a request, not a finding. It goes to every operator, so it
 * names none of them.
 */
function industryDraft(x: PushSubject): string {
  const ask = 'DRAQA asks operators nearby to describe their operating conditions during that window, and any mitigation applied, within 24 hours. This is a request for information, not a finding about any site.'
  if (x.source === 'model') {
    return [
      `${x.title}.`,
      'DRAQA asks the operator that filed this study to review it against the measured wind before its next permit filing.',
    ].join(' ')
  }
  const at = when(x, fmtTime24)
  if (x.source === 'residents') {
    const verb = x.endedAt ? 'filed' : 'have filed'
    return `${at}, residents ${verb} a cluster of air concern reports near ${x.where}. ${ask}`
  }
  const m = x.measureLabel ?? 'the pollutant'
  const level = x.threshold == null
    ? ''
    : `, against the ${levelWords(x.levelLabel)} of ${num(x.threshold, x.unit)}`
  if (x.source === 'fleet') {
    const reading = x.value == null ? '' : `: ${num(x.value, x.unit)}`
    return `The mobile fleet flagged ${m} on ${x.where} ${at}${reading}${level}. ${ask.replace('during that window', 'around that time')}`
  }
  const instrument = x.source === 'fence'
    ? `the ${x.where} fence sensor`
    : `DRAQA's ${x.where} reference monitor`
  const long = x.endedAt
    ? ` (${fmtDuration(campaignMs(x.endedAt) - campaignMs(x.startedAt))})`
    : ''
  // In replay the reading of an hour still in progress is not known yet
  // (alerting `knownValue`), so the draft says only that it is over the level.
  if (x.value == null) {
    const over = x.threshold == null ? 'over its action level' : `over the ${levelWords(x.levelLabel)} of ${num(x.threshold, x.unit)}`
    return `${at}${long}, ${instrument} ${x.endedAt ? 'measured' : 'has measured'} ${m} ${over}. ${ask}`
  }
  const reading = ` ${x.endedAt ? 'at' : 'up to'} ${num(x.value, x.unit)}`
  return `${at}${long}, ${instrument} measured ${m}${reading}${level}. ${ask}`
}

/** "the NO2 1-hour standard", "the Diesel exposure 8-hour level". */
function levelWords(label: string | null): string {
  if (!label) return 'action level'
  return /\b(standard|watch|level|screening)$/i.test(label) ? label : `${label} level`
}

/** A level as issued ("100 ppb"), a reading to its precision ("121.4 ppb"). */
function num(v: number, unit: string | null): string {
  return `${fmtNum(v, Number.isInteger(v) ? 0 : v >= 10 ? 1 : 2)}${unit ? ` ${unitText(unit)}` : ''}`
}

function titleFor(x: PushSubject, who: Role): string {
  if (who === 'community') return `Air quality notice · near ${x.where}`
  if (x.source === 'model') return `DRAQA request · ${x.title}`
  const what = x.source === 'residents' ? 'Resident reports' : (x.measureLabel ?? 'Reading')
  return `DRAQA request for information · ${what} at ${x.where}, ${fmtDay(x.startedAt)}`
}

const AUDIENCE_LABEL: Record<string, string> = {
  community: 'Advisory to residents',
  industry: 'Request to operators',
}

export function PushComposer({ subject }: { subject: PushSubject }) {
  const create = useCreateAdvisory()
  const authorId = useSession((x) => x.user?.id ?? undefined)
  const [audience, setAudience] = useState<Role | null>(null)
  const [body, setBody] = useState('')
  const [sent, setSent] = useState<Role | null>(null)

  const allowed = audiencesFor(subject)
  const drafts = useMemo(
    () => ({ community: communityDraft(subject), industry: industryDraft(subject) }),
    [subject],
  )

  if (!allowed.length) {
    return <p className={p.note}>Nothing to send for this kind of alert: it is not about the air.</p>
  }

  const open = (who: Role) => {
    setAudience(who)
    setBody(who === 'community' ? drafts.community : drafts.industry)
    setSent(null)
  }

  const send = () => {
    if (!audience) return
    create.mutate(
      {
        kind: audience === 'community' ? 'advisory' : 'notice',
        severity: subject.severity,
        title: titleFor(subject, audience),
        body,
        ...(subject.measure ? { measure: subject.measure } : {}),
        alert_id: subject.alertId,
        audience: [audience],
        ...(authorId ? { author_id: authorId } : {}),
      },
      { onSuccess: () => { setSent(audience); setAudience(null) } },
    )
  }

  return (
    <div className={p.push}>
      {sent ? (
        <p className={p.sent} role="status">
          {sent === 'community'
            ? 'Advisory posted to the residents’ feed, in plain language.'
            : 'Request sent to the industry feed.'}
        </p>
      ) : null}

      {audience === null ? (
        <div className={p.row}>
          {allowed.includes('community') ? (
            <Button size="sm" variant="primary" icon="megaphone" onClick={() => open('community')}>
              {AUDIENCE_LABEL.community}
            </Button>
          ) : null}
          <Button size="sm" icon="factory" onClick={() => open('industry')}>
            {AUDIENCE_LABEL.industry}
          </Button>
        </div>
      ) : (
        <>
          <p className={p.note}>
            {audience === 'community'
              ? 'To residents · plain language, no units, no site named.'
              : 'To operators · the reading, the level and the window. It names no site.'}
          </p>
          <Textarea
            value={body}
            rows={5}
            onChange={(e) => setBody(e.currentTarget.value)}
            className={p.text}
            aria-label={AUDIENCE_LABEL[audience]}
          />
          <div className={p.row}>
            <Button size="sm" variant="primary" loading={create.isPending} onClick={send}>
              Publish
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAudience(null)}>Cancel</Button>
            {create.isError ? <span className={p.error}>Not sent. Try again.</span> : null}
          </div>
        </>
      )}
    </div>
  )
}
