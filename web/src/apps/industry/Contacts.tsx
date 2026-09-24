/**
 * /industry/alerts — every alert near the site, on a timeline.
 *
 * The deck's map answers "where"; this answers "how long". An alert that has
 * been ongoing for nine hours and one that began four minutes ago demand
 * different things, and that difference should be a shape, not arithmetic.
 *
 * ONE count (F3). "Ongoing" is `useLiveAlerts('industry')` — the same hook,
 * the same fold and the same number as the rail badge and the deck. This page
 * used to count its own unfolded list, so in replay at Aug 24 06:30 the badge
 * and the deck said 1 and this page said 2: Riverport Road's NO2 watch and its
 * 1-hour standard, one exceedance seen at two levels. The fold keeps the
 * higher level as the row and names the lower one inside it, rather than
 * listing it as a second alert. "All" is the record up to the moment shown,
 * unfolded, and is labelled as a different number.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { AlertTimeline } from '@/components'
import { Segmented } from '@/app/ui'
import { foldConcurrent, useLiveAlerts } from '@/core/alerts'
import { happenedBy } from '@/core/events'
import { compassPoint, fmtDistance, fmtDuration, fmtNum, fmtStamp, relativeTime } from '@/core/format'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import { useAlerts } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type { Alert } from '@/core/types'

import {
  Caps, Panel, Readout, countBySeverity, endedBy, severityCountLine, styles as s,
  toNearAlerts, upMs, useSiteLock, whatShort,
} from './lib'

type Filter = 'ongoing' | 'all'

/** "1h 30m", "1d 11h", "45m" — exact, so a row never disagrees with the header. */
function durShort(ms: number): string {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return mins % 60 ? `${h}h ${mins % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}

/**
 * "1-hour watch level" out of "NO2 1-hour watch exceeded at Riverport Road" —
 * the pollutant is already on the row, so only the level is added.
 */
function levelOf(a: Alert): string | null {
  let m = a.title.match(/^(.+?) exceeded at /i)?.[1]?.trim()
  if (!m) return null
  const code = a.measure?.toUpperCase()
  if (code && m.toUpperCase().startsWith(`${code} `)) m = m.slice(code.length + 1)
  return /watch$/i.test(m) ? `${m} level` : m
}

export function Contacts() {
  const site = useSiteLock()
  const now = useNowCampaign()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('ongoing')
  const [selected, setSelected] = useState<string | null>(null)

  // THE number, and the rows behind it.
  const live = useLiveAlerts('industry')
  // The record, for "All". Same role and site as the hook, so one cache entry.
  const alertsQ = useAlerts({ role: 'industry', site_id: site?.id }, { enabled: !!site })
  const record = useMemo(() => happenedBy(alertsQ.data, now), [alertsQ.data, now])

  const listed: Alert[] = filter === 'ongoing' ? live.alerts : record
  const near = useMemo(() => toNearAlerts(listed), [listed])

  // For each ongoing row, the lower levels the fold absorbed into it — shown in
  // the row, not as a row of their own. `foldConcurrent` itself decides which
  // alerts belong together, so this cannot drift from the count.
  const absorbed = useMemo(() => {
    const out = new Map<string, Alert[]>()
    for (const kept of live.alerts) {
      const rest = live.all.filter((a) => a.id !== kept.id && foldConcurrent([kept, a]).length === 1)
      if (rest.length) out.set(kept.id, rest)
    }
    return out
  }, [live.alerts, live.all])

  const recordCounts = countBySeverity(toNearAlerts(record))
  // The longest by duration, measured to the moment shown — not the earliest
  // start, which under All is only the longest when the early alert was also
  // a long one.
  const longestMs = useMemo(
    () => near.reduce<number | null>((acc, c) => Math.max(acc ?? 0, upMs(c.alert, now)), null),
    [near, now],
  )

  const rows = useMemo(
    () => near.map((c) => {
      const what = whatShort(c.alert)
      return {
        id: c.alert.id,
        // The tooltip and the table read the whole title; the 92 px gutter
        // gets a code that fits it (at most 11 characters), so the direction
        // survives instead of being cut to "Reports ·…".
        label: c.alert.title,
        code: c.sited ? `${what} ${compassPoint(c.bearing)}` : what,
        severity: c.alert.severity,
        startedAt: c.alert.started_at,
        // Raw ends: the timeline rewinds them to the demo's now itself.
        endedAt: c.alert.ended_at,
        acknowledged: c.alert.status === 'acknowledged',
      }
    }),
    [near],
  )

  const threat = filter === 'ongoing'
    ? live.bySeverity.critical + live.bySeverity.warning > 0
    : recordCounts.critical + recordCounts.warning > 0

  return (
    <div className={`${s.page} ${s.detailPage}`}>
      <div className={`${s.banner} ${threat ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.bannerLine}>
          <span className={s.bannerHead}>{site?.name ?? 'Alerts'}</span>
          <span className={s.bannerSub}>
            {live.count
              ? `Ongoing at the moment shown: ${severityCountLine(live.bySeverity)}`
              : 'No alerts ongoing at the moment shown'}
            {filter === 'all'
              ? ` · ${record.length ? `${fmtNum(record.length, 0)} in the record up to then` : 'none in the record up to then'}`
              : ''}
          </span>
        </div>
        <div className={s.bannerStats}>
          <Readout
            label="Ongoing"
            value={live.loading ? '—' : fmtNum(live.count, 0)}
            big
            tone={live.bySeverity.warning + live.bySeverity.critical ? 'threat' : 'accent'}
          />
          {filter === 'all' ? <Readout label="In the record" value={fmtNum(record.length, 0)} /> : null}
          <Readout label="Longest" value={longestMs == null ? '—' : fmtDuration(longestMs)} />
          <div className={s.readout}>
            <Segmented
              value={filter}
              options={[{ value: 'ongoing', label: 'Ongoing' }, { value: 'all', label: 'All' }]}
              onValueChange={(v) => setFilter(v)}
            />
            <Caps>show</Caps>
          </div>
        </div>
      </div>

      <div className={s.stack}>
        <Panel title="Timeline">
          {rows.length ? (
            <AlertTimeline
              alerts={rows}
              rowHeight={20}
              maxRows={10}
              selectedId={selected}
              onSelect={(id) => setSelected(id)}
              style={{ padding: 'var(--s-2)' }}
            />
          ) : (
            <div className={s.err}>Nothing on the timeline.</div>
          )}
        </Panel>

        <Panel title="Alert list" className={s.stackGrow} aside={<Caps>worst first</Caps>}>
          <div className={s.contacts}>
            <div className={s.contactHead} aria-hidden>
              <span /><span>what</span><span>alert</span><span>toward</span><span>distance</span>
              <span>{filter === 'ongoing' ? 'so far' : 'duration'}</span>
            </div>
            {near.map((c) => {
              const ended = endedBy(c.alert, now)
              // Only under Ongoing: All lists the record unfolded, so the
              // lower level is its own row there.
              const folded = filter === 'ongoing' ? absorbed.get(c.alert.id) ?? [] : []
              const lower = folded
                .map(levelOf)
                .filter((x): x is string => !!x)
              const also = lower.length
                ? ` · also over the ${lower.join(' and the ')}`
                : folded.length ? ` · +${folded.length} at a lower level` : ''
              const stamp = `${fmtStamp(c.alert.started_at)}${ended ? ` · ended ${relativeTime(ended, now)}` : ' · ongoing'}${also}`
              return (
                <button
                  key={c.alert.id}
                  type="button"
                  className={`${s.contact}${selected === c.alert.id ? ` ${s.contactActive}` : ''}`}
                  onMouseEnter={() => setSelected(c.alert.id)}
                  onClick={() => navigate({ to: `/industry/alerts/${c.alert.id}` })}
                >
                  <span
                    className={s.contactGlyph}
                    style={{ color: severityVar(c.alert.severity) }}
                    aria-label={SEVERITY_LABEL[c.alert.severity]}
                  >
                    {c.glyph}
                  </span>
                  <span className={s.contactCode}>{whatShort(c.alert)}</span>
                  <span className={s.contactName} title={`${c.alert.title} · ${stamp}`}>
                    {c.alert.title}
                    <span className={s.contactCode} style={{ marginLeft: 8 }}>{stamp}</span>
                  </span>
                  {/* A site-wide alert has no direction: a dash, not a word
                      that wraps the 58 px column onto two lines. */}
                  <span className={`${s.contactNum} num`} title={c.sited ? undefined : 'site-wide'}>
                    {c.sited ? compassPoint(c.bearing) : '—'}
                  </span>
                  <span className={`${s.contactNum} num`}>{c.sited ? fmtDistance(c.distance, 1) : ''}</span>
                  {/* To its end once it had ended, else to the moment shown.
                      Measured to now, a one-hour exceedance on Aug 24 read
                      "4d" at the end of the data. */}
                  <span className={`${s.contactAge} num`}>{durShort(upMs(c.alert, now))}</span>
                </button>
              )
            })}
            {!near.length ? (
              <div className={s.err}>
                {filter === 'ongoing' ? 'No alerts ongoing at the moment shown.' : 'No alerts up to the moment shown.'}
              </div>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  )
}
