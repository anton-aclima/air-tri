/**
 * SHEET 04 — /admin/fleet · Vehicles and live positions.
 *
 * The fleet is the constraint the whole plan is built around, so this sheet is
 * a duty roster more than a tracker: who is out, who is charging, who is in the
 * shop, and what each one is carrying. Admins see undelayed positions — the
 * three-hour lag is a community-facing rule, not a data limit — and the sheet
 * says so out loud, because that asymmetry is part of the story.
 */

import { useMemo, useState } from 'react'

import {
  BaseMap, BoundaryLayer, FleetLayer, MapOverlay, MapScale, SegmentLayer,
  useFleetAnimation, usePulse,
} from '@/components'
import { fmtCompact, fmtNum, relativeShort } from '@/core/format'
import {
  useCampaignBoundary, useCampaignInfo, useCampaignStats, useFleet, useSegments,
  useVehicles,
} from '@/core/queries'
import type { VehicleStatus } from '@/core/types'

import {
  Caps, KV, Readout, Readouts, Sheet, TitleBlock, campaignView, styles as s,
  useActivePlan, useNowTick, usePlanRoutes,
} from './lib'

const STATUS_TONE: Record<VehicleStatus, string> = {
  driving: 'var(--accent)',
  idle: 'var(--ink-2)',
  charging: 'var(--sev-watch)',
  maintenance: 'var(--sev-warning)',
  offline: 'var(--ink-3)',
}

const STATUS_GLYPH: Record<VehicleStatus, string> = {
  driving: '▶', idle: '■', charging: '⚡', maintenance: '⚙', offline: '×',
}

