/**
 * SHEET 01 — /admin · Campaign overview.
 *
 * The cover page of the drawing set. It has to answer, in one screen, "what has
 * been built here" — and it has to state the sequence the rest of the set
 * follows, because that sequence IS the product: draw the boundary, size the
 * fleet, generate the plan, watch it run. Every number on this page is read off
 * the live campaign; none of them is written down here.
 */

import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'

import {
  BaseMap, BoundaryLayer, MapLegend, MapOverlay, MapScale, SeasonalStrip,
  SegmentLayer, makeColorScale, measureDomain, robustDomain, segmentDomain,
} from '@/components'
import { happenedBy, isOngoing, isOpenCase } from '@/core/events'
import { fmtCompact, fmtDay, fmtNum } from '@/core/format'
import {
  useActiveMeasure, useAdvisories, useAlerts, useBootstrapSites, useCampaignBoundary,
  useCampaignInfo, useCampaignStats, useConcerns, usePosts, useSegments, useVehicles,
} from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'

import {
  ACTOR_VAR, Caps, KV, Readout, Readouts, Sheet, TitleBlock, campaignView,
  daysBetween, pct, styles as s, useActivePlan, usePlanRoutes,
} from './lib'

export function Overview() {
  const campaign = useCampaignInfo()
  const stats = useCampaignStats()
  const measure = useActiveMeasure()
  const metric = useSession((x) => x.metric)
  const segments = useSegments({ limit: 2000 })
  const boundary = useCampaignBoundary(campaign?.id)
  const plan = useActivePlan()
  const planRoutes = usePlanRoutes(plan?.id)
  const vehicles = useVehicles()
  // The whole campaign's reports (204 in the checked-in build), so the ledger
  // can count what had been filed by the moment on screen. At 100 it was a
  // page, so the ledger read the server's campaign total instead — which says
  // 204 on June 1, when none had been filed.
  const concerns = useConcerns({ limit: 1000 })
  const posts = usePosts()
  const advisories = useAdvisories()
  const alerts = useAlerts({ role: 'admin' })
  const sites = useBootstrapSites()
  const now = useNowCampaign()

  const d = stats.data
  const domain = useMemo(
    () => (segments.data ? segmentDomain(segments.data) : null),
    [segments.data],
  )

  const days = campaign ? daysBetween(campaign.start_date, campaign.end_date) : 0
  const roadKm = useMemo(() => {
    if (!segments.data) return null
    return segments.data.features.reduce((a, f) => a + (f.properties.length_m ?? 0), 0) / 1000
  }, [segments.data])
  const districts = useMemo(() => {
    if (!segments.data) return 0
    return new Set(
      segments.data.features.map((f) => f.properties.district).filter(Boolean),
    ).size
  }, [segments.data])

  const passPoints = useMemo(
    () => (d?.by_day ?? []).map((x) => ({ t: x.date, v: x.passes })),
    [d?.by_day],
  )
  const driving = (vehicles.data ?? []).filter((v) => v.status === 'driving').length
  const coverage = d ? (100 * d.segments_at_target) / Math.max(1, d.segments) : null

  // The three parties' ledger follows the clock (D2): only what had happened
  // by the moment on screen. "Up" is `isOngoing` — begun and not ended — not a
  // status: at the end of the data 7 of the 13 "active" alerts had already
  // ended (Aug 24–27), and `!== 'resolved'` also counted the expired one.
  const concernsNow = happenedBy(concerns.data, now)
  const postsNow = happenedBy(posts.data, now)
  const advisoriesNow = happenedBy(advisories.data, now)
  const activeAlerts = (alerts.data ?? []).filter((a) => isOngoing(a, now))

  return (
    <div className={`${s.page} ${s.rowsFoot}`}>
      <TitleBlock
        sheet="overview"
        title={campaign?.name ?? 'Campaign'}
        subtitle={
          campaign
            ? `${campaign.subtitle ?? campaign.region} · ${campaign.start_date} → ${campaign.end_date} · ${days} days · ${campaign.status}`
            : 'Loading the drawing set…'
        }
        cells={[
          { label: 'segments', value: d ? fmtNum(d.segments, 0) : '—' },
          { label: 'road km', value: roadKm != null ? fmtNum(roadKm, 1) : '—' },
          { label: 'passes', value: d ? fmtCompact(d.passes_total, 0) : '—' },
          {
            label: '≥ target',
            value: coverage != null ? `${fmtNum(coverage, 2)}%` : '—',
            tone: 'accent',
          },
        ]}
      />

      <div className={s.split}>
        {/* ── the hero: the road grid inside the boundary ─────────────── */}
        <Sheet
          code="01-A"
          title="Measured area · road grid"
          className={s.mapCard}
          flat
          aside={
            <Caps ink>
              {measure ? `${measure.short_label} · ${metric}` : 'segments'}
            </Caps>
          }
        >
          <div className={s.mapBox}>
            <BaseMap
              label="Campaign road grid"
              initialView={campaignView(campaign, -0.15)}
              layers={(theme) => [
                ...BoundaryLayer({ data: boundary.data, theme, maskStrength: 0.28 }),
                ...SegmentLayer({
                  data: segments.data,
                  theme,
                  measure: measure?.code,
                  // Pinned for a derived index, stretched for a concentration.
                  scale: makeColorScale(theme, { domain: measureDomain(measure, segments.data) }),
                  metric,
                  dualEncode: 'both',
                  minPasses: 1,
                }),
              ]}
            >
              <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
              <MapOverlay place="top-right">
                {domain && measure ? (
                  <MapLegend domain={domain} measure={measure} metric={metric} compact />
                ) : null}
              </MapOverlay>
              <MapOverlay place="bottom-right">
                <div className={s.overlayCard}>
                  <Caps accent>enclosed by the boundary</Caps>
                  <div className={s.overlayRow}>
                    <span>segments</span>
                    <span className={s.overlayNum}>{d ? fmtNum(d.segments, 0) : '—'}</span>
                  </div>
                  <div className={s.overlayRow}>
                    <span>road</span>
                    <span className={s.overlayNum}>
                      {roadKm != null ? `${fmtNum(roadKm, 1)} km` : '—'}
                    </span>
                  </div>
                  <div className={s.overlayRow}>
                    <span>districts</span>
                    <span className={s.overlayNum}>{districts || '—'}</span>
                  </div>
                </div>
              </MapOverlay>
            </BaseMap>
          </div>
        </Sheet>

        {/* ── the sequence and the ledger ─────────────────────────────── */}
        <div className={s.stackFill}>
          <Sheet code="01-B" title="How this campaign was built">
            <div className={s.seq}>
              <SeqStep
                n={1}
                to="/admin/campaign"
                label="Draw the boundary"
                hint="One or more polylines. Everything downstream locks onto it."
                value={`${districts || '—'} districts`}
                done
              />
              <SeqStep
                n={2}
                to="/admin/fleet"
                label="Size the fleet"
                hint="The critical input. More cars, fewer days to target."
                value={`${vehicles.data?.length ?? campaign?.fleet_size ?? '—'} vehicles`}
                done
              />
              <SeqStep
                n={3}
                to="/admin/driveplan"
                label="Generate the drive plan"
                hint="One algorithm plans the routes and generates the data."
                value={planRoutes.data ? `${planRoutes.data.routes.length} routes` : '—'}
                done={!!plan}
              />
              <SeqStep
                n={4}
                to="/admin/oversight"
                label="Watch it run"
                hint="Coverage, passes, and everything all three parties did."
                value={coverage != null ? `${fmtNum(coverage, 1)}%` : '—'}
                done={!!coverage && coverage > 90}
              />
            </div>
          </Sheet>

          <Sheet code="01-C" title="Campaign record">
            <KV
              wide
              rows={[
                ['campaign id', campaign?.slug ?? '—'],
                ['region', `${campaign?.region ?? '—'}, ${campaign?.state ?? ''}`],
                ['window', `${campaign?.start_date ?? '—'} → ${campaign?.end_date ?? '—'}`],
                ['timezone', campaign?.timezone ?? '—'],
                ['target passes', `${campaign?.target_passes ?? '—'} per segment`],
                ['km driven', d ? `${fmtCompact(d.km_driven, 0)} km` : '—'],
                ['reference net', d ? `${d.monitors_online} of ${d.monitors_total} online` : '—'],
              ]}
            />
          </Sheet>

          <Sheet
            code="01-D"
            title="Three parties, one dataset"
            className={s.grow}
            aside={<Link to="/admin/oversight" className={s.caps}>oversight →</Link>}
          >
            <div className={s.ledger}>
              <LedgerCell
                role="community"
                label="concerns"
                value={fmtNum(concerns.data ? concernsNow.length : null, 0)}
                foot={`${concernsNow.filter((c) => isOpenCase(c, now)).length} open`}
              />
              <LedgerCell
                role="industry"
                label="claimed sites"
                value={fmtNum(sites.length, 0)}
                foot={`${postsNow.length} posts`}
              />
              <LedgerCell
                role="regulator"
                label="advisories"
                value={fmtNum(advisories.data ? advisoriesNow.length : null, 0)}
                foot={`${activeAlerts.length} alerts up`}
              />
            </div>
            <p className={`${s.note} ${s.pad}`}>
              The community files it, the operator answers it, the regulator rules on
              it. Sheet 06 puts all three next to each other.
            </p>
          </Sheet>
        </div>
      </div>

      {/* ── the 90-day build, one cell per day ───────────────────────── */}
      {/* The whole campaign, whatever the clock says: this sheet calls
          `/stats/campaign` without `at` (its fleet figures are whole-campaign
          even with one; only the concern and alert counts follow `at`). At
          Aug 12 it plotted days through Aug 28 and counted 56,673 passes when
          44,667 had been driven, so it says it is the whole campaign instead
          of implying "so far". */}
      <Sheet
        code="01-E"
        title="Ninety days of driving"
        aside={
          <Caps ink>
            {d ? `whole campaign · ${fmtCompact(d.passes_total, 0)} passes · ${fmtCompact(d.km_driven, 0)} km · ${driving} vehicles out now` : ''}
          </Caps>
        }
      >
        {/* Mounted only once the data is in: a chart that mounts empty keeps a
            neutral theme for its whole life (see the report) and draws nothing. */}
        {passPoints.length ? (
          <div style={{ padding: '2px var(--s-3) var(--s-2)' }}>
            <SeasonalStrip
              points={passPoints}
              unit=" passes"
              decimals={0}
              height={42}
              domain={robustDomain(passPoints.map((x) => x.v))}
              subtitle={`${fmtDay(passPoints[0].t)} → ${fmtDay(passPoints[passPoints.length - 1].t)} · passes per day · whole campaign`}
            />
          </div>
        ) : (
          <div className={s.err}>Waiting for the daily record…</div>
        )}
        <Readouts>
          <Readout
            label="at ≥ target"
            value={d ? fmtNum(d.segments_at_target, 0) : '—'}
            foot={d ? `of ${fmtNum(d.segments, 0)} · ${pct(d.segments_at_target, d.segments, 2)}` : undefined}
            tone="accent"
            size="lg"
          />
          <Readout
            label="below target"
            value={d ? fmtNum(d.segments - d.segments_at_target, 0) : '—'}
            foot="segments needing more laps"
            tone="warn"
            size="lg"
          />
          <Readout label="mean passes" value={d ? fmtNum(d.mean_passes, 1) : '—'} foot="per segment" size="lg" />
          <Readout label="alerts up" value={fmtNum(activeAlerts.length, 0)} foot="across all audiences" size="lg" />
          <Readout label="sites" value={fmtNum(d?.sites ?? null, 0)} foot="claimed operators" size="lg" />
          <Readout
            label="vehicles"
            value={d ? `${d.vehicles_active}/${vehicles.data?.length ?? 5}` : '—'}
            foot="reporting today"
            size="lg"
          />
        </Readouts>
      </Sheet>
    </div>
  )
}

function SeqStep({
  n, to, label, hint, value, done,
}: {
  n: number
  to: string
  label: string
  hint: string
  value: string
  done?: boolean
}) {
  return (
    <Link to={to} className={s.seqStep}>
      <span className={`${s.seqNo}${done ? ` ${s.seqNoDone}` : ''}`}>{done ? '✓' : n}</span>
      <span className={s.seqBody}>
        <span className={s.seqLabel}>
          {n}. {label}
        </span>
        <span className={s.seqHint}>{hint}</span>
      </span>
      <span className={s.seqValue}>{value}</span>
    </Link>
  )
}

function LedgerCell({
  role, label, value, foot,
}: {
  role: 'community' | 'industry' | 'regulator'
  label: string
  value: string
  foot: string
}) {
  return (
    <div
      className={s.ledgerCell}
      style={{ ['--cellColor' as string]: ACTOR_VAR[role] }}
    >
      <Caps>{label}</Caps>
      <span className={s.ledgerValue}>{value}</span>
      <span className={s.readoutFoot}>{foot}</span>
    </div>
  )
}
