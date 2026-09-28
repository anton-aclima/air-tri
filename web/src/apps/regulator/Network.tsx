/**
 * /regulator — Network: one map and one panel that answer the owner's three
 * questions, in order (2026-09-23):
 *
 *   1. What are the reference monitors reporting? The four DRAQA monitors,
 *      named on the map with their reading at the moment shown, and one line
 *      each in the panel. The alarm is lit only by a reading in the last hour
 *      over a level with the SAME averaging period — "O3 ▲" beside "Ozone
 *      8-hour CLEAR" was a 1-hour reading judged against an 8-hour rule.
 *   2. What does the mobile network add, and do the expected plumes reach the
 *      monitors or the measured streets? The streets the fleet measured in
 *      the street window — 24 h, 7 days (the default) or to date, always
 *      ENDING at the moment shown — are the only coloured ink; every street
 *      measured earlier is a quiet grey hairline under them, so the road
 *      network reads even in a week the fleet did not drive. Each site's
 *      modelled plume is a hairline outline, solid to the detection envelope
 *      and dashed beyond it; the filed study is dotted (both models, as the
 *      brief asks). A site gets its axis and label only when its outline
 *      touches a monitor, a street driven in the window or an open resident
 *      cluster.
 *   3. How does this overlay with community concerns? Resident report
 *      bubbles on top, and a Residents block that names a site only under F7.
 *
 * Every "inside the plume", every count and the headline come from
 * `GET /regulator/network`, computed on the server from the same outline the
 * map draws (`plumegeom.py`). R0 found two model geometries disagreeing about
 * one monitor, 7 of 9 exceedance hours inside by one and 1 of 5 by the other;
 * the drawn outline was right and is now the only one. The alert count is
 * `useLiveAlerts('regulator')`, the number the rail badge prints.
 *
 * One street window, bounded by the moment shown (F1, F2). The map's
 * coloured streets are `/segments?window=trailing:<N>h|todate&at=`, and the
 * header's street-km, each plume's streets driven inside and its coverage
 * floor are `/regulator/network?streets=` over the SAME window — so nothing
 * on the screen says "whole day" or "by 06:00". The old map drew the day's
 * stored `date:` aggregate: it included passes after the moment shown, was
 * empty on every day the fleet did not drive (29 of ~90), and on a driven
 * day held a median 367 of 1,307 streets, a third of them in the ramp's
 * bottom quarter — the "mostly dark" map the owner asked about.
 *
 * Retired with Watchfloor and the old map (R1, R8): the status strip and its
 * giant word, the action-level table (Levels owns it), the monitor cards, the
 * reach panel, the proximity-only site list and its threat-red tags, the
 * duplicate alert timeline, the wind-model stats panel, and the separate
 * Coverage and Analysis pages — what a regulator reads from those is a
 * monitor's detail here, next to the streets it is compared with.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueries } from '@tanstack/react-query'
import type { LayersList, PickingInfo } from 'deck.gl'

import {
  BEYOND_ENVELOPE_NOTE, BUBBLE_SPLIT_ZOOM, BaseMap, BoundaryLayer, ConcernLayer, CoverageMaskLayer,
  DiurnalClock, DispersionLayer, FiledStudyLayer, FleetLayer, MapLegend, MapOverlay, MapWindField, MonitorLayer,
  PLUME_STROKE, RATIO_LABEL_FROM, REPORT_WINDOW_DAYS, SegmentLayer, SiteLayer, bboxCenter,
  bboxOfPositions, fitZoom, formatRatio, geometryPositions, hasBeyondEnvelope, labelCollision,
  makeColorScale, metersPerPixel, pickedSite, robustDomain, useFleetAnimation, usePulse, useSize,
  windowReports,
} from '@/components'
import type { ConcernBubble, MapView, SegmentFeature, Theme } from '@/components'
import { Button, Icon, Popover, Toggle } from '@/app/ui'
import * as api from '@/core/api'
import type { BoundaryCollection } from '@/core/api'
import { useLiveAlerts } from '@/core/alerts'
import { addHours, campaignMs } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { compassPoint, fmtDay, fmtDistance, fmtNum, fmtTime24, relativeShort, relativeTime } from '@/core/format'
import { INDEX_DOMAIN, PICKABLE, shortName, unitFor } from '@/core/measures'
import {
  STALE, keepSegmentsWhile, qk, useActiveMeasure, useCalibration, useCampaignBoundary,
  useCampaignInfo, useConcernClusters, useConcerns, useDispersion, useFleet, useMeasures,
  useMonitorReadings, useMonitors, useRegulatorNetwork, useSegmentDetail, useSegments, useSites,
  useTouchdown, useUpdateConcernStatus, useWindField,
} from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type {
  Concern, ConcernCluster, ConcernStatus, DispersionModel, FleetPosition, IndustrySite, MeasureCode, MeasureDef,
  Monitor, MonitorReadings, RegulatorNetwork, RegulatorNetworkMonitor, RegulatorNetworkPlume,
  RegulatorNetworkResident, SegmentCollection, StreetsWindow,
} from '@/core/types'

import {
  STREETS_WINDOWS, emptyWindowLine, isStreetsWindow, median, peakOf, plumeCoverageLine, plumeTouches,
  reportsAsOf,
  shortPlace, shortSite, streetsInRing, styles as s, toDiurnal24, touchdownSentence, useStableWindow,
  useTowers, windowIsEmpty, windowKmLabel, windowPhrase, windowRelative, windowTitle,
} from './lib'

// ─────────────────────────────────────────────────────────────── constants

/**
 * Streets with fewer passes than this in the window are drawn THIN, not
 * hidden (R4). One or two passes is a measurement, and a regulator reading
 * an hourly plume over the window's streets needs to see that the fleet was
 * there — hiding them read as "never driven". Thin says "few passes".
 */
const THIN_BELOW_PASSES = 3
/**
 * The legend's words for those streets, built from the same constant so the
 * key cannot drift from the layer rule (it was a literal "1–2 passes"). The
 * computed windows keep one-pass streets (`min_passes` 1 on the server).
 */
const FEW_PASSES_NOTE = `thin: fewer than ${THIN_BELOW_PASSES} passes`
/**
 * The context grid's key (F3c, F4): every street measured up to the moment
 * shown and not in the window, in neutral ink. It is measurement, so it is
 * drawn; it is not this window's, so it carries no value colour.
 */
const CONTEXT_NOTE = 'grey: measured earlier, not in this window'
/**
 * Nothing past this is reportable (CLAUDE.md, the touchdown estimator): the
 * truth field is clipped to zero beyond it, and an estimator run there passed
 * both rotation tests on a plume that does not exist.
 */
const REPORTABLE_M = 4200

type Pick =
  | { kind: 'monitor'; id: string }
  | { kind: 'plume'; id: string }
  | { kind: 'cluster'; id: string; report: string | null }

interface Shown {
  plumes: boolean
  filed: boolean
  mask: boolean
  reports: boolean
  rings: boolean
  wind: boolean
  fleet: boolean
  trails: boolean
  other: boolean
}

/**
 * Off by default: other sensors (nine fenceline and porch pucks) and fleet
 * trails (R9). Both were on, and both are what made the old map busy without
 * answering any of the three questions. The filed study is ON here, unlike
 * the industry deck (D9): the brief asks for both models on the regulator map.
 */
const DEFAULT_SHOWN: Shown = {
  plumes: true, filed: true, mask: true, reports: true, rings: true, wind: true, fleet: true,
  trails: false, other: false,
}

// ═══════════════════════════════════════════════════════════════ the screen

