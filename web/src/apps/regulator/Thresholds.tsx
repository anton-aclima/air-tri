/**
 * /regulator/thresholds — ACTION LEVELS.
 *
 * The tripwires, and the consequence of moving one, in the same viewport.
 *
 * Everything on the right reacts to the control on the left, at two different
 * speeds, and the split is deliberate:
 *
 *   instantly, with no round trip — the campaign histogram re-counts how many
 *   of the 1,307 measured streets sit above the line as the slider moves, so
 *   the drag never feels like it is waiting for anything;
 *
 *   a beat later, from the backend — the alert bus re-evaluates and the ledger
 *   fills in with what actually appeared or cleared, region-wide, in every
 *   interface at once. That is the number the operator's scope is reading too.
 *
 * The second panel is the one that matters for the argument: for black carbon,
 * methane and diesel the reference network carries no channel at all, so the
 * agency can draw the line but has nothing of its own standing on it. The
 * histogram underneath is entirely fleet-measured. Nothing here says
 * "leapfrog"; the tower count says zero and the street count says 1,307.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { Distribution } from '@/components'
import { Button, Input, Slider, Toggle } from '@/app/ui'
import type { CampaignTime } from '@/core/clock'
import { fmtNum } from '@/core/format'
import { severityVar } from '@/core/measures'
import { useActionLevels, useAlerts, useSegments, useUpdateActionLevel } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import type { ActionLevel, ActionLevelKind, Alert, MeasureCode, SegmentCollection } from '@/core/types'

import { PushComposer, subjectFromLevel } from './Push'
import {
  Caps, KIND_CODE, KIND_LABEL, Panel, Readout, Sev, Tag, Unit, fmtRatio, levelSetWhen, levelUnit,
  liveAlerts, overBy, shortWhere, sliderRange, sortLevels, sourceTag, SOURCE_TAG_LABEL,
  styles as s, towerMeasures, towersFor, useMeasureMap, useTowers,
} from './lib'

/** `PUT /action-levels/{id}` answers with what the edit did. Not on the wire type. */
interface Evaluation {
  alerts_created: string[]
  alerts_resolved: string[]
  advisories_created: string[]
}
type UpdateResult = ActionLevel & { evaluation?: Evaluation }

/**
 * As-issued values, captured the first time this session sees them, so a row
 * can say what it was moved from and be put back. Module scope: the baseline
 * has to survive navigating away from the screen and back.
 */
const SEEDED = new Map<string, number>()

const DEBOUNCE_MS = 260

/**
 * How long the ledger flashes what an edit raised or cleared. Real seconds, on
 * a timer, not campaign time: this is an animation, and the demo's clock is
 * paused at the end of the data. (It read `Date.now()` during render, so the
 * flash only ended on whatever render happened to come next.)
 */
const FLASH_MS = 6000