export function Fleet() {
  const campaign = useCampaignInfo()
  const stats = useCampaignStats()
  const boundary = useCampaignBoundary(campaign?.id)
  const segments = useSegments({ limit: 2000 })
  const vehicles = useVehicles()
  // Admin sees the fleet undelayed: `delay_min: 0` is explicit, not inherited.
  const fleet = useFleet({ delay_min: 0 })
  const plan = useActivePlan()
  const planQ = usePlanRoutes(plan?.id)
  const now = useNowTick(15_000)
  const pulse = usePulse(2200)
  const animated = useFleetAnimation(fleet.data ?? [])

  const [selected, setSelected] = useState<string | null>(null)

  const byId = useMemo(
    () => new Map((fleet.data ?? []).map((p) => [p.vehicle_id, p])),
    [fleet.data],
  )
  const duty = useMemo(() => {
    const out = new Map<string, { routes: number; km: number; passes: number }>()
    for (const r of planQ.data?.routes ?? []) {
      const id = r.vehicle_id ?? '—'
      const cur = out.get(id) ?? { routes: 0, km: 0, passes: 0 }
      cur.routes += 1
      cur.km += r.distance_m / 1000
      cur.passes += r.est_passes
      out.set(id, cur)
    }
    return out
  }, [planQ.data])

  const roster = vehicles.data ?? []
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const v of roster) c[v.status] = (c[v.status] ?? 0) + 1
    return c
  }, [roster])

  const d = stats.data
  const sel = selected ? byId.get(selected) : undefined
  const selVehicle = roster.find((v) => v.id === selected)

  return (
    <div className={`${s.page} ${s.rows}`}>
      <TitleBlock
        sheet="fleet"
        subtitle={
          `${roster.length} instrumented vehicles · ${counts.driving ?? 0} on the road, ` +
          `${counts.charging ?? 0} charging, ${counts.maintenance ?? 0} in maintenance, ${counts.idle ?? 0} idle`
        }
        cells={[
          { label: 'out now', value: fmtNum(counts.driving ?? 0, 0), tone: 'accent' },
          { label: 'reporting', value: d ? fmtNum(d.vehicles_active, 0) : '—' },
          { label: 'km driven', value: d ? fmtCompact(d.km_driven, 0) : '—' },
          { label: 'delay', value: '0 min', tone: 'accent' },
        ]}
      />

      <div className={s.split}>
        <Sheet
          code="04-A"
          title="Live positions · undelayed"
          className={s.mapCard}
          flat
          aside={<Caps ink>{fleet.data ? `${fleet.data.length} pinging` : 'no fix'}</Caps>}
        >
          <div className={s.mapBox}>
            <BaseMap
              label="Fleet positions"
              initialView={campaignView(campaign, -0.2)}
              layers={(theme) => [
                ...BoundaryLayer({ data: boundary.data, theme, maskStrength: 0.28 }),
                ...SegmentLayer({
                  data: segments.data,
                  theme,
                  metric: 'persistence',
                  dualEncode: 'none',
                  minPasses: 1,
                  opacity: 0.4,
                  pickable: false,
                }),
                ...FleetLayer({
                  data: animated,
                  theme,
                  trails: true,
                  trailLength: 40,
                  labels: true,
                  pulse,
                  selectedId: selected,
                  onClick: (info) => {
                    const obj = info.object as { vehicle_id?: string } | null
                    setSelected(obj?.vehicle_id ?? null)
                  },
                }),
              ]}
            >
              <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
              <MapOverlay place="top-right">
                <div className={s.overlayCard}>
                  <Caps accent>fleet status</Caps>
                  {(['driving', 'idle', 'charging', 'maintenance'] as VehicleStatus[]).map((st) => (
                    <div className={s.overlayRow} key={st}>
                      <span style={{ color: STATUS_TONE[st] }}>{STATUS_GLYPH[st]}</span>
                      <span>{st}</span>
                      <span className={s.overlayNum}>{counts[st] ?? 0}</span>
                    </div>
                  ))}
                </div>
              </MapOverlay>
            </BaseMap>
          </div>
        </Sheet>

        <div className={s.stack} style={{ overflow: 'auto' }}>
          <Sheet
            code="04-B"
            title="Duty roster"
            aside={<Caps ink>{roster.length} vehicles</Caps>}
          >
            <div className={s.fleetList}>
              {roster.map((v) => {
                const pos = byId.get(v.id)
                const job = duty.get(v.id)
                const on = selected === v.id
                return (
                  <button
                    type="button"
                    key={v.id}
                    className={`${s.vehicle}${on ? ` ${s.vehicleActive}` : ''}`}
                    onClick={() => setSelected(on ? null : v.id)}
                  >
                    <span
                      className={s.vehicleBadge}
                      style={{ color: STATUS_TONE[v.status] }}
                      aria-label={v.status}
                    >
                      <span style={{ fontSize: 'var(--text-3xs)' }}>{v.label.replace('AC-', '')}</span>
                      <span aria-hidden>{STATUS_GLYPH[v.status]}</span>
                    </span>
                    <span className={s.vehicleMain}>
                      <span className={s.vehicleTop}>
                        <span className={s.vehicleName}>
                          {v.label} · {v.call_sign ?? '—'}
                        </span>
                        <span className={s.spacer} />
                        <Caps>{v.status}</Caps>
                      </span>
                      <span className={s.vehicleGrid}>
                        <span className={s.vehicleCell}>
                          <Caps>speed</Caps>
                          <span className={s.vehicleVal}>
                            {pos ? `${fmtNum(pos.speed_kph, 0)} km/h` : '—'}
                          </span>
                        </span>
                        <span className={s.vehicleCell}>
                          <Caps>last fix</Caps>
                          <span className={s.vehicleVal}>
                            {pos ? relativeShort(pos.ts, now) : '—'}
                          </span>
                        </span>
                        <span className={s.vehicleCell}>
                          <Caps>routes</Caps>
                          <span className={s.vehicleVal}>{job ? fmtNum(job.routes, 0) : '—'}</span>
                        </span>
                        <span className={s.vehicleCell}>
                          <Caps>planned km</Caps>
                          <span className={s.vehicleVal}>{job ? fmtNum(job.km, 0) : '—'}</span>
                        </span>
                      </span>
                      <span className={s.chips}>
                        <span className={s.chip}>{v.powertrain ?? 'ev'}</span>
                        <span className={s.chip}>{v.model ?? 'unknown'}</span>
                        {v.measures.slice(0, 7).map((m) => (
                          <span className={s.chip} key={m}>{m}</span>
                        ))}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </Sheet>

          <Sheet
            code="04-C"
            title={selVehicle ? `${selVehicle.label} · detail` : 'Select a vehicle'}
          >
            {selVehicle ? (
              <KV
                wide
                rows={[
                  ['call sign', selVehicle.call_sign ?? '—'],
                  ['operator', selVehicle.operator_name ?? '—'],
                  ['platform', `${selVehicle.model ?? '—'} · ${selVehicle.powertrain ?? '—'}`],
                  ['status', selVehicle.status],
                  ['payload', `${selVehicle.measures.length} measures`],
                  ['position', sel ? `${fmtNum(sel.lat, 5)}, ${fmtNum(sel.lon, 5)}` : '—'],
                  ['heading', sel?.heading_deg != null ? `${fmtNum(sel.heading_deg, 0)}°` : '—'],
                  ['on segment', sel?.segment_id ?? '—'],
                  ['last ping', sel ? relativeShort(sel.ts, now) : '—'],
                  ['assigned', duty.get(selVehicle.id) ? `${duty.get(selVehicle.id)?.routes} routes` : '—'],
                ]}
              />
            ) : (
              <div className={s.err}>
                Pick a vehicle from the roster or the map to see its assignment.
              </div>
            )}
          </Sheet>

          <Sheet code="04-D" title="Who sees where the cars are">
            <Readouts>
              <Readout label="aclima" value="live" foot="0 min delay" tone="accent" />
              <Readout label="regulator" value="live" foot="0 min delay" tone="accent" />
              <Readout label="industry" value="live" foot="0 min delay" tone="accent" />
              <Readout label="community" value="−3 h" foot="enforced server-side" tone="warn" />
            </Readouts>
            <div className={s.pad}>
              <p className={s.note}>
                Residents get fleet positions delayed by at least three hours. It is a
                privacy rule, not a data limitation, and it is enforced in the data layer
                rather than in any one interface — which is why it cannot be switched off
                from a screen.
              </p>
            </div>
          </Sheet>
        </div>
      </div>
    </div>
  )
}
