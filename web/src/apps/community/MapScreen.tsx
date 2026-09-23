/**
 * community — the map. Your streets, block by block.
 *
 * The road grid is the hero: every ~200 m of street we drove, coloured on the
 * public-health ramp so green really does mean clean. Neighbours' reports sit
 * on top as pins, and a group of them gets a halo.
 */

import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'

import s from '@/apps/community/community.module.css'
import {
  distanceFromHome,
  kindEmoji,
  kindLabel,
  nearWords,
  PRIMARY_KINDS,
  severityWord,
  statusPlain,
  useCommunitySegments,
  usePlaces,
} from '@/apps/community/lib'
import { DelayNote, FootNote, RiskPill, SimNote } from '@/apps/community/parts'
import { Picked } from '@/apps/community/Picked'
import { Plume, latestClusterOf } from '@/apps/community/Plume'
import type { PlumeMode } from '@/apps/community/Plume'
import type { MapPick } from '@/apps/community/Picked'
import { Badge, Button, Chip, Empty, Toggle } from '@/app/ui'
import {
  BaseMap,
  ConcernLayer,
  FleetLayer,
  MapLegend,
  MapOverlay,
  MapScale,
  MeasurePicker,
  SegmentLayer,
  SiteLayer,
  SoftPlumeLayer,
  makeColorScale,
  pickedSite,
  pointInRing,
  usePulse,
} from '@/components'
import { relativeTime } from '@/core/format'
import { PICKABLE, plainName } from '@/core/measures'
import {
  useActiveMeasure,
  useBootstrapSites,
  useConcernClusters,
  useConcerns,
  useDispersion,
  useFleet,
  useFlags,
  useMeasures,
} from '@/core/queries'
import { resolveNow, useSession, useTime } from '@/core/session'
import type { ConcernKind, MeasureCode, Position } from '@/core/types'

const NEAR_RADIUS_M = 1600

