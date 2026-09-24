/**
 * /industry — THE SCOPE: an RWR and an MFD, the way an 80s cockpit had both.
 *
 * The top band answers "do I have a problem?" in one word from three metres.
 * After that the operator needs two different things, and one instrument cannot
 * be both:
 *
 *   · the RWR (rail, small)  — which way, how far, how long. One second, no
 *                              context, no interaction. Its whole value is that
 *                              it shows almost nothing.
 *   · the MFD (main surface) — what is actually there. Your buildings, your
 *                              stacks, the streets, the wind, and only the
 *                              alerts near you. Zoom it, pick a stack, LOCK
 *                              back onto your site.
 *
 * The MFD carries the RWR's geometry — range rings centred on you, a bearing
 * line to every contact — so the two read as one system rather than two
 * unrelated pictures of the same air. An earlier version had only the scope,
 * and it was honest to the metaphor and useless in practice: you could see that
 * something was 6.3 km to the north-east and nothing whatsoever about what it
 * was over.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'

import {
  AlertTimeline, BEYOND_ENVELOPE_NOTE, BaseMap, DispersionLayer, MapOverlay, MapWindField,
  hasBeyondEnvelope,
  MonitorLayer, RadarScope, SegmentLayer, SiteLayer, makeColorScale, measureDomain,
  pickedSite, REPORT_WINDOW_DAYS, windowReports,
} from '@/components'
import type { MapView, RadarContact, SegmentFeature, Theme } from '@/components'
import { Button } from '@/app/ui'
import { compassPoint, fmtBearing, fmtCompact, fmtDistance, fmtNum, fmtPct, relativeShort } from '@/core/format'
import { SEVERITY_LABEL, severityVar, shortName, unitFor } from '@/core/measures'
import {
  useActiveMeasure, useAlerts, useConcernClusters, useConcerns, useDispersion, useEnvelope,
  useDispersionModels, useMeasures, useModelVerification, useMonitors, useSegments,
  useWind, useWindField,
} from '@/core/queries'
import { useSession } from '@/core/session'
import type { Alert, MeasureCode, Position } from '@/core/types'

import { Selected } from './Selected'
import type { MapPick } from './Selected'
import {
  Caps, Gauge, Panel, Readout, Tag, bboxAround, contactLine, countBySeverity, downwindOf,
  envelopeRead, foldContacts, radarOverlay, severityCountLine, shortTitle, styles as s,
  bearingFrom, permitFootprintLayer, placeReports, regimeOf, reportsOverlay, toContacts, useNowTick, useSiteLock,
  useCampaignWindow, useStableWindow,
} from './lib'

const LIVE_STATUSES = new Set(['active', 'acknowledged'])

export function Scope() {
  const site = useSiteLock()
  const navigate = useNavigate()
  const now = useNowTick(1000)

  // The field is binned from wherever the fleet drove, so a longer window fills
  // more streets. The strip states the window and the sample size out loud.
  const fieldWin = useStableWindow(24 * 14)
  const alertsQ = useAlerts({ site_id: site?.id }, { enabled: !!site })
  const windQ = useWindField({ cell_m: 400, ...fieldWin })
  const modelsQ = useDispersionModels(site?.id)
  // The campaign, not the last 30 days — see `useCampaignWindow`. The default
  // window has slid off the end of the data and answers `consistent`.
  const verifyWin = useCampaignWindow()
  const verifyQ = useModelVerification(site?.id, verifyWin ?? {}, {
    enabled: !!site?.id && !!verifyWin,
  })
  // Two weeks, not 24 h. `win` is anchored to the wall clock, and the moment it
  // runs past the end of the generated data the query comes back empty — which
  // silently took out the plume track and the downwind readout with it. The
  // strip labels this as the latest observation, so a wider search is honest.
  const windSeries = useWind(useStableWindow(24 * 14))
  const wind = windSeries.data?.[windSeries.data.length - 1]

  const [showWind, setShowWind] = useState(true)
  // Two separate things, and calling them both "MODEL" is what made them
  // confusing: PLUME is this hour's cone per stack, PERMIT is the consultant's
  // long-run average footprint for the whole site. See `permitFootprintLayer`.
  const [showPlume, setShowPlume] = useState(false)
  const [showPermit, setShowPermit] = useState(true)
  const [showGrid, setShowGrid] = useState(true)
  const [showReports, setShowReports] = useState(true)
  const [pick, setPick] = useState<MapPick | null>(null)
  /** Which emission point the MFD is centred on. `null` = the site centroid. */
  const [focusEp, setFocusEp] = useState<string | null>(null)
  const [locked, setLocked] = useState(true)

  // Only the streets around this site. The regulator wants the whole campaign;
  // an operator wants the blocks their plume actually crosses, and a 1,307
  // segment grid at this zoom is noise they did not ask for.
  const bbox = useMemo(() => (site ? bboxAround(site.centroid, 9000) : null), [site])
  const segsQ = useSegments({ bbox, limit: 9000 }, { enabled: !!bbox && showGrid })
  const monitorsQ = useMonitors()
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
  /**
   * The plume does NOT follow the picker, deliberately. `dispersion_model` rows
   * exist for bc, no2 and pm25 only, so passing the session measure through
   * would silently blank the cone for the other seven. The MFD legend names the
   * species the plume is actually showing.
   */
  const plumeQ = useDispersion({ site_id: site?.id })
  const concernsQ = useConcerns({ limit: 400 })
  const clustersQ = useConcernClusters()
  // The last fortnight by default, as on every map (components/lib/reports).
  const cursor = useSession((st) => st.time.cursor)
  const windowed = useMemo(
    () => windowReports(concernsQ.data ?? [], clustersQ.data ?? [], REPORT_WINDOW_DAYS, cursor),
    [concernsQ.data, clustersQ.data, cursor],
  )

  const live = useMemo(
    () => (alertsQ.data ?? []).filter((a: Alert) => LIVE_STATUSES.has(a.status)),
    [alertsQ.data],
  )
  // Only alerts with a place relative to the site. The one without (measured
  // wind vs the dispersion study) is the wind panel's, and on a range-sorted
  // list it read "000° · 0 m".
  const all = useMemo(() => toContacts(live).filter((c) => c.sited), [live])
  // One row per real threat: a watch and a warning from the same instrument are
  // the same problem counted twice.
  const { contacts, folded } = useMemo(() => foldContacts(all), [all])
  const counts = useMemo(() => countBySeverity(contacts), [contacts])
  const worst = contacts[0]
  /**
   * Civil flight decks do not have "threats"; they have three annunciator
   * levels, and everyone in the industry already knows what they mean.
   * WARNING is act now, CAUTION is act soon, ADVISORY is be aware. Mapping our
   * severities onto that ladder means the header word carries an expectation
   * about *how fast to respond*, which "THREAT" never did.
   */
  const level = counts.critical > 0
    ? 'WARNING'
    : counts.warning > 0
      ? 'CAUTION'
      : contacts.length ? 'ADVISORY' : 'NORMAL'
  const alarm = level === 'WARNING' || level === 'CAUTION'
  /**
   * THE NUMBER THIS INTERFACE EXISTS FOR. Measured, and reported for the air
   * that is actually out there right now — not `site.headroom_pct`, which was
   * a constant and therefore the same on a still night as on a windy
   * afternoon. See `envelopeRead`.
   */
  const envQ = useEnvelope(site?.id)
  const regime = regimeOf(wind?.stability)
  const envelope = envelopeRead(envQ.data, regime)
  const envStable = envelopeRead(envQ.data, 'stable')

  const radarContacts: RadarContact[] = useMemo(
    () => contacts.map((c) => ({
      id: c.alert.id,
      bearing_deg: c.bearing,
      distance_m: c.distance,
      severity: c.alert.severity,
      label: c.alert.title,
      code: c.code,
      source: c.alert.source_type,
      isNew: c.alert.status === 'active',
      startedAt: c.alert.started_at,
      status: c.alert.status,
    })),
    [contacts],
  )

  const model = modelsQ.data?.[0]
  const verify = verifyQ.data
  const windAlert = live.find((a) => a.kind === 'wind_shift')

  const fenceline = useMemo(
    () => (monitorsQ.data ?? []).filter((m) => m.site_id === site?.id),
    [monitorsQ.data, site],
  )
  // The instruments that actually matter to an operator. The fenceline exists so
  // that these never trip; leaving them off the display hid the thing the whole
  // interface is managing against.
  const reference = useMemo(
    () => (monitorsQ.data ?? []).filter((m) => m.owner_type === 'regulator'),
    [monitorsQ.data],
  )
  const transportDeg = wind ? (wind.dir_deg + 180) % 360 : null
  const downwind = useMemo(
    () => (site ? downwindOf(site.centroid, reference, transportDeg) : []),
    [site, reference, transportDeg],
  )
  const exposed = downwind[0]

  /**
   * The other half of the optimisation: not how much load is left, but how
   * close the worst thing being measured already is to the line it is measured
   * against. 1.00x IS the line, so that is where the redline goes.
   */
  const nearest = useMemo(() => {
    let worstRatio: number | null = null
    let which: Alert | null = null
    for (const a of live) {
      if (a.value == null || !a.threshold) continue
      // Concentration limits only. A concern cluster's `value` is a count of
      // residents and its `threshold` is 3, so including it reported "3.56x of
      // limit" for eleven neighbours filing reports — a category error, and a
      // gauge that would have had the operator chasing the wrong number.
      if (!a.measure || !a.action_level_id) continue
      const r = a.value / a.threshold
      if (worstRatio == null || r > worstRatio) { worstRatio = r; which = a }
    }
    return { ratio: worstRatio, alert: which }
  }, [live])

  // Whose instrument is reading that. A fenceline sensor running hot is the
  // early warning working as designed; the same ratio on a DRAQA reference
  // instrument is a different afternoon entirely, so the gauge has to say which.
  const nearestWhere = useMemo(() => {
    const src = nearest.alert?.source_id
    if (!src) return nearest.alert?.source_type === 'mobile' ? 'fleet' : 'of limit'
    if (reference.some((m) => m.id === src)) return 'reference'
    if (fenceline.some((m) => m.id === src)) return 'fenceline'
    return 'of limit'
  }, [nearest.alert, reference, fenceline])

  // The scale follows the reading. A fixed 1.6x ceiling pegged the needle and
  // threw away the only thing the gauge had left to say — how far over.
  const ratioMax = Math.max(1.5, (nearest.ratio ?? 0) * 1.2)

  // Reports near this campus, split by whether the wind actually points at them.
  const reports = useMemo(
    () => (site ? placeReports(site.centroid, windowed.concerns, transportDeg) : []),
    [site, windowed.concerns, transportDeg],
  )
  const nearClusters = useMemo(() => {
    if (!site) return []
    return windowed.clusters.filter(
      (cl) => bearingFrom(site.centroid, cl.centroid[0], cl.centroid[1]).distanceM <= 6000,
    )
  }, [windowed.clusters, site])
  const downwindReports = reports.filter((r) => r.downwind).length
  const pickedId = pick?.id ?? null

  /** Where the MFD is looking: a chosen stack, or the site as a whole. */
  const focus: Position | null = useMemo(() => {
    if (!site) return null
    const ep = focusEp ? site.emission_points.find((e) => e.id === focusEp) : undefined
    return ep ? [ep.lon, ep.lat] : site.centroid
  }, [site, focusEp])

  const [view, setView] = useState<MapView>({
    longitude: -90.1479, latitude: 35.035, zoom: 11.9, pitch: 0, bearing: 0,
  })

  // LOCK is a mode, not a button press: while it is on, the camera follows the
  // focus, so picking a stack slews to it the way a real slew-to-designate does.
  useEffect(() => {
    if (!locked || !focus) return
    setView((v) => (
      Math.abs(v.longitude - focus[0]) < 1e-6 && Math.abs(v.latitude - focus[1]) < 1e-6
        ? v
        : { ...v, longitude: focus[0], latitude: focus[1] }
    ))
  }, [locked, focus])

  // Any real pan breaks the lock. Compared against the focus rather than the
  // previous view, so the programmatic slew above does not unlock itself.
  const handleView = useCallback((next: MapView) => {
    setView(next)
    if (!focus) return
    const off = Math.hypot(next.longitude - focus[0], next.latitude - focus[1])
    if (off > 0.004) setLocked(false)
  }, [focus])

  /**
   * A measure with no unit is an *index*, not a concentration: its value is
   * already on 0-100 and has to be painted against that fixed scale. The grid's
   * default is a robust p2-p98 stretch, which is right for concentrations —
   * ppb, ug/m3 and ppm share no scale — and wrong for a score, where stretching
   * a seven-point spread across the whole ramp manufactures alarm out of air
   * that is genuinely uniform.
   */
  const isIndex = measureDef?.unit === ''
  /**
   * Which species the cone is actually showing. Named out loud because the
   * channel picker now sits three centimetres away and does not move it — an
   * unlabelled plume beside a channel selector reads as the selector's output.
   */
  const plumeSpecies = useMemo(() => {
    const code = plumeQ.data?.features?.[0]?.properties?.measure
    const def = code ? measures.find((m) => m.code === code) : undefined
    if (!def) return null
    return def.code === measureDef?.code ? null : shortName(def)
  }, [plumeQ.data, measures, measureDef])
  /**
   * No instrument carries an index as a channel, so `latest[code]` is undefined
   * on every monitor and every dot would drop silently to un-alarmed. Passing
   * `undefined` restores the any-channel fallback: the dot means "something on
   * this instrument is over", which is the honest reading of a tower when the
   * grid is showing a derived score.
   */
  const dotMeasure = isIndex ? undefined : (measureDef?.code as MeasureCode | undefined)
  const gridScale = useCallback(
    (theme: Theme) => makeColorScale(theme, { domain: measureDomain(measureDef, segsQ.data), ramp: 'map' }),
    [measureDef, segsQ.data],
  )

  /**
   * What the plume is actually saying, in one line under the map.
   *
   * Three facts the old cone could not express and this one has to state, or
   * the reader supplies their own wrong answer:
   *
   *  - Reach is weather. It moves by a factor of five between a summer
   *    afternoon and a still night, so a bare cone with no number invites
   *    "that is what my plume looks like" rather than "that is tonight".
   *  - A lofted plume is over the fenceline, not on it. The clean ground next
   *    to a stack is a real result and it is the shape of the hole in the
   *    middle of the drawing.
   *  - Past the detection envelope nothing has been measured. CONTRACT §10b
   *    requires the words, not just the dashes — `BEYOND_ENVELOPE_NOTE` is
   *    exported so all four interfaces print the same sentence.
   */
  const plumeRead = useMemo(() => {
    const p = plumeQ.data?.features?.[0]?.properties
    if (!p) return null
    const bits: string[] = [
      `class ${p.stability} at ${fmtNum(p.wind_speed_ms, 1)} m/s`,
      `reaches ${fmtDistance(p.x_reach_m)}${p.truncated ? '+' : ''}`,
    ]
    if (p.lofted && p.elevated_touchdown_m != null) {
      bits.push(
        `${p.n_elevated} source${p.n_elevated === 1 ? '' : 's'} aloft — touching down ${fmtDistance(p.elevated_touchdown_m)} out`,
      )
    }
    if (p.stability_note) bits.push(p.stability_note)
    if (hasBeyondEnvelope(plumeQ.data)) bits.push(`dashed: ${BEYOND_ENVELOPE_NOTE}`)
    return bits.join(' · ')
  }, [plumeQ.data])

  const mfdLayers = useCallback((theme: Theme) => [
    ...(showGrid ? SegmentLayer({
      data: segsQ.data, theme, dualEncode: 'width', minPasses: 3,
      measure: measureDef?.code, scale: gridScale(theme),
    }) : []),
    ...(showPermit ? permitFootprintLayer({ theme, contours: model?.contours }) : []),
    ...(showPlume ? DispersionLayer({ data: plumeQ.data, theme, maxOpacity: 0.16 }) : []),
    /* The campus goes UNDER its own instruments. deck picks the topmost
       layer, and the footprint is a polygon covering every fenceline sensor
       on it — drawn last, it swallowed their clicks and every attempt to
       inspect a sensor selected the site instead. */
    ...SiteLayer({ data: site ? [site] : [], theme, emissionPoints: true, labels: true }),
    ...MonitorLayer({
      id: 'fenceline', data: fenceline, theme, rings: false, labels: false, sizePx: 11,
      measure: dotMeasure,
      selectedId: pick?.kind === 'monitor' ? pick.id : null,
    }),
    // Rings ON for these: a 2.5 km representativeness radius is exactly the
    // question — is my plume crossing the ground this instrument speaks for?
    ...MonitorLayer({
      id: 'reference', data: reference, theme, rings: true, labels: true, sizePx: 16,
      measure: dotMeasure,
      selectedId: pick?.kind === 'monitor' ? pick.id : (exposed?.monitor.id ?? null),
    }),
    ...(showReports ? reportsOverlay({
      theme,
      reports,
      clusters: nearClusters,
      zoom: view.zoom,
      selectedId: pick?.kind === 'report' ? pick.id : null,
      onSelect: (id) => setPick(id ? { kind: 'report', id } : null),
    }) : []),
    ...(focus ? radarOverlay({
      theme,
      origin: focus,
      contacts,
      selectedId: pick?.kind === 'alert' ? pick.id : null,
      onSelect: (id) => setPick(id ? { kind: 'alert', id } : null),
      transportDeg,
    }) : []),
  ], [
    showGrid, showPlume, showPermit, showReports, segsQ.data, plumeQ.data, model, fenceline,
    reference, site, focus, contacts, pick, transportDeg, exposed, reports, nearClusters,
    measureDef, dotMeasure, gridScale, view.zoom,
  ])

  if (!site) {
    return <div className={`${s.page} ${s.scopePage}`}><div className={s.err}>No site locked.</div></div>
  }

  const focusEpRow = focusEp ? site.emission_points.find((e) => e.id === focusEp) : undefined
  const focusName = focusEpRow ? epShort(focusEpRow.name) : site.name

  return (
    <div className={`${s.page} ${s.scopePage}`}>
      {/* ── the one-second read ─────────────────────────────────────────── */}
      <div className={`${s.banner} ${alarm ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.verdict}>
          <span className={`${s.verdictGlyph} ${alarm ? s.threatInk : s.clearInk}`}>
            {alarm ? '▲' : '◇'}
          </span>
          <span className={`${s.verdictWord} ${alarm ? s.threatInk : s.clearInk}`}>
            {level}
          </span>
        </div>

        <div className={s.bannerLine}>
          {worst ? (
            <>
              <span className={`${s.bannerHead} num`}>{contactLine(worst, now)}</span>
              <span className={s.bannerSub}>
                {worst.alert.title}
                {' · '}
                {worst.alert.source_type === 'community'
                  ? 'residents reporting'
                  : worst.alert.source_type === 'mobile'
                    ? 'our fleet'
                    : 'stationary instrument'}
              </span>
            </>
          ) : (
            <>
              <span className={s.bannerHead}>Nothing above an action level</span>
              <span className={s.bannerSub}>
                Nothing from the regulator, the community or your fenceline in the current window.
              </span>
            </>
          )}
        </div>

        <div className={s.bannerStats}>
          <Readout
            label="Alerts"
            value={fmtNum(contacts.length, 0)}
            tone={alarm ? 'threat' : 'accent'}
            big
          />
          <Readout
            label="Bearing"
            value={worst ? fmtBearing(worst.bearing) : '—'}
            tone={alarm ? 'threat' : undefined}
          />
          <Readout
            label="Range"
            value={worst ? fmtDistance(worst.distance, 1) : '—'}
          />
          <Readout
            label={envelope ? `Envelope · ${regime}` : 'Envelope'}
            value={envelope ? envelope.headline : '—'}
            tone={envelope?.binding ? 'threat' : 'accent'}
            big
          />
        </div>
      </div>

      {/* ── the MFD, and the RWR beside it ─────────────────────────────── */}
      <div className={s.scopeBody}>
        {/* the map, and whatever is picked on it, in one column */}
        <div className={s.mapCol}>
        <Panel
          title={`MFD · ${focusName}`}
          aside={
            <>
              <Button size="sm" variant={showGrid ? 'secondary' : 'ghost'} onClick={() => setShowGrid((v) => !v)}>
                GRID
              </Button>
              <Button
                size="sm"
                variant={showReports ? 'secondary' : 'ghost'}
                onClick={() => setShowReports((v) => !v)}
                title="Resident reports — filled if the wind is carrying toward them"
              >
                REPORTS
              </Button>
              <Button size="sm" variant={showWind ? 'secondary' : 'ghost'} onClick={() => setShowWind((v) => !v)}>
                WIND
              </Button>
              <Button
                size="sm"
                variant={showPermit ? 'secondary' : 'ghost'}
                onClick={() => setShowPermit((v) => !v)}
                title="The consultant's permit study — a long-run average footprint for the whole site"
              >
                PERMIT
              </Button>
              <Button
                size="sm"
                variant={showPlume ? 'secondary' : 'ghost'}
                onClick={() => setShowPlume((v) => !v)}
                title="This hour's modelled cone from each running stack"
              >
                PLUME
              </Button>
              <Button
                size="sm"
                variant={locked ? 'secondary' : 'ghost'}
                onClick={() => setLocked(true)}
                title="Re-centre on your site"
              >
                {locked ? 'LOCKED' : 'LOCK'}
              </Button>
            </>
          }
          bodyClass={s.scopeWrap}
        >
          <BaseMap
            view={view}
            onViewChange={handleView}
            layers={mfdLayers}
            /* One surface, one meaning: a click says "tell me about that".
               Layers that carry their own onClick (reports, contacts) resolve
               first; everything else is classified by the layer it came from. */
            onClick={(info) => {
              const obj = info.object as Record<string, unknown> | null
              if (!obj) { setPick(null); return }
              const lid = String(info.layer?.id ?? '')
              if (lid.startsWith('mfd-reports') || lid.startsWith('mfd-contacts')) return
              if (lid.startsWith('segments')) {
                const id = (obj as unknown as SegmentFeature).properties?.id
                if (id) setPick({ kind: 'segment', id })
              } else if (lid.startsWith('reference') || lid.startsWith('fenceline')) {
                if (typeof obj.id === 'string') setPick({ kind: 'monitor', id: obj.id })
              } else if (lid.startsWith('sites')) {
                // SiteLayer picks a footprint, a stack, or the brand badge, and
                // each is a different shape — reading `obj.id` alone silently
                // dropped every click on the campus polygon, which is the
                // largest target on the screen.
                const { siteId, emissionPointId } = pickedSite(obj)
                if (emissionPointId) setPick({ kind: 'emission', id: emissionPointId })
                else if (siteId) setPick({ kind: 'site', id: siteId })
              }
            }}
            minZoom={10}
            maxZoom={18}
            label={`Moving map centred on ${focusName}`}
            fullBleed={showWind ? (
              <MapWindField field={windQ.data} particles={700} opacity={0.42} lineWidth={1} />
            ) : null}
          >
            {/* Slew-to-designate: your buildings and every stack on them.
                Beside it, the channel everything on the map is reading. Two
                chips, same idiom: one says where you are looking, one says
                what you are looking at. */}
            <MapOverlay place="top-left">
              <div className={s.mfdPicks}>
                <label className={s.sourcePick}>
                  <span className={s.sourcePickCaps}>slew to</span>
                  <select
                    className={s.sourceSelect}
                    value={focusEp ?? ''}
                    onChange={(e) => { setFocusEp(e.target.value || null); setLocked(true) }}
                  >
                    <option value="">Whole site</option>
                    {site.emission_points.map((ep) => (
                      <option key={ep.id} value={ep.id}>
                        {epShort(ep.name)}{ep.active ? '' : ' · idle'}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={s.sourcePick}>
                  <span className={s.sourcePickCaps}>channel</span>
                  <select
                    className={s.sourceSelect}
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
            </MapOverlay>

            <MapOverlay place="bottom-left">
              <div className={s.mapKey}>
                <Caps>
                  rings 1 · 2 · 4 · 6 km from {focusName}
                  {contacts.length ? ` · ${contacts.length} alert${contacts.length === 1 ? '' : 's'} nearby` : ' · nothing nearby'}
                </Caps>
                {showGrid && (
                  <Caps>
                    streets — {shortName(measureDef)}
                    {isIndex
                      ? ' · colour fixed 0–60, where 60 is the top of the Moderate band'
                      : `${unitFor(measureDef) ? ` in ${unitFor(measureDef)}` : ''}, colour stretched to what is in view`}
                    {' · width is how often'}
                  </Caps>
                )}
                {showReports && (
                  <Caps>
                    reports — filled is downwind of you, hollow is off your axis
                    {downwindReports ? ` · ${downwindReports} downwind now` : ''}
                  </Caps>
                )}
                {(showPermit || showPlume) && (
                  <Caps>
                    {showPermit ? 'permit — the study\u2019s long-run average, all wind directions' : ''}
                    {showPermit && showPlume ? ' · ' : ''}
                    {showPlume ? `plume — this hour, modelled${plumeSpecies ? ` · ${plumeSpecies}, not the picked channel` : ''}` : ''}
                  </Caps>
                )}
                {showPlume && plumeRead ? <Caps>{plumeRead}</Caps> : null}
              </div>
            </MapOverlay>
          </BaseMap>
        </Panel>

        <div className={s.selected}>
          <Selected
            pick={pick}
            onClear={() => setPick(null)}
            now={now}
            site={site}
            measure={measureDef}
            reports={reports}
            contacts={contacts}
            monitors={monitorsQ.data ?? []}
            segments={segsQ.data?.features ?? []}
            geo={(lon: number, lat: number) => bearingFrom(site.centroid, lon, lat)}
          />
        </div>
        </div>

        {/* how hard can this campus still run, and where is the air going */}
        <div className={s.instruments}>
          <Panel title="Margin">
            <div className={s.gauges}>
              {/* Not "envelope used" out of a notional 100. The gauge is how
                  much of THIS SITE's own contribution the air has room for
                  tonight — 0% means run as you are, 100% means none of it. */}
              <Gauge
                label="Cut needed tonight"
                value={envStable?.cutPct ?? null}
                max={100}
                redline={20}
                over={Boolean(envStable?.binding)}
                readout={
                  envStable == null || envStable.cutPct == null
                    ? (envStable?.state === 'insufficient' ? 'n/a' : '0%')
                    : `${fmtNum(envStable.cutPct, 0)}%`
                }
                sub="in stable air"
              />
              <Gauge
                label="Worst vs limit"
                value={nearest.ratio}
                max={ratioMax}
                redline={1}
                over={(nearest.ratio ?? 0) >= 1}
                readout={nearest.ratio == null ? '—' : `${fmtNum(nearest.ratio, 2)}×`}
                sub={nearestWhere}
              />
            </div>
            {/* Both readings, because the whole point is that they differ:
                the air out there now, and the air on the nights that bind. */}
            <div className={s.gaugeFoot}>
              {envelope ? `Now · ${envelope.detail}` : 'Envelope not yet characterised for this site.'}
            </div>
            {envStable && envStable.regime !== envelope?.regime ? (
              <div className={s.gaugeFoot}>
                {`Stable air · ${envStable.detail} That is ${fmtPct(envStable.shareOfHours * 100, 0, false)} of hours.`}
              </div>
            ) : null}
            {envQ.data ? (
              <div className={s.gaugeFoot}>
                <Caps>{envQ.data.headroom_is_modelled}</Caps>
              </div>
            ) : null}
          </Panel>

          {/* the operator's real question: who is downwind of me right now */}
          <Panel title="Observed wind · who is downwind">
            {/* Not "am I over a limit" — the fenceline exists so they never get
                that far — but "is the wind pointing me at a regulator's
                instrument this shift". That is what a hold-the-load decision
                actually turns on. */}
            <div
              className={`${s.strip} ${exposed ? s.stripAlarm : ''}`}
              style={{ borderTop: 0 }}
            >
              <Tag tone={exposed ? 'threat' : 'accent'}>
                {exposed ? 'downwind' : 'clear'}
              </Tag>
              {exposed ? (
                <>
                  <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                    {exposed.monitor.name.toUpperCase()}
                  </span>
                  <span className={`${s.bannerSub} num`}>
                    {fmtDistance(exposed.distanceM, 1)} · {fmtBearing(exposed.bearing)}
                    {' · '}{fmtNum(exposed.offAxis, 0)}° off the plume track
                  </span>
                </>
              ) : (
                <span className={s.bannerSub}>
                  No reference instrument is in your plume track right now.
                </span>
              )}
              <span className={s.spacer} />
              <Caps>
                {downwind.length > 1 ? `+${downwind.length - 1} also downwind` : `${reference.length} in network`}
              </Caps>
            </div>
            <div className={s.strip}>
              <Tag tone="accent">wind</Tag>
              <span className="num" style={{ fontSize: 'var(--text-sm)' }}>
                FROM {fmtBearing(wind?.dir_deg ?? null)} @ {fmtNum(wind?.speed_ms, 1)} m/s
              </span>
              <span className={s.bannerSub}>
                plume toward {compassPoint(((wind?.dir_deg ?? 0) + 180) % 360)}
              </span>
              <span className={s.spacer} />
              <Caps>
                {windQ.data
                  ? `72 h · ${fmtCompact(windQ.data.n_obs)} fleet obs · ${fmtNum(windQ.data.cells.length, 0)} cells`
                  : 'no field'}
              </Caps>
            </div>
            {verify ? (
              <Link
                to={windAlert ? `/industry/alerts/${windAlert.id}` : '/industry/site'}
                className={`${s.strip} ${s.stripLink}`}
              >
                <Tag tone={verify.verdict === 'understates' ? 'threat' : undefined}>
                  {verify.verdict === 'understates' ? 'model understates' : verify.verdict}
                </Tag>
                <span className={s.bannerSub} style={{ minWidth: 0 }}>
                  {verify.bearing_bias.length
                    ? (() => {
                        const w = [...verify.bearing_bias].sort((a, b) => b.delta - a.delta)[0]
                        return `${compassPoint(w.dir_deg)} assumed ${fmtNum(w.assumed_freq, 1)}% · measured ${fmtNum(w.observed_freq, 1)}%`
                      })()
                    : 'no comparison'}
                </span>
                <span className={s.spacer} />
                <Caps>{fmtCompact(verify.n_obs)} obs →</Caps>
              </Link>
            ) : null}
          </Panel>
        </div>

        <div className={s.stack} style={{ minHeight: 0 }}>
          {/* the one-second instrument: bearing, range, nothing else */}
          <Panel
            title="Proximity"
            aside={<Caps>{contacts.length ? `worst ${fmtBearing(worst?.bearing ?? null)}` : 'clear'}</Caps>}
          >
            <div className={s.rwrWrap}>
              <RadarScope
                contacts={radarContacts}
                size={160}
                site={site.centroid}
                modelContours={model?.contours ?? null}
                /* Name which of the two dispersion pictures this outline is —
                   the scope carries the permit study, the MFD carries today. */
                modelLabel="Permit footprint · annual"
                ownLabel={site.name}
                selectedId={pick?.kind === 'alert' ? pick.id : null}
                onSelect={(id) => setPick(id ? { kind: 'alert', id } : null)}
                rangeCurve="sqrt"
                labels="none"
              />
            </div>
          </Panel>

          {/* worst first, one click to the answer */}
          <Panel
            title="Alerts"
            aside={<Caps>{contacts.length ? severityCountLine(counts) : 'none'}{folded ? ` · +${folded} folded` : ''}</Caps>}
            className={s.stackGrow}
          >
            {alertsQ.isError ? (
              <div className={s.err}>Alert feed unavailable.</div>
            ) : contacts.length === 0 ? (
              <div className={s.err}>Nothing above an action level near this site right now.</div>
            ) : (
              <div className={s.contacts}>
                <div className={s.contactHead} aria-hidden>
                  <span /><span>src</span><span>source</span><span>brg</span><span>range</span><span>up for</span>
                </div>
                {contacts.map((c) => (
                  <button
                    key={c.alert.id}
                    type="button"
                    className={`${s.contact}${pickedId === c.alert.id ? ` ${s.contactActive}` : ''}`}
                    onMouseEnter={() => setPick({ kind: 'alert', id: c.alert.id })}
                    onFocus={() => setPick({ kind: 'alert', id: c.alert.id })}
                    onClick={() => navigate({ to: `/industry/alerts/${c.alert.id}` })}
                    title={c.alert.title}
                  >
                    <span
                      className={s.contactGlyph}
                      style={{ color: severityVar(c.alert.severity) }}
                      aria-label={SEVERITY_LABEL[c.alert.severity]}
                    >
                      {c.glyph}
                    </span>
                    <span className={s.contactCode}>{c.alert.measure ? c.alert.measure.toUpperCase() : c.code}</span>
                    <span className={s.contactName}>{shortTitle(c.alert)}</span>
                    <span className={`${s.contactNum} num`}>{fmtBearing(c.bearing).split(' ')[1]}</span>
                    <span className={`${s.contactNum} num`}>{fmtDistance(c.distance, 1)}</span>
                    <span className={`${s.contactAge} num`}>
                      {relativeShort(c.alert.started_at, now)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>

        </div>
      </div>

      {/* ── how long has each contact been up ───────────────────────────── */}
      <div className={s.ribbon}>
        <ContactRibbon
          alerts={contacts.map((c) => c.alert)}
          selected={pick?.kind === 'alert' ? pick.id : null}
          onSelect={(id) => setPick(id ? { kind: 'alert', id } : null)}
        />
      </div>
    </div>
  )
}

/* The duration channel: a contact that has been up for six hours is a different
   problem from one that appeared four minutes ago, and that is a shape. */
function ContactRibbon({
  alerts, selected, onSelect,
}: {
  alerts: Alert[]
  selected: string | null
  onSelect(id: string | null): void
}) {
  const rows = useMemo(
    () => alerts.map((a) => ({
      id: a.id,
      label: a.measure ? `${a.measure.toUpperCase()} ${shortTitle(a)}` : shortTitle(a),
      severity: a.severity,
      startedAt: a.started_at,
      endedAt: a.ended_at,
      acknowledged: a.status === 'acknowledged',
    })),
    [alerts],
  )
  if (!rows.length) return null
  return (
    <Panel title="Alert history · how long each has been up">
      <AlertTimeline
        alerts={rows}
        rowHeight={14}
        maxRows={6}
        labels={false}
        selectedId={selected}
        onSelect={onSelect}
        style={{ padding: '2px 8px 6px' }}
      />
    </Panel>
  )
}

/** "Turbine bank A (4 x 14.6 MW)" → "TURBINE BANK A". */
function epShort(name: string): string {
  const head = name.split(' (')[0].trim()
  return (head.length > 18 ? `${head.slice(0, 17)}\u2026` : head).toUpperCase()
}
