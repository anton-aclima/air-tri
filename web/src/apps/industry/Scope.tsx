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
  AlertTimeline, BaseMap, DispersionLayer, MapOverlay, MapWindField,
  MonitorLayer, RadarScope, SegmentLayer, SiteLayer,
} from '@/components'
import type { MapView, RadarContact, Theme } from '@/components'
import { Button } from '@/app/ui'
import { compassPoint, fmtBearing, fmtCompact, fmtDistance, fmtNum, fmtPct, relativeShort } from '@/core/format'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import {
  useAlerts, useDispersion, useDispersionModels, useModelVerification, useMonitors,
  useSegments, useWind, useWindField,
} from '@/core/queries'
import type { Alert, Position } from '@/core/types'

import {
  Caps, Panel, Readout, Tag, bboxAround, contactLine, countBySeverity, downwindOf,
  envelopeOf, foldContacts, radarOverlay, severityCountLine, shortTitle, styles as s,
  toContacts, useNowTick, useSiteLock, useStableWindow,
} from './lib'

const LIVE_STATUSES = new Set(['active', 'acknowledged'])

export function Scope() {
  const site = useSiteLock()
  const navigate = useNavigate()
  const now = useNowTick(1000)

  // Quantised window — see `useStableWindow`: the shared default re-derives
  // `to` every render, which turns any wind query into a refetch loop.
  const win = useStableWindow(24)
  // The field is binned from wherever the fleet drove, so a longer window fills
  // more streets. The strip states the window and the sample size out loud.
  const fieldWin = useStableWindow(72)
  const alertsQ = useAlerts({ site_id: site?.id }, { enabled: !!site })
  const windQ = useWindField({ cell_m: 400, ...fieldWin })
  const modelsQ = useDispersionModels(site?.id)
  const verifyQ = useModelVerification(site?.id)
  const windSeries = useWind(win)
  const wind = windSeries.data?.[windSeries.data.length - 1]

  const [showWind, setShowWind] = useState(true)
  const [showModel, setShowModel] = useState(false)
  const [showGrid, setShowGrid] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  /** Which emission point the MFD is centred on. `null` = the site centroid. */
  const [focusEp, setFocusEp] = useState<string | null>(null)
  const [locked, setLocked] = useState(true)

  // Only the streets around this site. The regulator wants the whole campaign;
  // an operator wants the blocks their plume actually crosses, and a 1,307
  // segment grid at this zoom is noise they did not ask for.
  const bbox = useMemo(() => (site ? bboxAround(site.centroid, 9000) : null), [site])
  const segsQ = useSegments({ bbox, limit: 9000 }, { enabled: !!bbox && showGrid })
  const monitorsQ = useMonitors()
  const plumeQ = useDispersion({ site_id: site?.id })

  const live = useMemo(
    () => (alertsQ.data ?? []).filter((a: Alert) => LIVE_STATUSES.has(a.status)),
    [alertsQ.data],
  )
  const all = useMemo(() => toContacts(live), [live])
  // One row per real threat: a watch and a warning from the same instrument are
  // the same problem counted twice.
  const { contacts, folded } = useMemo(() => foldContacts(all), [all])
  const counts = useMemo(() => countBySeverity(contacts), [contacts])
  const worst = contacts[0]
  const threat = counts.critical > 0 || counts.warning > 0
  const envelope = envelopeOf(site)

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

  const mfdLayers = useCallback((theme: Theme) => [
    ...(showGrid ? SegmentLayer({ data: segsQ.data, theme, dualEncode: 'width', minPasses: 3 }) : []),
    ...(showModel ? DispersionLayer({ data: plumeQ.data, theme, maxOpacity: 0.1 }) : []),
    ...MonitorLayer({ data: fenceline, theme, rings: false, labels: false, sizePx: 11 }),
    // Rings ON for these: a 2.5 km representativeness radius is exactly the
    // question — is my plume crossing the ground this instrument speaks for?
    ...MonitorLayer({
      id: 'reference', data: reference, theme, rings: true, labels: true, sizePx: 16,
      selectedId: exposed?.monitor.id ?? null,
    }),
    ...SiteLayer({ data: site ? [site] : [], theme, emissionPoints: true, labels: true }),
    ...(focus ? radarOverlay({
      theme, origin: focus, contacts, selectedId: selected, onSelect: setSelected,
      transportDeg,
    }) : []),
  ], [
    showGrid, showModel, segsQ.data, plumeQ.data, fenceline, reference,
    site, focus, contacts, selected, transportDeg, exposed,
  ])

  if (!site) {
    return <div className={`${s.page} ${s.scopePage}`}><div className={s.err}>No site locked.</div></div>
  }

  const focusEpRow = focusEp ? site.emission_points.find((e) => e.id === focusEp) : undefined
  const focusName = focusEpRow ? epShort(focusEpRow.name) : site.name

  return (
    <div className={`${s.page} ${s.scopePage}`}>
      {/* ── the one-second read ─────────────────────────────────────────── */}
      <div className={`${s.banner} ${threat ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.verdict}>
          <span className={`${s.verdictGlyph} ${threat ? s.threatInk : s.clearInk}`}>
            {threat ? '▲' : '◇'}
          </span>
          <span className={`${s.verdictWord} ${threat ? s.threatInk : s.clearInk}`}>
            {threat ? 'THREAT' : contacts.length ? 'WATCH' : 'CLEAR'}
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
              <span className={s.bannerHead}>No contacts on the scope</span>
              <span className={s.bannerSub}>
                Nothing from the regulator, the community or your fenceline in the current window.
              </span>
            </>
          )}
        </div>

        <div className={s.bannerStats}>
          <Readout
            label="Contacts"
            value={fmtNum(contacts.length, 0)}
            tone={threat ? 'threat' : 'accent'}
            big
          />
          <Readout
            label="Bearing"
            value={worst ? fmtBearing(worst.bearing) : '—'}
            tone={threat ? 'threat' : undefined}
          />
          <Readout
            label="Range"
            value={worst ? fmtDistance(worst.distance, 1) : '—'}
          />
          <Readout
            label="Envelope left"
            value={envelope ? fmtPct(envelope.freePct, 0, false) : '—'}
            tone={envelope?.tight ? 'threat' : 'accent'}
            big
          />
        </div>
      </div>

      {/* ── the MFD, and the RWR beside it ─────────────────────────────── */}
      <div className={s.scopeBody}>
        <Panel
          title={`MFD · ${focusName}`}
          aside={
            <>
              <Button size="sm" variant={showGrid ? 'secondary' : 'ghost'} onClick={() => setShowGrid((v) => !v)}>
                GRID
              </Button>
              <Button size="sm" variant={showWind ? 'secondary' : 'ghost'} onClick={() => setShowWind((v) => !v)}>
                WIND
              </Button>
              <Button size="sm" variant={showModel ? 'secondary' : 'ghost'} onClick={() => setShowModel((v) => !v)}>
                MODEL
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
            minZoom={10}
            maxZoom={18}
            label={`Moving map centred on ${focusName}`}
            fullBleed={showWind ? (
              <MapWindField field={windQ.data} particles={700} opacity={0.42} lineWidth={1} />
            ) : null}
          >
            {/* Slew-to-designate: your buildings and every stack on them. */}
            <MapOverlay place="top-left">
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
            </MapOverlay>

            <MapOverlay place="bottom-left">
              <Caps>
                rings 1 · 2 · 4 · 6 km from {focusName}
                {contacts.length ? ` · ${contacts.length} contact${contacts.length === 1 ? '' : 's'} within reach` : ' · scope clear'}
              </Caps>
            </MapOverlay>
          </BaseMap>
        </Panel>

        <div className={s.stack} style={{ minHeight: 0 }}>
          {/* the one-second instrument: bearing, range, nothing else */}
          <Panel
            title="Threat scope"
            aside={<Caps>{contacts.length ? `worst ${fmtBearing(worst?.bearing ?? null)}` : 'clear'}</Caps>}
          >
            <div className={s.rwrWrap}>
              <RadarScope
                contacts={radarContacts}
                size={160}
                site={site.centroid}
                modelContours={model?.contours ?? null}
                ownLabel={site.name}
                selectedId={selected}
                onSelect={setSelected}
                rangeCurve="sqrt"
                labels="none"
              />
            </div>
          </Panel>

          {/* the promise: what is still available to run */}
          <Panel title="Safe operating envelope">
            <div className={s.envelope}>
              <div className={s.envRow}>
                <span className={`${s.envNum} num${envelope?.tight ? ` ${s.envNumTight}` : ''}`}>
                  {envelope ? fmtPct(envelope.freePct, 0, false) : '—'}
                </span>
                <Caps ink>of the safe envelope left</Caps>
                <span className={s.spacer} />
                <span className="num" style={{ color: 'var(--ink-2)', fontSize: 'var(--text-xs)' }}>
                  {envelope ? `${fmtPct(envelope.usedPct, 0, false)} used` : ''}
                </span>
              </div>
              <div className={s.envBar}>
                <div className={s.envUsed} style={{ width: `${envelope?.usedPct ?? 0}%` }} />
                <div className={s.envTicks} />
                <div className={s.envEdge} style={{ left: `${envelope?.usedPct ?? 0}%` }} />
              </div>
              <span className={s.bannerSub}>
                {envelope?.freeMw != null
                  ? `≈ ${fmtNum(envelope.freeMw, 0)} MW of additional load still inside the community-and-regulator-safe envelope at today's ${fmtNum(site.it_load_mw, 0)} MW IT load.`
                  : 'Envelope not yet characterised for this site.'}
              </span>
            </div>
          </Panel>

          {/* threat-first, one click to the answer */}
          <Panel
            title="Contacts"
            aside={<Caps>{contacts.length ? severityCountLine(counts) : 'none'}{folded ? ` · +${folded} folded` : ''}</Caps>}
            className={s.stackGrow}
          >
            {alertsQ.isError ? (
              <div className={s.err}>Scope offline — no contact feed.</div>
            ) : contacts.length === 0 ? (
              <div className={s.err}>No contacts. Nothing is pointing at you right now.</div>
            ) : (
              <div className={s.contacts}>
                <div className={s.contactHead} aria-hidden>
                  <span /><span>src</span><span>contact</span><span>brg</span><span>range</span><span>up for</span>
                </div>
                {contacts.map((c) => (
                  <button
                    key={c.alert.id}
                    type="button"
                    className={`${s.contact}${selected === c.alert.id ? ` ${s.contactActive}` : ''}`}
                    onMouseEnter={() => setSelected(c.alert.id)}
                    onFocus={() => setSelected(c.alert.id)}
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
      </div>

      {/* ── how long has each contact been up ───────────────────────────── */}
      <div className={s.ribbon}>
        <ContactRibbon
          alerts={contacts.map((c) => c.alert)}
          selected={selected}
          onSelect={setSelected}
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
    <Panel title="Contact history · how long each has been up">
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