export function MapScreen() {
  // Climatology is the default and the only mode that draws nothing. See
  // `Plume` for why the live cloud is a tap behind rather than the front door.
  const [plumeMode, setPlumeMode] = useState<PlumeMode>('usually')
  const time = useTime()
  const now = resolveNow(time)
  const places = usePlaces()
  const pulse = usePulse(2400)

  const segments = useCommunitySegments().data
  const concerns = useConcerns({ limit: 200 }).data ?? []
  const clusters = useConcernClusters().data ?? []
  const fleet = useFleet().data ?? []
  // Only fetched when a cloud mode is on. `usually` is the default and draws
  // nothing, so a resident who never taps never requests a modelled shape.
  //
  // In `when` mode the fetch is pinned to the hour the cluster of reports
  // landed — the same cluster the card names. Without that the card said
  // "where the air was going when your neighbours reported" over a map drawing
  // the plume for right now.
  const frozenAt = plumeMode === 'when' ? (latestClusterOf(clusters)?.last_at ?? undefined) : undefined
  const dispersion = useDispersion(
    frozenAt ? { at: frozenAt } : {},
    { enabled: plumeMode !== 'usually' && (plumeMode !== 'when' || !!frozenAt) },
  )
  /**
   * Industrial sites, shown to residents.
   *
   * They were absent from this map and present in Outreach, which was an
   * inconsistency rather than a policy — nothing in the contract withholds them,
   * and facility locations are public record. Hiding the emitter from the one
   * party living downwind of it is the least defensible omission the product
   * could make: a resident looking at a red street with no visible source cannot
   * even form a question. The care goes into the wording, not the withholding —
   * see the `site` branch in Picked.
   */
  const sites = useBootstrapSites()
  const delayMin = useFlags()?.community_fleet_delay_min ?? 180

  // PICKABLE, not 'modality': the overall health score is the lens this screen
  // exists to show a resident, and it is a composite rather than a species.
  const measures = useMeasures(PICKABLE)
  const measure = useActiveMeasure()
  const setMeasure = useSession((st) => st.setMeasure)
  const flyTo = useSession((st) => st.flyTo)
  const mapView = useSession((st) => st.mapView)

  /**
   * The session camera is shared with the other three interfaces, so frame it
   * for a resident once on arrival: home neighbourhood plus every report.
   */
  const framed = useRef(false)
  const setMapView = useSession((st) => st.setMapView)
  useEffect(() => {
    if (framed.current || !concerns.length) return
    framed.current = true
    const lons = [places.home[0], ...concerns.map((c) => c.lon)]
    const lats = [places.home[1], ...concerns.map((c) => c.lat)]
    setMapView({
      longitude: (Math.min(...lons) + Math.max(...lons)) / 2,
      latitude: (Math.min(...lats) + Math.max(...lats)) / 2,
      zoom: 12.1,
      pitch: 0,
      bearing: 0,
    })
  }, [concerns, places.home, setMapView])

  const [nearOnly, setNearOnly] = useState(false)
  const [kindFilter, setKindFilter] = useState<ConcernKind | null>(null)
  const [showCars, setShowCars] = useState(true)
  const [showSites, setShowSites] = useState(true)
  /**
   * ONE selection for the whole map. Previously this was a bare concern id
   * whose only effect was moving a highlight into a rail list that was usually
   * scrolled elsewhere — so a tap appeared to do nothing at all. Streets were
   * not even pickable.
   */
  const [pick, setPick] = useState<MapPick | null>(null)
  const railRef = useRef<HTMLDivElement>(null)

  /**
   * Put the card where the eye already is. Selecting from the map means the
   * answer must come to you; a card that renders above the fold of a scrolled
   * rail is the same bug in a nicer costume.
   */
  const choose = (next: MapPick | null) => {
    setPick(next)
    if (next) railRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const rows = useMemo(() => {
    return concerns
      .map((c) => ({ c, d: distanceFromHome(c, places.home) }))
      .filter(({ c, d }) => (!nearOnly || d <= NEAR_RADIUS_M) && (!kindFilter || c.kind === kindFilter))
      .sort((a, b) => (nearOnly ? a.d - b.d : +new Date(b.c.occurred_at) - +new Date(a.c.occurred_at)))
  }, [concerns, places.home, nearOnly, kindFilter])

  const shown = rows.map((r) => r.c)

  /*
    P6-E — "what we measured under the cloud", and how it degrades.

    The count is only meaningful if enough of the neighbourhood was driven in
    the window: hour-window coverage runs 90 to 407 of 1,307 segments, so this
    can be computed from a handful of streets and read as though the whole area
    had been checked. `Plume` holds the floor and shows the honest sentence
    instead of a small number — the failure to avoid is not a wrong count, it
    is a right count that sounds like coverage.

    Memoised on the plume payload and the segment list rather than recomputed
    per render: this is point-in-polygon over ~1,300 midpoints, and the time
    cursor ticks.
  */
  const measuredStreets = useMemo(() => {
    const feats = dispersion.data?.features ?? []
    const segs = segments?.features ?? []
    if (!feats.length || !segs.length) return null
    // The OUTER band only. The bands nest, so testing all three would count
    // the same street up to three times.
    const outer = Math.max(...feats.map((f) => f.properties.band ?? 0))
    const rings = feats
      .filter((f) => (f.properties.band ?? 0) === outer)
      .map((f) => f.geometry.coordinates[0] as unknown as Position[])
    let n = 0
    for (const seg of segs) {
      const line = seg.geometry.coordinates
      const mid = line[Math.floor(line.length / 2)]
      if (!mid) continue
      if (rings.some((r) => pointInRing(r, mid as Position))) n += 1
    }
    return n
  }, [dispersion.data, segments])

  return (
    <div className={[s.page, s.pageWide].join(' ')}>
      <SimNote />

      <header style={{ marginBottom: 'var(--s-4)' }}>
        <h1 className={s.hello}>Your streets, block by block</h1>
        <p className={s.helloSub}>
          Every coloured line is about two hundred metres of real street that our cars have driven
          over and over. Green is clean; orange and red are the streets worth asking about. Pins are
          reports from people who live here.
        </p>
      </header>

      <div className={s.mapLayout}>
        <div className={s.mapFrame}>
          <BaseMap
            label="Neighbourhood air map"
            initialView={{ longitude: places.home[0], latitude: places.home[1], zoom: 12.4 }}
            view={mapView}
            onViewChange={(v) => useSession.getState().setMapView(v)}
            /**
             * Classify by which layer answered. deck hands back the topmost
             * pickable object, so the layer id is the only reliable way to know
             * whether that was a report, a group or a street.
             */
            onClick={(info) => {
              const layer = info.layer?.id ?? ''
              const obj = info.object as { id?: string; properties?: { id?: string } } | null
              if (!obj) return choose(null)
              if (layer.startsWith('concerns-cluster')) {
                return choose(obj.id ? { kind: 'cluster', id: obj.id } : null)
              }
              if (layer.startsWith('concerns')) {
                return choose(obj.id ? { kind: 'concern', id: obj.id } : null)
              }
              if (layer.startsWith('sites')) {
                // The footprint, the badge and a stack each hand back a
                // different shape; only the badge has a bare `id`.
                const { siteId } = pickedSite(obj)
                return choose(siteId ? { kind: 'site', id: siteId } : null)
              }
              if (layer.startsWith('segments')) {
                const sid = obj.properties?.id
                return choose(sid ? { kind: 'street', id: sid } : null)
              }
              return choose(null)
            }}
            layers={(t) => [
              /* UNDER EVERYTHING, and only in the two cloud modes. `usually`
                 draws nothing at all, which is the point of it being the
                 default. The cloud is a guess and the coloured streets are
                 measurements; a guess is never drawn on top of a measurement. */
              ...(plumeMode === 'usually'
                ? []
                : SoftPlumeLayer({
                    data: dispersion.data,
                    theme: t,
                    zoom: mapView?.zoom ?? 12.4,
                  })),
              ...SegmentLayer({
                data: segments,
                theme: t,
                metric: 'risk',
                measure: measure?.code,
                scale: makeColorScale(t, { domain: [0, 100], ramp: 'aqi' }),
                dualEncode: 'width',
                minPasses: 8,
                widthMinPixels: 1.4,
                // Was false, which is why tapping a road did nothing. The road
                // grid is the hero of this screen; it has to answer.
                pickable: true,
                selectedId: pick?.kind === 'street' ? pick.id : null,
              }),
              /* Under the reports on purpose. A site footprint is a polygon
                 big enough to swallow every pin standing on it, and deck hands
                 back the topmost layer — drawn last, it would eat their clicks.
                 Emission points are off: stack-level detail is not a resident's
                 question, and pulsing stacks read as "emitting right now",
                 which is a claim this screen does not get to make. */
              ...(showSites
                ? SiteLayer({
                    data: sites,
                    theme: t,
                    emissionPoints: false,
                    labels: true,
                    selectedId: pick?.kind === 'site' ? pick.id : null,
                  })
                : []),
              ...(showCars
                ? FleetLayer({ data: fleet, theme: t, pulse, labels: true, trails: true })
                : []),
              ...ConcernLayer({
                data: shown,
                clusters,
                theme: t,
                pulse,
                selectedId: pick?.kind === 'concern' ? pick.id : null,
              }),
            ]}
          >
            <MapOverlay place="top-right">
              <MapLegend
                measure={measure ?? null}
                metric="risk"
                dualEncode="width"
                plainLanguage
                compact
                title="How your street scores"
              />
            </MapOverlay>
            <MapOverlay place="bottom-left">
              <MapScale units="imperial" />
            </MapOverlay>
            <MapOverlay place="top-left">
              <MeasurePicker
                measures={measures}
                value={(measure?.code ?? 'no2') as MeasureCode}
                onChange={(c) => setMeasure(c)}
                variant="select"
                plainLanguage
                showUnit={false}
                label="What to show"
              />
            </MapOverlay>
          </BaseMap>
        </div>

        <div className={s.mapSide} ref={railRef}>
          <Picked
            pick={pick}
            onClear={() => setPick(null)}
            now={now}
            home={places.home}
            concerns={concerns}
            clusters={clusters}
            segments={segments?.features ?? []}
            sites={sites}
            measureName={measure ? plainName(measure, 'community') : 'the air'}
          />

          {/*
            THE FRONT DOOR, directly under whatever is picked and above the
            filters. Climatology first: one stable sentence per place, no shape
            drawn over anyone. The live cloud is a tab inside this card, not a
            layer that arrives unasked.
          */}
          <Plume
            sites={sites}
            clusters={clusters}
            mode={plumeMode}
            onMode={setPlumeMode}
            measuredStreets={measuredStreets}
            now={now}
          />

          <section className={s.railCard}>
            <h2 className={s.railTitle}>Filter the pins</h2>
            <div className={s.filters}>
              <Chip active={!kindFilter} onClick={() => setKindFilter(null)} small>
                Everything
              </Chip>
              {PRIMARY_KINDS.map((k) => (
                <Chip
                  key={k}
                  small
                  active={kindFilter === k}
                  onClick={() => setKindFilter(kindFilter === k ? null : k)}
                >
                  {kindEmoji(k)} {kindLabel(k)}
                </Chip>
              ))}
            </div>
            <div style={{ marginTop: 'var(--s-3)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <Toggle
                checked={nearOnly}
                onChange={setNearOnly}
                label={`Only near ${places.homeName}`}
              />
              <Toggle checked={showCars} onChange={setShowCars} label="Show where our cars were" />
              <Toggle checked={showSites} onChange={setShowSites} label="Show industrial places" />
            </div>
            <div className={s.railFoot}>
              <DelayNote minutes={delayMin} />
            </div>
          </section>

          <section className={s.railCard}>
            <h2 className={s.railTitle}>
              {shown.length} {shown.length === 1 ? 'report' : 'reports'}
              {nearOnly ? ` near ${places.homeName}` : ''}
            </h2>
            <div className={s.railList}>
              {shown.length === 0 ? (
                <Empty
                  icon="report"
                  title="Nothing here yet"
                  children="No reports match that filter. Try widening it."
                />
              ) : null}
              {rows.map(({ c, d }) => (
                <div
                  key={c.id}
                  className={[
                    s.concernRow,
                    pick?.kind === 'concern' && pick.id === c.id ? s.concernRowActive : '',
                  ].join(' ')}
                >
                  <span style={{ fontSize: '1.3rem', lineHeight: 1 }} aria-hidden>
                    {c.photo_emoji ?? kindEmoji(c.kind)}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span className={s.concernRowTitle}>{c.title}</span>
                    <span className={s.concernRowMeta}>
                      <span>
                        {[kindLabel(c.kind), severityWord(c.severity), relativeTime(c.occurred_at, now)].join(
                          ' · ',
                        )}
                      </span>
                    </span>
                    <span className={s.concernRowMeta}>
                      <span>{nearWords(d)}</span>
                      {c.cluster_id ? (
                        <Badge tone="accent">Grouped with nearby reports</Badge>
                      ) : (
                        <span>{statusPlain(c.status).label}</span>
                      )}
                    </span>
                    <span
                      style={{
                        display: 'flex',
                        gap: 'var(--s-3)',
                        alignItems: 'center',
                        marginTop: 6,
                      }}
                    >
                      <Button
                        size="sm"
                        variant="quiet"
                        icon="pin"
                        onClick={() => {
                          choose({ kind: 'concern', id: c.id })
                          // 14, not 15. At 15 a single report fills the frame
                          // and the streets around it — the reason the report
                          // matters — go off the edge.
                          flyTo([c.lon, c.lat] as Position, 14)
                        }}
                      >
                        Show me
                      </Button>
                      <Link to={`/community/c/${c.id}`} style={{ fontSize: 'var(--text-xs)' }}>
                        Open the thread
                      </Link>
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </section>

          {clusters.length ? (
            <section className={s.railCard}>
              <h2 className={s.railTitle}>Groups forming</h2>
              <div className={s.railList}>
                {clusters.map((cl) => (
                  <button
                    key={cl.id}
                    type="button"
                    className={s.railRow}
                    onClick={() => {
                      choose({ kind: 'cluster', id: cl.id })
                      // A group spans a few blocks by definition, so it needs
                      // more room than a single pin, not less.
                      flyTo(cl.centroid, 13.4)
                    }}
                  >
                    <span>
                      <span className={s.railRowName}>📍 {cl.label ?? 'Nearby reports'}</span>
                      <span className={s.railRowSub}>
                        {cl.count} reports · {cl.kinds.map(kindLabel).join(', ').toLowerCase()} ·
                        newest {relativeTime(cl.last_at, now)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
              <div className={s.railFoot}>
                Three or more reports within a few blocks in a day become a group. Groups show up in
                the air agency&rsquo;s queue and on the operator&rsquo;s own screen.
              </div>
            </section>
          ) : null}

          <section className={s.railCard}>
            <h2 className={s.railTitle}>Reading the map</h2>

            <div className={s.railSubLabel}>The coloured lines are streets</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <RiskPill risk={10} label="Clean" />
              <RiskPill risk={30} label="Fair" />
              <RiskPill risk={50} label="Moderate" />
              <RiskPill risk={75} label="High" />
            </div>
            <div className={s.railFoot} style={{ marginBlockEnd: 'var(--s-3)' }}>
              A score out of 100 for {measure ? plainName(measure, 'community') : 'the air'}. No
              units, no acronyms — the same scale on every screen here. A thicker line means the
              air was bad there more often, not just worse once.
            </div>

            {/* The pin colours carry the most consequential fact on this screen
                — whether anybody has picked the report up — and until now they
                were explained nowhere at all. They are the actor hues, which is
                an insider concept; say it in plain words instead. Kept in step
                with `concernStatusToken` in ConcernLayer.ts. */}
            <div className={s.railSubLabel}>The pins are your neighbours’ reports</div>
            <div className={s.pinKey}>
              {[
                ['actor-community', 'Nobody has answered it yet'],
                ['actor-regulator', 'The air agency is looking into it'],
                ['actor-industry', 'A company has replied'],
                ['sev-ok', 'Closed by the agency'],
              ].map(([token, what]) => (
                <span key={token} className={s.pinKeyRow}>
                  <span
                    className={s.pinKeySwatch}
                    style={{ color: `var(--${token})` }}
                    aria-hidden
                  />
                  <span>{what}</span>
                </span>
              ))}
            </div>
            <div className={s.railSubLabel}>The outlined blocks are industrial places</div>
            <div className={s.railFoot} style={{ marginBlockEnd: 'var(--s-3)' }}>
              Where they are, not a finding about them. Tap one to read what it is and who runs
              it. Air moves with the wind, so being near something is not evidence it caused
              anything.
            </div>

            <div className={s.railFoot}>
              The shape inside a pin is what was reported — a smell, a noise, smoke. A bigger pin
              means the person who reported it said it was worse. A ring around several pins means
              they became a group. Tap anything to read it.
            </div>
          </section>
        </div>
      </div>

      <FootNote>
        Car positions are delayed by at least three hours on purpose, so nobody can use this page to
        follow a vehicle. Streets and neighbourhood names are real; the reports, people and
        companies are invented for this demonstration.
      </FootNote>
    </div>
  )
}
