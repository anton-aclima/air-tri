/**
 * SHEET 07 — /admin/director · The Demo Director.
 *
 * A stage manager's panel, not a button bar. A presenter stands here and drives
 * the whole show: pick a cue, read what it will do to each of the other three
 * interfaces, then pull the lever. Everything is two-stage and every
 * consequence is stated before the fact — nothing here should ever be fired by
 * accident, and one cue (ALL CLEAR) empties the industry radar, so it is
 * marked, coloured and gated behind an extra confirmation.
 *
 * Scenarios write real rows. The cluster detector, the action-level evaluator
 * and the activity log then do their normal work, and the effect leaves over
 * SSE — which is why the log on the right fills up seconds after the lever
 * moves, without anyone refreshing anything.
 */

import { useMemo, useState } from 'react'

import { Button, Modal } from '@/app/ui'
import type { SimulateResult } from '@/core/api'
import { happenedBy, isOngoing } from '@/core/events'
import { fmtDateTime, fmtNum, fmtTime, relativeShort } from '@/core/format'
import { useLiveEvents, useLiveStatus } from '@/core/live'
import { severityVar } from '@/core/measures'
import { useAlerts, useConcerns, useReseed, useSimulate } from '@/core/queries'
import { nowCampaign, useNowCampaign, useSession } from '@/core/session'
import type { Role, SimScenario } from '@/core/types'

import {
  ACTOR_VAR, Caps, KV, Readout, Readouts, Sheet, TitleBlock, stampedBy, styles as s,
} from './lib'

/** The backend knows six; `SimScenario` in core/types is missing this one. */
type Scenario = SimScenario | 'model_divergence'

interface Consequence { who: Role; what: string }

interface Cue {
  id: Scenario
  no: string
  name: string
  description: string
  consequences: Consequence[]
  danger?: boolean
}

const CUES: Cue[] = [
  {
    id: 'generator_test',
    no: '1',
    name: 'Generator test',
    description:
      'Ridgeline runs a turbine test. NO₂ and black carbon spike on the east fenceline, real monitor readings are written, and the action-level evaluator does the rest.',
    consequences: [
      { who: 'industry', what: 'A new contact appears on the scope at ~095°, close in. The safe-envelope readout tightens.' },
      { who: 'regulator', what: 'An exceedance alert lands in the queue with the samples attached.' },
      { who: 'community', what: 'Nothing yet — residents only see it if someone files a concern or DRAQA issues an advisory.' },
    ],
  },
  {
    id: 'concern_wave',
    no: '2',
    name: 'Concern wave',
    description:
      'Six residents file smell, noise and health reports within ninety minutes and 600 m of each other. Cluster detection fires on its own.',
    consequences: [
      { who: 'community', what: 'Six new concerns on the map and in the feed; the cluster halo starts breathing.' },
      { who: 'industry', what: 'A concern-cluster contact appears on the radar to the south-east. The operator cannot close it.' },
      { who: 'regulator', what: 'The cluster enters the queue as a warning-severity alert.' },
    ],
  },
  {
    id: 'wind_shift',
    no: '3',
    name: 'Wind shift',
    description:
      'Wind veers from SW to NNE and carries the plume over the school. Integrated exposure crosses its level and DRAQA publishes.',
    consequences: [
      { who: 'community', what: 'A public advisory appears, pinned, in plain language with no units.' },
      { who: 'regulator', what: 'An integrated-exposure alert opens alongside the advisory.' },
      { who: 'industry', what: 'The observed wind field in the scope swings — and stops agreeing with the consultant contour.' },
    ],
  },
  {
    id: 'methane_leak',
    no: '4',
    name: 'Methane leak',
    description:
      'Mobile monitoring finds a methane anomaly no stationary monitor can see. The leapfrog moment: the regulator\'s own network is blind to it.',
    consequences: [
      { who: 'regulator', what: 'A mobile-detection alert with no reference-monitor corroboration — because none of the three monitors measures CH₄.' },
      { who: 'industry', what: 'A contact from a source the operator has no instrument of their own to check.' },
      { who: 'community', what: 'The affected streets change colour on the map.' },
    ],
  },
  {
    id: 'model_divergence',
    no: '5',
    name: 'Model divergence',
    description:
      'A run of north-wind days pushes observed transport off the consultant\'s assumed rose. Model verification flips to "understates".',
    consequences: [
      { who: 'industry', what: 'The verification panel flips verdict; the particles visibly cross the dashed contour instead of running along it.' },
      { who: 'regulator', what: 'A wind-shift alert citing the divergence, with the per-bearing bias attached.' },
      { who: 'community', what: 'The under-weighted downwind neighbourhood is exactly the one filing concerns.' },
    ],
  },
  {
    id: 'all_clear',
    no: '6',
    name: 'All clear',
    description:
      'Mitigation completes, levels fall, alerts resolve and advisories close. The reset at the end of a demo.',
    danger: true,
    consequences: [
      { who: 'industry', what: 'THE RADAR EMPTIES. Every contact resolves and the scope reads CLEAR — there is no undo.' },
      { who: 'regulator', what: 'The alert queue drains to nothing.' },
      { who: 'community', what: 'Advisories close and the feed goes quiet.' },
    ],
  },
]

