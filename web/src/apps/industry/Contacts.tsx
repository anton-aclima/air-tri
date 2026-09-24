/**
 * /industry/alerts — every contact, on a timeline.
 *
 * The scope answers "where"; this answers "how long". An alert that has been
 * up for nine hours and one that appeared four minutes ago demand different
 * things, and that difference should be a shape, not arithmetic.
 */

import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { AlertTimeline } from '@/components'
import { Segmented } from '@/app/ui'
import { happenedBy, isOngoing } from '@/core/events'
import { fmtBearing, fmtDistance, fmtDuration, fmtNum, fmtStamp, relativeShort, relativeTime } from '@/core/format'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import { useAlerts } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type { Alert } from '@/core/types'

import {
  Caps, Panel, Readout, countBySeverity, endedBy, severityCountLine, styles as s,
  toContacts, upMs, useSiteLock,
} from './lib'

type Filter = 'live' | 'all'

export function Contacts() {
  const site = useSiteLock()
  const now = useNowCampaign()
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('live')
  const [selected, setSelected] = useState<string | null>(null)

  const alertsQ = useAlerts({ site_id: site?.id }, { enabled: !!site })
  // Both filters follow the clock (D2). LIVE is begun and not yet ended at the
  // moment shown — `isOngoing`, not `status`, which is the final status and
  // listed alerts that had ended days earlier. ALL is everything that had begun
  // by then; an alert that starts later is the future and is not listed.
  const shown = useMemo(() => {
    const all = alertsQ.data ?? []
    return filter === 'live'
      ? all.filter((a: Alert) => isOngoing(a, now))
      : happenedBy(all, now)
  }, [alertsQ.data, filter, now])

  const contacts = useMemo(() => toContacts(shown), [shown])
  const counts = countBySeverity(contacts)
  // The longest by duration, measured to the moment shown — not the earliest
  // start, which under ALL is only the longest when the early alert was also
  // a long one.
  const longestMs = useMemo(
    () => contacts.reduce<number | null>((acc, c) => Math.max(acc ?? 0, upMs(c.alert, now)), null),
    [contacts, now],
  )

  const rows = useMemo(
    () => contacts.map((c) => ({
      id: c.alert.id,
      label: `${c.code} ${c.alert.measure ? c.alert.measure.toUpperCase() : ''} ${c.sited ? fmtBearing(c.bearing).split(' ')[1] : 'site-wide'}`.trim(),
      code: c.code,
      severity: c.alert.severity,
      startedAt: c.alert.started_at,
      // Raw ends: the timeline rewinds them to the demo's now itself.
      endedAt: c.alert.ended_at,
      acknowledged: c.alert.status === 'acknowledged',
    })),
    [contacts],
  )

  return (
    <div className={`${s.page} ${s.detailPage}`}>
      <div className={`${s.banner} ${counts.critical + counts.warning > 0 ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.bannerLine}>
          <span className={s.bannerHead}>{site?.name ?? 'Alerts'}</span>
          <span className={s.bannerSub}>
            {contacts.length ? severityCountLine(counts) : 'No contacts in this window'}
          </span>
        </div>
        <div className={s.bannerStats}>
          <Readout label="Alerts" value={fmtNum(contacts.length, 0)} big tone={counts.warning + counts.critical ? 'threat' : 'accent'} />
          <Readout
            label="Longest up"
            value={longestMs == null ? '—' : fmtDuration(longestMs)}
          />
          <div className={s.readout}>
            <Segmented
              value={filter}
              options={[{ value: 'live', label: 'LIVE' }, { value: 'all', label: 'ALL' }]}
              onValueChange={(v) => setFilter(v)}
            />
            <Caps>window</Caps>
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
              <span /><span>src</span><span>contact</span><span>brg</span><span>range</span>
              <span>{filter === 'live' ? 'up for' : 'lasted'}</span>
            </div>
            {contacts.map((c) => {
              const ended = endedBy(c.alert, now)
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
                  <span className={s.contactCode}>{c.alert.measure ? c.alert.measure.toUpperCase() : c.code}</span>
                  <span className={s.contactName}>
                    {c.alert.title}
                    <span className={s.contactCode} style={{ marginLeft: 8 }}>
                      {fmtStamp(c.alert.started_at)}
                      {ended ? ` · ended ${relativeTime(ended, now)}` : ''}
                    </span>
                  </span>
                  <span className={`${s.contactNum} num`}>{c.sited ? fmtBearing(c.bearing).split(' ')[1] : 'site-wide'}</span>
                  <span className={`${s.contactNum} num`}>{c.sited ? fmtDistance(c.distance, 1) : ''}</span>
                  {/* An ended alert reads how long it lasted. Measured to now,
                      a one-hour exceedance on Aug 24 read "4d" at the end of
                      the data, and about a month against the wall clock. */}
                  <span className={`${s.contactAge} num`}>
                    {relativeShort(c.alert.started_at, ended ?? now)}
                  </span>
                </button>
              )
            })}
            {!contacts.length ? <div className={s.err}>No contacts.</div> : null}
          </div>
        </Panel>
      </div>
    </div>
  )
}
