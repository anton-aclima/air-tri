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
import { fmtBearing, fmtDistance, fmtNum, fmtStamp, relativeShort } from '@/core/format'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import { useAlerts } from '@/core/queries'
import type { Alert } from '@/core/types'

import {
  Caps, Panel, Readout, countBySeverity, severityCountLine, styles as s,
  toContacts, upFor, useNowTick, useSiteLock,
} from './lib'

type Filter = 'live' | 'all'

export function Contacts() {
  const site = useSiteLock()
  const now = useNowTick(1000)
  const navigate = useNavigate()
  const [filter, setFilter] = useState<Filter>('live')
  const [selected, setSelected] = useState<string | null>(null)

  const alertsQ = useAlerts({ site_id: site?.id }, { enabled: !!site })
  const shown = useMemo(() => {
    const all = alertsQ.data ?? []
    return filter === 'live'
      ? all.filter((a: Alert) => a.status === 'active' || a.status === 'acknowledged')
      : all
  }, [alertsQ.data, filter])

  const contacts = useMemo(() => toContacts(shown), [shown])
  const counts = countBySeverity(contacts)
  const oldest = useMemo(
    () => contacts.reduce<Alert | null>(
      (acc, c) => (!acc || c.alert.started_at < acc.started_at ? c.alert : acc), null,
    ),
    [contacts],
  )

  const rows = useMemo(
    () => contacts.map((c) => ({
      id: c.alert.id,
      label: `${c.code} ${c.alert.measure ? c.alert.measure.toUpperCase() : ''} ${fmtBearing(c.bearing).split(' ')[1]}`.trim(),
      code: c.code,
      severity: c.alert.severity,
      startedAt: c.alert.started_at,
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
            value={oldest ? upFor(oldest, now) : '—'}
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
              <span /><span>src</span><span>contact</span><span>brg</span><span>range</span><span>up for</span>
            </div>
            {contacts.map((c) => (
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
                  </span>
                </span>
                <span className={`${s.contactNum} num`}>{fmtBearing(c.bearing).split(' ')[1]}</span>
                <span className={`${s.contactNum} num`}>{fmtDistance(c.distance, 1)}</span>
                <span className={`${s.contactAge} num`}>{relativeShort(c.alert.started_at, now)}</span>
              </button>
            ))}
            {!contacts.length ? <div className={s.err}>No contacts.</div> : null}
          </div>
        </Panel>
      </div>
    </div>
  )
}
