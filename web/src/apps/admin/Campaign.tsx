/**
 * SHEET 02 — /admin/campaign · Draw the boundary.
 *
 * Step one of the whole product. The admin draws one or more polylines on the
 * map; everything the other three interfaces lock onto derives from what is
 * inside them. So the screen is not a form with a map on it — it is a drawing
 * surface with a live bill of quantities in the margin: vertices, perimeter,
 * enclosed area, and — the number that matters — how much of the road network
 * the line just captured.
 *
 * The backend has no boundary-write endpoint, so a draft stays on the drafting
 * table. It still travels: sheet 03 plans against whatever is drawn here.
 */

import { useCallback, useMemo, useState } from 'react'
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers'
import type { LayersList, PickingInfo } from 'deck.gl'

import { BaseMap, BoundaryLayer, MapOverlay, MapScale, SegmentLayer } from '@/components'
import type { Theme } from '@/components'
import { Button, Slider, Toggle } from '@/app/ui'
import { fmtCompact, fmtNum } from '@/core/format'
import {
  useCampaignBoundary, useCampaignInfo, useCampaignStats, useSegments,
} from '@/core/queries'
import type { Position, SegmentCollection } from '@/core/types'

import {
  ACTOR_VAR, Caps, Dimension, KV, Readout, Readouts, Sheet, TitleBlock, campaignView,
  daysBetween, enclosedBy, pointInRings, ringAreaM2, ringCentroid, ringPerimeterM,
  styles as s, useDraft,
} from './lib'

