/**
 * SHEET 03 — /admin/driveplan · Routes, passes, coverage.
 *
 * The plan and the data are not two artifacts. The datagen build takes the
 * boundary and the fleet size and produces a circuit over every street; that
 * same circuit is what generated the 90 days of simulated measurement already
 * in the database. Sheet 03 has to show that duality, not assert it — so the
 * two outputs sit either side of one solver box with their real counts under
 * them.
 *
 * What the panel must NOT claim: that the regenerate lever on this sheet runs
 * that solver. It does not. `POST /admin/campaigns/{id}/drive-plan` is a
 * serpentine stand-in whose routes drove nothing, so panel 03-E names the
 * build, not a named algorithm, and says so. The Mission Brief (sheet 08)
 * reads the plan that produced the data for the same reason.
 *
 * The generator panel predicts what the backend will do *before* the lever is
 * pulled, using the backend's own constants. That is the drafting feel: you
 * work out the answer on paper, then commit.
 */

import { useMemo, useState } from 'react'

import {
  BaseMap, Distribution, DrivePlanLayer, MapOverlay, MapScale, SegmentLayer,
  vehicleColorIndex,
} from '@/components'
import { Button, Segmented, Slider } from '@/app/ui'
import { fmtCompact, fmtNum } from '@/core/format'
import {
  useCampaignInfo, useCampaignStats, useDrivePlanCoverage, useRegenerateDrivePlan,
  useSegments, useVehicles,
} from '@/core/queries'

import {
  Caps, Readout, Readouts, Sheet, TitleBlock, campaignView, enclosedBy, pct,
  styles as s, useActivePlan, useDraft, usePlanRoutes,
} from './lib'

/** The backend's own constant (`routers/admin.py`), so the estimate is honest. */
const KM_PER_SHIFT_HOUR = 18.0

type Mode = 'routes' | 'coverage'

