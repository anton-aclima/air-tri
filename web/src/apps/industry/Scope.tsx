/**
 * /industry — the deck: a map, one line of status, and one narrow side panel.
 *
 * The owner's words (2026-09-23): "Deck seems to have lost the map view? It
 * only has the rwr inspired quick view, which I honestly think might not be
 * necessary if the map view can tell the story", and "too busy — the Industry
 * alert header for example". The core message is "maximise performance within
 * responsible environmental constraints"; "verify your consultant" supports it.
 *
 *   · the LINE leads with the operating answer, for every site, then the
 *     reason — "Hold near 210 MW (modelled) until ~06:00 · stable air ·
 *     running 268 MW"; a site with no MW rating is answered against its
 *     normal operations ("No cut needed at current activity (modelled)"). It
 *     never reads a calm "no cut" over what the envelope cannot see: the
 *     site's own fence sensors over a level now, or a reference monitor the
 *     F7 rule ties to this site that crossed a level this week. Those are
 *     said in the line, and its tone follows the worst.
 *   · the MAP tells the story on its own: measured streets (the only filled
 *     ink), the fenceline road the envelope is measured on, the fleet's wind
 *     moving over it, today's plume as a hairline outline with its axis, the
 *     campus and its stacks, the fence sensors, and the reference monitors by
 *     name — lit only when inside the SOLID part of today's plume. Every mark
 *     that carries the story is in the legend.
 *   · the PANEL holds "now" (the air, the fence, a linked monitor), a typical
 *     day (the envelope by hour), one Downwind list, and turns into the detail
 *     of whatever is picked on the map — or the "About this map" notes, which
 *     live here so they never cover the campus.
 *
 * Retired here (D8): the RWR dial, the range rings and bearing lines, the
 * dashed plume-track line, the alert-history strip, the gauges and the
 * "model understates" strip. The avionics survive as finish only — mono
 * numerals, the phosphor accent, square corners — never as words.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import {
  BEYOND_ENVELOPE_NOTE, BaseMap, DispersionLayer, FiledStudyLayer, MapOverlay, MapWindField,
  MonitorLayer, PLUME_STROKE, SegmentLayer, SiteLayer, bboxCenter, bboxOfPositions, fitZoom,
  makeColorScale, measureDomain, metersPerPixel, pickedSite, REPORT_WINDOW_DAYS, useSize, windowReports,
} from '@/components'
import type { MapView, SegmentFeature, Theme } from '@/components'
import { Popover, Toggle } from '@/app/ui'
import { INDUSTRY_NEAR_M, useLiveAlerts } from '@/core/alerts'
import { addHours, hoursBetween } from '@/core/clock'
import { happenedBy, isOngoing, isRecent } from '@/core/events'
import { compassPoint, fmtCompact, fmtDay, fmtDistance, fmtNum, fmtTime24 } from '@/core/format'
import { SEVERITY_LABEL, severityRank, severityVar, shortName, unitFor } from '@/core/measures'
import {
  useActionLevels, useActiveMeasure, useAlerts, useConcernClusters, useConcerns, useDispersion,
  useDispersionModels, useEnvelope, useMeasures, useModelVerification, useMonitors, useOrgs,
  useSegments, useWind, useWindField,
} from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type { CampaignTime } from '@/core/clock'
import type { MeasureCode, Position, Severity } from '@/core/types'

import { EnvelopeBand } from './EnvelopeBand'
import { Selected } from './Selected'
import type { MapPick } from './Selected'
import {
  REPORTABLE_M, Tag, alertLinked, alertMarkers, alertSentence, alertWhere, bboxAround, bearingFrom,
  clusterLinked, crossingClause, downwindCrossing, envelopeByHour, envelopeLine, fenceClause, fenceNow,
  fencelineCasing, fencelineLabel, foldEpisodes, insidePlume, levelName, placeReports, plumeFacts,
  plumeFitPositions, plumeHasBeyond, regimeOf, regimeWord, reportLinked, reportsOverlay, styles as s,
  nextHold, toNearAlerts, typicalUntil, useCampaignWindow, useDownwindTests, useSiteLock, useStableWindow,
  wasDownwindAtStart,
} from './lib'
import type { AlertContext, NearAlert } from './lib'

/**
 * How far out the deck lists alerts — the room's reach, shared with the count
 * (`INDUSTRY_NEAR_M`, core/alerts) so the two cannot disagree. Not 6 km:
 * DRAQA's Riverport Road monitor is 6.27 km from Ridgeline's centroid, and it
 * is the monitor the review's example row names. It sits under "Elsewhere"
 * unless the wind was carrying this way when it tripped — the order, not the
 * radius, keeps it off the top.
 */
const NEAR_M = INDUSTRY_NEAR_M
/** The list's window: ongoing, or begun in the last week at the moment shown. */
const RECENT_H = 24 * 7

/** The camera when there is no plume to fit, and the fit's limits. */
const HOME_ZOOM = 12.5
const FIT_MIN_ZOOM = 11
const FIT_MAX_ZOOM = 14

interface Shown { grid: boolean; wind: boolean; plume: boolean; reports: boolean; filed: boolean }

/** One key per episode — the same key `foldEpisodes` folds on. */
const episodeKey = (c: NearAlert) => {
  const where = c.alert.source_id ?? `${c.bearing.toFixed(0)}|${c.distance.toFixed(0)}`
  return `${where}|${c.alert.measure ?? c.alert.kind}|${c.alert.started_at.slice(0, 10)}`
}

/**
 * The camera that fits `points` into the part of the map the furniture does
 * not cover: the bar across the top, the legend at the bottom left.
 */
function fitView(
  points: Position[], size: { width: number; height: number }, reserve: { top: number; bottom: number },
): MapView | null {
  if (points.length < 2 || size.width < 50 || size.height < 50) return null
  const b = bboxOfPositions(points)
  const side = 36
  const w = Math.max(160, size.width - side * 2)
  const h = Math.max(160, size.height - reserve.top - reserve.bottom)
  const zoom = Math.max(FIT_MIN_ZOOM, Math.min(FIT_MAX_ZOOM, fitZoom(b, w, h, 0)))
  const [cx, cy] = bboxCenter(b)
  // Put the box's centre in the middle of the free area, not of the canvas.
  // `metersPerPixel` is on 256-px tiles; the map (and `fitZoom`) is on 512-px
  // ones, so one zoom level up is this map's scale — without it the shift was
  // doubled and a stable night's plume ran off the top again.
  const shiftPx = (reserve.bottom - reserve.top) / 2
  const lat = cy - (shiftPx * metersPerPixel(cy, zoom + 1)) / 110540
  return { longitude: cx, latitude: lat, zoom, pitch: 0, bearing: 0 }
}

