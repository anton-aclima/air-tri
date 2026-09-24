/**
 * /industry/alerts/$alertId — one contact, and what to do about it.
 *
 * Two questions, in this order, and nothing else:
 *
 *   1. IS THIS REAL? The regulator's stationary instrument said a number. Our
 *      vehicles drove the same streets in the same window, and the operator's
 *      own fenceline ring was sitting right there. Three independent sources on
 *      one row each, with the verdict written out — because "is this a real
 *      problem or is the stationary sensor freaking out" is the question this
 *      operator actually asks, and triangulation is the only honest answer.
 *
 *   2. WHAT DO I DO? A concrete recommendation — which units, how much, how
 *      long, what it buys. The rules answer is on screen the moment the page
 *      opens and is replaced in place when the model's lands. There is never a
 *      spinner where an answer should be.
 *
 * When the geometry says it is NOT them, this page says so just as plainly as
 * when it says it is. Three emitters surround this community; a tool that only
 * ever confirms your innocence is worth nothing to anybody.
 */

import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'

import { CompassBearing, ModelVerificationPanel, TimeSeries, haversine } from '@/components'
import { Button, Field, Input, Textarea } from '@/app/ui'
import {
  compassPoint, fmtBearing, fmtCompact, fmtDateTime, fmtDistance,
  fmtNum, fmtPct, relativeShort,
} from '@/core/format'
import type { CampaignTime } from '@/core/clock'
import { hasStarted, happenedBy, isOngoing } from '@/core/events'
import { SEVERITY_LABEL, formatValue, severityVar } from '@/core/measures'
import {
  useAcknowledgeAlert, useAlert, useCreateMitigation, useCreatePost,
  useMeasure, useModelVerification, useMonitors, useSegmentDetail, useSegments, useWind,
} from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type { Alert, Concern, SegmentProps } from '@/core/types'

import {
  Caps, Panel, Readout, Sev, Tag, isSited, mitigationStatusAt, shortTitle, styles as s, upFor,
  useAdvisor, useCampaignWindow, useSiteLock,
  useStableWindow,
} from './lib'