export function Thresholds() {
  const now = useNowCampaign()
  const levelsQ = useActionLevels()
  const update = useUpdateActionLevel()
  const alertsQ = useAlerts({})
  const towers = useTowers().data ?? []
  const measures = useMeasureMap()

  const server = levelsQ.data ?? []
  useEffect(() => {
    for (const l of server) if (!SEEDED.has(l.id)) SEEDED.set(l.id, l.threshold)
  }, [server])

  /** Optimistic overlay: the slider must move at 60 fps, not at HTTP speed. */
  const [draft, setDraft] = useState<Record<string, Partial<ActionLevel>>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    for (const t of Object.values(timers.current)) clearTimeout(t)
    clearTimeout(flashTimer.current)
  }, [])

  const levels = useMemo(
    () => server.map((l) => ({ ...l, ...(draft[l.id] ?? {}) })),
    [server, draft],
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = levels.find((l) => l.id === selectedId) ?? levels[0]

  const [lastEval, setLastEval] = useState<{ levelId: string; evaluation: Evaluation; fresh: boolean } | null>(null)

  const commit = (l: ActionLevel, patch: Partial<ActionLevel>) => {
    const next = { ...l, ...patch }
    setDraft((d) => ({ ...d, [l.id]: { ...(d[l.id] ?? {}), ...patch } }))
    setSelectedId(l.id)
    clearTimeout(timers.current[l.id])
    timers.current[l.id] = setTimeout(() => {
      update.mutate(
        {
          id: l.id,
          body: {
            measure: next.measure,
            label: next.label,
            kind: next.kind,
            threshold: next.threshold,
            unit: next.unit,
            averaging_hours: next.averaging_hours,
            severity: next.severity,
            enabled: next.enabled,
            source: next.source,
            notify_community: next.notify_community,
            notify_industry: next.notify_industry,
          },
        },
        {
          onSuccess: (res) => {
            const ev = (res as UpdateResult).evaluation
            if (ev) {
              setLastEval({ levelId: l.id, evaluation: ev, fresh: true })
              clearTimeout(flashTimer.current)
              flashTimer.current = setTimeout(
                () => setLastEval((e) => (e ? { ...e, fresh: false } : e)),
                FLASH_MS,
              )
            }
            // The server row is authoritative once it lands.
            setDraft((d) => { const { [l.id]: _drop, ...rest } = d; return rest })
          },
        },
      )
    }, DEBOUNCE_MS)
  }

  const revert = (l: ActionLevel) => {
    const seed = SEEDED.get(l.id)
    if (seed == null || seed === l.threshold) return
    commit(l, { threshold: seed })
  }

  const moved = levels.filter((l) => {
    const seed = SEEDED.get(l.id)
    return seed != null && Math.abs(seed - l.threshold) > 1e-9
  })

  // Live at the demo's now, not by status. An edit's new alerts are stamped at
  // the end of the data with no `ended_at`, so at the end they count the moment
  // they land; replayed to an earlier hour, they have not happened yet.
  const live = useMemo(() => liveAlerts(alertsQ.data, now), [alertsQ.data, now])
  const canSee = useMemo(() => towerMeasures(towers), [towers])

  const spikes = sortLevels(levels.filter((l) => l.kind === 'spike'))
  const integrated = sortLevels(levels.filter((l) => l.kind === 'integrated'))
  const unreachable = levels.filter((l) => !canSee.has(l.measure))

  return (
    <div className={`${s.page} ${s.thrPage}`}>
      <div className={`${s.verdict} ${moved.length ? s.verdictOver : s.verdictClear}`}>
        <div className={s.verdictMark}>
          <span className={`${s.verdictGlyph} ${s.accentInk}`}>⌁</span>
          <span className={`${s.verdictWord} ${s.accentInk}`}>ACTION LEVELS</span>
        </div>
        <div className={s.verdictLines}>
          <span className={s.verdictHead}>
            {levels.filter((l) => l.enabled).length} armed · {unreachable.length} that no reference
            instrument can trip
          </span>
          <span className={s.sub}>
            Every edit re-evaluates the whole region immediately — the operator&apos;s scope and the
            residents&apos; feed see the same result you do, with no refresh.
          </span>
        </div>
        <div className={s.verdictStats}>
          <Readout label="Live alerts" value={fmtNum(live.length, 0)} tone={live.length ? 'over' : 'tower'} big />
          <Readout label="Moved this session" value={fmtNum(moved.length, 0)} tone={moved.length ? 'fleet' : undefined} />
          {moved.length ? (
            <div className={s.readout}>
              <Button
                size="sm"
                onClick={() => { for (const l of moved) revert(l) }}
                title="Put every action level back to its as-issued value"
              >
                Restore as-issued
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <div className={s.thrBody}>
        {/* ── the controls ─────────────────────────────────────────────── */}
        <Panel
          title="Tripwires"
          aside={<Caps>drag · the region re-evaluates as you go</Caps>}
        >
          <div className={s.levels}>
            <SectionHead
              title="Magnitude — a spike this high, once"
              hint="One averaging period over the number. This is a peak, not a dose."
            />
            {spikes.map((l) => (
              <LevelRow
                key={l.id}
                level={l}
                seeded={SEEDED.get(l.id) ?? l.threshold}
                active={selected?.id === l.id}
                blind={!canSee.has(l.measure)}
                towerCount={towersFor(towers, l.measure).length}
                towerTotal={towers.length}
                hits={live.filter((a) => a.action_level_id === l.id)}
                decimals={measures.get(l.measure)?.decimals ?? 1}
                onSelect={() => setSelectedId(l.id)}
                onChange={(patch) => commit(l, patch)}
                onRevert={() => revert(l)}
              />
            ))}
            <SectionHead
              title="Integrated exposure — this much, for this long"
              hint="An extended emission that never spikes can still reach a dose the standard cares about. The averaging window is part of the rule."
            />
            {integrated.map((l) => (
              <LevelRow
                key={l.id}
                level={l}
                seeded={SEEDED.get(l.id) ?? l.threshold}
                active={selected?.id === l.id}
                blind={!canSee.has(l.measure)}
                towerCount={towersFor(towers, l.measure).length}
                towerTotal={towers.length}
                hits={live.filter((a) => a.action_level_id === l.id)}
                decimals={measures.get(l.measure)?.decimals ?? 1}
                onSelect={() => setSelectedId(l.id)}
                onChange={(patch) => commit(l, patch)}
                onRevert={() => revert(l)}
                showAveraging
              />
            ))}
          </div>
        </Panel>

        {/* ── the consequence, in the same viewport ────────────────────── */}
        <div className={s.thrSide}>
          {selected ? (
            <Consequence
              level={selected}
              live={live}
              lastEval={lastEval?.levelId === selected.id ? lastEval : null}
              towerCount={towersFor(towers, selected.measure).length}
              towerTotal={towers.length}
              pending={update.isPending}
              now={now}
            />
          ) : (
            <Panel title="Consequence"><div className={s.empty}>No action level selected.</div></Panel>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={s.padSm} style={{ background: 'var(--bg-sunk)', borderBottom: '1px solid var(--line-strong)' }}>
      <Caps tone="accent">{title}</Caps>
      <div className={s.subTight} style={{ marginTop: 2 }}>{hint}</div>
    </div>
  )
}

// ───────────────────────────────────────────────────────────── one tripwire

function LevelRow({
  level, seeded, active, blind, towerCount, towerTotal, hits, decimals,
  onSelect, onChange, onRevert, showAveraging,
}: {
  level: ActionLevel
  seeded: number
  active: boolean
  blind: boolean
  towerCount: number
  towerTotal: number
  hits: Alert[]
  decimals: number
  onSelect(): void
  onChange(patch: Partial<ActionLevel>): void
  onRevert(): void
  showAveraging?: boolean
}) {
  const [min, max, step] = sliderRange(level, seeded)
  const edited = Math.abs(seeded - level.threshold) > 1e-9
  const worst = [...hits].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]

  return (
    <div
      className={[s.level, active ? s.levelActive : '', level.enabled ? '' : s.levelDisabled].filter(Boolean).join(' ')}
      onMouseDown={onSelect}
      onFocusCapture={onSelect}
      role="group"
      aria-label={level.label}
    >
      <div className={s.levelHead}>
        <Tag tone="accent">{level.measure.toUpperCase()}</Tag>
        <span className={s.levelLabel}>{level.label}</span>
      </div>
      <div className={s.levelRight}>
        <Sev severity={level.severity} />
        <Toggle
          checked={level.enabled}
          onChange={(v) => onChange({ enabled: v })}
          label={<span className={s.caps}>armed</span>}
        />
      </div>

      <div className={s.levelCtl}>
        <Slider
          value={level.threshold}
          min={min}
          max={max}
          step={step}
          onValueChange={(v) => onChange({ threshold: v })}
          display={null}
          aria-label={`${level.label} threshold`}
        />
        <div className={s.levelVal}>
          <Input
            numeric
            className={s.numInput}
            value={String(level.threshold)}
            onChange={(e) => {
              const v = Number(e.currentTarget.value)
              if (Number.isFinite(v)) onChange({ threshold: v })
            }}
            aria-label={`${level.label} threshold value`}
          />
          <Unit>{levelUnit(level)}</Unit>
        </div>
      </div>

      <div className={s.levelFoot}>
        <Tag>{KIND_CODE[level.kind]}</Tag>
        {showAveraging ? (
          <>
            <Caps>over</Caps>
            <span style={{ width: 110 }}>
              <Slider
                value={level.averaging_hours}
                min={1}
                max={24}
                step={1}
                onValueChange={(v) => onChange({ averaging_hours: v })}
                display={`${fmtNum(level.averaging_hours, 0)} h`}
                aria-label={`${level.label} averaging hours`}
              />
            </span>
          </>
        ) : (
          <Caps>{fmtNum(level.averaging_hours, 0)} h window</Caps>
        )}

        {blind ? (
          <Tag tone="fleet" title="No DRAQA reference instrument carries this channel.">
            0 / {towerTotal} towers · fleet only
          </Tag>
        ) : (
          <Tag tone="tower">{towerCount} / {towerTotal} towers</Tag>
        )}

        {hits.length ? (
          <>
            <Tag tone="invader">{hits.length} live</Tag>
            <span className={s.subTight}>
              worst <b>{fmtNum(worst?.value ?? null, decimals)}</b> {levelUnit(level)}
              {' · '}{fmtRatio(overBy(worst ?? ({} as Alert)))}
            </span>
          </>
        ) : (
          <Caps>nothing on this line</Caps>
        )}

        <span className={s.spacer} />
        {edited ? (
          <>
            <span className={`${s.caps} ${s.fleetInk}`}>
              was {fmtNum(seeded, decimals)}
            </span>
            <Button size="sm" variant="ghost" onClick={onRevert}>revert</Button>
          </>
        ) : (
          <Caps>{level.source ?? 'local'}</Caps>
        )}
      </div>

      <div className={s.levelMeta}>
        <Toggle
          checked={level.notify_community}
          onChange={(v) => onChange({ notify_community: v })}
          label={<span className={s.caps}>auto-advise residents</span>}
        />
        <Toggle
          checked={level.notify_industry}
          onChange={(v) => onChange({ notify_industry: v })}
          label={<span className={s.caps}>auto-notify operator</span>}
        />
      </div>
    </div>
  )
}

// ───────────────────────────────────────────────────────── the consequence

function Consequence({
  level, live, lastEval, towerCount, towerTotal, pending, now,
}: {
  level: ActionLevel
  live: Alert[]
  lastEval: { evaluation: Evaluation; fresh: boolean } | null
  towerCount: number
  towerTotal: number
  pending: boolean
  now: CampaignTime
}) {
  const towers = useTowers().data ?? []
  const towerIds = useMemo(() => new Set(towers.map((m) => m.id)), [towers])
  const measures = useMeasureMap()
  const def = measures.get(level.measure)

  /**
   * Spikes are judged against the peak a street ever reaches; an integrated
   * exposure is judged against what someone standing there breathes across the
   * window. Same 1,307 streets, the honest statistic for each kind of rule.
   */
  const metric: 'max' | 'median' = level.kind === 'spike' ? 'max' : 'median'
  const segsQ = useSegments({ measure: level.measure as MeasureCode, metric, window: 'all' })
  const values = useMemo(() => segmentValues(segsQ.data), [segsQ.data])
  const overCount = useMemo(
    () => values.reduce((n, v) => (v >= level.threshold ? n + 1 : n), 0),
    [values, level.threshold],
  )

  const hits = live.filter((a) => a.action_level_id === level.id)
  const bySource = useMemo(() => {
    const m: Record<string, number> = {}
    for (const a of hits) {
      const t = sourceTag(a, towerIds)
      m[t] = (m[t] ?? 0) + 1
    }
    return m
  }, [hits, towerIds])

  const created = lastEval?.evaluation.alerts_created.length ?? 0
  const resolved = lastEval?.evaluation.alerts_resolved.length ?? 0
  const fresh = lastEval?.fresh ?? false

  return (
    <>
      <Panel
        title={`Consequence · ${level.label}`}
        aside={pending ? <Caps tone="accent">re-evaluating…</Caps> : <Caps>{KIND_LABEL[level.kind]}</Caps>}
      >
        <div className={s.impact}>
          <div className={s.impactHero}>
            <div>
              <div className={`${s.impactBig}${live.length ? ` ${s.impactBigHot}` : ''}`}>
                {fmtNum(live.length, 0)}
              </div>
              <Caps>alerts live, region-wide</Caps>
            </div>
            <div>
              <div className={s.delta}>
                <span className={created ? s.deltaUp : s.deltaFlat}>+{created}</span>
                {'  '}
                <span className={resolved ? s.deltaDown : s.deltaFlat}>−{resolved}</span>
              </div>
              <Caps>{lastEval ? 'from your last edit' : 'move a slider'}</Caps>
            </div>
            <div className={s.subTight}>
              {lastEval
                ? `${created} raised, ${resolved} cleared the moment you let go. The operator's scope
                   and the residents' feed already have them.`
                : `${hits.length} alert${hits.length === 1 ? '' : 's'} currently stand on this line.
                   Drag its threshold and watch the count move.`}
            </div>
          </div>

          {/* who can even trip this rule */}
          {towerCount === 0 ? (
            <div className={s.blindBanner}>
              <span className={s.fleetInk}>▨</span>
              <div>
                <div className={`${s.caps} ${s.fleetInk}`}>
                  0 of {towerTotal} reference instruments carry a {level.measure.toUpperCase()} channel
                </div>
                <div className={s.subTight}>
                  This line cannot be crossed by anything DRAQA owns, at any threshold. Every reading
                  below is measured by the mobile fleet, calibrated against these same reference
                  instruments on the channels they do carry.
                </div>
              </div>
            </div>
          ) : (
            <div className={s.reachRow} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <span className={s.subTight}>
                <span className={s.towerInk}>▲</span> {towerCount} of {towerTotal} reference
                instruments carry {level.measure.toUpperCase()} — {towerCount} fixed points.{' '}
                <span className={s.fleetInk}>▨</span> the fleet measures it on{' '}
                {fmtNum(values.length, 0)} streets.
              </span>
              <span className={`${s.reachNum} ${s.fleetInk}`}>{fmtNum(values.length / Math.max(towerCount, 1), 0)}×</span>
            </div>
          )}
        </div>
      </Panel>

      {/* instant feedback: no round trip, the count moves with the thumb */}
      <Panel
        title={`Where the line falls · ${fmtNum(values.length, 0)} streets`}
        aside={
          <Tag tone={overCount ? 'invader' : 'tower'}>
            {fmtNum(overCount, 0)} over ({fmtNum(values.length ? (overCount / values.length) * 100 : 0, 1)}%)
          </Tag>
        }
      >
        <div className={s.chartPad}>
          {values.length ? (
            <Distribution
              values={values}
              marker={level.threshold}
              markerLabel="action level"
              unit={levelUnit(level)}
              decimals={def?.decimals ?? 1}
              height={148}
              bins={34}
              colorByValue={false}
              ramp="intensity"
              subtitle={
                level.kind === 'spike'
                  ? 'Peak concentration on every ~200 m of street we drove, 90 days.'
                  : 'Typical concentration on every ~200 m of street we drove, 90 days.'
              }
            />
          ) : (
            <div className={s.empty}>No street coverage for this pollutant.</div>
          )}
        </div>
      </Panel>

      {/* what is standing on the line, and who saw it */}
      <Panel
        className={s.grow}
        title="Standing on this line"
        aside={
          <span className={s.toolbar}>
            {Object.entries(bySource).map(([k, n]) => (
              <Tag key={k} tone={k === 'fleet' ? 'fleet' : k === 'tower' ? 'tower' : k === 'community' ? 'community' : 'invader'}>
                {n} {SOURCE_TAG_LABEL[k]}
              </Tag>
            ))}
          </span>
        }
      >
        {hits.length ? (
          <div className={s.ledger}>
            {[...hits]
              .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
              .map((a) => {
                const isNew = lastEval?.evaluation.alerts_created.includes(a.id) && fresh
                return (
                  <div key={a.id} className={`${s.ledgerRow}${isNew ? ` ${s.flashIn}` : ''}`}>
                    <span className={s.ledgerGlyph} style={{ color: severityVar(a.severity) }}>
                      {a.severity === 'critical' ? '✖' : a.severity === 'warning' ? '▲' : '◆'}
                    </span>
                    <span className={s.rowNum} style={{ textAlign: 'left' }}>
                      {SOURCE_TAG_LABEL[sourceTag(a, towerIds)]}
                    </span>
                    <span className={s.rowTrunc}>{shortWhere(a)}</span>
                    <span className={s.rowNum}>
                      {fmtNum(a.value, def?.decimals ?? 1)} <Unit>{levelUnit(level)}</Unit>
                      <span className={s.dim}>{'  '}{fmtRatio(overBy(a))}</span>
                    </span>
                  </div>
                )
              })}
          </div>
        ) : (
          <div className={s.empty}>
            Nothing is over this line. Lower the threshold and the region will answer.
          </div>
        )}
        {resolved && fresh ? (
          <div className={`${s.ledgerRow} ${s.flashOut}`} style={{ gridTemplateColumns: '16px minmax(0,1fr)' }}>
            <span className={`${s.ledgerGlyph} ${s.towerInk}`}>✓</span>
            <span className={s.subTight}>{resolved} alert{resolved === 1 ? '' : 's'} cleared by that edit.</span>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="Act on it"
        aside={<Caps>{levelSetWhen(level, now)}</Caps>}
      >
        <PushComposer subject={subjectFromLevel(level, [...hits].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0])} compact />
      </Panel>
    </>
  )
}

function segmentValues(data: SegmentCollection | undefined): number[] {
  const out: number[] = []
  for (const f of data?.features ?? []) {
    const v = f.properties.value
    if (v != null && Number.isFinite(v)) out.push(v)
  }
  return out
}

export type { ActionLevelKind }
