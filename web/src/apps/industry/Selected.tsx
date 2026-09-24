/**
 * The "selected item" column — one panel for everything the map can hand back.
 *
 * Before this, two things on the scope were clickable and each carried its own
 * piece of state: a report set `pickedReport`, an alert contact set `selected`,
 * and nothing else could be picked at all. That is a leaky abstraction dressed
 * as a feature — the map is one surface and a click on it means one thing
 * ("tell me about that"), so there is one selection and one place it lands.
 *
 * The panel is a discriminated union on `kind`. Adding a pickable layer means
 * adding a branch here, not another useState in `Scope`.
 */

import { Link } from '@tanstack/react-router'

import { Button } from '@/app/ui'
import { fmtBearing, fmtDistance, fmtNum, fmtPct, relativeShort } from '@/core/format'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import type { SegmentFeature } from '@/components'
import type { CampaignTime } from '@/core/clock'
import type { EmissionPoint, IndustrySite, MeasureDef, Monitor } from '@/core/types'

import { Caps, Panel, Tag, styles as s } from './lib'
import type { Contact, PlacedReport } from './lib'

export type MapPick =
  | { kind: 'report'; id: string }
  | { kind: 'alert'; id: string }
  | { kind: 'segment'; id: string }
  | { kind: 'monitor'; id: string }
  | { kind: 'emission'; id: string }
  | { kind: 'site'; id: string }

export interface SelectedProps {
  pick: MapPick | null
  onClear: () => void
  /** The demo's now (`useNowCampaign`). Every age on the panel is measured from it. */
  now: CampaignTime
  site: IndustrySite
  measure: MeasureDef | undefined
  reports: PlacedReport[]
  contacts: Contact[]
  monitors: Monitor[]
  segments: SegmentFeature[]
  /** Range and bearing from the campus, for anything with a position. */
  geo: (lon: number, lat: number) => { distanceM: number; bearing: number }
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={s.selRow}>
      <span className={s.selKey}>{label}</span>
      <span className={`${s.selVal} num`}>{value}</span>
    </div>
  )
}

function Where({ distanceM, bearing }: { distanceM: number; bearing: number }) {
  return (
    <Row
      label="From campus"
      value={`${fmtDistance(distanceM, 1)} ${fmtBearing(bearing)}`}
    />
  )
}

