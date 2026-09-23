/**
 * /regulator/map — the towers, and everything they cannot reach.
 *
 * This map is monitor-centric on purpose. DRAQA senses at four points; the
 * coverage discs are drawn because a regulator's mental model of their network
 * IS those discs, and the argument only lands once you can see where they stop.
 * On top of that sits the road grid — every ~200 m of street the fleet drove,
 * painted on the analytical intensity ramp — which keeps going straight past
 * the edge of every ring and right up to the fences of all three emitters.
 *
 * The wind field advecting underneath is observed, not modelled: it is binned
 * from the fleet's own anemometers, which is why it covers the whole region
 * rather than four points.
 */

import { useMemo, useState } from 'react'

import {
  BaseMap, BoundaryLayer, ConcernLayer, FleetLayer, LayerToggles, MapLegend, MapOverlay,
  MapScale, MapWindField, MeasurePicker, MetricPicker, MonitorLayer, NorthCompass,
  SegmentLayer, SiteLayer, makeColorScale, robustDomain, useFleetAnimation, usePulse,
  BUBBLE_SPLIT_ZOOM, REPORT_WINDOW_DAYS, windowReports,
} from '@/components'
import type { ConcernBubble, ReportWindowDays } from '@/components'
import { Button, Segmented } from '@/app/ui'
import { fmtCompact, fmtNum, fmtWind, relativeShort } from '@/core/format'
import { INDEX_DOMAIN, PICKABLE } from '@/core/measures'
import {
  useActiveMeasure, useAlerts, useCampaignBoundary, useCampaignInfo, useConcernClusters,
  useConcerns, useFleet, useMeasures, useMonitors, useSegments, useSites,
  useUpdateConcernStatus, useWind, useWindField,
} from '@/core/queries'
import { useSession } from '@/core/session'
import type {
  Concern, ConcernCluster, MeasureCode, Monitor, SegmentMetric,
} from '@/core/types'

import {
  Caps, Panel, Readout, Tag, liveAlerts, styles as s, towerMeasures, useNowTick, useReach,
  useStableWindow, useTowers,
} from './lib'

