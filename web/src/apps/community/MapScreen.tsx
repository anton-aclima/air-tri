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
  makeColorScale,
  usePulse,
} from '@/components'
import { relativeTime } from '@/core/format'
import { PICKABLE, plainName } from '@/core/measures'
import {
  useActiveMeasure,
  useConcernClusters,
  useConcerns,
  useFleet,
  useFlags,
  useMeasures,
} from '@/core/queries'
import { resolveNow, useSession, useTime } from '@/core/session'
import type { ConcernKind, MeasureCode, Position } from '@/core/types'

const NEAR_RADIUS_M = 1600

export function MapScreen() {
  const time = useTime()
  const now = resolveNow(time)
  const places = usePlaces()
  const pulse = usePulse(2400)

  const segments = useCommunitySegments().data
  const concerns = useConcerns({ limit: 200 }).data ?? []
  const clusters = useConcernClusters().data ?? []
  const fleet = useFleet().data ?? []
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
  const [selected, setSelected] = useState<string | null>(null)

  const rows = useMemo(() => {
    return concerns
      .map((c) => ({ c, d: distanceFromHome(c, places.home) }))
      .filter(({ c, d }) => (!nearOnly || d <= NEAR_RADIUS_M) && (!kindFilter || c.kind === kindFilter))
      .sort((a, b) => (nearOnly ? a.d - b.d : +new Date(b.c.occurred_at) - +new Date(a.c.occurred_at)))
  }, [concerns, places.home, nearOnly, kindFilter])

  const shown = rows.map((r) => r.c)

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
            onClick={(info) => {
              const id = (info.object as { id?: string } | null)?.id
              setSelected(id ?? null)
            }}
            layers={(t) => [
              ...SegmentLayer({
                data: segments,
                theme: t,
                metric: 'risk',
                scale: makeColorScale(t, { domain: [0, 100], ramp: 'aqi' }),
                dualEncode: 'width',
                minPasses: 8,
                widthMinPixels: 1.4,
                pickable: false,
              }),
              ...(showCars
                ? FleetLayer({ data: fleet, theme: t, pulse, labels: true, trails: true })
                : []),
              ...ConcernLayer({
                data: shown,
                clusters,
                theme: t,
                pulse,
                selectedId: selected,
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

        <div className={s.mapSide}>
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
                  className={[s.concernRow, selected === c.id ? s.concernRowActive : ''].join(' ')}
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
                          setSelected(c.id)
                          flyTo([c.lon, c.lat] as Position, 15)
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
                    onClick={() => flyTo(cl.centroid, 15)}
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
            <h2 className={s.railTitle}>Reading the colours</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              <RiskPill risk={10} label="Clean" />
              <RiskPill risk={30} label="Fair" />
              <RiskPill risk={50} label="Moderate" />
              <RiskPill risk={75} label="High" />
            </div>
            <div className={s.railFoot}>
              A score out of 100 for {measure ? plainName(measure, 'community') : 'the air'}. No
              units, no acronyms — the same scale on every screen here.
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
