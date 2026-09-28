/**
 * The side panel's detail view — one panel for everything the map can hand back.
 *
 * The map is one surface and a click on it means one thing ("tell me about
 * that"), so there is one selection and one place it lands: the side panel
 * turns into the detail and "Back" returns it to the envelope and the list.
 * There is no empty "nothing picked" box any more; it took 81–97 px to say
 * "click anything on the map".
 *
 * The panel is a discriminated union on `kind`. Adding a pickable layer means
 * adding a branch here, not another useState in `Scope`.
 */

import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { Button } from '@/app/ui'
import { compassPoint, fmtDay, fmtDistance, fmtNum, fmtPct, fmtTime24, relativeTime } from '@/core/format'
import { isOngoing } from '@/core/events'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import type { SegmentFeature } from '@/components'
import { campaignMs } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import type { EmissionPoint, Envelope, IndustrySite, MeasureDef, Monitor, WindPoint } from '@/core/types'

import { Tag, alertSentence, alertWhere, styles as s, windThen } from './lib'
import type { AlertContext, NearAlert, PlacedReport } from './lib'

export type MapPick =
  | { kind: 'report'; id: string }
  | { kind: 'alert'; id: string }
  | { kind: 'segment'; id: string }
  | { kind: 'monitor'; id: string }
  | { kind: 'emission'; id: string }
  | { kind: 'site'; id: string }
  | { kind: 'fenceline'; id: string }

export interface SelectedProps {
  pick: MapPick
  onBack: () => void
  /** The demo's now (`useNowCampaign`). Every age on the panel is measured from it. */
  now: CampaignTime
  site: IndustrySite
  measure: MeasureDef | undefined
  reports: PlacedReport[]
  alerts: NearAlert[]
  alertCtx: AlertContext
  monitors: Monitor[]
  /** Reference monitors inside today's modelled plume. */
  downwindIds: readonly string[]
  segments: SegmentFeature[]
  /** The grid's window in words (`streetsWindowWords`): "whole campaign", or "measured to Aug 24 05:00" in replay. */
  streetsWindow: string
  /** The hourly wind record around the moment shown, for "the wind when it began". */
  wind: WindPoint[] | undefined
  envelope: Envelope | undefined
  /** The typical-day band, drawn once by the deck and shown again for the fenceline road. */
  envelopeBand: ReactNode
  /** Range and bearing from the campus, for anything with a position. */
  geo: (lon: number, lat: number) => { distanceM: number; bearing: number }
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={s.selRow}>
      <span className={s.selKey}>{label}</span>
      <span className={`${s.selVal} num`}>{value}</span>
    </div>
  )
}

/** "430 m ENE" — distance and a compass point. No raw degrees: a bearing
 *  readout is instrument talk, and the map already places the thing. */
function Where({ distanceM, bearing }: { distanceM: number; bearing: number }) {
  return <Row label="From your campus" value={`${fmtDistance(distanceM, 1)} ${compassPoint(bearing)}`} />
}

/** The one answer to "who can close a resident's report", matching the server (403). */
const WHO_CLOSES = "Only the air agency or Aclima can close a resident's report; you can answer it or propose a mitigation."

/** A reading older than this at the moment shown is not "the" reading: the
 *  sensor was not reporting then (mon-rlfl-07 went offline on Jul 25). */
const STALE_MS = 2 * 3_600_000

const KIND_TITLE: Record<MapPick['kind'], string> = {
  report: 'Resident report',
  alert: 'Alert',
  segment: 'Street',
  monitor: 'Monitor',
  emission: 'Source',
  site: 'Campus',
  fenceline: 'Fenceline road',
}