export function Campaign() {
  const campaign = useCampaignInfo()
  const stats = useCampaignStats()
  const boundary = useCampaignBoundary(campaign?.id)
  const segments = useSegments({ limit: 2000 })

  const rings = useDraft((x) => x.rings)
  const active = useDraft((x) => x.active)
  const addVertex = useDraft((x) => x.addVertex)
  const undoVertex = useDraft((x) => x.undoVertex)
  const closeRing = useDraft((x) => x.closeRing)
  const clear = useDraft((x) => x.clear)
  const fleetSize = useDraft((x) => x.fleetSize)
  const targetPasses = useDraft((x) => x.targetPasses)
  const setFleet = useDraft((x) => x.setFleet)
  const setTarget = useDraft((x) => x.setTarget)

  const traceCommitted = useDraft((x) => x.traceRing)
  const [drawing, setDrawing] = useState(true)
  const [showGrid, setShowGrid] = useState(true)

  // The committed outline, decimated to a handful of handles — "start from what
  // is already there and edit it" is how a boundary actually gets revised.
  const committedRing = useMemo<Position[] | null>(() => {
    const f = boundary.data?.features?.[0]
    const g = f?.geometry
    if (!g) return null
    const ring = g.type === 'Polygon'
      ? (g.coordinates[0] as unknown as Position[])
      : g.type === 'MultiPolygon'
        ? (g.coordinates[0]?.[0] as unknown as Position[])
        : null
    if (!ring || ring.length < 4) return null
    const step = Math.max(1, Math.round(ring.length / 28))
    return ring.filter((_, i) => i % step === 0)
  }, [boundary.data])

  const hasDraft = rings.length > 0 || active.length > 0
  const allRings = useMemo(
    () => (active.length >= 3 ? [...rings, active] : rings),
    [rings, active],
  )

  const onClick = useCallback((info: PickingInfo) => {
    if (!drawing) return
    const c = info.coordinate
    if (!c || c.length < 2) return
    addVertex([c[0], c[1]] as Position)
  }, [drawing, addVertex])

  // ── the bill of quantities ────────────────────────────────────────────
  const vertices = rings.reduce((a, r) => a + r.length, 0) + active.length
  const perimeterM =
    rings.reduce((a, r) => a + ringPerimeterM(r, true), 0) + ringPerimeterM(active, false)
  const areaM2 = allRings.reduce((a, r) => a + ringAreaM2(r), 0)

  const enclosed = useMemo(
    () => enclosedBy(segments.data, allRings),
    [segments.data, allRings],
  )
  const whole = useMemo(() => enclosedBy(segments.data, []), [segments.data])

  const inside = useMemo<SegmentCollection | null>(() => {
    if (!segments.data || !allRings.length) return null
    return {
      type: 'FeatureCollection',
      features: segments.data.features.filter((f) => {
        const coords = f.geometry?.coordinates ?? []
        if (!coords.length) return false
        const mid = coords[Math.floor(coords.length / 2)] as Position
        return pointInRings(mid, allRings)
      }),
    }
  }, [segments.data, allRings])

  const days = campaign ? daysBetween(campaign.start_date, campaign.end_date) : 0
  const capturePct = whole.segments ? (100 * enclosed.segments) / whole.segments : 0

  return (
    <div className={`${s.page} ${s.rows}`}>
      <TitleBlock
        sheet="campaign"
        subtitle={
          hasDraft
            ? `Draft boundary · ${rings.length} closed ${rings.length === 1 ? 'ring' : 'rings'}${active.length ? ` · 1 open polyline (${active.length} pts)` : ''}`
            : `Committed boundary · ${campaign?.name ?? ''} · click the map to start drawing a new area of concern`
        }
        cells={[
          { label: 'vertices', value: fmtNum(vertices, 0) },
          { label: 'perimeter', value: `${fmtNum(perimeterM / 1000, 2)} km` },
          { label: 'area', value: `${fmtNum(areaM2 / 1e6, 2)} km²` },
          {
            label: 'segments in',
            value: hasDraft ? fmtNum(enclosed.segments, 0) : fmtNum(whole.segments, 0),
            tone: hasDraft ? 'accent' : undefined,
          },
        ]}
      />

      <div className={s.split}>
        {/* ── the drawing surface ─────────────────────────────────────── */}
        <Sheet
          code="02-A"
          title={drawing ? 'Drawing · click to place a vertex' : 'Area of concern'}
          className={s.mapCard}
          flat
          aside={
            <div className={s.toolbar}>
              <Toggle checked={drawing} onChange={setDrawing} label="draw" />
              <Toggle checked={showGrid} onChange={setShowGrid} label="grid" />
            </div>
          }
        >
          <div className={s.mapBox}>
            <BaseMap
              label="Campaign boundary drafting surface"
              cursor={drawing ? 'crosshair' : undefined}
              onClick={onClick}
              initialView={campaignView(campaign, -0.3)}
              layers={(theme) => [
                ...BoundaryLayer({
                  data: boundary.data,
                  theme,
                  mask: !hasDraft,
                  maskStrength: 0.5,
                  glow: !hasDraft,
                  colorToken: hasDraft ? 'line-strong' : 'accent',
                  edgeWidthPx: hasDraft ? 1 : 2,
                }),
                ...(showGrid
                  ? SegmentLayer({
                      id: 'seg-all',
                      data: segments.data,
                      theme,
                      metric: 'persistence',
                      dualEncode: 'none',
                      minPasses: 1,
                      opacity: hasDraft ? 0.3 : 0.95,
                      pickable: false,
                    })
                  : []),
                ...(showGrid && inside
                  ? SegmentLayer({
                      id: 'seg-in',
                      data: inside,
                      theme,
                      metric: 'persistence',
                      dualEncode: 'width',
                      minPasses: 1,
                      pickable: false,
                    })
                  : []),
                ...draftLayers(rings, active, theme),
              ]}
            >
              <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
              <MapOverlay place="top-right">
                <div className={s.overlayCard}>
                  <Caps accent>{hasDraft ? 'draft capture' : 'committed boundary'}</Caps>
                  <div className={s.overlayRow}>
                    <span>segments</span>
                    <span className={s.overlayNum}>
                      {fmtNum(hasDraft ? enclosed.segments : whole.segments, 0)}
                    </span>
                  </div>
                  <div className={s.overlayRow}>
                    <span>road</span>
                    <span className={s.overlayNum}>
                      {fmtNum(hasDraft ? enclosed.km : whole.km, 1)} km
                    </span>
                  </div>
                  <div className={s.overlayRow}>
                    <span>districts</span>
                    <span className={s.overlayNum}>
                      {(hasDraft ? enclosed.districts : whole.districts).length}
                    </span>
                  </div>
                </div>
              </MapOverlay>
              <MapOverlay place="bottom-right">
                <div className={s.toolbar}>
                  <Button
                    size="sm"
                    variant={active.length >= 3 ? 'primary' : 'ghost'}
                    disabled={active.length < 3}
                    onClick={closeRing}
                  >
                    Close ring
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!hasDraft} onClick={undoVertex}>
                    Undo
                  </Button>
                  <Button size="sm" variant="ghost" disabled={!hasDraft} onClick={clear}>
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!committedRing}
                    onClick={() => committedRing && traceCommitted(committedRing)}
                  >
                    Trace committed
                  </Button>
                </div>
              </MapOverlay>
            </BaseMap>
          </div>
        </Sheet>

        {/* ── the margin: quantities, window, targets, consequences ───── */}
        <div className={s.stack} style={{ overflow: 'auto' }}>
          <Sheet
            code="02-B"
            title="Bill of quantities"
            aside={<Caps ink>{hasDraft ? 'draft' : 'as committed'}</Caps>}
          >
            <Readouts>
              <Readout
                label="road captured"
                value={`${fmtNum(hasDraft ? enclosed.km : whole.km, 1)}`}
                foot="km of public road"
                tone="accent"
                size="lg"
              />
              <Readout
                label="segments"
                value={fmtNum(hasDraft ? enclosed.segments : whole.segments, 0)}
                foot={hasDraft ? `${fmtNum(capturePct, 1)}% of the network` : '≈200 m each'}
                size="lg"
              />
              <Readout
                label="passes on them"
                value={fmtCompact(hasDraft ? enclosed.passes : whole.passes, 0)}
                foot="already recorded"
                size="lg"
              />
            </Readouts>
            {hasDraft ? (
              <Dimension
                pct={capturePct}
                label={`${fmtNum(enclosed.segments, 0)} of ${fmtNum(whole.segments, 0)} segments enclosed`}
              />
            ) : null}
            <KV
              wide
              rows={[
                ['rings', `${rings.length} closed${active.length ? ' + 1 open' : ''}`],
                ['vertices', fmtNum(vertices, 0)],
                ['perimeter', `${fmtNum(perimeterM / 1000, 2)} km`],
                ['enclosed area', `${fmtNum(areaM2 / 1e6, 2)} km²`],
                [
                  'districts',
                  (hasDraft ? enclosed.districts : whole.districts).join(', ') || '—',
                ],
                [
                  'centroid',
                  allRings.length
                    ? ringCentroid(allRings[0]).map((v) => fmtNum(v, 4)).join(', ')
                    : campaign
                      ? campaign.center.map((v) => fmtNum(v, 4)).join(', ')
                      : '—',
                ],
              ]}
            />
          </Sheet>

          <Sheet code="02-C" title="Window and targets">
            <div className={s.controls}>
              <div className={s.controlRow}>
                <div className={s.controlTop}>
                  <Caps ink>fleet size</Caps>
                  <span className={s.controlValue}>{fleetSize}</span>
                </div>
                <Slider
                  value={fleetSize}
                  min={1}
                  max={12}
                  step={1}
                  onValueChange={setFleet}
                  aria-label="Fleet size"
                />
                <span className={s.noteDim}>
                  The critical input. Sheet 03 plans against this number.
                </span>
              </div>
              <div className={s.controlRow}>
                <div className={s.controlTop}>
                  <Caps ink>target passes per segment</Caps>
                  <span className={s.controlValue}>{targetPasses}</span>
                </div>
                <Slider
                  value={targetPasses}
                  min={5}
                  max={60}
                  step={5}
                  onValueChange={setTarget}
                  aria-label="Target passes"
                />
                <span className={s.noteDim}>
                  Below ~25 passes a segment's median is too noisy to defend.
                </span>
              </div>
            </div>
            <KV
              wide
              rows={[
                ['start', campaign?.start_date ?? '—'],
                ['end', campaign?.end_date ?? '—'],
                ['duration', `${days} days`],
                ['status', campaign?.status ?? '—'],
                ['committed fleet', `${campaign?.fleet_size ?? '—'} vehicles`],
                ['committed target', `${campaign?.target_passes ?? '—'} passes`],
                [
                  'achieved',
                  stats.data ? `${fmtNum(stats.data.mean_passes, 1)} mean passes` : '—',
                ],
              ]}
            />
          </Sheet>

          <Sheet code="02-D" title="What locks onto this line">
            <div className={s.rowList}>
              <LockRow
                role="community"
                who="Boxtown Air Watch"
                what="Street-level risk scores, the concern map, and which addresses are inside the campaign at all."
              />
              <LockRow
                role="industry"
                who="Operators"
                what="Fenceline rings, bearing and range to every contact, and the safe-envelope arithmetic."
              />
              <LockRow
                role="regulator"
                who="DRAQA"
                what="The domain action levels are evaluated over, and the reference network they are compared against."
              />
            </div>
            <div className={s.pad}>
              <p className={s.note}>
                A draft boundary stays on the drafting table — this prototype has no
                boundary-write endpoint, so the committed campaign is unchanged. Sheet 03
                still plans against whatever is drawn here.
              </p>
            </div>
          </Sheet>
        </div>
      </div>
    </div>
  )
}