export function Scope() {
  const site = useSiteLock()
  const now = useNowCampaign()
  const playing = useSession((x) => x.time.playing)
  // THE count, shared with the nav badge (core/alerts): one number per room.
  const live = useLiveAlerts('industry')

  const alertsQ = useAlerts({ site_id: site?.id }, { enabled: !!site })
  // "Fleet-measured wind, last 72 h": the field binned from the fleet's own
  // anemometers. Three days at a 400 m cell already fills the same 729 cells
  // around the campus as the two weeks this used to ask for.
  const fieldQ = useWindField({ cell_m: 400, ...useStableWindow(72) })
  // Fifteen days of hourly wind (360 rows), ending at the moment shown: the
  // latest row is the air of the moment, and the rest is "the wind when it
  // began" for every alert on the list (RECENT_H, a week) and every report on
  // the map (REPORT_WINDOW_DAYS, a fortnight), with a day's slack.
  const windQ = useWind(useStableWindow(24 * (REPORT_WINDOW_DAYS + 1)))
  const wind = windQ.data?.[windQ.data.length - 1]

  // The campaign's weather, for the typical day. Two halves because `/wind`
  // caps a response at 2,000 rows and the campaign is 2,160 hours — one call
  // silently lost the last week, which is the week the alerts are in.
  const campaignWin = useCampaignWindow()
  const halves = useMemo(() => {
    if (!campaignWin) return null
    const mid = addHours(campaignWin.from, 24 * 45)
    return [
      { from: campaignWin.from, to: addHours(mid, -1 / 60) },
      { from: mid, to: campaignWin.to },
    ]
  }, [campaignWin])
  const metA = useWind(halves?.[0] ?? {}, { enabled: !!halves })
  const metB = useWind(halves?.[1] ?? {}, { enabled: !!halves })

  const modelsQ = useDispersionModels(site?.id)
  const verifyQ = useModelVerification(site?.id, campaignWin ?? {}, {
    enabled: !!site?.id && !!campaignWin,
  })
  const envQ = useEnvelope(site?.id)
  const env = envQ.data
  const plumeQ = useDispersion({ site_id: site?.id, outline: true })
  const facts = plumeFacts(plumeQ.data)
  // F7's (b), per pollutant that has a calibrated downwind test. Reports take
  // the plume's own species; an alert takes its own pollutant.
  const tested = useDownwindTests(site?.id)
  const tdState = tested[facts?.measure ?? 'no2']
  const levelsQ = useActionLevels()

  const monitorsQ = useMonitors()
  const orgs = useOrgs()
  const measureDef = useActiveMeasure()
  /**
   * Every measure, not `useMeasures('modality')` like the other three apps.
   * The indicators are *derived source apportionment* — diesel vs non-diesel
   * combustion, methane excess over background — and an operator who runs
   * trucks and a gas line is the one reader for whom those are the interesting
   * lenses rather than analyst furniture.
   */
  const measures = useMeasures()
  const setMeasure = useSession((x) => x.setMeasure)

  const [shown, setShown] = useState<Shown>({
    grid: true, wind: true, plume: true, reports: true,
    // Off by default (D9): "verify your consultant" is a supporting visual.
    filed: false,
  })
  const toggle = (k: keyof Shown) => (v: boolean) => setShown((p) => ({ ...p, [k]: v }))
  const [pick, setPickState] = useState<MapPick | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const setPick = useCallback((p: MapPick | null) => {
    setPickState(p)
    if (p) setAboutOpen(false)
  }, [])
  const [hoverId, setHoverId] = useState<string | null>(null)
  // A muted monitor (not under today's plume) carries its name only while
  // hovered or selected, so the map is not four labels saying "not this one".
  const [hoverMonitor, setHoverMonitor] = useState<string | null>(null)
  const [layersOpen, setLayersOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const layersBtn = useRef<HTMLButtonElement>(null)
  const [mapRef, mapSize] = useSize<HTMLDivElement>({ width: 720, height: 720 })
  const [legendRef, legendSize] = useSize<HTMLDivElement>({ width: 260, height: 160 })

  // Only the streets around this site. The regulator wants the whole campaign;
  // an operator wants the blocks their plume actually crosses. Fetched even
  // with the grid hidden: the fenceline road is drawn from it.
  const bbox = useMemo(() => (site ? bboxAround(site.centroid, 9000) : null), [site])
  const segsQ = useSegments({ bbox, limit: 9000 }, { enabled: !!bbox })
  const fenceIds = useMemo(() => new Set(env?.fenceline_segment_ids ?? []), [env])
  const fenceSegs = useMemo(
    () => (segsQ.data?.features ?? []).filter((f) => fenceIds.has(f.properties.id)),
    [segsQ.data, fenceIds],
  )

  const fenceline = useMemo(
    () => (monitorsQ.data ?? []).filter((m) => m.site_id === site?.id),
    [monitorsQ.data, site],
  )
  const reference = useMemo(
    () => (monitorsQ.data ?? []).filter((m) => m.owner_type === 'regulator'),
    [monitorsQ.data],
  )
  // Lit only inside the SOLID part of today's plume, within 4,200 m — never
  // from the dashed part, where nothing is judged (CONTRACT §10b).
  const downwindIds = useMemo(
    () => reference.filter((m) => insidePlume(plumeQ.data, [m.lon, m.lat])).map((m) => m.id),
    [reference, plumeQ.data],
  )

  const alertCtx: AlertContext = useMemo(
    () => ({ monitors: monitorsQ.data ?? [], orgs, measures, siteId: site?.id ?? '' }),
    [monitorsQ.data, orgs, measures, site],
  )

  // The last fortnight by default, as on every map (components/lib/reports),
  // ending at the demo's now. Both lists are already cut at that moment by the
  // server (`at`), clusters included.
  const concernsQ = useConcerns({ limit: 400 })
  const clustersQ = useConcernClusters()
  const windowed = useMemo(
    () => windowReports(concernsQ.data ?? [], clustersQ.data ?? [], REPORT_WINDOW_DAYS, now),
    [concernsQ.data, clustersQ.data, now],
  )
  const reports = useMemo(
    () => (site ? placeReports(site.centroid, windowed.concerns, (c) => reportLinked(c, site.id, tdState)) : []),
    [site, windowed.concerns, tdState],
  )
  const nearClusters = useMemo(() => {
    if (!site) return []
    return windowed.clusters.filter(
      (cl) => bearingFrom(site.centroid, cl.centroid[0], cl.centroid[1]).distanceM <= 6000,
    )
  }, [windowed.clusters, site])

  /**
   * The Downwind list, in four groups.
   *
   *   1. Alerts the wind was carrying toward from this site when they BEGAN.
   *   2. "Found by Aclima's fleet": mobile detections on or beside this
   *      site's own fenceline road (D13) — a measurement on a street, which
   *      says what the road carried, not where it came from.
   *   3. "Elsewhere": the rest, folded shut. This is the rule that stops
   *      another operator's monitor headlining this deck.
   *
   * The ongoing rows ARE `live.alerts` — the room's one count, folded the way
   * the count folds — so the number printed equals the rows marked "now".
   * Ended rows are the last week's episodes within NEAR_M, minus any episode
   * an ongoing row already stands for. The study-vs-wind alert is a NOTICE
   * (`live.notices`, rule 4 in core/alerts): one line under the list, never a
   * "now" row, never in the count — it used to be counted and hidden, so the
   * deck read "1 ongoing" over rows none of which said "now".
   */
  const lists = useMemo(() => {
    const ongoing = toNearAlerts(live.alerts)
    const ongoingKeys = new Set(ongoing.map(episodeKey))
    const ended = foldEpisodes(toNearAlerts(happenedBy(alertsQ.data, now)).filter((c) => (
      c.sited && c.alert.kind !== 'wind_shift' && c.alert.source_type !== 'model' && c.distance <= NEAR_M
      && !isOngoing(c.alert, now) && isRecent(c.alert, now, RECENT_H)
    ))).alerts.filter((c) => !ongoingKeys.has(episodeKey(c)))
    const rows = [...ongoing, ...ended]
    const order = (a: NearAlert, b: NearAlert) => (
      Number(isOngoing(b.alert, now)) - Number(isOngoing(a.alert, now))
      || severityRank(b.alert.severity) - severityRank(a.alert.severity)
      || b.alert.started_at.localeCompare(a.alert.started_at)
    )
    const onFence = (c: NearAlert) => c.alert.source_type === 'mobile' && (
      (c.alert.source_id != null && fenceIds.has(c.alert.source_id))
      || c.distance <= (env?.fenceline_m ?? 0)
    )
    const siteWide = rows.filter((c) => !c.sited).sort(order)
    const placed = rows.filter((c) => c.sited)
    const fleet = placed.filter(onFence).sort(order)
    const rest = placed.filter((c) => !onFence(c))
    const downwind = rest.filter((c) => wasDownwindAtStart(c, windQ.data) === true).sort(order)
    const elsewhere = rest.filter((c) => wasDownwindAtStart(c, windQ.data) !== true).sort(order)
    const notices = toNearAlerts(live.notices)
    return { all: [...rows, ...notices], placed, downwind, fleet, siteWide, elsewhere, notices }
  }, [live.alerts, live.notices, alertsQ.data, now, fenceIds, env, windQ.data])

  // ── what the envelope cannot see ─────────────────────────────────────────
  const fence = useMemo(
    () => (site ? fenceNow(monitorsQ.data ?? [], site.id, levelsQ.data, now, env?.measure ?? 'no2', measures) : null),
    [site, monitorsQ.data, levelsQ.data, now, env, measures],
  )
  const crossing = useMemo(
    () => downwindCrossing(toNearAlerts(happenedBy(alertsQ.data, now)), alertCtx, windQ.data, tested, now),
    [alertsQ.data, alertCtx, windQ.data, tested, now],
  )
  const isAlertLinked = useCallback((c: NearAlert) => alertLinked(c, windQ.data, tested, (id) => {
    const cl = (clustersQ.data ?? []).find((x) => x.id === id)
    return !!cl && !!site && clusterLinked(cl, windowed.concerns, site.id, tdState)
  }), [windQ.data, tested, clustersQ.data, site, windowed.concerns, tdState])

  // The envelope for the air of the moment, and the typical day.
  // No regime until the hour's wind is in: `regimeOf` reads a missing class as
  // neutral, and the line would state "neutral air" for air it has not read.
  const regime = regimeOf(wind?.stability)
  const metRows = useMemo(() => [...(metA.data ?? []), ...(metB.data ?? [])], [metA.data, metB.data])
  const hours = useMemo(
    () => envelopeByHour(env, metRows, site?.capacity_mw),
    [env, metRows, site],
  )
  const nowHourRaw = Number(now.slice(11, 13))
  const nowHour = Number.isFinite(nowHourRaw) ? nowHourRaw : null
  const line = wind ? envelopeLine(env, regime, site?.capacity_mw, hours, nowHour) : null
  const clauses = useMemo(() => {
    const out: { text: string; severity: Severity }[] = []
    if (fence?.worst?.level) out.push({ text: fenceClause(fence.worst, measures), severity: fence.worst.level.severity })
    if (crossing) out.push({ text: crossingClause(crossing, measures), severity: crossing.severity })
    return out
  }, [fence, crossing, measures])
  // The tone follows the worst of the envelope, the fence and the monitor.
  const worstClause = clauses.reduce<Severity | null>(
    (w, c) => (!w || severityRank(c.severity) > severityRank(w) ? c.severity : w), null,
  )
  const tone = worstClause && severityRank(worstClause) >= severityRank('warning') ? 'alert'
    : worstClause || line?.tone === 'hold' ? 'hold'
      : line?.tone ?? 'unknown'

  const band = (
    <EnvelopeBand
      hours={hours}
      env={env}
      capacityMw={site?.capacity_mw}
      nowHour={nowHour}
      metHours={metRows.length}
    />
  )

  // ── the camera ───────────────────────────────────────────────────────────
  // Home FITS the solid part of today's plume, the fenceline road and the
  // campus into the part of the map the furniture leaves free. A constant
  // zoom let a stable night's 4 km inside part run off the top of the map at
  // 1080x900 and at 1680x1050. While playing, the fit holds still — a camera
  // that refits every hour is harder to read than a plume that swings.
  const fitPoints = useMemo(() => {
    if (!site) return []
    const pts: Position[] = [site.centroid, ...plumeFitPositions(plumeQ.data)]
    for (const f of fenceSegs) pts.push(...(f.geometry.coordinates as unknown as Position[]))
    return pts
  }, [site, plumeQ.data, fenceSegs])
  const reserve = useMemo(() => ({
    top: 52,
    bottom: Math.min(legendSize.height + 16, mapSize.height * 0.4),
  }), [legendSize.height, mapSize.height])
  const fitted: MapView | null = useMemo(() => {
    if (!site) return null
    return fitView(fitPoints, mapSize, reserve)
      ?? { longitude: site.centroid[0], latitude: site.centroid[1], zoom: HOME_ZOOM, pitch: 0, bearing: 0 }
  }, [site, fitPoints, mapSize, reserve])
  const [held, setHeld] = useState<{ siteId: string; view: MapView } | null>(null)
  // Derived state, set during render: the last fit made while NOT playing.
  if (!playing && fitted && site && (held?.siteId !== site.id || held.view !== fitted)) {
    setHeld({ siteId: site.id, view: fitted })
  }
  const home: MapView | null = playing && held && held.siteId === site?.id ? held.view : fitted
  const [moved, setMoved] = useState<{ siteId: string; view: MapView } | null>(null)
  /**
   * Only a gesture on the map counts as a pan. Measured: returning to the deck
   * from another industry page, the map reported a camera over the previous
   * persona's site shortly after mounting, with no input at all, and
   * "Re-centre" appeared over a map nobody had touched. Camera events before a
   * pointer, wheel or key on the map are the map settling, not the reader.
   */
  const gestured = useRef(false)
  const markGesture = () => { gestured.current = true }
  const view: MapView = (moved && moved.siteId === site?.id ? moved.view : home)
    ?? { longitude: -90.1479, latitude: 35.035, zoom: HOME_ZOOM, pitch: 0, bearing: 0 }
  const panned = !!home && !!moved && moved.siteId === site?.id && (
    Math.hypot(view.longitude - home.longitude, view.latitude - home.latitude) > 0.004
    || Math.abs(view.zoom - home.zoom) > 0.75
  )
  const handleView = useCallback((next: MapView) => {
    if (site && gestured.current) setMoved({ siteId: site.id, view: next })
  }, [site])
  const recentre = () => { gestured.current = false; setMoved(null) }

  /**
   * A measure with no unit is an *index*, not a concentration: its value is
   * already on 0-100 and has to be painted against that fixed scale. The grid's
   * default is a robust p2-p98 stretch, which is right for concentrations and
   * wrong for a score, where stretching a seven-point spread across the whole
   * ramp manufactures alarm out of air that is genuinely uniform.
   */
  const isIndex = measureDef?.unit === ''
  /**
   * No instrument carries an index as a channel, so `latest[code]` is undefined
   * on every monitor and every dot would drop silently to un-alarmed. Passing
   * `undefined` restores the any-pollutant fallback.
   */
  const dotMeasure = isIndex ? undefined : (measureDef?.code as MeasureCode | undefined)
  const gridScale = useCallback(
    (theme: Theme) => makeColorScale(theme, { domain: measureDomain(measureDef, segsQ.data), ramp: 'map' }),
    [measureDef, segsQ.data],
  )
  /**
   * The plume does NOT follow the pollutant picker, deliberately: the kernel
   * is run for one species per site. Named in the legend when it differs, or an
   * unlabelled plume beside a pollutant picker reads as the picker's output.
   */
  const plumeSpecies = useMemo(() => {
    const def = facts?.measure ? measures.find((m) => m.code === facts.measure) : undefined
    return def && def.code !== measureDef?.code ? shortName(def) : null
  }, [facts, measures, measureDef])
  const beyond = shown.plume && plumeHasBeyond(plumeQ.data)
  const model = modelsQ.data?.[0]
  const verify = verifyQ.data
  // One road by name; several as the first plus a count. Delta Forge has four,
  // and the full list ran off the map's left edge as a label.
  const roads = env?.fenceline_roads ?? []
  const fenceRoad = roads.length > 1 ? `${roads[0]} +${roads.length - 1}` : roads[0] ?? ''
  // On the map: the road's own name when there is one road, else just what it
  // is. "Channel Avenue +3 · your fenceline" sat on the basemap's Harbor Avenue.
  const fenceMapLabel = roads.length === 1 ? `${roads[0]} · your fenceline` : roads.length ? 'Your fenceline roads' : ''

  const selectedAlert = pick?.kind === 'alert' ? pick.id : null
  const layers = useCallback((theme: Theme) => [
    // The anchor goes UNDER the grid, so the road's measured colour stays the
    // only ink on it and the highlight reads as "this road", not a reading.
    ...fencelineCasing({ theme, segments: fenceSegs, selected: pick?.kind === 'fenceline' }),
    ...(shown.grid ? SegmentLayer({
      data: segsQ.data, theme, dualEncode: 'width', minPasses: 3,
      measure: measureDef?.code, scale: gridScale(theme),
    }) : []),
    ...(shown.filed ? FiledStudyLayer({ theme, contours: model?.contours }) : []),
    ...(shown.plume ? DispersionLayer({ data: plumeQ.data, theme, style: 'outline' }) : []),
    /* The campus goes UNDER its own instruments. deck picks the topmost
       layer, and the footprint is a polygon covering every fenceline sensor
       on it — drawn last, it swallowed their clicks. */
    // A neutral outline (keyed in the legend), no name and no badge: the shell
    // header names the site, and the name collided with the fence sensors, the
    // stacks and — at Riverport — the Riverport Road monitor's label.
    ...SiteLayer({
      data: site ? [site] : [], theme, emissionPoints: true, labels: false, branding: false, footprint: 'outline',
    }),
    ...MonitorLayer({
      id: 'fence-sensors', data: fenceline, theme, rings: false, labels: false, sizePx: 11,
      measure: dotMeasure,
      selectedId: pick?.kind === 'monitor' ? pick.id : null,
    }),
    // Named, no rings: the double ring is the regulator's own vocabulary, and
    // on this map it was 8 of the ~16 circles stacked over the campus.
    ...MonitorLayer({
      id: 'reference', data: reference, theme, rings: false, labels: true, labelBy: 'name', mutedLabels: 'dim',
      emphasizeIds: downwindIds, sizePx: 16, measure: dotMeasure, hoveredId: hoverMonitor,
      selectedId: pick?.kind === 'monitor' ? pick.id : null,
    }),
    ...(shown.reports ? reportsOverlay({
      theme, reports, clusters: nearClusters, zoom: view.zoom,
      selectedId: pick?.kind === 'report' ? pick.id : null,
      onSelect: (id) => setPick(id ? { kind: 'report', id } : null),
    }) : []),
    ...alertMarkers({
      theme, alerts: lists.placed, now, selectedId: selectedAlert, hoveredId: hoverId,
      isLinked: isAlertLinked,
      onSelect: (id) => setPick(id ? { kind: 'alert', id } : null),
    }),
    ...fencelineLabel({ theme, segments: fenceSegs, text: fenceMapLabel }),
  ], [
    fenceSegs, pick, shown, segsQ.data, measureDef, gridScale, model, plumeQ.data, site, fenceline,
    dotMeasure, reference, downwindIds, reports, nearClusters, view.zoom, lists.placed, now,
    selectedAlert, hoverId, fenceMapLabel, hoverMonitor, isAlertLinked, setPick,
  ])

  if (!site) {
    return <div className={`${s.page} ${s.deckPage}`}><div className={s.err}>No site for this persona.</div></div>
  }

  const onMapClick = (info: { object?: unknown; layer?: { id?: string } | null }) => {
    const obj = info.object as Record<string, unknown> | null | undefined
    if (!obj) { setPick(null); return }
    const lid = String(info.layer?.id ?? '')
    // These carry their own onClick.
    if (lid.startsWith('deck-reports') || lid.startsWith('deck-alerts')) return
    if (lid === 'fenceline-road') { setPick({ kind: 'fenceline', id: site.id }); return }
    if (lid.startsWith('segments')) {
      const id = (obj as unknown as SegmentFeature).properties?.id
      if (id) setPick(fenceIds.has(id) ? { kind: 'fenceline', id: site.id } : { kind: 'segment', id })
    } else if (lid.startsWith('reference') || lid.startsWith('fence-sensors')) {
      if (typeof obj.id === 'string') setPick({ kind: 'monitor', id: obj.id })
    } else if (lid.startsWith('sites')) {
      // SiteLayer picks a footprint, a stack, or the brand badge, and each is
      // a different shape — reading `obj.id` alone dropped every click on the
      // campus polygon, the largest target on the screen.
      const { siteId, emissionPointId } = pickedSite(obj)
      if (emissionPointId) setPick({ kind: 'emission', id: emissionPointId })
      else if (siteId) setPick({ kind: 'site', id: siteId })
    }
  }

  const aboutPlume = facts ? [
    `Today's plume is Aclima's model for ${fmtTime24(facts.ts)}: stability class ${facts.stability},`
      + ` ${fmtNum(facts.wind_speed_ms, 1)} m/s from ${compassPoint(facts.wind_dir_deg)},`
      + ` reaching ${fmtDistance(facts.x_reach_m)}${facts.truncated ? ' (the model’s limit)' : ''}.`,
    // The envelope is where the fleet can no longer DETECT this plume — not
    // where measurement stops: measured streets run on under the dashes.
    `The solid outline is where the fleet can still detect this plume: ${fmtDistance(facts.detection_envelope_m)}`
      + ' along the axis in this air. Past it the outline is dashed — model only. The streets there are'
      + ' still measured; the fleet just cannot tell this plume apart from other air that far out.',
    // A model statement, labelled as one, and never paired with a word about
    // the state of the ground: the fence sensors are the measurement there.
    facts.lofted && facts.elevated_touchdown_m != null
      ? `${facts.n_elevated} of the sources release aloft; the model brings that part of the plume down about ${fmtDistance(facts.elevated_touchdown_m)} out.`
      : null,
  ].filter(Boolean).join(' ') : null

  const filedLine = (() => {
    if (!shown.filed || !verify) return null
    if (verify.verdict === 'insufficient_data' || !verify.bearing_bias.length) {
      return `Filed study vs the fleet's wind: too few observations to compare (${fmtCompact(verify.n_obs)}).`
    }
    const w = [...verify.bearing_bias].sort((a, b) => b.delta - a.delta)[0]
    return `The filed study assumed wind from ${compassPoint(w.dir_deg)} ${fmtNum(w.assumed_freq, 1)}% of hours;`
      + ` the fleet measured ${fmtNum(w.observed_freq, 1)}% (${fmtCompact(verify.n_obs)} observations).`
  })()

  const toneClass = tone === 'alert' ? s.statusAlert : tone === 'hold' ? s.statusHold : tone === 'room' ? s.statusRoom : ''
  const hasReports = shown.reports && reports.length > 0
  const hasAlertMarks = lists.placed.some((c) => c.alert.lon != null && c.alert.lat != null)
  // The air of the moment and its next OPERATING change on the typical day —
  // when a hold usually ends, or when the next one usually begins — not every
  // change of class (neutral giving way to well-mixed air changes nothing).
  const untilNow = line?.tone === 'hold' ? typicalUntil(hours, nowHour, regime) : null
  const holdFrom = line?.tone === 'room' ? nextHold(hours, nowHour) : null
  const airNow = !wind ? '—'
    : `${regimeWord(regime)}${untilNow ? ` · usually until ${untilNow}` : holdFrom ? ` · stable air usually from ${holdFrom}` : ''}`
  const def = (code: string) => measures.find((m) => m.code === code)
  // "Your fence" in the Now card: the worst sensor over a level, else the
  // highest reading, and how many of the reporting sensors are over a level.
  const fenceTarget = fence?.worst ?? fence?.highest ?? null
  const pollutantOf = (code: string) => def(code)?.short_label ?? code.toUpperCase()
  const fenceRow = !fence ? (
    <NowRow label="Your fence" value="no fence sensors on this site; the fleet measures the fenceline road" />
  ) : (
    <NowRow
      label="Your fence"
      severity={fence.worst?.level?.severity ?? null}
      onClick={fenceTarget ? () => setPick({ kind: 'monitor', id: fenceTarget.monitor.id }) : undefined}
      value={fence.worst?.level
        ? `${fence.worst.side} · ${pollutantOf(fence.worst.measure)} ${fmtNum(fence.worst.value, 0)} ${fence.worst.unit}`
          + ` · over the ${fmtNum(fence.worst.level.threshold, 0)} ${fence.worst.level.unit}`
          + ` ${levelName(fence.worst.level.label, def(fence.worst.measure), fence.worst.measure)}`
          + ` · ${fence.over} of ${fence.reporting} sensors over a 1-hour level`
        : fence.highest
          ? `highest ${fence.highest.side} · ${pollutantOf(fence.highest.measure)} ${fmtNum(fence.highest.value, 0)} ${fence.highest.unit}`
            + ` · none of ${fence.reporting} over a 1-hour level`
          : 'no sensor reporting in the last 2 h'}
    />
  )
  const openAbout = () => {
    setAboutOpen((v) => !v)
    setPickState(null)
    setDrawerOpen(true)
  }

  return (
    <div className={`${s.page} ${s.deckPage}`}>
      {/* ── the one line ──────────────────────────────────────────────── */}
      {/* No site name here: the shell header already carries it. */}
      <div className={s.statusLine}>
        {line ? (
          <>
            <span className={`${s.statusMark} ${toneClass}`} aria-hidden />
            <span className={s.statusText}>
              <strong className={s.statusAnswer}>{line.answer}</strong>
              {line.reasons.length ? <span className={s.statusReason}>{' · '}{line.reasons.join(' · ')}</span> : null}
            </span>
          </>
        ) : (
          <span className={s.statusText}>
            {envQ.isError
              ? 'Envelope unavailable.'
              : envQ.isPending || windQ.isPending
                ? 'Reading the envelope…'
                : !wind ? 'No wind observation for the hour shown.' : 'Envelope not characterised for this site.'}
          </span>
        )}
        {/* Evidence, not Site: the question "says who?" is about the number on
            this line, and the measured nights behind it are on Evidence
            (PLAN-refocus I2, as built). */}
        <Link to="/industry/evidence" className={s.saysWho}>Says who →</Link>
        {clauses.length ? (
          <span className={s.statusBut}>
            {clauses.map((c, i) => (
              <span key={c.text} className={s.statusClause}>
                <span
                  className={s.statusClauseMark}
                  style={{ background: toneInk(c.severity) }}
                  aria-hidden
                />
                {i === 0 && line?.tone === 'room' ? 'But ' : ''}
                {i === 0 && line?.tone === 'room' ? c.text : c.text.charAt(0).toUpperCase() + c.text.slice(1)}
                .
              </span>
            ))}
          </span>
        ) : null}
      </div>

      <div className={s.deckBody}>
        {/* ── the map ─────────────────────────────────────────────────── */}
        <div
          ref={mapRef}
          className={s.deckMap}
          onPointerDownCapture={markGesture}
          onWheelCapture={markGesture}
          onKeyDownCapture={markGesture}
        >
          <BaseMap
            view={view}
            onViewChange={handleView}
            layers={layers}
            onClick={onMapClick}
            onHover={(info) => {
              const lid = String(info.layer?.id ?? '')
              const id = lid === 'deck-alerts'
                ? (info.object as NearAlert | undefined)?.alert.id ?? null
                : null
              const mon = lid.startsWith('reference')
                ? ((info.object as { id?: unknown } | undefined)?.id as string | undefined) ?? null
                : null
              setHoverId((prev) => (prev === id ? prev : id))
              setHoverMonitor((prev) => (prev === mon ? prev : mon))
            }}
            minZoom={10}
            maxZoom={18}
            label={`Map of ${site.name} and the streets around it`}
            fullBleed={shown.wind ? (
              // One neutral ink, speed on alpha: the intensity ramp is also the
              // measured street ramp on industry, and wind drawn in it read as
              // measured ink over ground nobody drove (CONTRACT §10b). `ink`, not
              // the default `ink-2`: at 0.42 the dimmer ink peaked at alpha
              // 0.43 and averaged 0.03 over the night basemap — invisible.
              <MapWindField field={fieldQ.data} particles={700} opacity={0.42} lineWidth={1} colorMode="neutral" colorToken="ink" />
            ) : null}
          >
            <MapOverlay place="top-left">
              <div className={s.mapBar}>
                <button
                  ref={layersBtn}
                  type="button"
                  className={s.mapBtn}
                  aria-expanded={layersOpen}
                  onClick={() => setLayersOpen((v) => !v)}
                >
                  Layers ▾
                </button>
                <label className={s.pollutant}>
                  <span className={s.pollutantKey}>Pollutant</span>
                  <select
                    className={s.pollutantSelect}
                    value={measureDef?.code ?? ''}
                    onChange={(e) => setMeasure(e.target.value as MeasureCode)}
                  >
                    {measures.map((m) => (
                      <option key={m.code} value={m.code}>
                        {shortName(m)}{unitFor(m) ? ` · ${unitFor(m)}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Popover
                open={layersOpen}
                onClose={() => setLayersOpen(false)}
                anchor={layersBtn}
                align="start"
                width={260}
                label="Map layers"
              >
                <div className={s.layersMenu}>
                  <Toggle checked={shown.grid} onChange={toggle('grid')} label="Measured streets" />
                  <Toggle checked={shown.wind} onChange={toggle('wind')} label="Fleet-measured wind" />
                  <Toggle checked={shown.plume} onChange={toggle('plume')} label="Today's plume (model)" />
                  <Toggle checked={shown.reports} onChange={toggle('reports')} label="Resident reports" />
                  <Toggle
                    checked={shown.filed}
                    onChange={toggle('filed')}
                    label={model ? 'Compare with filed study' : 'Compare with filed study (none on file)'}
                    disabled={!model}
                  />
                </div>
              </Popover>
            </MapOverlay>

            {panned ? (
              <MapOverlay place="top-right">
                <button type="button" className={s.mapBtn} onClick={recentre}>
                  Re-centre
                </button>
              </MapOverlay>
            ) : null}

            <MapOverlay place="bottom-left">
              <div ref={legendRef} className={s.legend}>
                <div className={s.legendKeys}>
                  {shown.grid ? <LegendKey swatch={<StreetSwatch />} text="Measured street · whole campaign" /> : null}
                  {fenceSegs.length ? <LegendKey swatch={<FenceSwatch />} text={`Fenceline road${roads.length > 1 ? 's' : ''}${fenceRoad ? ` · ${fenceRoad}` : ''}`} /> : null}
                  <LegendKey swatch={<CampusSwatch />} text="Your campus and stacks" />
                  {fenceline.length ? <LegendKey swatch={<FenceSensorSwatch />} text="Your fence sensor · red = over a level" /> : null}
                  {reference.length ? <LegendKey swatch={<MonitorSwatch />} text="Reference monitor · bright = in the plume" /> : null}
                  {hasReports ? <LegendKey swatch={<ReportSwatch />} text="Resident report · filled = linked" /> : null}
                  {hasAlertMarks ? <LegendKey swatch={<AlertSwatch />} text="Alert · heavy ring = ongoing" /> : null}
                  {shown.wind ? (
                    <LegendKey
                      swatch={<WindSwatch />}
                      text={`Fleet-measured wind, last ${fieldQ.data ? fmtSpan(hoursBetween(fieldQ.data.from, fieldQ.data.to)) : '72 h'}`}
                    />
                  ) : null}
                  {shown.plume ? (
                    <LegendKey
                      swatch={<StrokeSwatch register="model" />}
                      text={`Today's plume (model${plumeSpecies ? `, ${plumeSpecies}` : ''})`}
                    />
                  ) : null}
                  {beyond ? <LegendKey swatch={<StrokeSwatch register="beyond" />} text={BEYOND_ENVELOPE_NOTE} /> : null}
                  {shown.filed && model ? <LegendKey swatch={<StrokeSwatch register="filed" />} text="Filed study (model)" /> : null}
                  {filedLine ? <span className={s.legendNote}>{filedLine}</span> : null}
                  <button
                    type="button"
                    className={s.legendMore}
                    aria-expanded={aboutOpen}
                    onClick={openAbout}
                  >
                    {aboutOpen ? 'Close about' : 'About this map'}
                  </button>
                </div>
              </div>
            </MapOverlay>
          </BaseMap>
        </div>

        {/* ── the side panel ─────────────────────────────────────────── */}
        <aside className={`${s.deckPanel}${drawerOpen ? ` ${s.deckPanelOpen}` : ''}`} aria-label="Envelope and alerts">
          <button
            type="button"
            className={s.drawerHandle}
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((v) => !v)}
          >
            {drawerOpen ? 'Hide panel ▾' : `Envelope and alerts${lists.downwind.length ? ` · ${lists.downwind.length} downwind` : ''} ▴`}
          </button>
          {aboutOpen ? (
            <section className={s.card} aria-label="About this map">
              <header className={s.cardHead}>
                <span className={s.cardTitle}>About this map</span>
                <span className={s.spacer} />
                <button type="button" className={s.backBtn} onClick={() => setAboutOpen(false)}>Back</button>
              </header>
              <div className={s.aboutText}>
                {shown.grid ? (
                  <p>
                    Streets are {shortName(measureDef)}
                    {isIndex
                      ? ' on a fixed 0–60 scale, where 60 is the top of the Moderate band'
                      : `${unitFor(measureDef) ? ` in ${unitFor(measureDef)}` : ''}, colour stretched to what is in view`}
                    , measured by Aclima's cars over the whole campaign. Width is how often a street was driven.
                  </p>
                ) : null}
                {shown.plume && aboutPlume ? <p>{aboutPlume}</p> : null}
                {shown.wind && fieldQ.data ? (
                  <p>
                    Moving lines are the fleet's own anemometer readings over the last{' '}
                    {fmtSpan(hoursBetween(fieldQ.data.from, fieldQ.data.to))}, from{' '}
                    {fmtCompact(fieldQ.data.n_obs)} observations.
                  </p>
                ) : null}
                {fenceline.length ? (
                  <p>
                    Your fence sensors turn red when their latest reading is over an action level for
                    the pollutant picked. A sensor that is offline is drawn faint.
                  </p>
                ) : null}
                <p>
                  Reference monitors are named. One is drawn bright only when it sits inside the solid
                  part of today's plume, within {fmtDistance(REPORTABLE_M, 1)}; under the dashed part it stays
                  dim, because nothing is judged from that part.
                </p>
                {shown.reports ? (
                  <p>
                    Resident reports from the last {REPORT_WINDOW_DAYS} days. A report is filled only
                    when it is linked: the wind at the time carried from your campus to it, and your
                    measured downwind test passed its rotation check. The rest are hollow. Noise,
                    vibration and light reports are never linked by an air test.
                  </p>
                ) : null}
                <p>
                  Alerts sit where they were raised: a heavier ring while ongoing, a lighter one after.
                  One is filled only on the same rule — the wind when it began and your downwind test
                  for that pollutant — and only within {fmtDistance(REPORTABLE_M, 1)}.
                </p>
              </div>
            </section>
          ) : pick ? (
            <Selected
              pick={pick}
              onBack={() => setPick(null)}
              now={now}
              site={site}
              measure={measureDef}
              reports={reports}
              alerts={lists.all}
              alertCtx={alertCtx}
              monitors={monitorsQ.data ?? []}
              downwindIds={downwindIds}
              segments={segsQ.data?.features ?? []}
              wind={windQ.data}
              envelope={env}
              envelopeBand={band}
              geo={(lon: number, lat: number) => bearingFrom(site.centroid, lon, lat)}
            />
          ) : (
            <>
              <section className={s.card} aria-label="Now">
                <header className={s.cardHead}>
                  <span className={s.cardTitle}>Now</span>
                </header>
                <div className={s.nowRows}>
                  <NowRow label="Air" value={airNow} />
                  {fenceRow}
                  {crossing ? (
                    <NowRow
                      label="Downwind monitor"
                      severity={crossing.severity}
                      onClick={() => setPick({ kind: 'monitor', id: crossing.monitor.id })}
                      value={`${crossing.owner ? `${crossing.owner}'s ` : ''}${crossing.monitor.name}, ${fmtDistance(crossing.distanceM, 1)}`
                        + ` · ${pollutantOf(crossing.measure)} ${crossing.level}`
                        + ` on ${crossing.days} of the last ${crossing.windowDays} ${crossing.nights ? 'nights' : 'days'}`}
                    />
                  ) : null}
                </div>
              </section>

              <section className={s.card} aria-label="Typical day">
                <header className={s.cardHead}>
                  <span className={s.cardTitle}>Typical day</span>
                  <span className={s.spacer} />
                  {fenceSegs.length ? (
                    <button type="button" className={s.cardLink} onClick={() => setPick({ kind: 'fenceline', id: site.id })}>
                      Where it is measured
                    </button>
                  ) : null}
                </header>
                {band}
              </section>

              <section className={s.card} aria-label="Downwind">
                <header className={s.cardHead}>
                  <span className={s.cardTitle}>Downwind</span>
                  <span className={s.spacer} />
                  <Link to="/industry/alerts" className={s.cardLink}>
                    All alerts{live.count ? ` · ${live.count} ongoing` : ''} →
                  </Link>
                </header>
                <span className={s.cardCaption}>
                  Began with the wind carrying from your campus toward them · ongoing or last 7 days
                </span>
                {alertsQ.isError ? (
                  <span className={s.reportNote}>Alert feed unavailable.</span>
                ) : lists.downwind.length ? (
                  <AlertRows list={lists.downwind} ctx={alertCtx} now={now} hoverId={hoverId} onHover={setHoverId} onPick={(id) => setPick({ kind: 'alert', id })} />
                ) : (
                  <span className={s.reportNote}>
                    Nothing began downwind of {site.name} in the last 7 days.
                  </span>
                )}

                {lists.fleet.length ? (
                  <>
                    <span className={s.groupHead}>Found by Aclima's fleet</span>
                    <AlertRows list={lists.fleet} ctx={alertCtx} now={now} hoverId={hoverId} onHover={setHoverId} onPick={(id) => setPick({ kind: 'alert', id })} />
                  </>
                ) : null}

                {lists.siteWide.length ? (
                  <>
                    <span className={s.groupHead}>Site-wide</span>
                    <AlertRows list={lists.siteWide} ctx={alertCtx} now={now} hoverId={hoverId} onHover={setHoverId} onPick={(id) => setPick({ kind: 'alert', id })} />
                  </>
                ) : null}

                {lists.notices.length ? (
                  <>
                    <span className={s.groupHead}>Notice</span>
                    {lists.notices.map((c) => (
                      <button
                        key={c.alert.id}
                        type="button"
                        className={s.noticeRow}
                        onClick={() => setPick({ kind: 'alert', id: c.alert.id })}
                      >
                        {alertSentence(c.alert, alertCtx)} · since {fmtDay(c.alert.started_at)}
                      </button>
                    ))}
                  </>
                ) : null}

                {lists.elsewhere.length ? (
                  <details className={s.elsewhere} open={lists.elsewhere.some((c) => isOngoing(c.alert, now)) || undefined}>
                    <summary>Elsewhere ({lists.elsewhere.length})</summary>
                    <AlertRows list={lists.elsewhere} ctx={alertCtx} now={now} hoverId={hoverId} onHover={setHoverId} onPick={(id) => setPick({ kind: 'alert', id })} />
                  </details>
                ) : null}
              </section>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/** Watch is the hold amber; a standard (warning) or worse is the threat red. */
function toneInk(sev: Severity): string {
  return severityRank(sev) >= severityRank('warning') ? 'var(--threat)' : 'var(--accent-2)'
}

/** One "now" row: a label, a value, a severity mark when it is over a level. */
function NowRow({
  label, value, severity, onClick,
}: { label: string; value: string; severity?: Severity | null; onClick?: () => void }) {
  const mark = severity
    ? <span className={s.nowMark} style={{ background: toneInk(severity) }} aria-label={SEVERITY_LABEL[severity]} />
    : null
  const body = (
    <>
      <span className={s.nowKey}>{label}</span>
      <span className={s.nowVal}>{mark}{value}</span>
    </>
  )
  return onClick
    ? <button type="button" className={`${s.nowRow} ${s.nowRowBtn}`} onClick={onClick}>{body}</button>
    : <div className={s.nowRow}>{body}</div>
}

/** Two-line rows: what, then where and when. "now" only on the ongoing ones. */
function AlertRows({
  list, ctx, now, hoverId, onHover, onPick,
}: {
  list: NearAlert[]
  ctx: AlertContext
  now: CampaignTime
  hoverId: string | null
  onHover: (id: string | null) => void
  onPick: (id: string) => void
}) {
  return (
    <ul className={s.alertList}>
      {list.map((c) => {
        const ongoing = isOngoing(c.alert, now)
        return (
          <li key={c.alert.id}>
            <button
              type="button"
              className={`${s.alertRow}${hoverId === c.alert.id ? ` ${s.alertRowOn}` : ''}`}
              onMouseEnter={() => onHover(c.alert.id)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(c.alert.id)}
              onBlur={() => onHover(null)}
              onClick={() => onPick(c.alert.id)}
            >
              <span
                className={s.alertGlyph}
                style={{ color: severityVar(c.alert.severity) }}
                title={SEVERITY_LABEL[c.alert.severity]}
                aria-label={SEVERITY_LABEL[c.alert.severity]}
              >
                {c.glyph}
              </span>
              <span className={s.alertText}>
                <span className={s.alertWhat}>{alertSentence(c.alert, ctx)}</span>
                <span className={`${s.alertWhen} num`}>
                  {ongoing ? <Tag tone="accent">now</Tag> : null}
                  {alertWhere(c, now)}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function LegendKey({ swatch, text }: { swatch: ReactNode; text: string }) {
  return (
    <span className={s.legendKey}>
      <span className={s.legendSwatch} aria-hidden>{swatch}</span>
      <span>{text}</span>
    </span>
  )
}

/**
 * The model registers, drawn from the same stroke table the map layers read
 * (`PLUME_STROKE`), so the key cannot drift from the marks it explains. The
 * dash is in multiples of the line width there, as deck.gl reads it.
 */
function StrokeSwatch({ register }: { register: 'model' | 'beyond' | 'filed' }) {
  const st = PLUME_STROKE[register]
  const dash = st.dash ? st.dash.map((d) => d * st.width).join(' ') : undefined
  return (
    <svg width="22" height="10" viewBox="0 0 22 10">
      <line
        x1="1" y1="5" x2="21" y2="5"
        stroke={`var(--${st.token})`} strokeOpacity={st.alpha} strokeWidth={st.width}
        strokeDasharray={dash} strokeLinecap={register === 'filed' ? 'round' : 'butt'}
      />
    </svg>
  )
}

function StreetSwatch() {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10">
      <defs>
        <linearGradient id="deck-street-ramp" x1="0" x2="1">
          <stop offset="0" stopColor="var(--ramp-map-1)" />
          <stop offset="0.5" stopColor="var(--ramp-map-4)" />
          <stop offset="1" stopColor="var(--ramp-map-7)" />
        </linearGradient>
      </defs>
      <rect x="1" y="3" width="20" height="4" fill="url(#deck-street-ramp)" />
    </svg>
  )
}

function FenceSwatch() {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10">
      <line x1="2" y1="5" x2="20" y2="5" stroke="var(--scope)" strokeOpacity="0.35" strokeWidth="7" strokeLinecap="round" />
      <line x1="2" y1="5" x2="20" y2="5" stroke="var(--ramp-map-4)" strokeWidth="2" />
    </svg>
  )
}

/** The campus edge as SiteLayer draws it in 'outline' (neutral ink), with a stack. */
function CampusSwatch() {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12">
      <rect x="1.5" y="1.5" width="19" height="9" fill="none" stroke="var(--ink-2)" strokeWidth="1.2" />
      <path d="M9 10 L10 4 L12 4 L13 10 Z" fill="var(--accent-2)" />
    </svg>
  )
}

/** A fence sensor, and the same sensor over a level. */
function FenceSensorSwatch() {
  const hex = (cx: number) => `M${cx} 1.5 L${cx + 4} 3.8 L${cx + 4} 8.2 L${cx} 10.5 L${cx - 4} 8.2 L${cx - 4} 3.8 Z`
  return (
    <svg width="22" height="12" viewBox="0 0 22 12">
      <path d={hex(6)} fill="var(--actor-industry)" />
      <path d={hex(16)} fill="var(--sev-critical)" />
    </svg>
  )
}

/** A reference monitor mast, bright then dim. */
function MonitorSwatch() {
  const mast = (x: number, o: number) => (
    // `--tower` is the regulator skin's; the map layer reads it through the
    // theme's alias (sev-ok) on every other skin, so the swatch does too.
    <g opacity={o} fill="var(--tower, var(--sev-ok))">
      <path d={`M${x} 1 L${x + 1.5} 4 L${x - 1.5} 4 Z`} />
      <rect x={x - 0.6} y={3.5} width={1.2} height={5} />
      <path d={`M${x} 8 L${x + 3.5} 11.5 L${x - 3.5} 11.5 Z`} />
    </g>
  )
  return <svg width="22" height="12" viewBox="0 0 22 12">{mast(6, 1)}{mast(16, 0.38)}</svg>
}

/** A linked report (filled) and an unlinked one (hollow). */
function ReportSwatch() {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12">
      <circle cx="6" cy="6" r="4" fill="var(--actor-community)" fillOpacity="0.6" stroke="var(--actor-community)" strokeWidth="1.2" />
      <circle cx="16" cy="6" r="3" fill="none" stroke="var(--actor-community)" strokeOpacity="0.7" strokeWidth="1" />
    </svg>
  )
}

/** An ongoing alert (heavier ring) and an ended one. */
function AlertSwatch() {
  return (
    <svg width="22" height="12" viewBox="0 0 22 12">
      <circle cx="6" cy="6" r="4.2" fill="none" stroke="var(--sev-watch)" strokeWidth="2" />
      <circle cx="16" cy="6" r="4.2" fill="none" stroke="var(--sev-watch)" strokeOpacity="0.6" strokeWidth="1.1" />
    </svg>
  )
}

function WindSwatch() {
  return (
    <svg width="22" height="10" viewBox="0 0 22 10">
      <path d="M1 7 C 6 3, 10 3, 14 5 S 19 6, 21 3" fill="none" stroke="var(--ink)" strokeWidth="1" strokeOpacity="0.55" />
    </svg>
  )
}

/** A window's length for a label: "72 h", "14 d". */
function fmtSpan(hours: number): string {
  return hours >= 96 ? `${fmtNum(hours / 24, 0)} d` : `${fmtNum(hours, 0)} h`
}
