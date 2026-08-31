/**
 * /regulator/alerts — the queue.
 *
 * Two kinds of event share this list and the distinction is the whole point of
 * the action-level screen: a MAGNITUDE spike is one averaging period over the
 * line, an INTEGRATED EXPOSURE is a dose accumulated by an emission that never
 * spiked at all. Both are exceedances; only one of them is visible to a person
 * watching a peak.
 *
 * The `who saw it` column is doing quiet work. Rows tagged TOWER came from
 * DRAQA's own reference instruments; rows tagged FLEET came from ours, on
 * channels no tower carries, on streets no ring covers. Reading down that
 * column is the network gap without a word of argument.
 */

import { useMemo, useState } from 'react'

import { ALERT_KIND_LABEL, AlertTimeline, TimeSeries } from '@/components'
import { Button, Segmented } from '@/app/ui'
import { fmtNum, relativeShort } from '@/core/format'
import { severityRank, severityVar } from '@/core/measures'
import { useAcknowledgeAlert, useAlert, useAlerts, useMonitorReadings } from '@/core/queries'
import { useSession } from '@/core/session'
import type { Alert, Severity } from '@/core/types'

import { PushComposer, subjectFromAlert } from './Push'
import {
  Caps, Panel, Readout, Sev, Tag, Unit, fmtRatio, liveAlerts, overBy, shortWhere,
  SOURCE_TAG_LABEL, sourceTag, styles as s, tinyCode, useMeasureMap, useNowTick,
  useStableWindow, useTowers,
} from './lib'

type KindFilter = 'all' | 'spike' | 'integrated' | 'community' | 'model'

const KIND_TABS: { value: KindFilter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Everything in the queue' },
  { value: 'spike', label: 'Magnitude', title: 'One averaging period over the line' },
  { value: 'integrated', label: 'Integrated', title: 'A dose reached without a spike' },
  { value: 'community', label: 'Residents', title: 'Concern clusters raised by the neighbourhood' },
  { value: 'model', label: 'Model', title: 'Observed conditions diverging from a filed study' },
]

function kindOf(a: Alert): KindFilter {
  if (a.kind === 'integrated_exposure') return 'integrated'
  if (a.kind === 'concern_cluster') return 'community'
  if (a.kind === 'wind_shift' || a.kind === 'fleet_anomaly') return 'model'
  return 'spike'
}