export function Selected(props: SelectedProps) {
  const { pick, onClear, now, site, measure, reports, contacts, monitors, segments, geo } = props

  const head = (title: string, tag?: React.ReactNode) => (
    <div className={s.selHead}>
      <span className={s.selTitle}>{title}</span>
      {tag}
    </div>
  )

  let body: React.ReactNode = null

  if (!pick) {
    body = (
      <span className={s.reportNote}>
        Click anything on the map — a street, a stack, a sensor, a resident's report — to read
        it here.
      </span>
    )
  } else if (pick.kind === 'report') {
    const r = reports.find((x) => x.concern.id === pick.id)
    body = !r ? <span className={s.reportNote}>Report not in view.</span> : (
      <>
        {head(r.concern.title, r.downwind
          ? <Tag tone="threat">downwind of you</Tag>
          : <Tag>off your axis</Tag>)}
        <span className={s.reportSub}>
          resident report · {r.concern.kind} · severity {r.concern.severity}/5
        </span>
        {r.concern.body ? <p className={s.reportQuote}>“{r.concern.body}”</p> : null}
        <Where distanceM={r.distanceM} bearing={r.bearing} />
        <Row label="Filed" value={relativeShort(r.concern.created_at, now)} />
        <Row label="Neighbours agreed" value={fmtNum(r.concern.corroborations, 0)} />
        <Row label="Status" value={r.concern.status.replace(/_/g, ' ')} />
        <div className={s.reportActions}>
          <Link to="/industry/community"><Button size="sm" variant="secondary">All reports</Button></Link>
          <Link to="/industry/outreach"><Button size="sm" variant="ghost">Answer</Button></Link>
        </div>
        <span className={s.reportNote}>
          Answering moves this to “mitigation proposed”. Only the air agency or Aclima can
          close a resident's report.
        </span>
      </>
    )
  } else if (pick.kind === 'alert') {
    const c = contacts.find((x) => x.alert.id === pick.id)
    body = !c ? <span className={s.reportNote}>Alert no longer live.</span> : (
      <>
        {head(c.alert.title, (
          <Tag tone={c.alert.severity === 'critical' || c.alert.severity === 'warning' ? 'threat' : undefined}>
            {SEVERITY_LABEL[c.alert.severity]}
          </Tag>
        ))}
        <span className={s.reportSub}>{c.kindLabel}</span>
        {c.alert.value != null && c.alert.threshold ? (
          <Row
            label="Reading"
            value={
              <span style={{ color: severityVar(c.alert.severity) }}>
                {fmtNum(c.alert.value, 1)} {c.alert.unit ?? ''} · {fmtNum(c.alert.value / c.alert.threshold, 2)}× limit
              </span>
            }
          />
        ) : null}
        {c.sited ? <Where distanceM={c.distance} bearing={c.bearing} /> : <Row label="Where" value="site-wide" />}
        <Row label="Up for" value={relativeShort(c.alert.started_at, now)} />
        {c.alert.recommendation ? (
          <p className={s.reportQuote}>{c.alert.recommendation}</p>
        ) : null}
        <div className={s.reportActions}>
          <Link to={`/industry/alerts/${c.alert.id}`}>
            <Button size="sm" variant="secondary">Open alert</Button>
          </Link>
        </div>
      </>
    )
  } else if (pick.kind === 'segment') {
    const f = segments.find((x) => x.properties.id === pick.id)
    const p = f?.properties
    const unit = measure?.unit ?? ''
    const dec = measure?.decimals ?? 1
    body = !p ? <span className={s.reportNote}>Street not in view.</span> : (
      <>
        {head(f?.properties.name || 'Unnamed street', <Tag>our fleet</Tag>)}
        <span className={s.reportSub}>
          {p.district ?? 'unknown district'} · {measure?.label ?? 'measurement'}
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
        <span className={s.reportNote}>
          Measured by our cars on {p.n_passes} passes. No fixed instrument stands on this
          street — this number exists because something drove it.
        </span>
      </>
    )
  } else if (pick.kind === 'monitor') {
    const m = monitors.find((x) => x.id === pick.id)
    const mine = m?.site_id === site.id
    body = !m ? <span className={s.reportNote}>Sensor not in view.</span> : (
      <>
        {head(m.name, mine ? <Tag tone="accent">your fenceline</Tag> : <Tag tone="threat">the regulator's</Tag>)}
        <span className={s.reportSub}>
          {m.code ?? m.id} · {m.grade} · {m.status}
        </span>
        <Where {...geo(m.lon, m.lat)} />
        {m.radius_m ? <Row label="Speaks for" value={`${fmtNum(m.radius_m / 1000, 1)} km radius`} /> : null}
        <Row label="Channels" value={m.measures.map((x) => x.toUpperCase()).join(' · ') || '—'} />
        {m.measures.map((code) => {
          const l = m.latest?.[code]
          if (!l) return null
          const active = code === measure?.code
          return (
            <Row
              key={code}
              label={active ? `${code.toUpperCase()} ◂` : code.toUpperCase()}
              value={
                <span style={{ color: l.exceeds ? 'var(--threat, var(--sev-critical))' : undefined }}>
                  {fmtNum(l.value, 1)}{l.exceeds ? ' · over' : ''}
                </span>
              }
            />
          )
        })}
        {/* An instrument that does not carry the channel you are reading is not
            a quiet instrument — the dot on the map goes un-alarmed either way,
            and only this line tells the two apart. */}
        {measure && !m.measures.includes(measure.code) ? (
          <span className={s.reportNote}>
            This instrument has no {measure.short_label} channel. Nothing here confirms or
            denies what the streets are showing you.
          </span>
        ) : null}
        {!mine ? (
          <span className={s.reportNote}>
            This is a reference instrument you do not own. Your fenceline exists so that this
            one never has to raise anything.
          </span>
        ) : null}
      </>
    )
  } else if (pick.kind === 'emission') {
    const ep: EmissionPoint | undefined = site.emission_points.find((x) => x.id === pick.id)
    body = !ep ? <span className={s.reportNote}>Source not found.</span> : (
      <>
        {head(ep.name, ep.active ? <Tag tone="accent">running</Tag> : <Tag>idle</Tag>)}
        <span className={s.reportSub}>{ep.kind.replace(/_/g, ' ')} · your equipment</span>
        <Where {...geo(ep.lon, ep.lat)} />
        {ep.height_m ? <Row label="Stack height" value={`${fmtNum(ep.height_m, 0)} m`} /> : null}
        <Row label="Emits" value={ep.measures.map((x) => x.toUpperCase()).join(' · ') || '—'} />
      </>
    )
  } else {
    body = (
      <>
        {head(site.name, <Tag tone="accent">your campus</Tag>)}
        <span className={s.reportSub}>{site.kind} · {site.status}</span>
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
    <Panel
      title="Selected"
      aside={pick
        ? <button type="button" className={s.linkBtn} onClick={onClear}>clear</button>
        : <Caps>nothing picked</Caps>}
      bodyClass={s.selBody}
    >
      <div className={s.reportDetail}>{body}</div>
    </Panel>
  )
}