export function DrivePlan() {
  const campaign = useCampaignInfo()
  const stats = useCampaignStats()
  const plan = useActivePlan()
  const planQ = usePlanRoutes(plan?.id)
  const coverage = useDrivePlanCoverage(plan?.id)
  const segments = useSegments({ limit: 2000 })
  const vehicles = useVehicles()

  const fleetSize = useDraft((x) => x.fleetSize)
  const targetPasses = useDraft((x) => x.targetPasses)
  const shiftHours = useDraft((x) => x.shiftHours)
  const setFleet = useDraft((x) => x.setFleet)
  const setTarget = useDraft((x) => x.setTarget)
  const setShift = useDraft((x) => x.setShift)
  const regenerate = useRegenerateDrivePlan()

  const [mode, setMode] = useState<Mode>('routes')
  const [day, setDay] = useState<number | null>(null)
  const [vehicleId, setVehicleId] = useState<string | null>(null)

  const routes = planQ.data?.routes ?? []
  const dayCount = useMemo(
    () => (routes.length ? Math.max(...routes.map((r) => r.day_index)) + 1 : 0),
    [routes],
  )
  const hues = useMemo(() => vehicleColorIndex(routes), [routes])
  const shown = useMemo(
    () => routes.filter(
      (r) => (day == null || r.day_index === day)
        && (!vehicleId || r.vehicle_id === vehicleId),
    ),
    [routes, day, vehicleId],
  )
  const plannedKm = useMemo(
    () => routes.reduce((a, r) => a + r.distance_m, 0) / 1000,
    [routes],
  )
  const shownKm = useMemo(
    () => shown.reduce((a, r) => a + r.distance_m, 0) / 1000,
    [shown],
  )

  const network = useMemo(() => enclosedBy(segments.data, []), [segments.data])
  const coverValues = useMemo(
    () => (coverage.data ?? []).map((c) => c.passes),
    [coverage.data],
  )
  const belowTarget = useMemo(
    () => (coverage.data ?? []).filter((c) => c.passes < c.target).length,
    [coverage.data],
  )

  // ── the paper estimate, using the backend's arithmetic ───────────────
  const est = useMemo(() => {
    const totalKm = network.km || (campaign ? 195.9 : 0)
    const kmPerShift = KM_PER_SHIFT_HOUR * shiftHours
    const chunkKm = Math.max(0.05, (totalKm / Math.max(1, fleetSize)) * 1.35)
    const laps = Math.max(1, Math.floor(kmPerShift / chunkKm))
    const days = Math.max(1, Math.ceil(targetPasses / laps))
    return {
      totalKm, kmPerShift, chunkKm, laps, days,
      routes: days * fleetSize,
      fleetKmPerDay: kmPerShift,
      totalPlannedKm: days * fleetSize * chunkKm * laps,
    }
  }, [network.km, campaign, shiftHours, fleetSize, targetPasses])

  const committedDays = plan?.stats?.days_to_target ?? null
  const d = stats.data

  return (
    <div className={`${s.page} ${s.rowsPlan}`}>
      <TitleBlock
        sheet="driveplan"
        title={plan?.name ?? 'Drive plan'}
        subtitle={
          plan
            ? `${plan.id} · ${plan.status} · seed ${String(plan.params?.seed ?? '—')} · ${routes.length} routes over ${dayCount} days · ${fmtNum(plannedKm, 0)} km planned · created ${plan.created_at.slice(0, 10)}`
            : 'No active plan'
        }
        cells={[
          { label: 'fleet', value: fmtNum(plan?.fleet_size ?? null, 0) },
          { label: 'target', value: `${fmtNum(plan?.target_passes ?? null, 0)}×` },
          {
            label: 'coverage',
            value: plan ? `${fmtNum(plan.stats.coverage_pct, 2)}%` : '—',
            tone: 'accent',
          },
          {
            label: 'below',
            value: fmtNum(belowTarget || plan?.stats?.segments_below_target || null, 0),
            tone: 'warn',
          },
        ]}
      />

      <div className={s.split}>
        {/* ── routes or coverage, on the real streets ─────────────────── */}
        <Sheet
          code="03-A"
          title={mode === 'routes' ? 'Planned circuits · one hue per vehicle' : 'Coverage · passes ÷ target'}
          className={s.mapCard}
          flat
          aside={
            <Segmented
              value={mode}
              options={[
                { value: 'routes', label: 'Routes' },
                { value: 'coverage', label: 'Coverage' },
              ]}
              onValueChange={(v) => setMode(v as Mode)}
            />
          }
        >
          <div className={s.mapBox}>
            <BaseMap
              label="Drive plan"
              initialView={campaignView(campaign, -0.2)}
              layers={(theme) => [
                ...(mode === 'routes'
                  ? [
                      ...SegmentLayer({
                        id: 'plan-base',
                        data: segments.data,
                        theme,
                        metric: 'persistence',
                        dualEncode: 'none',
                        minPasses: 1,
                        opacity: 0.16,
                        pickable: false,
                      }),
                      ...DrivePlanLayer({
                        mode: 'routes',
                        routes: shown.length ? shown : routes,
                        theme,
                        arrowEvery: day != null ? 90 : 0,
                        endpoints: day != null,
                        pickable: false,
                      }),
                    ]
                  : DrivePlanLayer({
                      mode: 'coverage',
                      coverage: coverage.data,
                      segments: segments.data,
                      theme,
                      target: plan?.target_passes ?? 25,
                      pickable: false,
                    })),
              ]}
            >
              <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
              <MapOverlay place="top-right">
                <div className={s.overlayCard}>
                  <Caps accent>{mode === 'routes' ? 'showing' : 'coverage'}</Caps>
                  {mode === 'routes' ? (
                    <>
                      <div className={s.overlayRow}>
                        <span>routes</span>
                        <span className={s.overlayNum}>{fmtNum(shown.length || routes.length, 0)}</span>
                      </div>
                      <div className={s.overlayRow}>
                        <span>distance</span>
                        <span className={s.overlayNum}>
                          {fmtNum(shownKm || plannedKm, 0)} km
                        </span>
                      </div>
                      <div className={s.overlayRow}>
                        <span>day</span>
                        <span className={s.overlayNum}>
                          {day == null ? 'all' : `${day + 1} / ${dayCount}`}
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={s.overlayRow}>
                        <span>at ≥ target</span>
                        <span className={s.overlayNum}>
                          {coverage.data
                            ? fmtNum(coverage.data.length - belowTarget, 0)
                            : '—'}
                        </span>
                      </div>
                      <div className={s.overlayRow}>
                        <span>below</span>
                        <span className={s.overlayNum}>{fmtNum(belowTarget, 0)}</span>
                      </div>
                      <div className={s.overlayRow}>
                        <span>target</span>
                        <span className={s.overlayNum}>{plan?.target_passes ?? 25}×</span>
                      </div>
                    </>
                  )}
                </div>
              </MapOverlay>
              {mode === 'routes' ? (
                <MapOverlay place="bottom-right">
                  <div className={s.overlayCard} style={{ maxWidth: 210 }}>
                    <Caps accent>vehicles</Caps>
                    <div className={s.chips}>
                      <button
                        type="button"
                        className={`${s.chip}${vehicleId === null ? ` ${s.chipOn}` : ''}`}
                        onClick={() => setVehicleId(null)}
                      >
                        all
                      </button>
                      {(vehicles.data ?? []).map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          className={`${s.chip}${vehicleId === v.id ? ` ${s.chipOn}` : ''}`}
                          onClick={() => setVehicleId(vehicleId === v.id ? null : v.id)}
                          title={`${v.label} · ${v.call_sign ?? ''} · hue ${hues.get(v.id) ?? '—'}`}
                        >
                          {v.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </MapOverlay>
              ) : null}
            </BaseMap>
          </div>
        </Sheet>

        {/* ── the generator ───────────────────────────────────────────── */}
        <div className={s.stackTwo}>
          <Sheet
            code="03-B"
            title="Generate a plan"
            aside={<Caps ink>{regenerate.isPending ? 'solving…' : 'estimate'}</Caps>}
          >
            <div className={s.controls}>
              <div className={s.controlRow}>
                <div className={s.controlTop}>
                  <Caps ink>vehicles available</Caps>
                  <span className={s.controlValue}>{fleetSize}</span>
                </div>
                <Slider value={fleetSize} min={1} max={12} step={1} onValueChange={setFleet} aria-label="Fleet size" />
              </div>
              <div className={s.controlRow}>
                <div className={s.controlTop}>
                  <Caps ink>target passes</Caps>
                  <span className={s.controlValue}>{targetPasses}</span>
                </div>
                <Slider value={targetPasses} min={5} max={60} step={5} onValueChange={setTarget} aria-label="Target passes" />
              </div>
              <div className={s.controlRow}>
                <div className={s.controlTop}>
                  <Caps ink>shift hours</Caps>
                  <span className={s.controlValue}>{fmtNum(shiftHours, 1)}</span>
                </div>
                <Slider value={shiftHours} min={2} max={10} step={0.5} onValueChange={setShift} aria-label="Shift hours" />
              </div>
            </div>

            <div className={s.estimate}>
              <EstCell label="days to target" value={fmtNum(est.days, 0)} delta={
                committedDays != null ? `committed ${committedDays}` : undefined
              } />
              <EstCell label="routes" value={fmtNum(est.routes, 0)} delta={`${fleetSize}/day`} />
              <EstCell label="laps / shift" value={fmtNum(est.laps, 0)} delta={`${fmtNum(est.chunkKm, 1)} km each`} />
              <EstCell label="km / veh / day" value={fmtNum(est.kmPerShift, 0)} delta={`${KM_PER_SHIFT_HOUR} km/h`} />
            </div>

            <div className={s.pad}>
              <p className={s.note}>
                Generating <strong>archives the active plan</strong> and writes a new circuit
                over all {fmtNum(network.segments || 1307, 0)} segments — {fmtNum(est.days, 0)} days
                at {fleetSize} {fleetSize === 1 ? 'vehicle' : 'vehicles'} to reach {targetPasses}
                {' '}passes. The campaign's fleet size and target are updated to match.
              </p>
              <div className={s.leverActions} style={{ marginTop: 'var(--s-3)' }}>
                <Button
                  variant="primary"
                  loading={regenerate.isPending}
                  disabled={!campaign || regenerate.isPending}
                  onClick={() => {
                    if (!campaign) return
                    regenerate.mutate({
                      campaignId: campaign.id,
                      body: {
                        fleet_size: fleetSize,
                        target_passes: targetPasses,
                        shift_hours: shiftHours,
                      },
                    })
                  }}
                >
                  Generate drive plan
                </Button>
                {regenerate.isError ? (
                  <span className={s.noteDim}>{regenerate.error.message}</span>
                ) : null}
                {regenerate.isSuccess ? (
                  <Caps accent>plan {regenerate.data.id} active</Caps>
                ) : null}
              </div>
            </div>
          </Sheet>

          <Sheet
            code="03-C"
            title="Passes per segment"
            className={s.grow}
            aside={<Caps ink>{coverage.data ? `${fmtNum(coverage.data.length, 0)} segments` : ''}</Caps>}
          >
            {coverValues.length ? (
              <div className={s.pad2}>
                <Distribution
                  values={coverValues}
                  marker={plan?.target_passes ?? 25}
                  markerLabel="target"
                  bins={26}
                  height={120}
                  unit=" passes"
                  decimals={0}
                  colorByValue
                  subtitle={`${pct(coverValues.length - belowTarget, coverValues.length, 2)} of segments are at or past target`}
                />
              </div>
            ) : (
              <div className={s.err}>Counting passes…</div>
            )}
          </Sheet>
        </div>
      </div>

      {/* ── the duality: one solver, two outputs ─────────────────────── */}
      <Sheet
        code="03-E"
        title="One build · the plan and the data are the same object"
        aside={<Caps ink>as built by datagen</Caps>}
      >
        <div className={s.duality}>
          <div className={s.dualSplit}>
            <div className={s.dualNode}>
              <span className={s.dualLabel}>input · boundary</span>
              <span className={s.dualValue}>
                {fmtNum(network.segments || 1307, 0)} segments · {fmtNum(network.km || 195.9, 1)} km
              </span>
            </div>
            <div className={s.dualNode}>
              <span className={s.dualLabel}>input · fleet</span>
              <span className={s.dualValue}>
                {plan?.fleet_size ?? 5} vehicles · {fmtNum(shiftHours, 1)} h shifts
              </span>
            </div>
          </div>
          <div className={s.dualArrow}>→</div>
          <div className={`${s.dualNode} ${s.dualNodeCore}`}>
            <span className={s.dualLabel}>solver</span>
            <span className={s.dualValue}>datagen route builder</span>
            <span className={s.noteDim}>
              The regenerate lever above is a serpentine stand-in, not this build — its
              routes produced none of the data on the right.
            </span>
          </div>
          <div className={s.dualArrow}>→</div>
          <div className={s.dualSplit}>
            <div className={s.dualNode}>
              <span className={s.dualLabel}>output A · the plan the cars drive</span>
              <span className={s.dualValue}>
                {fmtNum(routes.length, 0)} routes · {fmtNum(dayCount, 0)} days · {fmtNum(plannedKm, 0)} km
              </span>
            </div>
            <div className={s.dualNode}>
              <span className={s.dualLabel}>output B · the measurements it produced</span>
              <span className={s.dualValue}>
                {d ? fmtCompact(d.passes_total, 0) : '—'} passes · {d ? fmtNum(d.segments, 0) : '—'} segments · 10 measures
              </span>
            </div>
          </div>
        </div>
        <Readouts>
          <Readout label="coverage" value={plan ? `${fmtNum(plan.stats.coverage_pct, 2)}%` : '—'} foot="segments at ≥ target" tone="accent" size="lg" />
          <Readout label="below target" value={fmtNum(belowTarget, 0)} foot="need more laps" tone="warn" size="lg" />
          <Readout label="mean passes" value={d ? fmtNum(d.mean_passes, 1) : '—'} foot={`target ${plan?.target_passes ?? 25}`} size="lg" />
          <Readout label="planned km" value={fmtNum(plannedKm, 0)} foot="across the whole plan" size="lg" />
          <Readout label="driven km" value={d ? fmtCompact(d.km_driven, 0) : '—'} foot="actually logged" size="lg" />
          <Readout label="days" value={fmtNum(dayCount, 0)} foot={`${routes.length ? fmtNum(routes.length / Math.max(1, dayCount), 1) : '—'} routes/day`} size="lg" />
        </Readouts>
      </Sheet>

      {/* the day scrubber, ruled along the bottom of the sheet */}
      {routes.length ? <DayRule day={day} dayCount={dayCount} onChange={setDay} /> : null}
    </div>
  )
}

function EstCell({ label, value, delta }: { label: string; value: string; delta?: string }) {
  return (
    <div className={s.estCell}>
      <Caps>{label}</Caps>
      <span className={s.estValue}>{value}</span>
      {delta ? <span className={s.estDelta}>{delta}</span> : null}
    </div>
  )
}

function DayRule({
  day, dayCount, onChange,
}: {
  day: number | null
  dayCount: number
  onChange(d: number | null): void
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--s-3)',
        padding: '0 var(--s-3)',
      }}
    >
      <Caps ink>day</Caps>
      <Button size="sm" variant={day == null ? 'secondary' : 'ghost'} onClick={() => onChange(null)}>
        all {dayCount}
      </Button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Slider
          value={day ?? 0}
          min={0}
          max={Math.max(0, dayCount - 1)}
          step={1}
          onValueChange={(v) => onChange(v)}
          aria-label="Plan day"
          display={day == null ? 'all days' : `day ${day + 1}`}
        />
      </div>
    </div>
  )
}