export function Network() {
  const now = useNowCampaign()
  const measureCode = useSession((x) => x.measure)
  const setMeasure = useSession((x) => x.setMeasure)
  const flyTo = useSession((x) => x.flyTo)
  const measure = useActiveMeasure()
  const measures = useMeasures(PICKABLE)
  // THE count: the rail badge and the Alerts page print this same number (F3).
  const live = useLiveAlerts('regulator')

  // ── the street window (F2, F4) ─────────────────────────────────────────
  // One window, ending at the moment shown, for the map's coloured streets
  // and every street figure the server counts. 7 days by default: at the end
  // of the data 24 h holds 857 of 1,307 streets and 7 days all of them, and on
  // Aug 20 — inside the fleet's off-week — 24 h holds none and 7 days 938.
  const [streets, setStreets] = useState<StreetsWindow>('7d')
  const netQ = useRegulatorNetwork({ streets })
  // A pollutant switch keeps the previous payload on screen while the next
  // one loads; under the new pollutant's label it is the wrong pollutant's
  // numbers, so it reads as absent (the loading copy) until the right one lands.
  const net = netQ.data?.measure === measureCode ? netQ.data : undefined
  // A WINDOW switch changes only the street figures: the readings, the plume
  // outlines and the clusters are the same at the same moment. So the kept
  // payload still answers those, and its street figures — the other window's
  // — read as absent until this window's land (`isStreetsWindow`).
  const netW = net && isStreetsWindow(net.streets_window, streets) ? net : undefined
  const towersQ = useTowers()
  const towers = useMemo(() => towersQ.data ?? [], [towersQ.data])
  const sites = useSites().data
  const [shown, setShown] = useState<Shown>(DEFAULT_SHOWN)
  const [pick, setPick] = useState<Pick | null>(null)

  // The coloured layer: the window's streets, as of the moment shown (the
  // clock's `at`, as the network payload's). While the clock steps, the
  // previous step's grid stays on screen; a change of pollutant or window
  // reads as loading, never as the previous pollutant's streets (open after
  // phase 5: the day grid held them until the new ones landed).
  const segWindow = api.streetsSegmentWindow(streets)
  const windowQ = useSegments(
    { measure: measureCode, metric: 'median', window: segWindow },
    { placeholderData: keepSegmentsWhile((p) => p.measure === measureCode && p.window === segWindow) },
  )
  // The context layer: every street measured up to the moment shown. Asked
  // for whatever the window, so "To date" is already loaded when it is picked
  // and is then the coloured layer's own query (one key, one request).
  const contextQ = useSegments(
    { measure: measureCode, metric: 'median', window: 'todate' },
    { placeholderData: keepSegmentsWhile((p) => p.measure === measureCode && p.window === 'todate') },
  )
  const windowStreets = windowQ.data
  const label = measure ? shortName(measure) : measureCode.toUpperCase()

  // The moment the figures are for: the payload's, else the clock's.
  const at = net?.at ?? now
  // Said once, in the legend and the panel, when the window holds no pass.
  // Judged on the map's own grid whenever it is on screen — its emptiness,
  // its moment and its last pass all from its `window` member, so the line
  // can never name a different moment than the colours (the payload may land
  // a clock step before or after the grid). Only while the grid is still
  // unknown does the payload's window, once it is this window's, answer.
  const gridWin = windowStreets?.window
  const emptyLine = windowStreets
    ? (windowStreets.features.length === 0
      ? emptyWindowLine(streets, gridWin?.to ?? at, gridWin?.last_pass_at ?? null, label)
      : null)
    : netW && windowIsEmpty(netW.streets_window)
      ? emptyWindowLine(streets, netW.streets_window.to, netW.streets_window.last_pass_at, label)
      : null

  const monitorsById = useMemo(() => new Map((net?.monitors ?? []).map((m) => [m.id, m])), [net])
  const plumesById = useMemo(() => new Map((net?.plumes ?? []).map((p) => [p.site_id, p])), [net])
  const siteById = useMemo(() => new Map((sites ?? []).map((x) => [x.id, x])), [sites])
  const siteName = useCallback(
    (id: string) => plumesById.get(id)?.name ?? siteById.get(id)?.name ?? id,
    [plumesById, siteById],
  )
  // The Plumes rows: what an outline touches includes the window's streets,
  // so they wait for this window's payload.
  const touching = useMemo(() => (netW?.plumes ?? []).filter(plumeTouches), [netW])
  // A named cluster is inside that site's outline NOW only when the plume's
  // own touches say so; `named_site_id` is the wind when it was reported.
  const insideNow = useCallback(
    (r: RegulatorNetworkResident) => !!r.named_site_id
      && !!plumesById.get(r.named_site_id)?.touches.open_cluster_ids.includes(r.cluster_id),
    [plumesById],
  )

  const pickMonitor = useCallback((id: string, fly = true) => {
    setPick({ kind: 'monitor', id })
    const m = towers.find((t) => t.id === id)
    if (fly && m) flyTo([m.lon, m.lat], 13.2)
  }, [towers, flyTo])
  const pickPlume = useCallback((siteId: string, fly = true) => {
    setPick({ kind: 'plume', id: siteId })
    const st = siteById.get(siteId)
    if (fly && st) flyTo(st.centroid, 12.8)
  }, [siteById, flyTo])
  const pickCluster = useCallback((id: string, report: string | null = null, at?: [number, number]) => {
    setPick({ kind: 'cluster', id, report })
    if (at) flyTo(at, 14)
  }, [flyTo])

  const unit = unitFor(measure)

  return (
    <div className={`${s.page} ${s.netPage}`}>
      <NetworkHeader
        net={net}
        streetKm={netW?.numbers.street_km ?? null}
        kmLabel={windowKmLabel(streets, at)}
        loading={netQ.isPending || netQ.isFetching}
        failed={netQ.isError && !netQ.isFetching}
        onRetry={() => { void netQ.refetch() }}
        alertsNow={live.count}
        alertsLoading={live.loading}
        alertsFailed={live.error}
      />

      <div className={s.netBody}>
        <NetworkMap
          net={net}
          towers={towers}
          sites={sites}
          measure={measure}
          measureCode={measureCode}
          measures={measures}
          onMeasure={setMeasure}
          windowStreets={windowStreets}
          streetsFailed={!windowStreets && windowQ.isError}
          onRetryStreets={() => { void windowQ.refetch() }}
          contextStreets={contextQ.data}
          streets={streets}
          onStreets={setStreets}
          at={at}
          emptyLine={emptyLine}
          shown={shown}
          onShown={setShown}
          pick={pick}
          onPickMonitor={pickMonitor}
          onPickPlume={pickPlume}
          onPickCluster={pickCluster}
          onClear={() => setPick(null)}
          now={now}
        />

        <aside className={s.netPanel} aria-label="Monitors, plumes and residents">
          {pick?.kind === 'monitor' ? (
            <MonitorDetail
              key={pick.id}
              id={pick.id}
              net={net}
              tower={towers.find((t) => t.id === pick.id) ?? null}
              row={monitorsById.get(pick.id) ?? null}
              windowStreets={windowStreets}
              streetsFailed={!windowStreets && windowQ.isError}
              streets={streets}
              at={at}
              measure={measure}
              measureCode={measureCode}
              siteName={siteName}
              now={now}
              onBack={() => setPick(null)}
            />
          ) : pick?.kind === 'plume' ? (
            <PlumeDetail
              key={pick.id}
              plume={plumesById.get(pick.id) ?? null}
              siteName={siteName(pick.id)}
              net={net}
              streetsReady={!!netW}
              streetsPhrase={windowPhrase(streets, at)}
              emptyLine={emptyLine}
              measure={measure}
              measureCode={measureCode}
              onBack={() => setPick(null)}
              onPickMonitor={(id) => pickMonitor(id)}
            />
          ) : pick?.kind === 'cluster' ? (
            <ClusterDetail
              key={pick.id}
              id={pick.id}
              report={pick.report}
              row={(net?.residents ?? []).find((r) => r.cluster_id === pick.id) ?? null}
              insideNow={insideNow}
              at={net?.at ?? now}
              siteName={siteName}
              now={now}
              onBack={() => setPick(null)}
              onReport={(rid) => setPick({ kind: 'cluster', id: pick.id, report: rid })}
            />
          ) : (
            <>
              <Section title="Monitors" aside={unit ? `${label} · ${unit}` : label}>
                {towers.length === 0 && !towersQ.isPending ? (
                  <p className={s.note}>No reference monitors in this campaign.</p>
                ) : towers.map((t) => (
                  <MonitorRow
                    key={t.id}
                    tower={t}
                    row={monitorsById.get(t.id) ?? null}
                    label={label}
                    decimals={measure?.decimals ?? 1}
                    onClick={() => pickMonitor(t.id)}
                  />
                ))}
              </Section>

              <Section title="Plumes" aside="modelled">
                {!netW ? (
                  <p className={s.note}>{netQ.isError ? 'Plume status unavailable.' : 'Reading the model…'}</p>
                ) : (
                  <>
                    {/* Once, here, rather than "not enough of this area was
                        driven" on every row: the window is empty everywhere. */}
                    {emptyLine ? <p className={s.note}>{emptyLine}.</p> : null}
                    {touching.length === 0 ? (
                      <p className={s.note}>
                        {/* An empty window has no street to reach: the line above said so. */}
                        {emptyLine
                          ? `At ${fmtTime24(netW.at)} no modelled plume reaches a monitor or a resident cluster.`
                          : `At ${fmtTime24(netW.at)} no modelled plume reaches a monitor, a street measured `
                            + `${windowRelative(streets)} or a resident cluster.`}
                      </p>
                    ) : touching.map((p) => (
                      <PlumeRow
                        key={p.site_id}
                        plume={p}
                        windowEmpty={!!emptyLine}
                        monitorName={(id) => towers.find((t) => t.id === id)?.name ?? id}
                        onClick={() => pickPlume(p.site_id)}
                      />
                    ))}
                  </>
                )}
              </Section>

              <Section title="Residents" aside={`last ${REPORT_WINDOW_DAYS} d`}>
                {!net ? (
                  <p className={s.note}>{netQ.isError ? 'Resident clusters unavailable.' : 'Reading reports…'}</p>
                ) : net.residents.length === 0 ? (
                  <p className={s.note}>No resident cluster in the last {REPORT_WINDOW_DAYS} days.</p>
                ) : net.residents.map((r) => (
                  <ResidentRow
                    key={r.cluster_id}
                    row={r}
                    inside={insideNow(r)}
                    siteName={siteName}
                    now={now}
                    onClick={() => pickCluster(r.cluster_id)}
                  />
                ))}
              </Section>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────── the header

/**
 * One generated sentence and three numbers (R1). The sentence is the
 * server's: it is built from status fields, carries no written-down number,
 * and branches on state — Riverport's downwind test sits just over its floor
 * (3.75 against 3.28) and the deployed demo is built without a pinned clock,
 * so the story has to degrade on another seed rather than be asserted here.
 */
function NetworkHeader({
  net, streetKm, kmLabel, loading, failed, onRetry, alertsNow, alertsLoading, alertsFailed,
}: {
  net: RegulatorNetwork | undefined
  /** `numbers.street_km` of the window shown; null until that window's payload lands. */
  streetKm: number | null
  /** "street-km measured, 7 days to 13:54": the window, named where the number is. */
  kmLabel: string
  loading: boolean
  failed: boolean
  onRetry: () => void
  alertsNow: number
  alertsLoading: boolean
  alertsFailed: boolean
}) {
  // The server's count or a dash: `status === 'online'` is the monitor list's
  // field, not the moment shown, and printed a count the payload never gave.
  const reporting = net?.numbers.monitors_reporting
  const total = net?.numbers.monitors_total
  // Nothing to count yet reads as a dash, not as "0/0 monitors reporting".
  const known = reporting != null && total != null && total > 0
  // A pending or failed alert list is not "0 alerts now".
  const alertsKnown = !alertsLoading && !alertsFailed
  return (
    <header className={s.netHead}>
      <h1 className={s.headline}>
        {net?.headline ?? (failed ? 'Network status unavailable.' : loading ? 'Reading the network…' : '')}
        {/* One retry is automatic; a failed step in playback stayed failed
            until the next one, with nothing on screen to ask again. */}
        {!net && failed ? (
          <>
            {' '}
            <button type="button" className={s.inlineLink} onClick={onRetry}>Try again</button>
          </>
        ) : null}
      </h1>
      <div className={s.numbers}>
        <Link to="/regulator/alerts" className={`${s.number} ${s.numberLink}`}>
          <span className={`${s.numberValue}${alertsKnown && alertsNow ? ` ${s.overInk}` : ''}`}>
            {alertsKnown ? fmtNum(alertsNow, 0) : '—'}
          </span>
          <span className={s.numberLabel}>{alertsKnown && alertsNow === 1 ? 'alert now' : 'alerts now'}</span>
        </Link>
        <div className={s.number}>
          <span className={s.numberValue}>{known ? `${fmtNum(reporting, 0)}/${fmtNum(total, 0)}` : '—'}</span>
          <span className={s.numberLabel}>monitors reporting</span>
        </div>
        <div className={s.number}>
          <span className={`${s.numberValue} ${s.fleetInk}`}>
            {streetKm != null ? fmtNum(streetKm, 0) : '—'}
          </span>
          {/* The same window as the map's coloured streets, so the label
              names it and needs no "whole day" beside it. */}
          <span className={s.numberLabel}>{kmLabel}</span>
        </div>
      </div>
    </header>
  )
}

// ═══════════════════════════════════════════════════════════════════ the map

interface MapProps {
  net: RegulatorNetwork | undefined
  towers: Monitor[]
  sites: IndustrySite[] | undefined
  measure: MeasureDef | undefined
  measureCode: MeasureCode
  measures: MeasureDef[]
  onMeasure: (c: MeasureCode) => void
  /** The window's streets (`trailing:<N>h` or `todate`, to `at`) — the coloured layer. */
  windowStreets: SegmentCollection | undefined
  /** The window's streets failed to load and none are on screen. */
  streetsFailed: boolean
  onRetryStreets: () => void
  /** Every street measured up to `at` (`todate`) — the grey context layer. */
  contextStreets: SegmentCollection | undefined
  streets: StreetsWindow
  onStreets: (w: StreetsWindow) => void
  /** The payload's moment; the street words use the grid's own (`windowStreets.window.to`). */
  at: CampaignTime
  /** "No NO2 passes in the 7 days to …", when the window holds no pass. */
  emptyLine: string | null
  shown: Shown
  onShown: (fn: (v: Shown) => Shown) => void
  pick: Pick | null
  onPickMonitor: (id: string, fly?: boolean) => void
  onPickPlume: (siteId: string, fly?: boolean) => void
  onPickCluster: (id: string, report?: string | null, at?: [number, number]) => void
  onClear: () => void
  now: CampaignTime
}

/**
 * The map on its own, memoised: the alarm pulse and the fleet animation
 * re-render it every frame, and they must not re-render the panel with it.
 */
const NetworkMap = memo(function NetworkMap(props: MapProps) {
  const {
    net, towers, sites, measure, measureCode, measures, onMeasure, windowStreets, streetsFailed,
    onRetryStreets, contextStreets, streets, onStreets, at, emptyLine, shown, onShown, pick,
    onPickMonitor, onPickPlume, onPickCluster, onClear, now,
  } = props
  const campaign = useCampaignInfo()
  const boundary = useCampaignBoundary(campaign?.id).data
  const mapView = useSession((x) => x.mapView)
  const setMapView = useSession((x) => x.setMapView)
  const flyTo = useSession((x) => x.flyTo)

  // ── the camera ─────────────────────────────────────────────────────────
  // Home FITS the campaign into the part of the map the furniture leaves
  // free. The session's saved view (often another room's) opened this map
  // with the legend over Ridgeline's campus and its plume at 1080x900. It
  // re-fits on a resize until the reader has touched the map; after that the
  // camera is theirs.
  const [mapRef, mapSize] = useSize<HTMLDivElement>({ width: 0, height: 0 })
  const [legendRef, legendSize] = useSize<HTMLDivElement>({ width: 296, height: 100 })
  const touched = useRef(false)
  const markTouched = () => { touched.current = true }
  useEffect(() => {
    if (touched.current || !boundary) return
    // +36 under the legend: West Shelby Drive's mast stands on the campaign's
    // south edge and its label hangs ~24 px below it.
    const home = fitCampaign(boundary, mapSize, { top: 52, bottom: legendSize.height + 36 })
    if (home) setMapView(home)
  }, [boundary, mapSize, legendSize.height, setMapView])

  // The pollutant in view drives the plume's label only: the kernel draws one
  // transport shape per site whatever the species (wind.py `dispersion`).
  const plumeQ = useDispersion({ outline: true, measure: measureCode }, { enabled: true })
  const others = useMonitors({}, { enabled: shown.other }).data
  const fleetQ = useFleet({ delay_min: 0 }, { enabled: shown.fleet })
  const fleet = useFleetAnimation(shown.fleet ? (fleetQ.data ?? EMPTY_FLEET) : EMPTY_FLEET)
  const fieldQ = useWindField({ cell_m: 400, ...useStableWindow(72) }, { enabled: shown.wind })

  // Resident reports as they stood at the moment shown, in the map's window.
  const concernsQ = useConcerns({ limit: 400 })
  const clustersQ = useConcernClusters()
  const reports = useMemo(() => {
    const asOf = reportsAsOf(concernsQ.data, clustersQ.data, now)
    return windowReports(asOf.concerns, asOf.clusters, REPORT_WINDOW_DAYS, now)
  }, [concernsQ.data, clustersQ.data, now])

  // Both models: the filed studies for the pollutant in view, one per site.
  const studies = useQueries({
    queries: (sites ?? []).map((st) => ({
      queryKey: qk.sites.models(st.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.listDispersionModels(st.id, signal),
      staleTime: STALE.dispersionModels,
      enabled: shown.filed,
    })),
  })
  const filed = useMemo(() => studies
    .flatMap((q) => q.data ?? [])
    .filter((m: DispersionModel) => m.model_tier === 'permit' && m.measure === measureCode),
  [studies, measureCode])

  const overIds = useMemo(() => (net?.monitors ?? []).filter((m) => m.over).map((m) => m.id), [net])
  const pulse = usePulse(2200, { running: overIds.length > 0 })

  // ── what gets an axis and a label ──────────────────────────────────────
  // From the payload on screen, which just after a window switch is the
  // previous window's for one fetch: the lit set can lag by that much, and
  // no number is printed from it.
  const touchingIds = useMemo(
    () => new Set((net?.plumes ?? []).filter(plumeTouches).map((p) => p.site_id)),
    [net],
  )
  // Muted: every site the model draws that touches nothing checkable. Until
  // the network answers there is nothing to judge that by, and none is muted.
  const mutedSiteIds = useMemo(() => {
    if (!net) return null
    const drawn = new Set((plumeQ.data?.features ?? []).map((f) => f.properties.site_id))
    return [...drawn].filter((id) => !touchingIds.has(id))
  }, [net, plumeQ.data, touchingIds])
  const beyond = shown.plumes && hasBeyondEnvelope(plumeQ.data)

  // ── the streets ────────────────────────────────────────────────────────
  const derived = measure?.unit === ''
  const domain = useMemo<[number, number]>(() => {
    // An index is pinned to its own scale; stretched to the local spread, a
    // seven-point range across the campaign painted full-scale alarm.
    if (derived) return INDEX_DOMAIN
    const vals: number[] = []
    for (const f of windowStreets?.features ?? []) if (f.properties.value != null) vals.push(f.properties.value)
    // No floor at zero: ambient NO2 never approaches it, and anchoring there
    // pushes every ordinary street into the hot half of the ramp.
    return robustDomain(vals, { floorAtZero: false })
  }, [windowStreets, derived])
  // The context grid is the streets measured up to the moment shown and NOT
  // in the window — "measured earlier" — so no street is drawn twice, and
  // with "To date" picked it is the window itself and is not drawn at all.
  // Only beside a known window grid (loading or failed, "not in the window"
  // would be every street, all grey), and only when both grids end at the
  // same moment: while the clock steps one lands before the other, and a grey
  // street cut at another moment is not "measured earlier" than this window.
  const contextOnly = useMemo<SegmentCollection | null>(() => {
    if (streets === 'todate' || !contextStreets || !windowStreets) return null
    if (contextStreets.window?.to !== windowStreets.window?.to) return null
    const inWindow = new Set(windowStreets.features.map((f) => f.properties.id))
    const features = contextStreets.features.filter((f) => !inWindow.has(f.properties.id))
    return features.length ? { type: 'FeatureCollection', features } : null
  }, [streets, contextStreets, windowStreets])
  const ringOf = pick?.kind === 'monitor' ? pick.id : null
  const ringIds = useMemo(() => {
    const m = ringOf ? towers.find((t) => t.id === ringOf) : null
    return m ? streetsInRing(windowStreets?.features, m).map((f) => f.properties.id) : null
  }, [ringOf, towers, windowStreets])

  const netById = useMemo(() => new Map((net?.monitors ?? []).map((m) => [m.id, m])), [net])
  // No channel for the pollutant in view: drawn muted, labelled so, never lit.
  const noChannel = useMemo(
    () => (net?.monitors ?? []).filter((m) => !m.has_measure).map((m) => m.id),
    [net],
  )
  // Labelled by the short name ("Delta Forge"): the full one ran 32
  // characters of mono across the Harbor Avenue monitor.
  const litSites = useMemo(
    () => (sites ?? []).filter((x) => touchingIds.has(x.id)).map((x) => ({ ...x, name: shortSite(x.name) })),
    [sites, touchingIds],
  )
  const quietSites = useMemo(() => (sites ?? []).filter((x) => !touchingIds.has(x.id)), [sites, touchingIds])

  const [hoverMonitor, setHoverMonitor] = useState<string | null>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  const layersBtn = useRef<HTMLButtonElement>(null)
  const toggle = (k: keyof Shown) => (v: boolean) => onShown((p) => ({ ...p, [k]: v }))

  const selectedMonitor = pick?.kind === 'monitor' ? pick.id : null
  const selectedReport = pick?.kind === 'cluster' ? pick.report : null
  const zoom = mapView?.zoom

  const layers = useCallback((t: Theme): LayersList => {
    const scale = makeColorScale(t, { domain, ramp: 'map' })
    const row = (id: string) => netById.get(id)
    // One collider per build: a site's name steps aside for a monitor's
    // label or mast (Riverport Road stands 425 m from Riverport's centroid,
    // about 40 px at the campaign zoom), and monitors always win.
    const collision = labelCollision()
    return [
      // The campaign edge in quiet ink, 1 px: in the accent it was the
      // brightest line on the old map, louder than the streets it encloses.
      ...(boundary ? BoundaryLayer({
        data: boundary, theme: t, mask: true, maskStrength: 0.28, glow: false, colorToken: 'ink-3', edgeWidthPx: 1,
      }) : []),
      // The ground the fleet did not drive in the window, recessed — under
      // the streets and every model layer, so it dims tiles, never data. The
      // window's streets, so the undimmed corridors are the coloured ones.
      ...(shown.mask ? CoverageMaskLayer({ data: windowStreets, theme: t }) : []),
      // Measured earlier, not in this window: every such street as a neutral
      // hairline, no casing, no value colour, not pickable (F3c). Drawn
      // first, so the road network reads on a week the fleet did not drive,
      // and the model outlines never sit over blank ground that WAS measured.
      ...(contextOnly ? SegmentLayer({ id: 'context-streets', data: contextOnly, theme: t, tone: 'context' }) : []),
      ...SegmentLayer({
        id: 'streets', data: windowStreets, theme: t, metric: 'median', measure: measureCode, scale,
        // A 3 px floor: few-pass streets draw at 0.7 of it, and just after
        // the off-week they are most of the 7 d window (to Aug 25 06:00, 603
        // of 926 streets have under 3 passes; at the end of the data, 144 of
        // 1,307 — seed 20260827) — at the 2.2 px floor such a grid read as
        // faint hairlines.
        dualEncode: 'none', fewPassesBelow: THIN_BELOW_PASSES, highlightIds: ringIds,
        baseWidthM: 30, widthMinPixels: 3, widthMaxPixels: 9,
      }),
      ...(shown.filed ? filed.flatMap((m) => FiledStudyLayer({ id: `filed-${m.id}`, theme: t, contours: m.contours })) : []),
      ...(shown.plumes
        ? DispersionLayer({ id: 'plumes', data: plumeQ.data, theme: t, style: 'outline', pickable: true, mutedSiteIds })
        : []),
      // Neutral outlines, no brand wash (CONTRACT §10b: measurement is the only
      // filled thing). Named only when the site's outline touches something.
      ...SiteLayer({
        id: 'sites-lit', data: litSites, theme: t, emissionPoints: false, labels: true, branding: false,
        footprint: 'outline', labelCase: 'asis', collision,
      }),
      ...SiteLayer({
        id: 'sites-quiet', data: quietSites, theme: t, emissionPoints: false, labels: false, branding: false,
        footprint: 'outline', collision,
      }),
      ...(shown.other && others ? MonitorLayer({
        id: 'monitors-other', data: others.filter((m) => m.owner_type !== 'regulator'), theme: t,
        rings: false, labels: false, measure: measureCode, sizePx: 14, overIds: [],
      }) : []),
      ...MonitorLayer({
        id: 'monitors-ref', data: towers, theme: t, rings: shown.rings, labels: true,
        // "Riverport Rd 10.6", as given: four monitor names in capitals were
        // four of the page's sixteen all-caps labels (R9).
        labelFor: (m: Monitor) => shortPlace(m.name), labelCase: 'asis',
        // The reading, and from 0.5× its ratio WITH the level's word, in one
        // string ("120.7 · 1.2× standard"): `ratioFor` would print a bare "1.2×".
        readingFor: (m: Monitor) => mapReading(row(m.id), measure),
        overIds, mutedIds: noChannel, mutedNote: `no ${shortName(measure)} channel`,
        measure: measureCode, pulse, sizePx: 30, selectedId: selectedMonitor, hoveredId: hoverMonitor,
        // On a plate: at Aug 25 06:00 three of Riverport's plume hairlines
        // ran straight through "120.7", the one figure the map is for.
        collision, labelPlate: true,
      }),
      ...(shown.fleet ? FleetLayer({ data: fleet, theme: t, pulse: 0, trails: shown.trails, labels: false }) : []),
      ...(shown.reports ? ConcernLayer({
        data: reports.concerns,
        clusters: reports.clusters,
        theme: t,
        pulse: 0,
        labels: false,
        zoom,
        selectedId: selectedReport,
        onBubbleClick: (info: PickingInfo) => {
          const b = info.object as ConcernBubble | undefined
          if (b) flyTo(b.position, Math.max(zoom ?? 0, BUBBLE_SPLIT_ZOOM))
        },
        onClick: (info: PickingInfo) => {
          const c = info.object as Concern | undefined
          if (c?.id && c.cluster_id && reports.clusters.some((g) => g.id === c.cluster_id)) {
            onPickCluster(c.cluster_id, c.id)
          }
        },
        onClusterClick: (info: PickingInfo) => {
          const cl = info.object as ConcernCluster | undefined
          if (cl?.id) onPickCluster(cl.id)
        },
      }) : []),
    ]
  }, [
    boundary, shown, windowStreets, contextOnly, measureCode, domain, ringIds, filed,
    plumeQ.data, mutedSiteIds, litSites, quietSites, others, towers, netById, measure, overIds,
    noChannel, pulse, selectedMonitor, hoverMonitor, fleet, reports, zoom, selectedReport, flyTo,
    onPickCluster,
  ])

  const onClick = (info: PickingInfo) => {
    const obj = info.object as Record<string, unknown> | null | undefined
    const lid = String(info.layer?.id ?? '')
    if (!obj) { onClear(); return }
    if (lid.startsWith('monitors-ref')) {
      if (typeof obj.id === 'string') onPickMonitor(obj.id, false)
    } else if (lid.startsWith('plumes')) {
      const sid = (obj as { properties?: { site_id?: unknown } }).properties?.site_id
      if (typeof sid === 'string') onPickPlume(sid, false)
    } else if (lid.startsWith('sites')) {
      const { siteId } = pickedSite(obj)
      if (siteId) onPickPlume(siteId, false)
    }
  }

  const unit = unitFor(measure)
  const hasFiled = filed.length > 0
  // The window, named exactly: "Measured, 7 days to Aug 25 06:00" — at the
  // grid's own end, so the title and the tooltip name the moment the colours
  // were cut at, not the payload's, which may be a clock step apart.
  const gridAt = windowStreets?.window?.to ?? at
  const streetsTitle = windowTitle(streets, gridAt)
  // The grey key only while the grey grid is drawn.
  const contextShown = !!contextOnly
  const tooltip = (info: PickingInfo): string | null => {
    const lid = String(info.layer?.id ?? '')
    if (!lid.startsWith('streets') || !info.object) return null
    const p = (info.object as SegmentFeature).properties
    return `${p.name ?? 'Street'} · median ${fmtNum(p.value, measure?.decimals ?? 1)}${unit ? ` ${unit}` : ''}`
      + ` · ${fmtNum(p.n_passes, 0)} ${p.n_passes === 1 ? 'pass' : 'passes'}, ${windowPhrase(streets, gridAt)}`
  }

  return (
    <div
      ref={mapRef}
      className={s.netMap}
      onPointerDownCapture={markTouched}
      onWheelCapture={markTouched}
      onKeyDownCapture={markTouched}
    >
      <BaseMap
        label="Reference monitors, measured streets, modelled plumes and resident reports"
        initialView={{
          longitude: campaign?.center?.[0] ?? -90.132,
          latitude: campaign?.center?.[1] ?? 35.058,
          zoom: campaign?.default_zoom ?? 12.2,
        }}
        view={mapView}
        onViewChange={setMapView}
        layers={layers}
        onClick={onClick}
        getTooltip={tooltip}
        onHover={(info) => {
          const lid = String(info.layer?.id ?? '')
          const id = lid.startsWith('monitors-ref')
            ? ((info.object as { id?: unknown } | undefined)?.id as string | undefined) ?? null
            : null
          setHoverMonitor((prev) => (prev === id ? prev : id))
        }}
        minZoom={10}
        maxZoom={17}
        fullBleed={shown.wind ? (
          // Texture, in one neutral ink: the map ramp is the measured-street
          // ramp, and wind drawn in it read as measured ink over ground
          // nobody drove (CONTRACT §10b). No stats panel — cells and
          // observation counts were plumbing, not an answer.
          <MapWindField field={fieldQ.data} particles={700} opacity={0.34} lineWidth={1} colorMode="neutral" colorToken="ink" />
        ) : null}
      >
        {/* Overlay 1 of 2: the pollutant and the layers, one bar. */}
        <MapOverlay place="top-left">
          <div className={s.mapBar}>
            <label className={s.pollutant}>
              <span className={s.pollutantKey}>Pollutant</span>
              <select
                className={s.pollutantSelect}
                value={measureCode}
                onChange={(e) => onMeasure(e.target.value as MeasureCode)}
              >
                {measures.map((m) => (
                  <option key={m.code} value={m.code}>
                    {shortName(m)}{unitFor(m) ? ` · ${unitFor(m)}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              ref={layersBtn}
              type="button"
              className={s.mapBtn}
              aria-expanded={layersOpen}
              onClick={() => setLayersOpen((v) => !v)}
            >
              Layers
              <Icon name="chevron" size={12} />
            </button>
          </div>
          <Popover
            open={layersOpen}
            onClose={() => setLayersOpen(false)}
            anchor={layersBtn}
            align="start"
            width={264}
            label="Map layers"
          >
            <div className={s.layersMenu}>
              <Toggle checked={shown.plumes} onChange={toggle('plumes')} label="Modelled plumes" />
              <Toggle
                checked={shown.filed}
                onChange={toggle('filed')}
                label={shown.filed && !hasFiled ? `Filed studies (none for ${shortName(measure)})` : 'Filed studies'}
              />
              <Toggle checked={shown.mask} onChange={toggle('mask')} label="Dim ground not driven" />
              <Toggle checked={shown.reports} onChange={toggle('reports')} label="Resident reports" />
              <Toggle checked={shown.rings} onChange={toggle('rings')} label="Monitor rings" />
              <Toggle checked={shown.wind} onChange={toggle('wind')} label="Fleet-measured wind" />
              <Toggle checked={shown.fleet} onChange={toggle('fleet')} label="Fleet, live" />
              <Toggle checked={shown.trails} onChange={toggle('trails')} label="Fleet trails" disabled={!shown.fleet} />
              <Toggle checked={shown.other} onChange={toggle('other')} label="Other sensors" />
            </div>
          </Popover>
        </MapOverlay>

        {/* Overlay 2 of 2: the legend. Every mark that carries the story. */}
        <MapOverlay place="bottom-left">
          <div ref={legendRef} className={s.legend}>
            {/* The streets' key is the shared one, so its ramp, its range,
                its thin stroke and its grey hairline are the marks
                SegmentLayer draws. The title names the window exactly, the
                switch under it changes that window, and the counts in the
                panel and the header are the same window — so no line needs a
                "whole day" beside it. The ramp only once the window's streets
                have landed: `empty` holds the loading line until then (the
                scale's empty fallback read "0.0–1.0"), and a window with no
                pass says so and names the last one instead of an empty ramp.
                The switch stays usable in both. */}
            <MapLegend
              className={s.legendStreets}
              title={streetsTitle}
              domain={domain}
              measure={measure ?? null}
              metric="median"
              dualEncode="none"
              compact
              showNoData={false}
              fewPassesNote={FEW_PASSES_NOTE}
              contextNote={contextShown ? CONTEXT_NOTE : null}
              empty={windowStreets ? emptyLine : streetsFailed ? 'Streets unavailable' : 'Reading streets…'}
              control={<WindowPicker value={streets} onChange={onStreets} />}
            />
            {streetsFailed ? (
              <div className={s.legendRow}>
                <button type="button" className={s.inlineLink} onClick={onRetryStreets}>Try again</button>
              </div>
            ) : null}
            {shown.mask ? (
              <div className={s.legendRow}>
                <span className={s.legendSwatch} aria-hidden><MaskSwatch /></span>
                <span className={s.legendText}>dim: not driven in this window</span>
              </div>
            ) : null}
            {shown.plumes ? (
              <div className={s.legendRow}>
                <span className={s.legendSwatch} aria-hidden><StrokeSwatch register="model" /></span>
                <span className={s.legendText}>Modelled plume{net ? ` · ${fmtTime24(net.at)}` : ''}</span>
              </div>
            ) : null}
            {beyond ? (
              <div className={s.legendRow}>
                <span className={s.legendSwatch} aria-hidden><StrokeSwatch register="beyond" /></span>
                <span className={s.legendText}>{BEYOND_ENVELOPE_NOTE}</span>
              </div>
            ) : null}
            {shown.filed && hasFiled ? (
              <div className={s.legendRow}>
                <span className={s.legendSwatch} aria-hidden><StrokeSwatch register="filed" /></span>
                <span className={s.legendText}>Filed study (model)</span>
              </div>
            ) : null}
          </div>
        </MapOverlay>
      </BaseMap>
    </div>
  )
})

const EMPTY_FLEET: FleetPosition[] = []

/** The camera that fits the campaign boundary into the map minus its furniture. */
function fitCampaign(
  boundary: BoundaryCollection,
  size: { width: number; height: number },
  reserve: { top: number; bottom: number },
): MapView | null {
  if (size.width < 120 || size.height < 120) return null
  const pts = boundary.features.flatMap((f) => geometryPositions(f.geometry))
  if (pts.length < 2) return null
  const b = bboxOfPositions(pts)
  const side = 16
  const w = Math.max(120, size.width - side * 2)
  const h = Math.max(120, size.height - reserve.top - reserve.bottom)
  const zoom = Math.max(10.5, Math.min(14, fitZoom(b, w, h, 0)))
  const [cx, cy] = bboxCenter(b)
  // Centre the box in the free area, not the canvas. `metersPerPixel` is on
  // 256-px tiles and the map on 512-px ones, hence `zoom + 1` (as the
  // industry deck's fit).
  const shiftPx = (reserve.bottom - reserve.top) / 2
  const lat = cy - (shiftPx * metersPerPixel(cy, zoom + 1)) / 110_540
  return { longitude: cx, latitude: lat, zoom, pitch: 0, bearing: 0 }
}

/**
 * The street window, three ways — 24 h · 7 d · To date — in the legend,
 * beside the key it changes (F4). One control, not three chips: a group of
 * toggle buttons, exactly one pressed. It replaces the "90 days" toggle,
 * whose 90-day grid under an hourly plume read as confirmation (R4); the
 * longest window here still ends at the moment shown.
 */
function WindowPicker({ value, onChange }: { value: StreetsWindow; onChange: (w: StreetsWindow) => void }) {
  return (
    <span className={s.windowPick} role="group" aria-label="Street window">
      {STREETS_WINDOWS.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`${s.windowOpt}${o.value === value ? ` ${s.windowOptOn}` : ''}`}
          aria-pressed={o.value === value}
          title={o.title}
          onClick={() => { if (o.value !== value) onChange(o.value) }}
        >
          {o.label}
        </button>
      ))}
    </span>
  )
}

/**
 * What the map label prints after the name: "10.6", or "120.7 · 1.2× standard"
 * from 0.5× up. The payload's level is the highest 1-hour level the reading
 * exceeds, else the tightest (owner, D15), so for NO2 the same monitor reads
 * "· 1.2× standard" over the 100 ppb standard, "· 1.6× watch" between the two
 * levels and "· 0.62× watch" below both. The ratio carries its level's word
 * because a bare "1.6×" does not say which level it is a multiple of.
 */
function mapReading(row: RegulatorNetworkMonitor | undefined, measure: MeasureDef | undefined): string | null {
  if (!row?.has_measure || !row.reading) return null
  const value = fmtNum(row.reading.value, measure?.decimals ?? 1)
  const ratio = row.level ? formatRatio(row.level.ratio, RATIO_LABEL_FROM) : null
  return ratio && row.level ? `${value} · ${ratio} ${levelWord(row.level.name)}` : value
}

/**
 * A level in its own words, less the pollutant the row already names:
 * "NO2 1-hour watch" → "1-hour watch". Falls back to the whole name.
 */
function levelWords(name: string): string {
  return /\b(\d+-hour\b.*)$/i.exec(name)?.[1] ?? name
}

/** A level's last word, for a map label: "watch", "standard", "spike". */
function levelWord(name: string): string {
  return name.trim().split(/\s+/).pop() ?? name
}

/**
 * A level as a noun phrase, as the headline says it (`_level_phrase` in
 * network.py): "1-hour standard" reads as it is, "1-hour watch" gains
 * "level" — so the panel never prints "the 1-hour standard level".
 */
function levelPhrase(words: string): string {
  return /(standard|level)$/i.test(words.trim()) ? words : `${words} level`
}

// ═══════════════════════════════════════════════════════════════ the panel

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={s.section} aria-label={title}>
      <header className={s.sectionHead}>
        <h2 className={s.sectionTitle}>{title}</h2>
        {aside ? <span className={s.sectionAside}>{aside}</span> : null}
      </header>
      <div className={s.sectionBody}>{children}</div>
    </section>
  )
}

/**
 * One monitor, one line: name, the reading at the moment shown, and its
 * status only when it is not online. From 0.5× a second line names the ratio
 * WITH its level — "1.2× the 1-hour standard", "1.6× the 1-hour watch level":
 * the highest level the reading exceeds, else the tightest (D15), and so the
 * level the headline names for the monitor it leads with. A missing channel
 * is said in muted ink ("no NO2 channel"), never "blind to": it is a property
 * of the instrument list, not a failing.
 */
function MonitorRow({
  tower, row, label, decimals, onClick,
}: {
  tower: Monitor
  row: RegulatorNetworkMonitor | null
  label: string
  decimals: number
  onClick: () => void
}) {
  // The map label's own formatter, so the label and this row cannot disagree.
  const ratio = row?.has_measure && row.reading ? formatRatio(row.level?.ratio ?? null, RATIO_LABEL_FROM) : null
  const value = !row ? null
    : !row.has_measure ? <span className={s.mute}>no {label} channel</span>
      : !row.reading ? <span className={s.mute}>no reading</span>
        : (
          <span className={`${s.itemNum}${row.over ? ` ${s.overInk}` : ''}`}>
            {fmtNum(row.reading.value, decimals)}
          </span>
        )
  return (
    <button type="button" className={`${s.item}${ratio ? ` ${s.itemTwo}` : ''}`} onClick={onClick}>
      <span className={`${s.itemGlyph} ${row?.over ? s.overInk : row?.has_measure === false ? s.dim : s.towerInk}`} aria-hidden>
        <Icon name="tower" size={14} />
      </span>
      <span className={s.itemName}>
        {tower.name}
        {tower.status !== 'online' ? <span className={s.itemStatus}> · {tower.status}</span> : null}
      </span>
      <span className={s.itemValue}>
        {row?.over ? <span className={s.overMark} aria-label="over a level" /> : null}
        {value ?? <span className={s.mute}>—</span>}
      </span>
      {ratio && row?.level ? (
        <span className={s.itemSub}>
          <span className={`${s.itemRatio}${row.over ? ` ${s.overInk}` : ''}`}>{ratio}</span>
          {' '}the {levelPhrase(levelWords(row.level.name))}
        </span>
      ) : null}
    </button>
  )
}

/**
 * One site, one line: its name and where the model carries it, with what its
 * outline touches underneath. "Inside" means the SOLID part: a monitor under
 * the dashed part is not downwind (CONTRACT §10b), so it is never listed.
 */
function PlumeRow({
  plume, windowEmpty, monitorName, onClick,
}: {
  plume: RegulatorNetworkPlume
  /** The window holds no pass: the section says so once, so the row does not. */
  windowEmpty: boolean
  monitorName: (id: string) => string
  onClick: () => void
}) {
  const t = plume.touches
  const parts: string[] = []
  if (t.monitor_ids.length) parts.push(`${t.monitor_ids.map(monitorName).join(', ')} inside`)
  // Counted over the street window, the same streets the map colours. An
  // empty window is said once, above the rows.
  if (!windowEmpty) {
    const cannotSay = plumeCoverageLine(plume)
    if (cannotSay) parts.push(cannotSay)
    else if (t.streets_driven) parts.push(`${fmtNum(t.streets_driven, 0)} streets driven inside`)
  }
  if (t.open_cluster_ids.length) parts.push(`${t.open_cluster_ids.length} resident ${t.open_cluster_ids.length === 1 ? 'cluster' : 'clusters'}`)
  return (
    <button type="button" className={`${s.item} ${s.itemTwo}`} onClick={onClick}>
      <span className={s.itemGlyph} aria-hidden><StrokeSwatch register="model" /></span>
      <span className={s.itemName} title={plume.name}>{shortSite(plume.name)}</span>
      <span className={`${s.itemValue} ${s.itemNum}`}>
        {compassPoint(plume.bearing_deg)} {fmtDistance(Math.min(plume.reach_m, plume.envelope_m), 1)}
      </span>
      {parts.length ? <span className={s.itemSub}>{parts.join(' · ')}</span> : null}
    </button>
  )
}

/**
 * One cluster, one line. A site is named ONLY through `named_site_id` (F7):
 * the wind at the time AND the site's placebo-checked downwind test. The
 * cluster's own `site_id` is the generator's episode cause and is never read.
 *
 * `named_site_id` is the wind WHEN THE REPORTS WERE FILED (most of them
 * downwind of the site), not where the plume is now: at Aug 25 06:00 Pisgah
 * Heights, named for Riverport from reports up to Aug 17, read "in
 * Riverport's modelled plume" while that outline touched no cluster.
 * "Inside … modelled plume" is said only when the site's outline (its solid
 * part) touches the cluster at the moment shown.
 */
function ResidentRow({
  row, inside, siteName, now, onClick,
}: {
  row: RegulatorNetworkResident
  inside: boolean
  siteName: (id: string) => string
  now: CampaignTime
  onClick: () => void
}) {
  return (
    <button type="button" className={`${s.item}${row.named_site_id ? ` ${s.itemTwo}` : ''}`} onClick={onClick}>
      <span className={`${s.itemGlyph} ${s.itemCount}`}>{fmtNum(row.count, 0)}</span>
      <span className={s.itemName}>{row.label ?? 'Resident cluster'}</span>
      <span className={`${s.itemValue} ${s.mute}`}>
        {row.last_posted_at ? relativeShort(row.last_posted_at, now) : ''}
      </span>
      {row.named_site_id ? (
        <span className={s.itemSub}>
          {inside
            ? `inside ${shortSite(siteName(row.named_site_id))}’s modelled plume now`
            : `downwind of ${shortSite(siteName(row.named_site_id))} when reported`}
          {' · downwind test passed'}
        </span>
      ) : null}
    </button>
  )
}

function DetailHead({ title, sub, onBack }: { title: ReactNode; sub?: ReactNode; onBack: () => void }) {
  return (
    <header className={s.detailHead}>
      <button type="button" className={s.backBtn} onClick={onBack} aria-label="Back to the network">
        <Icon name="chevron" size={12} className={s.backIcon} />
        Network
      </button>
      <h2 className={s.detailTitle}>{title}</h2>
      {sub ? <p className={s.detailSub}>{sub}</p> : null}
    </header>
  )
}

function Fact({ k, children, model }: { k: string; children: ReactNode; model?: boolean }) {
  return (
    <div className={`${s.fact}${model ? ` ${s.factModel}` : ''}`}>
      <span className={s.factKey}>{k}</span>
      <span className={s.factVal}>{children}</span>
    </div>
  )
}

// ────────────────────────────────────────────────────────── monitor detail

/**
 * `placeholderData` for the monitor's same-window readings: the previous
 * hours stay on screen only while they are the same pollutant over the same
 * window. A step of the clock moves both ends of a trailing window by the
 * same amount (its length holds) and only the end of "To date" (its start
 * holds); a switch of window or pollutant changes neither of those, so it
 * reads as loading instead of printing the other set's median under this label.
 */
function keepReadingsWhile(id: string, measure: MeasureCode, from: CampaignTime | null, to: CampaignTime) {
  const span = from ? campaignMs(to) - campaignMs(from) : null
  return (
    previous: MonitorReadings | undefined,
    previousQuery?: { queryKey: readonly unknown[] },
  ): MonitorReadings | undefined => {
    // qk.monitors.readings: ['monitors', 'readings', id, params]
    const pid = previousQuery?.queryKey[2]
    const p = previousQuery?.queryKey[3] as api.MonitorReadingsParams | undefined
    if (!from || !p?.from || !p.to || pid !== id || p.measure !== measure) return undefined
    const same = p.from === from || campaignMs(p.to) - campaignMs(p.from) === span
    return same ? previous : undefined
  }
}

/**
 * A monitor's detail: what it reads, the streets inside its ring in the
 * street window, the channel's calibration anchor, how often the model puts
 * it in a plume, and its 24-hour shape beside a street's.
 *
 * The comparison is like with like — its OWN median against the street
 * medians inside its ring, over the SAME window (the map's, ending at the
 * moment shown). The old line set its latest hour against 90-day street p90s
 * ("up to 5.3× its own number"), which read as grading DRAQA's instrument; a
 * disagreement between a reference monitor and the streets is jointly owned,
 * never a finding against the monitor.
 */
function MonitorDetail({
  id, net, tower, row, windowStreets, streetsFailed, streets, at, measure, measureCode, siteName, now,
  onBack,
}: {
  id: string
  net: RegulatorNetwork | undefined
  tower: Monitor | null
  row: RegulatorNetworkMonitor | null
  /** The map's coloured streets: the window, to `at`. */
  windowStreets: SegmentCollection | undefined
  /** They failed to load and none are on screen. */
  streetsFailed: boolean
  streets: StreetsWindow
  at: CampaignTime
  measure: MeasureDef | undefined
  measureCode: MeasureCode
  siteName: (id: string) => string
  now: CampaignTime
  onBack: () => void
}) {
  const label = measure ? shortName(measure) : measureCode.toUpperCase()
  const unit = unitFor(measure)
  const dec = measure?.decimals ?? 1
  const carries = row?.has_measure ?? tower?.measures.includes(measureCode) ?? false

  // The monitor over the streets' window: after `at − hours` up to `at`
  // (a minute in, so the reading AT the start, which the window excludes,
  // is not counted), or from the start of the data for "To date". Never past
  // the moment shown: in replay the rest is the future.
  const hours = api.STREETS_WINDOW_HOURS[streets]
  const dataStart = useSession((x) => x.time.bounds?.start ?? null)
  const winFrom = hours != null ? addHours(at, -hours + 1 / 60) : dataStart
  const winQ = useMonitorReadings(id, {
    // 90 days of hours is ~2,160 rows, over the server's default 2,000.
    measure: measureCode, from: winFrom ?? undefined, to: at, interval: 'hour', limit: 5000,
  }, {
    enabled: carries && !!winFrom,
    // A step of the clock keeps the previous median on screen (TIMED); a
    // change of pollutant or of window does not — under the new label it
    // was the other pollutant's, or the other window's, median.
    placeholderData: keepReadingsWhile(id, measureCode, winFrom, at),
  })
  const towerMedian = useMemo(
    () => median((winQ.data?.points ?? []).flatMap((p) => (p.v == null ? [] : [p.v]))),
    [winQ.data],
  )
  const ring = useMemo(() => (tower ? streetsInRing(windowStreets?.features, tower) : []), [tower, windowStreets])
  const ringVals = useMemo(
    () => ring.flatMap((f) => (f.properties.value == null ? [] : [f.properties.value])).sort((a, b) => a - b),
    [ring],
  )

  // The 24-hour shape: the monitor's whole record, and the street in its ring
  // the fleet drove most in the window — well measured, and its own 90-day
  // fingerprint is what the detail endpoint returns.
  const longWin = useStableWindow(24 * 90, 60)
  const longQ = useMonitorReadings(id, {
    measure: measureCode, from: longWin.from, to: longWin.to, interval: 'hour', limit: 5000,
  }, { enabled: carries })
  const busiest = useMemo(
    () => [...ring].sort((a, b) => b.properties.n_passes - a.properties.n_passes
      || (b.properties.value ?? 0) - (a.properties.value ?? 0))[0] ?? null,
    [ring],
  )
  // Bounded by the moment shown, so its shape holds no pass after the clock.
  const streetQ = useSegmentDetail(busiest?.properties.id ?? null, { enabled: carries }, { at })
  const towerHours = useMemo(() => toDiurnal24(longQ.data?.points), [longQ.data])
  const streetHours = useMemo(
    () => toDiurnal24(streetQ.data?.diurnal?.[measureCode]),
    [streetQ.data, measureCode],
  )
  const towerPeak = peakOf(towerHours)
  const streetPeak = peakOf(streetHours)
  const shared = useMemo<[number, number] | undefined>(() => {
    const all = [...towerHours, ...streetHours].filter((v): v is number => v != null)
    return all.length ? [0, Math.max(...all) * 1.05] : undefined
  }, [towerHours, streetHours])

  const calQ = useCalibration()
  const channel = calQ.data?.channels.find((c) => c.code === measureCode) ?? null

  const name = tower?.name ?? row?.name ?? id
  const shares = (row?.plume_share ?? []).filter((p) => p.inside_pct > 0 || p.beyond_pct > 0)

  return (
    <div className={s.detail}>
      <DetailHead
        title={name}
        sub={tower ? `DRAQA reference monitor · ${tower.status}${tower.radius_m ? ` · ${fmtDistance(tower.radius_m, 1)} ring` : ''}` : null}
        onBack={onBack}
      />

      <Fact k={`${label} now`}>
        {!carries ? (
          <span className={s.mute}>no {label} channel on this monitor</span>
        ) : row?.reading ? (
          <>
            <b className={`${s.factNum}${row.over ? ` ${s.overInk}` : ''}`}>{fmtNum(row.reading.value, dec)}</b>
            {unit ? ` ${unit}` : ''} at {fmtTime24(row.reading.ts)}
            {row.level ? (
              // The level by name, every time: the highest 1-hour level the
              // reading exceeds, else the tightest (D15) — at Aug 25 06:00
              // "1.21× the NO2 1-hour standard (100 ppb)", the level the
              // headline names; below both, "0.18× the NO2 1-hour watch level".
              <span className={s.factNote}>
                {row.level.ratio != null ? `${fmtNum(row.level.ratio, 2)}× ` : ''}the {levelPhrase(row.level.name)}
                {' '}({fmtNum(row.level.threshold, Number.isInteger(row.level.threshold) ? 0 : dec)}{unit ? ` ${unit}` : ''})
                {row.over ? <span className={s.overInk}> · over it</span> : null}
              </span>
            ) : null}
          </>
        ) : (
          <span className={s.mute}>no reading in the 2 h before {net ? fmtTime24(net.at) : 'the moment shown'}</span>
        )}
      </Fact>

      {carries ? (
        // One window for both sides: the monitor's hours and the streets'
        // passes, each ending at the moment shown — no "whole day" caveat.
        <Fact k={`Same window · ${windowPhrase(streets, at)}`}>
          {ringVals.length ? (
            <RingStrip values={ringVals} marker={towerMedian} decimals={dec} unit={unit} />
          ) : null}
          <span>
            Monitor median{' '}
            <b className={`${s.factNum} ${s.towerInk}`}>{towerMedian == null ? '—' : fmtNum(towerMedian, dec)}</b>
            {ringVals.length ? (
              <>
                {' · '}{fmtNum(ringVals.length, 0)} {ringVals.length === 1 ? 'street' : 'streets'} in its ring
                {' '}
                <b className={s.factNum}>
                  {fmtNum(ringVals[0], dec)}–{fmtNum(ringVals[ringVals.length - 1], dec)}
                </b>
                {unit ? ` ${unit}` : ''}
              </>
            ) : windowStreets
              ? ' · no street in its ring was driven in this window'
              : streetsFailed ? ' · streets unavailable' : ' · reading streets…'}
          </span>
          <span className={s.factNote}>Median of each, highlighted on the map.</span>
        </Fact>
      ) : null}

      <Fact k="Calibration">
        {calibrationLine(channel, id, label, now)}
      </Fact>

      {row?.in_plume.length ? (
        <Fact k={`Modelled at ${fmtTime24(net?.at ?? now)}`} model>
          {row.in_plume.map((p, i) => (
            <span key={p.site_id}>
              {i ? '; ' : ''}
              {p.part === 'inside'
                ? `inside ${siteName(p.site_id)}’s plume`
                : `under ${siteName(p.site_id)}’s plume beyond measurement range — model only`}
            </span>
          ))}
        </Fact>
      ) : null}

      {/* The whole record, not the week and not up to the moment shown: in
          replay it counts hours the cursor has not reached yet. */}
      <Fact k="Hours in a modelled plume · whole campaign" model>
        {shares.length ? shares.map((p) => (
          <span key={p.site_id} className={s.shareRow}>
            <span className={s.shareSite}>{siteName(p.site_id)}</span>
            <span>
              {p.inside_pct > 0 ? <><span className={s.factNum}>{fmtNum(p.inside_pct, 1)}%</span> within range</> : null}
              {p.inside_pct > 0 && p.beyond_pct > 0 ? ' · ' : null}
              {p.beyond_pct > 0 ? <><span className={s.factNum}>{fmtNum(p.beyond_pct, 1)}%</span> beyond — model only</> : null}
            </span>
          </span>
        )) : <span className={s.mute}>{row ? 'no site’s modelled plume reached it in this record' : '—'}</span>}
        {net?.basis ? <span className={s.factNote}>{net.basis}</span> : null}
      </Fact>

      {carries ? (
        <Fact k="24-hour shape">
          {towerPeak || streetPeak ? (
            <>
              <div className={s.clocks}>
                <DiurnalClock
                  points={towerHours}
                  size={132}
                  showTable={false}
                  measure={measure ?? null}
                  domain={shared}
                  ramp="intensity"
                  subtitle="Monitor · 90 days"
                />
                <DiurnalClock
                  points={streetHours}
                  size={132}
                  showTable={false}
                  measure={measure ?? null}
                  domain={shared}
                  ramp="intensity"
                  subtitle={streetQ.data?.name ?? busiest?.properties.name ?? 'Street in its ring'}
                />
              </div>
              {towerPeak && streetPeak ? (
                <span className={s.factNote}>
                  Peak hour over the daily median: monitor {fmtNum(towerPeak.ratio, 2)}×, street{' '}
                  {fmtNum(streetPeak.ratio, 2)}×. One scale for both.
                </span>
              ) : null}
            </>
          ) : (
            <span className={s.mute}>{longQ.isPending || streetQ.isPending ? 'Reading…' : 'not enough hours to draw'}</span>
          )}
        </Fact>
      ) : null}

      {/* Labelled with `exceedance_level`, the tightest 1-hour level the
          hours are counted against — never with `level`, which is the
          highest level THIS reading exceeds and moves with it. Riverport
          Road at Aug 25 06:00: "4 h over the 1-hour watch level" under
          "1.21× the NO2 1-hour standard"; at the end, "10 h over the 1-hour
          watch level". */}
      <Fact k="Last 7 days">
        {row
          ? !row.has_measure
            ? <span className={s.mute}>no {label} channel</span>
            : row.exceedance_hours_7d
              ? (
                <>
                  <b className={`${s.factNum} ${s.overInk}`}>{fmtNum(row.exceedance_hours_7d, 0)} h</b>
                  {' '}over {row.exceedance_level
                    ? `the ${levelPhrase(levelWords(row.exceedance_level.name))}`
                    : 'its tightest 1-hour level'}
                </>
              )
              : row.exceedance_level
                ? `not over the ${levelPhrase(levelWords(row.exceedance_level.name))}`
                // Ozone, CO: no 1-hour level exists, so nothing was counted —
                // "no hour over" would read as a clean week.
                : <span className={s.mute}>no 1-hour level to count against</span>
          : '—'}
        {' · '}<Link to="/regulator/alerts" className={s.inlineLink}>Alerts</Link>
      </Fact>

      {/* The duty-cycle case, conceded (PLAN-plume never-say: "Aclima
          replaces stationary monitoring"). Said once, here, in words. */}
      <p className={s.note}>
        A reference monitor reads every hour at one place; the fleet reads each street only while it
        drives it. Between them: the hour, and the street.
      </p>
    </div>
  )
}

/**
 * The anchor for the fleet's channel, as a statement about the network. A
 * channel no reference instrument carries is "no reference anchor exists in
 * this campaign" — never "uncalibrated", which would be a claim about the
 * sensor or about the agency's diligence.
 */
function calibrationLine(
  channel: { anchored: boolean; anchors: { monitor_id: string; name: string; last_calibrated: string | null }[] } | null,
  monitorId: string,
  label: string,
  now: CampaignTime,
): ReactNode {
  if (!channel) return <span className={s.mute}>—</span>
  if (!channel.anchored) return `No reference anchor exists in this campaign for ${label}.`
  const mine = channel.anchors.find((a) => a.monitor_id === monitorId)
  const seen = (t: string | null) => (t && campaignMs(t) <= campaignMs(now) ? t : null)
  if (mine) {
    const last = seen(mine.last_calibrated)
    return `The fleet’s ${label} is anchored to this monitor${last ? ` · last ${fmtDay(last)}` : ''}.`
  }
  return `The fleet’s ${label} is anchored to ${channel.anchors.map((a) => a.name).join(', ')}.`
}

/**
 * Each street's median as a tick on one axis, and the monitor's as a taller
 * mark: same window, same statistic, drawn so the spread is seen, not scored.
 */
function RingStrip({
  values, marker, decimals, unit,
}: { values: number[]; marker: number | null; decimals: number; unit: string }) {
  const lo = Math.min(values[0], marker ?? values[0])
  const hi = Math.max(values[values.length - 1], marker ?? values[values.length - 1])
  const span = hi - lo || 1
  const x = (v: number) => 4 + ((v - lo) / span) * 92
  return (
    <svg
      className={s.strip}
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Streets ${fmtNum(values[0], decimals)} to ${fmtNum(values[values.length - 1], decimals)}${unit ? ` ${unit}` : ''}; monitor ${marker == null ? 'no value' : fmtNum(marker, decimals)}`}
    >
      <line x1="4" x2="96" y1="12" y2="12" className={s.stripAxis} />
      {values.map((v, i) => (
        <line key={i} x1={x(v)} x2={x(v)} y1="7" y2="17" className={s.stripTick} />
      ))}
      {marker != null ? <line x1={x(marker)} x2={x(marker)} y1="2" y2="20" className={s.stripMark} /> : null}
    </svg>
  )
}

// ──────────────────────────────────────────────────────────── plume detail

/**
 * A site's modelled plume at the moment shown, and its MEASURED downwind
 * test. Figures for the test are printed only when it is `elevated_downwind`
 * (it passed the rotation check); every other state is a sentence. Nothing
 * past 4,200 m is printed as a result.
 */
function PlumeDetail({
  plume, siteName, net, streetsReady, streetsPhrase, emptyLine, measure, measureCode, onBack,
  onPickMonitor,
}: {
  plume: RegulatorNetworkPlume | null
  siteName: string
  net: RegulatorNetwork | undefined
  /** The payload on screen is for the window shown, so its street figures may print. */
  streetsReady: boolean
  /** "7 days to Aug 25 06:00": the window the streets are counted over. */
  streetsPhrase: string
  /** Set when the window holds no pass. */
  emptyLine: string | null
  measure: MeasureDef | undefined
  measureCode: MeasureCode
  onBack: () => void
  onPickMonitor: (id: string) => void
}) {
  const label = measure ? shortName(measure) : measureCode.toUpperCase()
  const unit = unitFor(measure)
  const elevated = plume?.touchdown_state === 'elevated_downwind'
  const tdQ = useTouchdown(plume?.site_id, { measure: measureCode }, { enabled: !!plume && elevated })
  const td = tdQ.data?.site
  const monitors = net?.monitors ?? []
  const nameOf = (id: string) => monitors.find((m) => m.id === id)?.name ?? id
  const clusters = net?.residents ?? []

  if (!plume) {
    return (
      <div className={s.detail}>
        <DetailHead title={siteName} onBack={onBack} />
        <p className={s.note}>{net ? 'No modelled plume for this site at the moment shown.' : 'Reading the model…'}</p>
      </div>
    )
  }
  const truncatedReach = plume.reach_m > plume.envelope_m
  const t = plume.touches
  // Too few streets under the outline, or too few of them driven: each said as itself.
  const cannotSay = plumeCoverageLine(plume)
  return (
    <div className={s.detail}>
      <DetailHead
        title={plume.name}
        sub={`Modelled for ${net ? fmtTime24(net.at) : '—'} · stability ${plume.stability} · carried toward ${compassPoint(plume.bearing_deg)}`}
        onBack={onBack}
      />

      <Fact k="Reach" model>
        measurable to <b className={s.factNum}>{fmtDistance(Math.min(plume.reach_m, plume.envelope_m), 1)}</b>
        {truncatedReach ? (
          <>
            {'; drawn on to '}{fmtDistance(plume.reach_m, 1)}
            <span className={s.factNote}>Past {fmtDistance(plume.envelope_m, 1)}: {BEYOND_ENVELOPE_NOTE}.</span>
          </>
        ) : null}
      </Fact>

      <Fact k="Monitors inside" model>
        {t.monitor_ids.length ? t.monitor_ids.map((id, i) => (
          <span key={id}>
            {i ? ', ' : ''}
            <button type="button" className={s.inlineLink} onClick={() => onPickMonitor(id)}>{nameOf(id)}</button>
          </span>
        )) : <span className={s.mute}>none inside the solid part</span>}
      </Fact>

      {/* The street window: the streets the map colours, counted inside
          the solid part of this outline. */}
      <Fact k={`Streets · ${streetsPhrase}`}>
        {!streetsReady
          ? <span className={s.mute}>Reading streets…</span>
          : emptyLine
            ? `${emptyLine}.`
            : cannotSay
              ? `${cannotSay.charAt(0).toUpperCase()}${cannotSay.slice(1)}.`
              : (
                <>
                  <b className={s.factNum}>{fmtNum(t.streets_driven, 0)}</b> driven inside it
                  {' · '}{fmtNum(plume.driven_share * 100, 0)}% of its streets
                </>
              )}
      </Fact>

      {t.open_cluster_ids.length ? (
        <Fact k="Resident clusters inside" model>
          {t.open_cluster_ids.map((id) => clusters.find((c) => c.cluster_id === id)?.label ?? id).join('; ')}
        </Fact>
      ) : null}

      <Fact k={`Measured downwind test · ${label}`}>
        {elevated && td && td.excess != null && td.r_hi_m <= REPORTABLE_M ? (
          <>
            <span>
              <b className={s.factNum}>+{fmtNum(td.excess, 2)}</b>{unit ? ` ${unit}` : ''}
              {td.ci_lo != null && td.ci_hi != null ? ` (${fmtNum(td.ci_lo, 2)} to ${fmtNum(td.ci_hi, 2)})` : ''}
              {' over '}{fmtNum(td.n_hours, 0)} h, {fmtDistance(td.r_lo_m, 1)}–{fmtDistance(td.r_hi_m, 1)} downwind
            </span>
            <span className={s.factNote}>
              {touchdownSentence(plume.touchdown_state)}
              {td.placebo_ratio != null ? ` (rotated bearings reached ${fmtNum(td.placebo_ratio, 2)} of it)` : ''}.
            </span>
          </>
        ) : elevated && tdQ.isPending ? (
          <span className={s.mute}>Reading…</span>
        ) : (
          <span>{capitalise(touchdownSentence(plume.touchdown_state))}.</span>
        )}
      </Fact>
    </div>
  )
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

// ────────────────────────────────────────────────────────── cluster detail

/**
 * A resident cluster and its reports. The regulator can move a report to
 * "under review"; closing one is the agency's or Aclima's alone, and an
 * operator's reply moves it no further than "mitigation proposed".
 */
/** Statuses "Mark under review" still moves forward from. */
const BEFORE_REVIEW: ReadonlySet<ConcernStatus> = new Set(['new', 'corroborated'])

/**
 * A replayed report's status at the end of the data, when the server sends it
 * beside the replayed `status` (`status_at_end`, as on alerts). Read through a
 * widened type so the page compiles on either side of that field landing in
 * core/types; null when it is not sent.
 */
function reportStatusAtEnd(c: Concern): ConcernStatus | null {
  return c.status_at_end ?? null
}

function ClusterDetail({
  id, report, row, insideNow, at, siteName, now, onBack, onReport,
}: {
  id: string
  report: string | null
  row: RegulatorNetworkResident | null
  insideNow: (r: RegulatorNetworkResident) => boolean
  /** The moment the network payload is for. */
  at: CampaignTime
  siteName: (id: string) => string
  now: CampaignTime
  onBack: () => void
  onReport: (id: string) => void
}) {
  const concernsQ = useConcerns({ limit: 400 })
  const clustersQ = useConcernClusters()
  const setStatus = useUpdateConcernStatus()
  // A status change is stamped at the end of the data, and each report's
  // status arrives as it stood at `at` (server/statusat.py), so a change made
  // in replay would not show at the moment on screen and the button would
  // stay pressable. In replay the reader is sent to the end to make it.
  const replaying = useSession((x) => x.time.cursor != null)
  const setTimeCursor = useSession((x) => x.setTimeCursor)
  const asOf = useMemo(() => reportsAsOf(concernsQ.data, clustersQ.data, now), [concernsQ.data, clustersQ.data, now])
  const cluster = asOf.clusters.find((c) => c.id === id) ?? null
  const members = useMemo(
    () => asOf.concerns.filter((c) => c.cluster_id === id)
      .sort((a, b) => campaignMs(b.occurred_at) - campaignMs(a.occurred_at)),
    [asOf, id],
  )
  const picked = report ? members.find((c) => c.id === report) ?? null : null
  // Sent to the end only if the report can still be marked there. Replay
  // walks a report back, so one 'corroborated' at the moment shown may be
  // under review or closed by the end, where the sheet offers no such step.
  // Workflow only moves forward: without the end status, one already past
  // 'corroborated' now is past it at the end too.
  const endStatus = picked ? reportStatusAtEnd(picked) : null
  const markableAtEnd = picked ? BEFORE_REVIEW.has(endStatus ?? picked.status) : false
  const title = row?.label ?? cluster?.label ?? 'Resident cluster'
  const count = row?.count ?? cluster?.count ?? members.length
  const kinds = row?.kinds ?? cluster?.kinds ?? []

  return (
    <div className={s.detail}>
      <DetailHead
        title={title}
        sub={`${fmtNum(count, 0)} ${count === 1 ? 'report' : 'reports'}${kinds.length ? ` · ${kinds.join(', ')}` : ''}`}
        onBack={onBack}
      />

      <Fact k="Site">
        {row?.named_site_id ? (
          <>
            {`Most of its reports were filed downwind of ${siteName(row.named_site_id)}, and that site’s downwind excess passed the rotation check.`}
            <span className={s.factNote}>
              {insideNow(row)
                ? `At ${fmtTime24(at)} the cluster is inside that site’s modelled plume.`
                : `At ${fmtTime24(at)} it is outside that site’s modelled plume within measurement range.`}
            </span>
          </>
        ) : 'None named: the wind at the time and a passed downwind test have to agree before one is.'}
      </Fact>

      {cluster ? (
        <Fact k="When">
          first {fmtDay(cluster.first_at)} {fmtTime24(cluster.first_at)} · last {relativeTime(cluster.last_at, now)}
        </Fact>
      ) : null}

      <div className={s.reportList}>
        {members.slice(0, 8).map((c) => (
          <button
            key={c.id}
            type="button"
            className={`${s.item}${c.id === report ? ` ${s.itemOn}` : ''}`}
            onClick={() => onReport(c.id)}
          >
            {/* Severity as "3/5", muted: in the count style a bare "3" read
                as three reports. */}
            <span className={`${s.itemGlyph} ${s.mute}`} title="Resident's severity, out of 5">{c.severity}/5</span>
            <span className={s.itemName}>{c.title}</span>
            <span className={`${s.itemValue} ${s.mute}`}>{relativeShort(c.occurred_at, now)}</span>
          </button>
        ))}
        {members.length > 8 ? <p className={s.note}>and {members.length - 8} more</p> : null}
      </div>

      {picked ? (
        <div className={s.quoteBlock}>
          <span className={s.factNote}>
            {picked.kind} · severity {picked.severity}/5 · {picked.status.replace(/_/g, ' ')}
            {picked.corroborations ? ` · ${picked.corroborations} corroborated` : ''}
          </span>
          {picked.body ? <p className={s.quote}>“{picked.body}”</p> : null}
          {replaying && !markableAtEnd ? null : <div className={s.actions}>
            {replaying ? (
              <Button size="sm" variant="secondary" onClick={() => setTimeCursor(null)}>
                Go to the end of the data
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={picked.status === 'under_review' || setStatus.isPending}
                onClick={() => setStatus.mutate({ id: picked.id, status: 'under_review', actorRole: 'regulator' })}
              >
                Mark under review
              </Button>
            )}
          </div>}
          {replaying ? (
            <span className={s.factNote}>
              {`Its status as of ${fmtDay(now)} ${fmtTime24(now)}. ${
                markableAtEnd
                  ? 'A change is stamped at the end of the data, so it is made from there.'
                  : endStatus
                    ? `By the end of the data it is ${endStatus.replace(/_/g, ' ')}, so there is nothing left to mark.`
                    : `It was already ${picked.status.replace(/_/g, ' ')} then, so there is nothing left to mark.`
              }`}
            </span>
          ) : null}
          <span className={s.factNote}>
            Only DRAQA or Aclima can close a resident’s report. An operator’s reply moves it to
            “mitigation proposed” and no further.
          </span>
        </div>
      ) : members.length ? (
        <p className={s.note}>Pick a report to read it.</p>
      ) : null}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────── swatches

/**
 * The model registers, drawn from the same stroke table the layers read
 * (`PLUME_STROKE`), so the key cannot drift from the marks it explains.
 */
function StrokeSwatch({ register }: { register: 'model' | 'beyond' | 'filed' }) {
  const st = PLUME_STROKE[register]
  const dash = st.dash ? st.dash.map((d) => d * st.width).join(' ') : undefined
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden>
      <line
        x1="1" y1="5" x2="21" y2="5"
        stroke={`var(--${st.token})`} strokeOpacity={st.alpha} strokeWidth={st.width}
        strokeDasharray={dash} strokeLinecap={register === 'filed' ? 'round' : 'butt'}
      />
    </svg>
  )
}

/** The veil over ground the fleet did not drive: a dimmed patch. */
function MaskSwatch() {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10" aria-hidden>
      <rect x="1" y="1" width="20" height="8" fill="var(--bg-sunk)" stroke="var(--line-strong)" strokeWidth="1" />
    </svg>
  )
}