export function AlertsQueue() {
  const now = useNowTick()
  const alertsQ = useAlerts({})
  const towers = useTowers().data ?? []
  const towerIds = useMemo(() => new Set(towers.map((m) => m.id)), [towers])
  const measures = useMeasureMap()

  const [kind, setKind] = useState<KindFilter>('all')
  const [selected, setSelected] = useState<string | null>(null)

  const live = useMemo(() => liveAlerts(alertsQ.data), [alertsQ.data])
  const rows = useMemo(
    () =>
      live
        .filter((a) => kind === 'all' || kindOf(a) === kind)
        .sort(
          (a, b) =>
            severityRank(b.severity) - severityRank(a.severity) ||
            (overBy(b) ?? 0) - (overBy(a) ?? 0) ||
            b.started_at.localeCompare(a.started_at),
        ),
    [live, kind],
  )

  const active = rows.find((a) => a.id === selected) ?? rows[0]

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, warning: 0, watch: 0, info: 0 }
    for (const a of live) c[a.severity] += 1
    return c
  }, [live])
  const fleetOnly = live.filter((a) => sourceTag(a, towerIds) === 'fleet').length
  const towerSeen = live.filter((a) => sourceTag(a, towerIds) === 'tower').length

  const timeline = useMemo(
    () =>
      rows.slice(0, 22).map((a) => ({
        id: a.id,
        label: `${a.measure ? a.measure.toUpperCase() : 'CLSTR'} · ${shortWhere(a)}`,
        code: tinyCode(a),
        severity: a.severity,
        startedAt: a.started_at,
        endedAt: a.ended_at,
        acknowledged: a.status === 'acknowledged',
      })),
    [rows, towerIds],
  )

  return (
    <div className={`${s.page} ${s.alertsPage}`}>
      <div className={`${s.verdict} ${counts.warning + counts.critical ? s.verdictOver : s.verdictClear}`}>
        <div className={s.verdictMark}>
          <span className={`${s.verdictGlyph} ${counts.warning + counts.critical ? s.overInk : s.clearInk}`}>
            {counts.warning + counts.critical ? '▲' : '◇'}
          </span>
          <span className={`${s.verdictWord} ${counts.warning + counts.critical ? s.overInk : s.clearInk}`}>
            {fmtNum(live.length, 0)} LIVE
          </span>
        </div>
        <div className={s.verdictLines}>
          <span className={s.verdictHead}>
            {counts.critical} critical · {counts.warning} warning · {counts.watch} watch · {counts.info} info
          </span>
          <span className={s.sub}>
            {towerSeen} of these were seen by a DRAQA reference instrument. {fleetOnly} were seen
            only by the mobile fleet — on channels or streets the reference network does not carry.
          </span>
        </div>
        <div className={s.verdictStats}>
          <Readout label="Tower-seen" value={fmtNum(towerSeen, 0)} tone="tower" />
          <Readout label="Fleet-only" value={fmtNum(fleetOnly, 0)} tone="fleet" big />
          <Readout label="Unacknowledged" value={fmtNum(live.filter((a) => a.status === 'active').length, 0)} tone="over" />
        </div>
      </div>

      <Panel
        title="Duration"
        aside={
          <Segmented
            value={kind}
            options={KIND_TABS}
            onValueChange={(v) => setKind(v)}
          />
        }
      >
        {timeline.length ? (
          <AlertTimeline
            alerts={timeline}
            rowHeight={13}
            maxRows={8}
            labels
            selectedId={active?.id ?? null}
            onSelect={setSelected}
            style={{ padding: '4px 10px 8px' }}
          />
        ) : (
          <div className={s.empty}>Nothing in this filter.</div>
        )}
      </Panel>

      <div className={s.alertsBody}>
        <Panel title={`Queue · ${rows.length}`} aside={<Caps>severity, then overshoot</Caps>}>
          <div className={s.rows}>
            <div className={`${s.rowHead} ${s.alertCols}`}>
              <span>severity</span><span>saw it</span><span>meas</span><span>where · rule</span>
              <span style={{ textAlign: 'right' }}>reading</span>
              <span style={{ textAlign: 'right' }}>limit</span>
              <span style={{ textAlign: 'right' }}>×</span>
              <span style={{ textAlign: 'right' }}>up for</span>
            </div>
            {rows.map((a) => {
              const src = sourceTag(a, towerIds)
              const def = a.measure ? measures.get(a.measure) : undefined
              const r = a.kind === 'wind_shift' ? null : overBy(a)
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`${s.row} ${s.alertCols}${active?.id === a.id ? ` ${s.rowActive}` : ''}`}
                  onClick={() => setSelected(a.id)}
                  title={a.title}
                >
                  <Sev severity={a.severity} />
                  <Tag tone={src === 'fleet' ? 'fleet' : src === 'tower' ? 'tower' : src === 'community' ? 'community' : 'invader'}>
                    {SOURCE_TAG_LABEL[src]}
                  </Tag>
                  <span className={s.rowNum} style={{ textAlign: 'left', color: 'var(--accent)' }}>
                    {a.measure ? a.measure.toUpperCase() : '—'}
                  </span>
                  <span className={s.rowTrunc}>
                    {shortWhere(a)}
                    <span className={s.dim}>{'  '}· {ALERT_KIND_LABEL[a.kind] ?? a.kind}</span>
                  </span>
                  <span className={s.rowNum} style={{ color: severityVar(a.severity) }}>
                    {fmtNum(a.value, def?.decimals ?? 1)}
                  </span>
                  <span className={`${s.rowNum} ${s.dim}`}>{fmtNum(a.threshold, def?.decimals ?? 1)}</span>
                  <span className={s.rowNum} style={{ color: (r ?? 0) >= 1 ? severityVar(a.severity) : undefined }}>
                    {fmtRatio(r)}
                  </span>
                  <span className={`${s.rowNum} ${s.dim}`}>{relativeShort(a.started_at, now)}</span>
                </button>
              )
            })}
            {rows.length === 0 ? <div className={s.empty}>Nothing in this filter.</div> : null}
          </div>
        </Panel>

        <div className={s.stack}>
          {active ? <AlertDetail alert={active} towerIds={towerIds} /> : (
            <Panel title="Detail"><div className={s.empty}>Select an event.</div></Panel>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────── detail

function AlertDetail({ alert, towerIds }: { alert: Alert; towerIds: Set<string> }) {
  const detail = useAlert(alert.id).data ?? alert
  const ack = useAcknowledgeAlert()
  const userId = useSession((x) => x.user?.id)
  const measures = useMeasureMap()
  const def = detail.measure ? measures.get(detail.measure) : undefined
  const src = sourceTag(detail, towerIds)
  const win = useStableWindow(48)

  // The alert carries its own samples; a monitor-sourced one also has the
  // instrument's full hourly trace, which is what puts the spike in context.
  const isMonitor = detail.source_type === 'monitor' && !!detail.source_id
  const readings = useMonitorReadings(
    isMonitor ? detail.source_id : null,
    { measure: detail.measure ?? undefined, from: win.from, to: win.to, interval: 'hour' },
    { enabled: isMonitor },
  ).data

  const samples = detail.samples ?? []
  const series = readings?.points?.length
    ? [{ id: 'inst', label: readings.monitor_id, points: readings.points }]
    : samples.length
      ? [{ id: 'alert', label: detail.measure?.toUpperCase() ?? 'value', points: samples }]
      : []

  const thresholds = [
    ...(detail.threshold != null
      ? [{ id: 'al', label: 'Action level', value: detail.threshold, severity: detail.severity, shade: true }]
      : []),
    ...(readings?.action_levels ?? [])
      .filter((l) => detail.threshold == null || Math.abs(l.threshold - detail.threshold) > 1e-9)
      .map((l) => ({ id: l.id, label: l.label, value: l.threshold, severity: l.severity, shade: false })),
  ]

  return (
    <>
      <Panel
        title={detail.measure ? `${detail.measure.toUpperCase()} · ${shortWhere(detail)}` : shortWhere(detail)}
        aside={
          <span className={s.toolbar}>
            <Sev severity={detail.severity} />
            <Tag tone={src === 'fleet' ? 'fleet' : src === 'tower' ? 'tower' : src === 'community' ? 'community' : 'invader'}>
              {SOURCE_TAG_LABEL[src]}
            </Tag>
          </span>
        }
      >
        <div className={s.pad}>
          <div className={s.toolbar} style={{ gap: 'var(--s-5)', marginBottom: 'var(--s-3)' }}>
            <Readout
              label="Reading"
              value={fmtNum(detail.value, def?.decimals ?? 1)}
              unit={<Unit>{detail.unit === 'ug/m3' ? 'µg/m³' : detail.unit ?? ''}</Unit>}
              tone="over"
              big
            />
            <Readout label="Action level" value={fmtNum(detail.threshold, def?.decimals ?? 1)} />
            <Readout
              label="Overshoot"
              value={fmtRatio(detail.kind === 'wind_shift' ? null : overBy(detail))}
              tone="over"
            />
          </div>
          {detail.body ? <p className={s.sub} style={{ margin: 0 }}>{detail.body}</p> : null}
          {detail.recommendation ? (
            <p className={s.sub} style={{ marginTop: 'var(--s-2)', marginBottom: 0, color: 'var(--ink)' }}>
              <span className={`${s.caps} ${s.capsAccent}`}>recommended  </span>
              {detail.recommendation}
            </p>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Trace"
        aside={<Caps>{readings?.points?.length ? 'instrument, hourly' : 'alert samples'}</Caps>}
      >
        <div className={s.chartPad}>
          {series.length ? (
            <TimeSeries
              series={series}
              thresholds={thresholds}
              unit={readings?.unit === 'ug/m3' ? 'µg/m³' : readings?.unit ?? (detail.unit === 'ug/m3' ? 'µg/m³' : detail.unit ?? '')}
              decimals={def?.decimals ?? 1}
              height={168}
              exceedanceSeriesId={series[0].id}
            />
          ) : (
            <div className={s.empty}>No trace available for this source.</div>
          )}
        </div>
      </Panel>

      <Panel title="Act on it">
        <div className={s.padSm}>
          <Button
            size="sm"
            variant={detail.status === 'acknowledged' ? 'ghost' : 'secondary'}
            disabled={detail.status === 'acknowledged'}
            loading={ack.isPending}
            onClick={() => ack.mutate({ id: detail.id, userId })}
          >
            {detail.status === 'acknowledged' ? 'Acknowledged' : 'Acknowledge'}
          </Button>
        </div>
        <PushComposer subject={subjectFromAlert(detail)} compact />
      </Panel>
    </>
  )
}