function LockRow({
  role, who, what,
}: {
  role: 'community' | 'industry' | 'regulator'
  who: string
  what: string
}) {
  return (
    <div
      className={`${s.row} ${s.rowStatic}`}
      style={{
        gridTemplateColumns: '6px 132px minmax(0, 1fr)',
        alignItems: 'flex-start',
        paddingTop: 'var(--s-2)',
        paddingBottom: 'var(--s-2)',
      }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: '50%',
          background: ACTOR_VAR[role], marginTop: 5,
        }}
      />
      <Caps ink>{who}</Caps>
      <span className={s.noteDim}>{what}</span>
    </div>
  )
}

// ══════════════════════════════════════════ the draft, drawn like a drawing

/**
 * The polyline under the cursor, rendered the way a drafting tool would:
 * a translucent fill, a confident edge, square handles at every vertex, and
 * the length of each drawn edge written on it. Measured lines, not a shape.
 */
function draftLayers(rings: Position[][], active: Position[], theme: Theme): LayersList {
  const accent = theme.color('accent')
  const ink = theme.color('ink')
  const fill: [number, number, number, number] = [accent[0], accent[1], accent[2], 34]
  const layers: LayersList = []

  if (rings.length) {
    layers.push(new SolidPolygonLayer<{ polygon: Position[] }>({
      id: 'draft-fill',
      data: rings.map((r) => ({ polygon: r })),
      getPolygon: (d) => d.polygon,
      getFillColor: fill,
      pickable: false,
    }))
    layers.push(new PathLayer<{ path: Position[] }>({
      id: 'draft-edge',
      data: rings.map((r) => ({ path: [...r, r[0]] })),
      getPath: (d) => d.path,
      getColor: [accent[0], accent[1], accent[2], 255],
      widthUnits: 'pixels',
      getWidth: 2,
      capRounded: true,
      jointRounded: true,
      pickable: false,
    }))
  }

  if (active.length > 1) {
    layers.push(new PathLayer<{ path: Position[] }>({
      id: 'draft-active',
      data: [{ path: active }],
      getPath: (d) => d.path,
      getColor: [accent[0], accent[1], accent[2], 220],
      widthUnits: 'pixels',
      getWidth: 2,
      capRounded: true,
      jointRounded: true,
      pickable: false,
    }))
    // the closing rubber band, thinner — "this is what closing would give you"
    if (active.length > 2) {
      layers.push(new PathLayer<{ path: Position[] }>({
        id: 'draft-close',
        data: [{ path: [active[active.length - 1], active[0]] }],
        getPath: (d) => d.path,
        getColor: [accent[0], accent[1], accent[2], 90],
        widthUnits: 'pixels',
        getWidth: 1,
        pickable: false,
      }))
    }
  }

  const handles = [...rings.flat(), ...active]
  if (handles.length) {
    layers.push(new ScatterplotLayer<Position>({
      id: 'draft-handles',
      data: handles,
      getPosition: (d) => [d[0], d[1]],
      radiusUnits: 'pixels',
      getRadius: 3.4,
      getFillColor: [accent[0], accent[1], accent[2], 255],
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      getLineColor: [ink[0], ink[1], ink[2], 220],
      pickable: false,
    }))
  }

  // dimension labels: how long is each drawn edge
  if (active.length > 1) {
    const dims = active.slice(0, -1).map((p, i) => {
      const q = active[i + 1]
      return {
        position: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Position,
        text: fmtDim(ringPerimeterM([p, q], false)),
      }
    })
    layers.push(new TextLayer<{ position: Position; text: string }>({
      id: 'draft-dims',
      data: dims,
      getPosition: (d) => [d.position[0], d.position[1]],
      getText: (d) => d.text,
      getSize: 10,
      sizeUnits: 'pixels',
      getColor: [accent[0], accent[1], accent[2], 235],
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      characterSet: '0123456789.km ',
      getPixelOffset: [0, -9],
      background: true,
      getBackgroundColor: [0, 0, 0, 130],
      backgroundPadding: [3, 1, 3, 1],
      pickable: false,
    }))
  }

  return layers
}

function fmtDim(m: number): string {
  return m >= 1000 ? `${fmtNum(m / 1000, 2)} km` : `${fmtNum(m, 0)} m`
}