interface Fired {
  at: string
  scenario: Scenario
  ok: boolean
  summary: string
}

/**
 * When a cue's rows were written. The server's clock is frozen at the end of
 * the data (docs/PLAN-refocus.md D1) and does not follow the cursor, so a cue
 * fired while replaying August 12 still writes at the end — and the log says
 * that instant, not the cursor's and not the wall clock's (which was a month
 * after the data). `POST /admin/simulate` returns it as `at`; core/api's type
 * leaves the field out.
 */
function writtenAt(res?: SimulateResult & { at?: string }): string {
  const { time } = useSession.getState()
  return res?.at ?? time.bounds?.end ?? nowCampaign(time)
}

export function Director() {
  const simulate = useSimulate()
  const reseed = useReseed()
  const events = useLiveEvents()
  const status = useLiveStatus()
  // The whole record (`at: undefined`), not the session's moment: ALL CLEAR
  // resolves by status at the end of the data, whatever the cursor says, so
  // its confirmation must count every alert it will close. The world state is
  // cut to the moment below — all 31 alerts fit in one request.
  const alerts = useAlerts({ role: 'admin', at: undefined })
  // Counted as a headline below, so the limit must exceed the campaign.
  const concerns = useConcerns({ limit: 1000 })
  const now = useNowCampaign()
  const replaying = useSession((st) => st.time.cursor)

  // A stage manager's panel always has something on the lever.
  const [armed, setArmed] = useState<Scenario | null>('generator_test')
  const [confirm, setConfirm] = useState(false)
  const [log, setLog] = useState<Fired[]>([])
  const [reseedOpen, setReseedOpen] = useState(false)

  const cue = useMemo(() => CUES.find((c) => c.id === armed) ?? null, [armed])
  const lastFired = log[0]
  // What the world looks like AT THE MOMENT ON SCREEN (D2): only what had begun
  // by then, and "up" means `isOngoing` — begun and not ended — not a status.
  const shown = happenedBy(alerts.data, now)
  const active = shown.filter((a) => isOngoing(a, now))
  const closable = (alerts.data ?? []).filter((a) => a.status === 'active' || a.status === 'acknowledged')
  // Cues write at the end of the data, so while replaying, what they write is
  // in the moment's future and — correctly — nowhere on screen yet.
  const stream = useMemo(() => stampedBy(events, now, (e) => e.at), [events, now])

  function fire(target: Cue) {
    simulate.mutate(target.id as SimScenario, {
      onSuccess: (res) => {
        const bits = [
          res.alerts?.length ? `${res.alerts.length} alerts` : '',
          res.concerns?.length ? `${res.concerns.length} concerns` : '',
          res.advisories?.length ? `${res.advisories.length} advisories` : '',
        ].filter(Boolean)
        setLog((l) => [
          {
            at: writtenAt(res),
            scenario: target.id,
            ok: true,
            summary: bits.length ? bits.join(' · ') : (res.message ?? 'written'),
          },
          ...l,
        ])
        // The cue stays on the board: a stage manager does not clear the lever
        // the moment it moves, and the consequences are still worth reading.
      },
      onError: (err) => {
        setLog((l) => [
          { at: writtenAt(), scenario: target.id, ok: false, summary: err.message },
          ...l,
        ])
      },
    })
  }

  return (
    <div className={`${s.page} ${s.rows}`}>
      <TitleBlock
        sheet="director"
        subtitle="Scripted scenarios write real rows. The cluster detector, the action-level evaluator and the SSE stream then do their normal work — nothing here fabricates an alert the product would not have produced on its own."
        cells={[
          { label: 'cues', value: String(CUES.length) },
          { label: 'fired', value: String(log.length), tone: log.length ? 'accent' : undefined },
          { label: 'alerts up', value: fmtNum(active.length, 0) },
          { label: 'stream', value: status, tone: status === 'open' ? 'accent' : 'warn' },
        ]}
      />

      <div className={s.split}>
        {/* ── the cue deck ────────────────────────────────────────── */}
        <Sheet
          code="07-A"
          title="Cue deck"
          bodyClass={s.deckBody}
          aside={<Caps ink>{armed ? 'armed — read the consequences' : 'select a cue to arm it'}</Caps>}
        >
          <div className={s.cues}>
            {CUES.map((c) => (
              <button
                type="button"
                key={c.id}
                className={[
                  s.cue,
                  armed === c.id ? s.cueArmed : '',
                  c.danger ? s.cueDanger : '',
                ].filter(Boolean).join(' ')}
                onClick={() => setArmed(armed === c.id ? null : c.id)}
              >
                <span className={s.cueNo}>{c.no}</span>
                <span className={s.cueMain}>
                  <span className={s.cueTitle}>
                    {c.name}
                    {c.danger ? (
                      <span
                        className={s.chip}
                        style={{ color: 'var(--sev-critical)', borderColor: 'var(--sev-critical)' }}
                      >
                        destructive
                      </span>
                    ) : null}
                    <span className={s.spacer} />
                    <Caps>{armed === c.id ? 'armed' : 'cue ' + c.no}</Caps>
                  </span>
                  <span className={s.cueDesc}>{c.description}</span>
                  <span className={s.cueFires}>
                    {c.consequences.map((k) => (
                      <span className={s.cueFire} key={k.who}>
                        <span className={s.cueDot} style={{ background: ACTOR_VAR[k.who] }} />
                        {k.who}
                      </span>
                    ))}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* the lever — always on the board, so the panel never loses its floor */}
          {cue ? (
            <div className={s.lever}>
              <div className={s.leverHead}>
                <Caps ink>cue {cue.no} {lastFired?.scenario === cue.id ? 'fired' : 'armed'}</Caps>
                <span className={`${s.leverName}${cue.danger ? ` ${s.leverNameDanger}` : ''}`}>
                  {cue.name.toUpperCase()}
                </span>
                {lastFired?.scenario === cue.id ? (
                  <>
                    <span className={s.spacer} />
                    <Caps accent>fired {fmtTime(lastFired.at)} · {lastFired.summary}</Caps>
                  </>
                ) : null}
              </div>
              <div className={s.consequences}>
                {cue.consequences.map((k) => (
                  <div
                    className={s.consequence}
                    key={k.who}
                    style={{ ['--conColor' as string]: ACTOR_VAR[k.who] }}
                  >
                    <span className={s.consequenceWho}>{k.who}</span>
                    <span>{k.what}</span>
                  </div>
                ))}
              </div>
              <div className={s.leverActions}>
                <Button
                  variant={cue.danger ? 'danger' : 'primary'}
                  loading={simulate.isPending}
                  disabled={simulate.isPending}
                  onClick={() => (cue.danger ? setConfirm(true) : fire(cue))}
                >
                  {simulate.isPending ? 'Firing…' : `Fire cue ${cue.no}`}
                </Button>
                <Button variant="ghost" onClick={() => setArmed(null)} disabled={simulate.isPending}>
                  Disarm
                </Button>
                <span className={s.spacer} />
                <Caps>
                  {cue.danger
                    ? 'requires confirmation'
                    : replaying ? 'writes at the end of the data' : 'propagates over SSE in ~1 s'}
                </Caps>
              </div>
            </div>
          ) : (
            <div className={s.lever}>
              <div className={s.leverHead}>
                <Caps ink>no cue armed</Caps>
                <span className={s.leverName} style={{ color: 'var(--ink-3)' }}>—</span>
              </div>
              <p className={s.noteDim}>
                Pick a cue above. Its consequences appear here, one line per interface,
                and the lever only unlocks once they are on screen.
              </p>
              <div className={s.leverActions}>
                <Button variant="primary" disabled>Fire</Button>
                <span className={s.spacer} />
                <Caps>nothing is armed</Caps>
              </div>
            </div>
          )}
        </Sheet>

        {/* ── the show log + what the world looks like now ─────────── */}
        <div className={s.stackFill}>
          <Sheet code="07-B" title="Show log · this session">
            {log.length === 0 ? (
              <div className={s.err}>
                Nothing fired yet. The cues above write into the same database the other
                three interfaces are reading from right now.
              </div>
            ) : (
              <div className={s.showLog}>
                {log.map((f, i) => (
                  <div className={s.showRow} key={`${f.at}-${i}`}>
                    <span className={s.showNo}>{log.length - i}</span>
                    <span className={s.truncate}>
                      <span style={{ color: f.ok ? 'var(--accent)' : 'var(--sev-critical)' }}>
                        {f.scenario}
                      </span>
                      <span className={s.showResult}> · {f.summary}</span>
                    </span>
                    <span className={s.tickTime}>{fmtTime(f.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </Sheet>

          <Sheet code="07-C" title="World state">
            <Readouts>
              <Readout label="alerts up" value={fmtNum(active.length, 0)} tone={active.length ? 'warn' : 'accent'} size="lg" />
              <Readout
                label="concerns"
                value={fmtNum(concerns.data ? happenedBy(concerns.data, now).length : null, 0)}
                size="lg"
              />
              <Readout
                label="stream"
                value={status}
                tone={status === 'open' ? 'accent' : 'warn'}
                size="sm"
                foot="server-sent events"
              />
            </Readouts>
            <KV
              wide
              rows={[
                ['critical', fmtNum(active.filter((a) => a.severity === 'critical').length, 0)],
                ['warning', fmtNum(active.filter((a) => a.severity === 'warning').length, 0)],
                ['watch', fmtNum(active.filter((a) => a.severity === 'watch').length, 0)],
                ['acknowledged', fmtNum(shown.filter((a) => a.status === 'acknowledged').length, 0)],
              ]}
            />
          </Sheet>

          <Sheet
            code="07-D"
            title="Live stream"
            className={s.grow}
            aside={<Caps ink>{stream.length} events</Caps>}
          >
            {stream.length === 0 ? (
              <div className={s.err}>
                {replaying
                  ? `Replaying ${fmtDateTime(replaying)}. Cues write at the end of the data, so what they write appears here — and in the other three interfaces — once the clock is back at the end.`
                  : 'Quiet. Fire a cue and the consequences arrive here — and in the other three interfaces — without a refresh.'}
              </div>
            ) : (
              <div className={s.ticker}>
                {stream.slice(0, 40).map((e) => (
                  <div className={s.tickRow} key={e.id}>
                    <span className={s.tickTime}>{fmtTime(e.at)}</span>
                    <span
                      className={s.tickActor}
                      style={{ color: e.actorRole ? ACTOR_VAR[e.actorRole] : 'var(--ink-3)' }}
                    >
                      {e.actorRole ?? e.type}
                    </span>
                    <span
                      className={s.tickText}
                      title={e.title}
                      style={e.severity ? { color: severityVar(e.severity) } : undefined}
                    >
                      {e.title}
                    </span>
                    <span className={s.tickTime}>{relativeShort(e.at, now)}</span>
                  </div>
                ))}
              </div>
            )}
          </Sheet>

          {/* the thing you must not touch mid-show */}
          <div className={s.danger}>
            <div className={s.leverHead}>
              <Caps ink>rebuild</Caps>
              <span className={`${s.leverName} ${s.leverNameDanger}`}>RESEED</span>
              <span className={s.spacer} />
              <Button size="sm" variant="ghost" onClick={() => setReseedOpen(true)}>
                Open
              </Button>
            </div>
            <p className={s.noteDim}>
              Regenerates the entire campaign from datagen — segments, passes, wind, personas,
              the lot. Minutes, not seconds, and every scripted moment set up for this demo is
              gone. Locked behind a confirmation for a reason.
            </p>
          </div>
        </div>
      </div>

      {/* ── confirmations ───────────────────────────────────────────── */}
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Fire ALL CLEAR?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={simulate.isPending}
              onClick={() => {
                const c = CUES.find((x) => x.id === 'all_clear')
                if (c) fire(c)
                setConfirm(false)
              }}
            >
              Yes — resolve everything
            </Button>
          </>
        }
      >
        <p className={s.note}>
          This resolves <strong>every open alert</strong> and closes every advisory. The
          industry radar goes to CLEAR and the regulator queue empties. There is no undo: the
          only way back is to fire the other cues again, one at a time.
        </p>
        <p className={s.noteDim} style={{ marginTop: 'var(--s-3)' }}>
          {closable.length} open {closable.length === 1 ? 'alert' : 'alerts'} will be closed, at the end
          of the data.
        </p>
      </Modal>

      <Modal
        open={reseedOpen}
        onClose={() => setReseedOpen(false)}
        title="Reseed the campaign?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setReseedOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              loading={reseed.isPending}
              onClick={() => { reseed.mutate(undefined); setReseedOpen(false) }}
            >
              Rebuild from datagen
            </Button>
          </>
        }
      >
        <p className={s.note}>
          Hands off to <span className="num">air-datagen</span> and rebuilds the whole
          database. It takes minutes, it invalidates every cache in every open interface, and
          it destroys the state the demo was staged in. Do not do this during a show.
        </p>
      </Modal>
    </div>
  )
}