export function ContactDetail({ alertId }: { alertId: string }) {
  const site = useSiteLock()
  const now = useNowCampaign()
  const alertQ = useAlert(alertId, site?.id)
  const alert = alertQ.data
  const measure = useMeasure(alert?.measure ?? null)
  const windWin = useStableWindow(24)
  const windQ = useWind(windWin)
  const wind = windQ.data?.[windQ.data.length - 1]
  const ack = useAcknowledgeAlert()
  const user = useSession((x) => x.user)

  const advisor = useAdvisor(alertId, site?.id ?? null)

  if (alertQ.isError) {
    return <div className={`${s.page} ${s.detailPage}`}><div className={s.err}>Alert not found.</div></div>
  }
  if (!alert) {
    return <div className={`${s.page} ${s.detailPage}`}><div className={s.err}>Acquiring contact…</div></div>
  }
  // Reached by a link while the clock is earlier than the alert: at the moment
  // shown it had not happened, so nothing about it is drawn (D2) — not even its
  // start time, which is the future too.
  if (!hasStarted(alert, now)) {
    return (
      <div className={`${s.page} ${s.detailPage}`}>
        <div className={s.err}>
          This alert had not begun at the moment shown. Move the clock later to see it, or{' '}
          <Link to="/industry/alerts">see the alerts up to now</Link>.
        </div>
      </div>
    )
  }

  const sited = isSited(alert)
  const ongoing = isOngoing(alert, now)
  const bearing = sited ? alert.bearing_deg ?? null : null
  const plumeToward = wind?.dir_deg != null ? (wind.dir_deg + 180) % 360 : null
  const offset = bearing != null && plumeToward != null
    ? Math.abs(((plumeToward - bearing + 540) % 360) - 180)
    : null
  const downwind = offset == null ? null : offset < 50 ? 'toward' : offset > 130 ? 'away' : 'across'

  return (
    <div className={`${s.page} ${s.detailPage}`}>
      {/* ── the contact, in one band ─────────────────────────────────── */}
      <div className={`${s.banner} ${alert.severity === 'critical' || alert.severity === 'warning' ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.verdict}>
          <span
            className={s.verdictGlyph}
            style={{ color: severityVar(alert.severity) }}
          >
            {alert.severity === 'critical' ? '◆' : alert.severity === 'warning' ? '▲' : alert.severity === 'watch' ? '△' : '·'}
          </span>
          <div className={s.bannerLine}>
            <span className={s.bannerHead}>{shortTitle(alert)}</span>
            <span className={s.bannerSub}>
              <Sev severity={alert.severity} />
              {' · '}
              {alert.source_type === 'community' ? 'Reported by residents'
                : alert.source_type === 'mobile' ? 'Detected by the Aclima fleet'
                : alert.source_type === 'model' ? 'Model comparison'
                : 'Stationary instrument'}
              {alert.body ? ` · ${alert.body}` : ''}
            </span>
          </div>
        </div>
        <div className={s.bannerStats}>
          <Readout label="Bearing" value={sited ? fmtBearing(bearing) : 'site-wide'} />
          <Readout label="Range" value={sited ? fmtDistance(alert.distance_m ?? null, 1) : '—'} />
          {/* Up or ended AT THE MOMENT SHOWN: in replay an alert that ends
              later was still up, and one that has ended reads its real
              duration rather than the time since it began. */}
          <Readout
            label={ongoing ? 'Up for' : 'Was up'}
            value={upFor(alert, now)}
            tone={ongoing ? 'threat' : undefined}
            big
          />
          <div className={s.readout}>
            <Button
              size="sm"
              variant={alert.status === 'acknowledged' ? 'ghost' : 'secondary'}
              disabled={alert.status === 'acknowledged' || ack.isPending}
              onClick={() => ack.mutate({ id: alert.id, userId: user?.id })}
            >
              {alert.status === 'acknowledged' ? 'ACKNOWLEDGED' : 'ACKNOWLEDGE'}
            </Button>
            <Caps>{alert.status}</Caps>
          </div>
        </div>
      </div>

      <div className={s.detailBody}>
        {/* ── evidence ─────────────────────────────────────────────── */}
        <div className={s.scrollStack}>
          {alert.kind === 'wind_shift' || alert.source_type === 'model' ? (
            <ModelCheck siteId={site?.id ?? null} />
          ) : (
            <Triangulation alert={alert} siteId={site?.id ?? null} />
          )}

          {alert.samples && alert.samples.length > 1 && measure && alert.kind !== 'wind_shift' ? (
            <Panel title={`Excursion · ${measure.code.toUpperCase()} at the reporting instrument`}>
              <TimeSeries
                series={[{ id: 'src', label: shortTitle(alert), points: alert.samples }]}
                thresholds={alert.threshold != null
                  ? [{ id: 'lim', label: 'Action level', value: alert.threshold, severity: alert.severity, shade: true }]
                  : []}
                unit={alert.unit ?? ''}
                height={168}
                exceedanceSeriesId="src"
              />
            </Panel>
          ) : null}

          <ConcernList concerns={happenedBy(alert.concerns, now)} now={now} />
        </div>

        {/* ── the answer ───────────────────────────────────────────── */}
        <div className={s.scrollStack}>
          <Panel
            title="Recommended action"
            aside={
              advisor.upgrading ? (
                <span className={s.upgrading}><span className={s.upgradeDot} />refining</span>
              ) : advisor.reply ? (
                <Caps>{advisor.reply.source === 'llm' ? 'reviewed' : 'rules'} · {advisor.reply.confidence} confidence</Caps>
              ) : null
            }
          >
            <RecommendedAction advisor={advisor} recommendation={alert.recommendation} />
          </Panel>

          <Panel title="Geometry">
            {!sited ? (
              <div className={s.geoText}>
                <span className={s.geoLine}>
                  This alert is about the site as a whole, not a place near it, so it has no
                  direction from your campus.
                </span>
              </div>
            ) : (
            <div className={s.geo}>
              <CompassBearing
                bearing={bearing ?? 0}
                distanceM={alert.distance_m ?? null}
                size={112}
                severity={alert.severity}
                cardinal
                label="from your campus"
              />
              <div className={s.geoText}>
                <span className={s.geoLine}>
                  Wind measured FROM {fmtBearing(wind?.dir_deg ?? null)} at {fmtNum(wind?.speed_ms, 1)} m/s,
                  carrying your plume toward {compassPoint(plumeToward)}.
                </span>
                <span
                  className={s.geoLine}
                  style={{ color: downwind === 'toward' ? 'var(--threat)' : 'var(--ink)' }}
                >
                  {downwind === 'toward'
                    ? '▲ This contact is directly downwind of you. On the geometry, this is yours.'
                    : downwind === 'away'
                      ? '◇ This contact is upwind of you right now — on the geometry it is unlikely to be your plume. Two other emitters sit north and north-east of this community; say so, do not stop there.'
                      : downwind === 'across'
                        ? '△ This contact sits across the wind from you. Attribution is genuinely ambiguous — check the fenceline ring before you claim either way.'
                        : 'Wind not available for this window.'}
                </span>
              </div>
            </div>
            )}
          </Panel>

          <RespondPanel alert={alert} siteId={site?.id ?? null} now={now} />
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────────────────────────────────── the recommendation */

function RecommendedAction({
  advisor, recommendation,
}: {
  advisor: ReturnType<typeof useAdvisor>
  recommendation: string | null
}) {
  const reply = advisor.reply
  // The backend's own one-liner stands in until the advisor's first answer
  // lands — a decisive sentence, never an empty box with a spinner in it.
  const headline = reply?.recommendation ?? recommendation ?? 'Hold current load and re-check the fenceline ring in 15 minutes.'

  return (
    <div className={s.action} key={advisor.revision}>
      <p className={`${s.actionText}${advisor.revision > 0 ? ` ${s.enriched}` : ''}`}>{headline}</p>

      {reply?.actions?.length ? (
        <div className={s.actionList}>
          {reply.actions.map((a, i) => (
            <div key={`${a.label}-${i}`} className={s.actionItem}>
              <span className={`${s.actionIndex} num`}>{i + 1}</span>
              <div>
                <div className={s.actionLabel}>{a.label}</div>
                <div className={s.actionDetail}>{a.detail}</div>
                {a.impact ? <div className={s.actionImpact}>{a.impact}</div> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {reply?.rationale ? (
        <details className={s.reasoning}>
          <summary>Why this</summary>
          <p>{reply.rationale}</p>
        </details>
      ) : null}

      {advisor.error ? <Caps>advisor offline · rules answer shown</Caps> : null}
    </div>
  )
}

/* ─────────────────────────────────── is this real, or is the sensor broken */

function Triangulation({ alert, siteId }: { alert: Alert; siteId: string | null }) {
  // A community cluster names no pollutant, but the question is the same one:
  // do our vehicles find anything on those streets? NO2 is the proxy — it is
  // what a turbine and a diesel yard put out, and it is labelled as a proxy so
  // nobody mistakes it for what the residents actually reported.
  const isCluster = alert.source_type === 'community' || alert.kind === 'concern_cluster'
  const code = alert.measure ?? (isCluster ? ('no2' as const) : null)
  const proxy = !alert.measure && !!code
  const measure = useMeasure(code ?? null)
  const lon = alert.lon
  const lat = alert.lat

  // ~1.2 km box around the contact. The nearest covered street is reported with
  // its distance, because "we measured 900 m away" is a different claim from
  // "we measured right there" and the operator should see which one this is.
  const d = 0.008
  const bbox: [number, number, number, number] | null =
    lon != null && lat != null ? [lon - d, lat - d, lon + d, lat + d] : null

  // NOTE: the server applies `limit` BEFORE the bbox filter, so a small limit
  // returns the campaign's top-N by value and then filters them away. The limit
  // has to exceed the campaign's segment count for a local query to be correct.
  const segsQ = useSegments(
    { measure: code ?? undefined, metric: 'p90', bbox, min_passes: 4, limit: 5000 },
    { enabled: !!bbox && !!code },
  )
  const nearest = useMemo(() => {
    const feats = segsQ.data?.features ?? []
    if (!feats.length || lon == null || lat == null) return null
    let best: { props: SegmentProps; m: number } | null = null
    for (const f of feats) {
      const coords = f.geometry.coordinates
      const mid = coords[Math.floor(coords.length / 2)]
      if (!mid) continue
      const m = haversine([mid[0], mid[1]], [lon, lat])
      if (!best || m < best.m) best = { props: f.properties, m }
    }
    return best
  }, [segsQ.data, lon, lat])
  const nearProps = nearest?.props ?? null
  const nearM = nearest?.m ?? null
  const farAway = nearM != null && nearM > 700

  const detailQ = useSegmentDetail(nearProps?.id ?? null, { enabled: !!nearProps })
  const monitorsQ = useMonitors({ site_id: siteId ?? undefined }, { enabled: !!siteId })

  const fenceline = useMemo(() => {
    if (!code) return null
    const rows = (monitorsQ.data ?? [])
      .map((m) => ({ m, latest: m.latest?.[code] }))
      .filter((r): r is { m: typeof r.m; latest: NonNullable<typeof r.latest> } => !!r.latest)
    if (!rows.length) return null
    rows.sort((a, b) => b.latest.value - a.latest.value)
    return { top: rows[0], exceeding: rows.filter((r) => r.latest.exceeds).length, total: rows.length }
  }, [monitorsQ.data, code])

  const rank = code && detailQ.data ? detailQ.data.rank_pct?.[code] ?? null : null
  const stats = code && detailQ.data ? detailQ.data.stats?.[code] ?? null : null
  const passes = stats?.n_passes ?? nearProps?.n_passes ?? 0

  const where = isCluster ? 'where those reports came from' : 'beside that instrument'
  const verdict = !code
    ? { word: 'NO MEASURE', tone: 'var(--ink-2)', body: 'This contact is not tied to a single pollutant, so there is nothing to cross-check instrument-to-instrument.' }
    : farAway
      ? { word: 'OUT OF COVERAGE', tone: 'var(--sev-watch)', body: `The nearest street we cover is ${fmtDistance(nearM, 1)} from this contact. That is too far to speak for the air where it was reported — we can tell you what the corridor is doing, not what that block is doing.` }
      : passes < 12 || rank == null
      ? { word: 'UNCONFIRMED', tone: 'var(--sev-watch)', body: `Only ${fmtNum(passes, 0)} mobile passes on the streets ${where} in this window — too thin to confirm or dismiss it. Treat this as unverified, not as wrong.` }
      : rank >= 75
        ? {
            word: 'CORROBORATED',
            tone: 'var(--threat)',
            body: isCluster
              ? `Our vehicles put the streets ${where} in the ${fmtNum(rank, 0)}th percentile campaign-wide for ${code.toUpperCase()} across ${fmtNum(passes, 0)} passes. The residents are describing something our instruments can also see. Treat this as real.`
              : `Our vehicles put the street ${where} in the ${fmtNum(rank, 0)}th percentile campaign-wide across ${fmtNum(passes, 0)} passes. The instrument is not misbehaving — the air there really is loaded.`,
          }
        : rank <= 40
          ? {
              word: isCluster ? 'NOT VISIBLE TO US' : 'NOT CORROBORATED',
              tone: 'var(--scope)',
              body: isCluster
                ? `Those streets sit at the ${fmtNum(rank, 0)}th percentile campaign-wide for ${code.toUpperCase()} (${fmtNum(passes, 0)} passes) — at or below the campaign norm. That does not make the reports wrong: odour and irritation travel on species nobody in this campaign measures. It does mean NO2 is not the explanation.`
                : `Our vehicles put the same street in the ${fmtNum(rank, 0)}th percentile campaign-wide across ${fmtNum(passes, 0)} passes — at or below the campaign norm. The stationary instrument is reading high against its own surroundings; check its calibration before you throttle anything.`,
            }
          : { word: 'PARTIAL', tone: 'var(--sev-warning)', body: `The streets ${where} sit at the ${fmtNum(rank, 0)}th percentile campaign-wide (${fmtNum(passes, 0)} passes). Elevated, but not an excursion — expect a local, short-lived source.` }

  return (
    <Panel
      title={isCluster ? 'Is this us, or is it one of the other two?' : 'Is this real, or is the instrument freaking out?'}
      aside={<Caps>three independent sources</Caps>}
    >
      <div className={s.tri}>
        <div className={s.triRow}>
          <span style={{ color: isCluster ? 'var(--actor-community)' : 'var(--actor-regulator)' }}>
            {isCluster ? '●' : '◆'}
          </span>
          <div>
            <div className={s.triSrc}>
              {isCluster ? 'Residents' : alert.title.replace(/^.*at /, '') || 'Reporting instrument'}
            </div>
            <div className={s.triNote}>
              {isCluster ? 'reports clustered in space and time' : 'stationary · reported this contact'}
            </div>
          </div>
          <span className={`${s.triValue} num`}>
            {alert.value == null
              ? '—'
              : alert.unit
                ? `${fmtNum(alert.value, alert.unit === 'reports' ? 0 : 1)} ${alert.unit}`
                : measure
                  ? formatValue(measure, alert.value, { role: 'industry' })
                  : fmtNum(alert.value, 1)}
          </span>
          <span className={s.triState}>
            <span className={s.triBadge} style={{ color: severityVar(alert.severity) }}>
              {alert.threshold != null ? `▲ limit ${fmtNum(alert.threshold, 0)}` : SEVERITY_LABEL[alert.severity]}
            </span>
          </span>
        </div>

        <div className={s.triRow}>
          <span style={{ color: 'var(--fleet, var(--accent))' }}>▲</span>
          <div>
            <div className={s.triSrc}>Aclima mobile · {detailQ.data?.name ?? nearProps?.name ?? 'streets nearby'}</div>
            <div className={s.triNote}>
              {passes
                ? `${fmtNum(passes, 0)} passes · ${detailQ.data?.district ?? nearProps?.district ?? '—'}`
                  + `${nearM != null ? ` · ${fmtDistance(nearM, 1)} away` : ''}`
                  + `${proxy && code ? ` · ${code.toUpperCase()} as proxy` : ''}`
                : 'no covered street near this contact'}
            </div>
          </div>
          <span className={`${s.triValue} num`}>
            {measure && stats
              ? formatValue(measure, stats.p90, { role: 'industry' })
              : measure && nearProps?.p90 != null
                ? formatValue(measure, nearProps.p90, { role: 'industry' })
                : '—'}
          </span>
          <span className={s.triState}>
            <span className={s.triBadge} style={{ color: 'var(--ink-2)' }}>
              {rank != null ? `${fmtNum(rank, 0)}th pctile` : 'thin sample'}
            </span>
          </span>
        </div>

        <div className={s.triRow}>
          <span style={{ color: 'var(--tower, var(--accent))' }}>◇</span>
          <div>
            <div className={s.triSrc}>Your fenceline · {fenceline?.top.m.name ?? 'ring'}</div>
            <div className={s.triNote}>
              {fenceline ? `${fenceline.total} sensors · ${fenceline.exceeding} over` : 'no fenceline reading for this pollutant'}
            </div>
          </div>
          <span className={`${s.triValue} num`}>
            {measure && fenceline ? formatValue(measure, fenceline.top.latest.value, { role: 'industry' }) : '—'}
          </span>
          <span className={s.triState}>
            <span
              className={s.triBadge}
              style={{ color: fenceline?.top.latest.exceeds ? 'var(--threat)' : 'var(--ink-2)' }}
            >
              {fenceline ? (fenceline.top.latest.exceeds ? '▲ over' : '◇ under') : '—'}
            </span>
          </span>
        </div>
      </div>

      <div className={s.triVerdict}>
        <span className={`${s.triVerdictWord}`} style={{ color: verdict.tone }}>{verdict.word}</span>
        <p className={s.triVerdictBody}>{verdict.body}</p>
      </div>
    </Panel>
  )
}

/* ─────────────────────────────────────────────── verify your consultant */

function ModelCheck({ siteId }: { siteId: string | null }) {
  // The campaign, not the last 30 days — see `useCampaignWindow`.
  const verifyWin = useCampaignWindow()
  const verifyQ = useModelVerification(siteId, verifyWin ?? {}, {
    enabled: !!siteId && !!verifyWin,
  })
  const v = verifyQ.data
  return (
    <>
      <Panel
        title="Your dispersion study vs. what we measured"
        aside={v ? <Caps>{fmtCompact(v.n_obs)} fleet wind observations</Caps> : null}
      >
        <ModelVerificationPanel data={v ?? null} roseSize={196} />
      </Panel>
      {v && v.affected_districts.length ? (
        <Panel title="Who the study under-weights">
          <div className={s.tri}>
            {v.affected_districts.map((d) => (
              <div key={d.district} className={s.triRow}>
                <span style={{ color: 'var(--actor-community)' }}>●</span>
                <div>
                  <div className={s.triSrc}>{d.district}</div>
                  <div className={s.triNote}>hours with wind blowing this way</div>
                </div>
                <span className={`${s.triValue} num`}>{fmtNum(d.observed_freq, 1)}%</span>
                <span className={s.triState}>
                  <span className={s.triBadge} style={{ color: 'var(--threat)' }}>
                    study assumed {fmtNum(d.assumed_freq, 1)}%
                  </span>
                </span>
              </div>
            ))}
          </div>
          <div className={s.triVerdict}>
            <p className={s.triVerdictBody}>
              The rose the study assumed is not the rose we measured. That is not a reason to
              discount the study's chemistry — it is a reason to re-run it on the observed rose
              before Phase 2 permitting, because the receptor set changes.
            </p>
          </div>
        </Panel>
      ) : null}
    </>
  )
}

/* ──────────────────────────────────────────────── the residents behind it */

/** Only the reports filed by `now` — the caller has already cut the list. */
function ConcernList({ concerns, now }: { concerns: Concern[]; now: CampaignTime }) {
  if (!concerns.length) return null
  return (
    <Panel title={`Resident reports · ${concerns.length}`} aside={<Caps>you cannot close these</Caps>}>
      <div className={s.tri}>
        {concerns.map((c) => (
          <div key={c.id} className={s.triRow} style={{ gridTemplateColumns: '12px minmax(0,1fr) 96px' }}>
            <span style={{ color: 'var(--actor-community)' }}>●</span>
            <div>
              <div className={s.triSrc}>{c.title}</div>
              <div className={s.triNote}>
                {c.kind} · {c.district ?? c.address_hint ?? 'nearby'} · {relativeShort(c.occurred_at, now)}
                {c.corroborations ? ` · +${c.corroborations} corroborated` : ''}
              </div>
            </div>
            <span className={s.triState}>
              <span className={s.triBadge} style={{ color: 'var(--ink-2)' }}>{c.status.replace('_', ' ')}</span>
            </span>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/* ───────────────────────────────────────────────────────── act on it */

function RespondPanel({ alert, siteId, now }: { alert: Alert; siteId: string | null; now: CampaignTime }) {
  const mitigate = useCreateMitigation()
  const post = useCreatePost()
  const user = useSession((x) => x.user)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pct, setPct] = useState('')
  const [sent, setSent] = useState<'none' | 'mitigation' | 'post'>('none')

  if (!siteId) return null
  const disabled = !title.trim() || mitigate.isPending || post.isPending
  // Filed by the moment shown. By FILING time, not `started_at`: a mitigation
  // proposed for later had still been proposed. One filed live is stamped with
  // the server's now, the end of the data, so it appears once the clock is back
  // at the end.
  const filed = (alert.mitigations ?? []).filter((m) => hasStarted({ created_at: m.created_at }, now))

  const submit = (kind: 'mitigation' | 'post') => {
    if (kind === 'mitigation') {
      mitigate.mutate(
        {
          site_id: siteId,
          title: title.trim(),
          body: body.trim() || undefined,
          alert_id: alert.id,
          ...(alert.measure ? { measure: alert.measure } : {}),
          ...(pct.trim() ? { expected_reduction_pct: Number(pct) } : {}),
        },
        { onSuccess: () => { setSent('mitigation'); setTitle(''); setBody(''); setPct('') } },
      )
    } else {
      post.mutate(
        {
          site_id: siteId,
          kind: 'response',
          title: title.trim(),
          body: body.trim() || title.trim(),
          ...(user?.id ? { author_id: user.id } : {}),
        },
        { onSuccess: () => { setSent('post'); setTitle(''); setBody('') } },
      )
    }
  }

  return (
    <Panel title="Respond">
      <div className={s.form}>
        <div className={s.notice}>
          <span className={s.noticeMark}>▲</span>
          <span>
            You can propose a mitigation and post publicly. You cannot close a community
            concern or clear this contact — the residents and DRAQA decide when it is over.
            A mitigation is a claim you are making, and it will be read as one.
          </span>
        </div>

        <Field label="What are you doing about it">
          <Input
            value={title}
            placeholder="Throttle turbine banks C–F to 65% until 06:00"
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
        </Field>
        <Field label="Detail (optional)">
          <Textarea
            rows={3}
            value={body}
            placeholder="What changed, when it started, when you expect the fenceline to respond."
            onChange={(e) => setBody(e.currentTarget.value)}
          />
        </Field>
        <div className={s.formRow}>
          <Field label="Expected reduction %">
            <Input numeric value={pct} inputMode="numeric" onChange={(e) => setPct(e.currentTarget.value)} />
          </Field>
          <span className={s.spacer} />
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => submit('post')}>
            POST UPDATE
          </Button>
          <Button variant="primary" size="sm" disabled={disabled} onClick={() => submit('mitigation')}>
            PROPOSE MITIGATION
          </Button>
        </div>

        {sent !== 'none' ? (
          <Caps>
            {sent === 'mitigation'
              ? 'Mitigation filed · concern status now reads MITIGATION PROPOSED · awaiting the community'
              : 'Posted to the community feed'}
          </Caps>
        ) : null}

        {filed.length ? (
          <div className={s.tri}>
            {filed.map((m) => (
              <div key={m.id} className={s.triRow} style={{ gridTemplateColumns: '12px minmax(0,1fr) 96px' }}>
                <span style={{ color: 'var(--scope)' }}>◇</span>
                <div>
                  <div className={s.triSrc}>{m.title}</div>
                  <div className={s.triNote}>
                    {mitigationStatusAt(m, now).replace('_', ' ')} · {fmtDateTime(m.created_at)}
                    {m.expected_reduction_pct != null ? ` · −${fmtPct(m.expected_reduction_pct, 0, false)} expected` : ''}
                  </div>
                </div>
                <span className={s.triState}><Tag>filed</Tag></span>
              </div>
            ))}
          </div>
        ) : null}

        <Link to="/industry/outreach" className={s.stripLink}>
          <Caps>Open the outreach portal →</Caps>
        </Link>
      </div>
    </Panel>
  )
}