export function Selected(props: SelectedProps) {
  const {
    pick, onBack, now, site, measure, reports, alerts, alertCtx, monitors, downwindIds,
    segments, streetsWindow, wind, envelope, envelopeBand, geo,
  } = props

  const head = (title: string, tag?: ReactNode) => (
    <div className={s.selHead}>
      <span className={s.selTitle}>{title}</span>
      {tag}
    </div>
  )

  let body: ReactNode = null

  if (pick.kind === 'report') {
    const r = reports.find((x) => x.concern.id === pick.id)
    body = !r ? <span className={s.reportNote}>That report is not in the last fortnight.</span> : (
      <>
        {head(r.concern.title, r.linked ? <Tag tone="accent">downwind then</Tag> : null)}
        <span className={s.selSub}>
          resident report · {r.concern.kind} · severity {r.concern.severity}/5
        </span>
        {r.concern.body ? <p className={s.reportQuote}>“{r.concern.body}”</p> : null}
        <Where distanceM={r.distanceM} bearing={r.bearing} />
        <Row label="Filed" value={relativeTime(r.concern.created_at, now)} />
        <Row label="Neighbours agreed" value={fmtNum(r.concern.corroborations, 0)} />
        <Row label="Status" value={r.concern.status.replace(/_/g, ' ')} />
        <span className={s.selNote}>{windThen(wind, r.concern.occurred_at, r.bearing)}</span>
        {/* F7, said as the drawing rule rather than as a verdict on the
            report: filled means both tests agree, hollow means they do not. */}
        <span className={s.selNote}>
          {r.linked
            ? 'Drawn filled: the wind at the time carried from your campus to here, and your measured downwind test passed the rotation check.'
            : 'Drawn hollow: the wind at the time and your measured downwind test do not both point here.'}
        </span>
        <div className={s.reportActions}>
          <Link to="/industry/community"><Button size="sm" variant="secondary">All reports</Button></Link>
          <Link to="/industry/outreach"><Button size="sm" variant="ghost">Answer</Button></Link>
        </div>
        <span className={s.selNote}>
          {WHO_CLOSES} Either one moves it to “mitigation proposed”.
        </span>
      </>
    )
  } else if (pick.kind === 'alert') {
    const c = alerts.find((x) => x.alert.id === pick.id)
    const ongoing = c ? isOngoing(c.alert, now) : false
    body = !c ? <span className={s.reportNote}>That alert is not in the recent list.</span> : (
      <>
        {head(alertSentence(c.alert, alertCtx), (
          <Tag tone={c.alert.severity === 'critical' || c.alert.severity === 'warning' ? 'threat' : undefined}>
            {SEVERITY_LABEL[c.alert.severity]}
          </Tag>
        ))}
        <span className={s.selSub}>
          {c.kindLabel}{ongoing ? ' · ongoing' : ' · ended'}
        </span>
        {c.alert.value != null && c.alert.threshold && c.alert.measure ? (
          <Row
            label="Reading"
            value={
              <span style={{ color: severityVar(c.alert.severity) }}>
                {fmtNum(c.alert.value, 1)} {c.alert.unit ?? ''} · {fmtNum(c.alert.value / c.alert.threshold, 2)}× the level
              </span>
            }
          />
        ) : null}
        <Row label="Where · when" value={alertWhere(c, now)} />
        {c.sited ? (
          <span className={s.selNote}>{windThen(wind, c.alert.started_at, c.bearing)}</span>
        ) : null}
        {c.alert.source_type === 'mobile' ? (
          <span className={s.selNote}>
            A measurement on a street by Aclima's cars. It says what the air on that road
            carried, not where it came from.
          </span>
        ) : null}
        {/* D13: the fleet's detections come with the regulator's advice
            ("site a temporary monitor here"). Advice addressed to someone
            else is not printed to the operator as theirs. */}
        {c.alert.recommendation && c.alert.audience?.includes('industry')
          ? <p className={s.reportQuote}>{c.alert.recommendation}</p>
          : null}
        <div className={s.reportActions}>
          <Link to={`/industry/alerts/${c.alert.id}`}>
            <Button size="sm" variant="secondary">Open alert</Button>
          </Link>
        </div>
      </>
    )
  } else if (pick.kind === 'fenceline') {
    const stable = envelope?.regimes.find((r) => r.regime === 'stable')
    body = (
      <>
        {head(envelope?.fenceline_roads.join(', ') || 'Fenceline road', <Tag tone="accent">your fenceline</Tag>)}
        <span className={s.selSub}>
          within {fmtDistance(envelope?.fenceline_m ?? null, 1)} of a running source · {envelope?.n_fenceline_segments ?? 0} street segments
        </span>
        <span className={s.selNote}>
          The envelope is measured here: this road against roads of the same class more than
          2 km from any site, on the same nights, by the same cars.
        </span>
        {stable && stable.level_p50 != null && stable.comparison_p50 != null ? (
          <>
            <Row
              label="Stable air, median"
              value={`${fmtNum(stable.level_p50, 0)} vs ${fmtNum(stable.comparison_p50, 0)} ${envelope?.unit ?? ''}`}
            />
            <Row label="Measured stable nights" value={fmtNum(stable.n_episodes, 0)} />
          </>
        ) : null}
        {envelopeBand}
        <div className={s.reportActions}>
          <Link to="/industry/evidence"><Button size="sm" variant="secondary">The evidence</Button></Link>
        </div>
      </>
    )
  } else if (pick.kind === 'segment') {
    const f = segments.find((x) => x.properties.id === pick.id)
    const p = f?.properties
    const unit = measure?.unit ?? ''
    const dec = measure?.decimals ?? 1
    body = !p ? <span className={s.reportNote}>That street is not in view.</span> : (
      <>
        {head(f?.properties.name || 'Unnamed street', <Tag>Aclima fleet</Tag>)}
        <span className={s.selSub}>
          {p.district ?? 'unknown district'} · {measure?.label ?? 'measurement'} · {streetsWindow}
        </span>
        {/* This is the novel data — nobody else has a number for this street. */}
        <Row label="Median" value={`${fmtNum(p.median, dec)} ${unit}`} />
        <Row label="P90" value={`${fmtNum(p.p90, dec)} ${unit}`} />
        <Row label="Worst pass" value={`${fmtNum(p.max, dec)} ${unit}`} />
        <Row
          label="Persistence"
          value={p.persistence == null ? '—' : fmtPct(p.persistence * 100, 0, false)}
        />
        <Row label="Passes" value={fmtNum(p.n_passes, 0)} />
        {(() => {
          const g = geo(f.geometry.coordinates[0][0], f.geometry.coordinates[0][1])
          return <Where distanceM={g.distanceM} bearing={g.bearing} />
        })()}
        <span className={s.selNote}>
          Measured by Aclima's cars on {p.n_passes} passes. No fixed instrument stands on this
          street — this number exists because something drove it.
        </span>
      </>
    )
  } else if (pick.kind === 'monitor') {
    const m = monitors.find((x) => x.id === pick.id)
    const mine = m?.site_id === site.id
    const org = m ? alertCtx.orgs.find((o) => o.id === m.org_id) : undefined
    const downwind = m ? downwindIds.includes(m.id) : false
    body = !m ? <span className={s.reportNote}>That sensor is not in view.</span> : (
      <>
        {head(
          mine ? m.name : `${m.name} monitor`,
          mine ? <Tag tone="accent">your fenceline</Tag> : <Tag>{org?.short_name ?? 'reference'}</Tag>,
        )}
        <span className={s.selSub}>
          {mine ? 'fenceline sensor' : 'reference monitor'} · {m.code ?? m.id} · {m.status}
        </span>
        <Where {...geo(m.lon, m.lat)} />
        {!mine ? (
          <Row label="Today's plume (model)" value={downwind ? 'over it' : 'not over it'} />
        ) : null}
        <Row label="Pollutants" value={m.measures.map((x) => x.toUpperCase()).join(' · ') || '—'} />
        {m.measures.map((code) => {
          const l = m.latest?.[code]
          if (!l) return null
          const active = code === measure?.code
          // A stale value is not a reading at the moment shown: an offline
          // sensor's last July number, printed plainly, read as today's.
          const stale = campaignMs(now) - campaignMs(l.ts) > STALE_MS
          return (
            <Row
              key={code}
              label={active ? `${code.toUpperCase()} ◂` : code.toUpperCase()}
              value={stale ? (
                <span style={{ color: 'var(--ink-3)' }}>no reading since {fmtDay(l.ts)} {fmtTime24(l.ts)}</span>
              ) : (
                <span style={{ color: l.exceeds ? 'var(--threat, var(--sev-critical))' : undefined }}>
                  {fmtNum(l.value, 1)}{l.exceeds ? ' · over' : ''}
                </span>
              )}
            />
          )
        })}
        {/* An instrument that does not carry the pollutant you are reading is
            not a quiet instrument — the dot on the map goes un-alarmed either
            way, and only this line tells the two apart. */}
        {measure && !m.measures.includes(measure.code) ? (
          <span className={s.selNote}>
            No {measure.short_label} on this instrument. Nothing here confirms or denies what
            the streets are showing you.
          </span>
        ) : null}
        {!mine ? (
          <span className={s.selNote}>
            {org?.short_name ? `Run by ${org.short_name}. ` : ''}It measures the air at this spot;
            it does not say where that air came from.
          </span>
        ) : null}
      </>
    )
  } else if (pick.kind === 'emission') {
    const ep: EmissionPoint | undefined = site.emission_points.find((x) => x.id === pick.id)
    body = !ep ? <span className={s.reportNote}>Source not found.</span> : (
      <>
        {head(ep.name, ep.active ? <Tag tone="accent">running</Tag> : <Tag>idle</Tag>)}
        <span className={s.selSub}>{ep.kind.replace(/_/g, ' ')} · your equipment</span>
        <Where {...geo(ep.lon, ep.lat)} />
        {ep.height_m ? <Row label="Stack height" value={`${fmtNum(ep.height_m, 0)} m`} /> : null}
        <Row label="Emits" value={ep.measures.map((x) => x.toUpperCase()).join(' · ') || '—'} />
      </>
    )
  } else {
    body = (
      <>
        {head(site.name, <Tag tone="accent">your campus</Tag>)}
        <span className={s.selSub}>{site.kind} · {site.status}</span>
        <Row label="Sources" value={`${site.emission_points.length} · ${site.emission_points.filter((e) => e.active).length} running`} />
        {site.capacity_mw ? <Row label="Capacity" value={`${fmtNum(site.capacity_mw, 0)} MW`} /> : null}
        {site.it_load_mw ? <Row label="IT load today" value={`${fmtNum(site.it_load_mw, 0)} MW`} /> : null}
        <div className={s.reportActions}>
          <Link to="/industry/site"><Button size="sm" variant="secondary">Site settings</Button></Link>
        </div>
      </>
    )
  }

  return (
    <section className={s.card} aria-label={KIND_TITLE[pick.kind]}>
      <header className={s.cardHead}>
        <button type="button" className={s.backBtn} onClick={onBack}>← Back</button>
        <span className={s.cardTitle}>{KIND_TITLE[pick.kind]}</span>
      </header>
      <div className={s.reportDetail}>{body}</div>
    </section>
  )
}