export function MapScreen() {
  const campaign = useCampaignInfo()
  const boundary = useCampaignBoundary(campaign?.id).data
  const towersQ = useTowers()
  const towers = towersQ.data ?? []
  const allMonitors = useMonitors().data ?? []
  const sites = useSites().data ?? []
  // The whole record is fetched (the campaign holds 204, more than the old
  // 200 limit); the map and the panel draw the window. See components/lib/reports.
  const allConcerns = useConcerns({ limit: 400 }).data
  const allClusters = useConcernClusters().data
  const cursor = useSession((x) => x.time.cursor)
  const [reportDays, setReportDays] = useState<ReportWindowDays>(REPORT_WINDOW_DAYS)
  const windowed = useMemo(
    () => windowReports(allConcerns ?? [], allClusters ?? [], reportDays, cursor),
    [allConcerns, allClusters, reportDays, cursor],
  )
  const concerns = windowed.concerns
  const clusters = windowed.clusters
  const alerts = useAlerts({}).data
  const live = useMemo(() => liveAlerts(alerts), [alerts])

  // PICKABLE, not 'modality' — the composite is a lens here too. What it is not
  // is an instrument channel, which is why the blind-verdict banner below has to
  // branch on family rather than on tower membership alone.
  const measures = useMeasures(PICKABLE)
  const measure = useActiveMeasure()
  const measureCode = useSession((x) => x.measure)
  const setMeasure = useSession((x) => x.setMeasure)
  /**
   * The metric is a per-screen control here, not shared state: the community map
   * pins itself to `risk`, and an analyst arriving from that skin should land on
   * p90, not on a risk score with no unit.
   */
  const sessionMetric = useSession((x) => x.metric)
  const [metric, setMetric] = useState<SegmentMetric>(
    sessionMetric === 'persistence' ? 'persistence' : 'p90',
  )
  const mapView = useSession((x) => x.mapView)
  const setMapView = useSession((x) => x.setMapView)
  const flyTo = useSession((x) => x.flyTo)

  const segments = useSegments({ measure: measureCode, metric, window: 'all' }).data
  // Regulators get the fleet undelayed — the ≥3 h lag is a community-only rule.
  const fleetRaw = useFleet({ delay_min: 0 }).data
  const fleet = useFleetAnimation(fleetRaw ?? [])
  const windWin = useStableWindow(72)
  const windField = useWindField({ cell_m: 400, ...windWin }).data
  // `useCurrentWind()` calls `useWind()` with no window, which re-keys every
  // render — take the last point off a quantised query instead.
  const windSeries = useWind(windWin).data
  const wind = windSeries?.[windSeries.length - 1]

  const pulse = usePulse(2200)

  const [show, setShow] = useState({
    grid: true, towers: true, rings: true, other: true, fleet: true, sites: true,
    wind: true, concerns: true,
  })
  const [selectedTower, setSelectedTower] = useState<string | null>(null)
  /**
   * Resident reports are evidence, not decoration.
   *
   * They were drawn on this map and could not be touched — 200 pins the
   * regulator could see and not read. A cluster is the unit that actually
   * matters to them (three reports inside 600 m in a day is what turns a
   * complaint into a case), so the cluster leads and the individual report is
   * one click further in.
   */
  const [pickedCluster, setPickedCluster] = useState<string | null>(null)
  const [pickedConcern, setPickedConcern] = useState<string | null>(null)
  const now = useNowTick(30_000)
  const setStatus = useUpdateConcernStatus()
  const picked = pickedConcern ? concerns.find((c) => c.id === pickedConcern) ?? null : null
  const clusterConcerns = pickedCluster
    ? concerns.filter((c) => c.cluster_id === pickedCluster)
    : []

  const { reach } = useReach(measureCode)
  const canSee = useMemo(() => towerMeasures(towers), [towers])
  /**
   * A derived index is not a channel the agency failed to install. `blind`
   * means "nobody is watching this pollutant"; for a composite the true
   * statement is "nothing instruments this, because it is arithmetic" — and
   * printing the first where the second is meant turns a property of the number
   * into an accusation against DRAQA.
   */
  const derived = measure?.family === 'composite'
  const blind = !derived && !canSee.has(measureCode)

  const domain = useMemo<[number, number]>(() => {
    // A derived index means the same thing everywhere, so it is pinned rather
    // than stretched to the local spread — that would repaint a campaign which
    // is honestly uniform as a full-scale emergency. See INDEX_DOMAIN for why
    // the ceiling is 60 (AQHI 6, a published band edge) and not 100.
    if (derived) return INDEX_DOMAIN
    const vals: number[] = []
    for (const f of segments?.features ?? []) if (f.properties.value != null) vals.push(f.properties.value)
    // No floor at zero: ambient NO2 never approaches zero, so anchoring there
    // pushes every ordinary street into the hot half of the ramp and the real
    // hotspot stops standing out. p2–p98 of what was actually measured.
    return robustDomain(vals, { floorAtZero: false })
  }, [segments, derived])

  const otherMonitors = useMemo(
    () => allMonitors.filter((m) => m.owner_type !== 'regulator'),
    [allMonitors],
  )

  const towerRows = reach.perTower

  return (
    <div className={`${s.page} ${s.mapPage}`}>
      <div className={`${s.verdict} ${blind ? s.verdictOver : s.verdictClear}`}>
        <div className={s.verdictMark}>
          <span className={`${s.verdictGlyph} ${s.towerInk}`}>▲</span>
          <span className={`${s.verdictWord} ${s.towerInk}`}>NETWORK</span>
        </div>
        <div className={s.verdictLines}>
          <span className={s.verdictHead}>
            {towers.length} reference towers · {fmtNum(reach.total, 0)} measured street segments ·{' '}
            {fmtNum(campaign?.fleet_size ?? 0, 0)} cars
          </span>
          <span className={s.sub}>
            {derived ? (
              <>
                <b>{measure?.short_label}</b> is a derived index, not a species — no instrument
                anywhere carries it. Every line on this map is the fleet’s own measurements
                run through the formula.
              </>
            ) : blind ? (
              <>
                No reference instrument carries a <b>{measureCode.toUpperCase()}</b> channel. Every
                line on this map for this pollutant was measured by the fleet.
              </>
            ) : (
              <>
                {fmtNum(reach.outside, 0)} segments — {fmtNum(reach.kmOutside, 0)} km of road — fall
                outside every coverage ring. The grid does not stop where the rings do.
              </>
            )}
          </span>
        </div>
        <div className={s.verdictStats}>
          <Readout label="Inside rings" value={fmtNum(reach.inside, 0)} tone="tower" />
          <Readout label="Beyond rings" value={fmtNum(reach.outside, 0)} tone="fleet" big />
          <Readout
            label="Wind"
            value={wind ? fmtWind(wind.speed_ms, wind.dir_deg) : '—'}
            tone="accent"
          />
          <Readout label="Live alerts" value={fmtNum(live.length, 0)} tone={live.length ? 'over' : undefined} />
        </div>
      </div>

      <div className={s.mapBody}>
        <div className={s.mapFrame}>
          <BaseMap
            label="Reference network and measured road grid"
            initialView={{
              longitude: campaign?.center?.[0] ?? -90.132,
              latitude: campaign?.center?.[1] ?? 35.058,
              zoom: campaign?.default_zoom ?? 12.2,
            }}
            view={mapView}
            onViewChange={setMapView}
            /* The road grid is the hero. The wind is texture underneath it, so the
               field runs thin and low-contrast: enough streaks to read the
               direction and the shear, never enough to compete with a street. */
            fullBleed={
              show.wind ? (
                <MapWindField
                  field={windField}
                  particles={2400}
                  keep={0.92}
                  ramp="map"
                  opacity={0.3}
                  lineWidth={1}
                  minConfidence={0.3}
                />
              ) : null
            }
            onClick={(info) => {
              const obj = info.object as { id?: string; owner_type?: string } | null
              if (obj?.id && obj.owner_type === 'regulator') {
                setSelectedTower(obj.id)
                return
              }
              // Empty ground clears the report selection, the way a map should.
              if (!info.object) { setPickedConcern(null); setPickedCluster(null) }
            }}
            layers={(t) => [
              ...(boundary ? BoundaryLayer({ data: boundary, theme: t, mask: true, maskStrength: 0.28 }) : []),
              ...(show.grid
                ? SegmentLayer({
                    data: segments,
                    theme: t,
                    metric,
                    scale: makeColorScale(t, { domain, ramp: 'map' }),
                    dualEncode: 'width',
                    minPasses: 8,
                    baseWidthM: 26,
                    widthMinPixels: 1.9,
                    widthMaxPixels: 9,
                    pickable: false,
                  })
                : []),
              ...(show.concerns
                ? ConcernLayer({
                    data: concerns,
                    clusters,
                    theme: t,
                    pulse,
                    labels: false,
                    zoom: mapView?.zoom,
                    onBubbleClick: (info) => {
                      const b = info.object as ConcernBubble | undefined
                      if (b) flyTo(b.position, Math.max(mapView?.zoom ?? 0, BUBBLE_SPLIT_ZOOM))
                    },
                    selectedId: pickedConcern,
                    onClick: (info) => {
                      const c = info.object as Concern | undefined
                      if (!c?.id) return
                      setPickedConcern(c.id)
                      setPickedCluster(c.cluster_id ?? null)
                    },
                    onClusterClick: (info) => {
                      const cl = info.object as ConcernCluster | undefined
                      if (!cl?.id) return
                      setPickedCluster(cl.id)
                      setPickedConcern(null)
                    },
                  })
                : []),
              ...(show.sites ? SiteLayer({ data: sites, theme: t, pulse, labels: true }) : []),
              ...(show.other
                ? MonitorLayer({
                    id: 'monitors-other',
                    data: otherMonitors,
                    theme: t,
                    rings: false,
                    labels: false,
                    measure: measureCode,
                    pulse,
                    sizePx: 18,
                  })
                : []),
              ...(show.towers
                ? MonitorLayer({
                    id: 'monitors-towers',
                    data: towers,
                    theme: t,
                    rings: show.rings,
                    labels: true,
                    measure: measureCode,
                    pulse,
                    selectedId: selectedTower,
                    sizePx: 38,
                  })
                : []),
              ...(show.fleet ? FleetLayer({ data: fleet, theme: t, pulse, trails: true, labels: true }) : []),
            ]}
          >
            <MapOverlay place="top-left">
              <div className={`${s.overlayCard} ${s.overlayBar}`}>
                <MeasurePicker
                  measures={measures}
                  value={measureCode as MeasureCode}
                  onChange={(c) => setMeasure(c)}
                  variant="select"
                  showUnit
                  label="Pollutant"
                />
                <MetricPicker value={metric} onChange={setMetric} variant="select" />
              </div>
            </MapOverlay>

            <MapOverlay place="top-right">
              <MapLegend
                domain={domain}
                measure={measure ?? null}
                metric={metric}
                dualEncode="width"
                title={`${measureCode.toUpperCase()} — measured road grid`}
              />
            </MapOverlay>

            <MapOverlay place="middle-right">
              <LayerToggles
                title="Layers"
                items={[
                  { id: 'grid', label: 'Road grid', enabled: show.grid, count: reach.total, keyShape: 'line' },
                  { id: 'towers', label: 'Reference towers', enabled: show.towers, count: towers.length, keyShape: 'dot' },
                  { id: 'rings', label: 'Coverage rings', enabled: show.rings, count: null, keyShape: 'line', disabled: !show.towers },
                  { id: 'other', label: 'Other sensors', enabled: show.other, count: otherMonitors.length, keyShape: 'dot' },
                  { id: 'fleet', label: 'Fleet, live', enabled: show.fleet, count: fleetRaw?.length ?? 0, keyShape: 'dot' },
                  { id: 'sites', label: 'Emitters', enabled: show.sites, count: sites.length, keyShape: 'dot' },
                  { id: 'concerns', label: 'Resident reports', enabled: show.concerns, count: concerns.length, keyShape: 'dot' },
                  { id: 'wind', label: 'Observed wind', enabled: show.wind, count: windField?.cells.length ?? null, keyShape: 'line' },
                ]}
                onToggle={(id, next) => setShow((v) => ({ ...v, [id]: next }))}
              />
            </MapOverlay>

            <MapOverlay place="bottom-left"><MapScale units="both" /></MapOverlay>
            <MapOverlay place="bottom-right"><NorthCompass readout /></MapOverlay>
          </BaseMap>
        </div>

        {/* ── the roster: what each tower stands for ────────────────────── */}
        <div className={s.stack}>
          <Panel
            title="Towers"
            aside={<Caps>click to centre</Caps>}
          >
            <div className={s.rows}>
              {towerRows.map((t) => (
                <TowerRow
                  key={t.monitor.id}
                  monitor={t.monitor}
                  measureCode={measureCode}
                  measureLabel={measure?.short_label ?? measureCode.toUpperCase()}
                  derived={derived}
                  segments={t.segments}
                  km={t.km}
                  lo={t.lo}
                  hi={t.hi}
                  towerValue={t.towerValue}
                  spread={t.spread}
                  active={selectedTower === t.monitor.id}
                  onClick={() => {
                    setSelectedTower(t.monitor.id)
                    flyTo([t.monitor.lon, t.monitor.lat], 13.4)
                  }}
                />
              ))}
            </div>
          </Panel>

          {/* ── the other evidence source ──────────────────────────────────
              DRAQA has four instruments and two hundred witnesses. The second
              set is not a decoration on this map; it is the input that starts
              loop 1 of the whole product, so it gets a first-class panel next
              to the towers rather than a legend entry. */}
          <Panel
            title="Resident reports"
            aside={
              <Segmented
                value={reportDays == null ? 'all' : 'recent'}
                options={[
                  { value: 'recent', label: `Last ${REPORT_WINDOW_DAYS} d` },
                  { value: 'all', label: `All · ${windowed.total}` },
                ]}
                onValueChange={(v) => setReportDays(v === 'all' ? null : REPORT_WINDOW_DAYS)}
              />
            }
          >
            <div className={s.rows}>
              {clusters.length === 0 ? (
                <span className={s.muted}>
                  {reportDays == null
                    ? 'No clusters have formed in this campaign.'
                    : `No cluster in the last ${REPORT_WINDOW_DAYS} days — ${concerns.length} single reports. "All" shows the record.`}
                </span>
              ) : clusters.map((cl) => {
                const on = pickedCluster === cl.id
                const alert = liveAlerts(alerts).find((a) => a.source_id === cl.id)
                return (
                  <button
                    key={cl.id}
                    type="button"
                    className={`${s.reportRow}${on ? ` ${s.reportRowOn}` : ''}`}
                    onClick={() => {
                      setPickedCluster(cl.id)
                      setPickedConcern(null)
                      flyTo(cl.centroid, 14.2)
                    }}
                  >
                    <span className={s.reportCount}>{cl.count}</span>
                    <span className={s.reportBody}>
                      <span className={s.reportTitle}>{cl.label ?? 'Cluster'}</span>
                      <span className={s.reportSub}>
                        {cl.kinds.slice(0, 3).join(' · ')} · last {relativeShort(cl.last_at, now)}
                      </span>
                    </span>
                    {alert ? <Tag tone="invader">alerted</Tag> : <Tag>{cl.status}</Tag>}
                  </button>
                )
              })}
            </div>

            {picked ? (
              <div className={s.reportDetail}>
                <div className={s.reportDetailHead}>
                  <span className={s.reportTitle}>{picked.title}</span>
                  <Tag tone={picked.status === 'resolved' ? undefined : 'community'}>{picked.status.replace(/_/g, ' ')}</Tag>
                </div>
                <span className={s.reportSub}>
                  {picked.kind} · severity {picked.severity}/5 · {picked.district ?? 'unknown district'}
                  {' · '}{relativeShort(picked.occurred_at, now)}
                  {picked.corroborations ? ` · ${picked.corroborations} corroborated` : ''}
                </span>
                {picked.body ? <p className={s.reportQuote}>“{picked.body}”</p> : null}
                <div className={s.reportActions}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={picked.status === 'under_review' || setStatus.isPending}
                    onClick={() => setStatus.mutate({
                      id: picked.id, status: 'under_review', actorRole: 'regulator',
                    })}
                  >
                    Mark under review
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => flyTo([picked.lon, picked.lat], 15)}>
                    Centre
                  </Button>
                </div>
                {/* The asymmetry, from the side that actually holds the power. */}
                <span className={s.reportNote}>
                  Only DRAQA or Aclima can close a resident's report. An operator's reply moves
                  it to “mitigation proposed” and no further.
                </span>
              </div>
            ) : pickedCluster ? (
              <span className={s.reportNote}>
                {clusterConcerns.length} report{clusterConcerns.length === 1 ? '' : 's'} in this
                cluster. Click a pin on the map to read one.
              </span>
            ) : (
              <span className={s.reportNote}>
                Click a report or a cluster halo on the map to read it.
              </span>
            )}
          </Panel>

          <Panel title="Observed wind field" aside={<Caps>fleet anemometry · 72 h</Caps>}>
            <div className={s.split2}>
              <div>
                <div className={s.kv}>
                  <span>Cells</span>
                  <span className={s.kvVal}>{fmtNum(windField?.cells.length ?? null, 0)}</span>
                </div>
                <div className={s.kv}>
                  <span>Observations</span>
                  <span className={s.kvVal}>{fmtCompact(windField?.n_obs ?? 0)}</span>
                </div>
                <div className={s.kv}>
                  <span>Cell size</span>
                  <span className={s.kvVal}>{fmtNum(windField?.cell_size_m ?? null, 0)} m</span>
                </div>
              </div>
              <div>
                <div className={s.kv}>
                  <span>Now</span>
                  <span className={s.kvVal}>{wind ? fmtWind(wind.speed_ms, wind.dir_deg) : '—'}</span>
                </div>
                <div className={s.kv}>
                  <span>Mixing height</span>
                  <span className={s.kvVal}>{fmtNum(wind?.pbl_m ?? null, 0)} m</span>
                </div>
                <div className={s.kv}>
                  <span>Stability</span>
                  <span className={s.kvVal}>{wind?.stability ?? '—'}</span>
                </div>
              </div>
            </div>
            <div className={s.padSm}>
              <span className={s.subTight}>
                Every streak is advected from wind our own cars measured on the street. A stationary
                network cannot produce a field like this — it produces four arrows.
              </span>
            </div>
          </Panel>

          <Panel title="Suspected emitters" aside={<Caps>three sides</Caps>}>
            <div className={s.rows}>
              {sites.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  className={s.row}
                  style={{ gridTemplateColumns: '20px minmax(0,1fr) auto' }}
                  onClick={() => flyTo(site.centroid, 13.6)}
                >
                  <span className={s.overInk}>◤</span>
                  <span className={s.rowTrunc}>{site.name}</span>
                  <Tag tone="invader">{site.kind}</Tag>
                </button>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function TowerRow({
  monitor, measureCode, measureLabel, derived, segments, km, lo, hi, towerValue, spread, active, onClick,
}: {
  monitor: Monitor
  measureCode: string
  /** `short_label` — `aclima_sense` uppercased is twelve characters of mono. */
  measureLabel: string
  /** A composite: no instrument carries it, and none was ever meant to. */
  derived: boolean
  segments: number
  km: number
  lo: number | null
  hi: number | null
  towerValue: number | null
  spread: number | null
  active: boolean
  onClick(): void
}) {
  const carries = !derived && monitor.measures.includes(measureCode as MeasureCode)
  return (
    <button
      type="button"
      className={`${s.row}${active ? ` ${s.rowActive}` : ''}`}
      style={{ gridTemplateColumns: '18px minmax(0,1fr)', alignItems: 'start', rowGap: 4 }}
      onClick={onClick}
    >
      <span className={carries ? s.towerInk : s.dim} style={{ paddingTop: 2 }}>▲</span>
      <span style={{ display: 'grid', gap: 4, minWidth: 0 }}>
        <span className={s.toolbar}>
          <span className={s.rowTrunc} style={{ flex: 1 }}>{monitor.name}</span>
          <Tag tone={monitor.status === 'online' ? 'tower' : undefined}>{monitor.status}</Tag>
        </span>
        <span className={s.toolbar}>
          {monitor.measures.map((c) => (
            <Tag key={c} tone={c === measureCode ? 'accent' : undefined}>{c.toUpperCase()}</Tag>
          ))}
        </span>
        {carries ? (
          <span className={s.subTight}>
            reads <b className={s.towerInk}>{fmtNum(towerValue, 1)}</b> · stands for{' '}
            {fmtNum(segments, 0)} streets ({fmtNum(km, 0)} km) measuring{' '}
            <b className={s.fleetInk}>{fmtNum(lo, 1)}–{fmtNum(hi, 1)}</b>
            {spread != null ? ` · up to ${fmtNum(spread, 1)}× its own number` : ''}
          </span>
        ) : (
          <span className={s.subTight}>
            <span className={s.fleetInk}>▨</span>{' '}
            {derived
              ? `${measureLabel} is computed, not measured — the`
              : `no ${measureLabel} channel — the`}{' '}
            {fmtNum(segments, 0)} streets inside this ring are measured only by the fleet
          </span>
        )}
      </span>
    </button>
  )
}
