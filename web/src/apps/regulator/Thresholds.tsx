/**
 * /regulator/thresholds — action levels, and what moving one does
 * (docs/PLAN-refocus.md R7).
 *
 * The list on the left, the consequence pinned on the right, in one viewport
 * at 1080. The consequence moves at two speeds, and the split is deliberate:
 *
 *   instantly, with no round trip — the campaign histogram re-counts how many
 *   of the measured streets reach the level as the slider moves, so the drag
 *   never waits on anything;
 *
 *   a beat later, from the backend — the alert bus re-evaluates and the
 *   ledger fills in with what was raised or resolved, region-wide, on every
 *   screen at once, including the operators' and the residents'.
 *
 * At 1080x900 the old layout showed 330 of the list's 1,693px, 55 of the
 * histogram's 238px and none of "Act on it": each level was a four-line card
 * (label, slider, a chip row, a toggle row), and below 1180px the two columns
 * stacked. Now a level is one row of at most 64px — label, slider, number,
 * state — and the rest sits behind the row's disclosure: the on/off switch,
 * the auto-advise and auto-notify toggles, the as-issued value and revert.
 * The averaging slider shows only on the selected row. The "0 / 4 towers ·
 * fleet only" chip that sat on every row is one legend line: the channels no
 * reference monitor carries are a property of the network, stated once.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { Distribution, SEVERITY_GLYPH } from '@/components'
import { Button, Input, Slider, Toggle } from '@/app/ui'
import { useLiveAlerts } from '@/core/alerts'
import type { CampaignTime } from '@/core/clock'
import { fmtDay, fmtNum, fmtTime24 } from '@/core/format'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import { useActionLevels, useSegments, useUpdateActionLevel } from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type { ActionLevel, Alert, MeasureCode, MeasureDef, SegmentCollection, Severity } from '@/core/types'

import {
  SOURCE_LABEL, knownValue, levelBasis, sourceOf, subjectFor, unitText, whereOf,
} from './alerting'
import { PushComposer } from './Push'
import {
  levelUnit, sliderRange, sortLevels, towerMeasures, towersFor, useMeasureMap, useTowers,
} from './lib'
import { Panel } from './Panel'
import l from './levels.module.css'
import t from './title.module.css'

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
 * How long the ledger flashes what an edit raised or resolved. Real seconds, on
 * a timer, not campaign time: this is an animation, and the demo's clock is
 * paused at the end of the data. (It read `Date.now()` during render, so the
 * flash only ended on whatever render happened to come next.)
 */
const FLASH_MS = 6000

const EMPTY_LEVELS: ActionLevel[] = []

export function Thresholds() {
  const now = useNowCampaign()
  const replaying = useSession((x) => x.time.cursor != null)
  const levelsQ = useActionLevels()
  const update = useUpdateActionLevel()
  const live = useLiveAlerts('regulator')
  const towers = useTowers().data
  const measures = useMeasureMap()

  const server = levelsQ.data ?? EMPTY_LEVELS
  useEffect(() => {
    for (const x of server) if (!SEEDED.has(x.id)) SEEDED.set(x.id, x.threshold)
  }, [server])

  /** Optimistic overlay: the slider must move at 60 fps, not at HTTP speed. */
  const [draft, setDraft] = useState<Record<string, Partial<ActionLevel>>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    for (const x of Object.values(timers.current)) clearTimeout(x)
    clearTimeout(flashTimer.current)
  }, [])

  const levels = useMemo(
    () => server.map((x) => ({ ...x, ...(draft[x.id] ?? {}) })),
    [server, draft],
  )

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const selected = levels.find((x) => x.id === selectedId) ?? levels[0]

  const [lastEval, setLastEval] = useState<{ levelId: string; evaluation: Evaluation; fresh: boolean } | null>(null)

  const commit = (lv: ActionLevel, patch: Partial<ActionLevel>) => {
    const next = { ...lv, ...patch }
    setDraft((d) => ({ ...d, [lv.id]: { ...(d[lv.id] ?? {}), ...patch } }))
    setSelectedId(lv.id)
    clearTimeout(timers.current[lv.id])
    timers.current[lv.id] = setTimeout(() => {
      const body = {
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
      }
      update.mutate(
        { id: lv.id, body },
        {
          onSuccess: (res) => {
            const ev = (res as UpdateResult).evaluation
            if (ev) {
              setLastEval({ levelId: lv.id, evaluation: ev, fresh: true })
              clearTimeout(flashTimer.current)
              flashTimer.current = setTimeout(
                () => setLastEval((e) => (e ? { ...e, fresh: false } : e)),
                FLASH_MS,
              )
            }
            // The server row is authoritative once it lands (the mutation has
            // already written it into the cache) — unless the level was moved
            // again while this one was in flight: that draft is newer than
            // the row, and dropping it would snap the thumb back.
            setDraft((d) => {
              const cur = d[lv.id]
              if (!cur) return d
              const sent: Partial<ActionLevel> = body
              const same = (Object.keys(cur) as (keyof ActionLevel)[]).every((k) => cur[k] === sent[k])
              if (!same) return d
              const { [lv.id]: _drop, ...rest } = d
              return rest
            })
          },
        },
      )
    }, DEBOUNCE_MS)
  }

  const revert = (lv: ActionLevel) => {
    const seed = SEEDED.get(lv.id)
    if (seed == null || seed === lv.threshold) return
    commit(lv, { threshold: seed })
  }

  const moved = levels.filter((x) => {
    const seed = SEEDED.get(x.id)
    return seed != null && Math.abs(seed - x.threshold) > 1e-9
  })

  const canSee = useMemo(() => towerMeasures(towers), [towers])
  const spikes = sortLevels(levels.filter((x) => x.kind === 'spike'))
  const integrated = sortLevels(levels.filter((x) => x.kind === 'integrated'))

  // The legend line: the channels no reference monitor carries, from the
  // instrument list, not asserted. Empty until the monitors load, so the line
  // never claims "none carries" off an empty list.
  const fleetOnly = useMemo(() => {
    if (!towers) return []
    const codes = [...new Set(levels.map((x) => x.measure))].filter((m) => !canSee.has(m))
    return codes.map((m) => inSentence(measures.get(m)?.short_label ?? m.toUpperCase()))
  }, [towers, levels, canSee, measures])

  // Per-level hits are the unfolded ongoing alerts: the fold keeps one level
  // per source, and a level's own row must count every alert on it.
  const hitsFor = (id: string) => live.all.filter((a) => a.action_level_id === id)

  const row = (lv: ActionLevel) => (
    <LevelRow
      key={lv.id}
      level={lv}
      seeded={SEEDED.get(lv.id) ?? lv.threshold}
      active={selected?.id === lv.id}
      open={openId === lv.id}
      fleetOnly={!!towers && !canSee.has(lv.measure)}
      hits={hitsFor(lv.id)}
      def={measures.get(lv.measure)}
      now={now}
      replaying={replaying}
      onSelect={() => setSelectedId(lv.id)}
      onToggleOpen={() => { setSelectedId(lv.id); setOpenId((o) => (o === lv.id ? null : lv.id)) }}
      onChange={(patch) => commit(lv, patch)}
      onRevert={() => revert(lv)}
    />
  )

  return (
    <div className={l.page}>
      <header className={t.head}>
        <h1 className={t.title}>Action levels</h1>
        <span className={t.summary}>
          {levels.filter((x) => x.enabled).length} of {levels.length} on · {live.count} alerts ongoing
          region-wide · drag a level and the region re-evaluates
        </span>
        {moved.length ? (
          <span className={t.aside}>
            <span className={l.moved}>{moved.length} moved this session</span>
            <Button
              size="sm"
              onClick={() => { for (const x of moved) revert(x) }}
              title="Put every action level back to its as-issued value"
            >
              Restore as issued
            </Button>
          </span>
        ) : null}
      </header>

      <div className={l.body}>
        <Panel title="Levels" className={l.listPanel}>
          {fleetOnly.length ? (
            <p className={l.legend}>
              <span className={l.fleetMark} aria-hidden>▨</span>
              No reference monitor carries {listWords(fleetOnly)}: those levels are measured only by
              the mobile fleet.
            </p>
          ) : null}
          <SectionHead
            title="Magnitude"
            hint="one averaging period this high, once: a peak, not a dose"
          />
          {spikes.map(row)}
          <SectionHead
            title="Integrated exposure"
            hint="this much, for this long: the averaging window is part of the level"
          />
          {integrated.map(row)}
        </Panel>

        <div className={l.side}>
          {selected ? (
            <Consequence
              level={selected}
              count={live.count}
              hits={hitsFor(selected.id)}
              lastEval={lastEval?.levelId === selected.id ? lastEval : null}
              monitors={towersFor(towers, selected.measure).length}
              monitorTotal={towers?.length ?? 0}
              monitorIds={towers ? new Set(towers.map((m) => m.id)) : null}
              pending={update.isPending}
              now={now}
              replaying={replaying}
              def={measures.get(selected.measure)}
            />
          ) : (
            <Panel title="Consequence"><p className={l.empty}>No action level selected.</p></Panel>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * A measure's short label inside a sentence: "diesel", but "BC" and "PM2.5".
 * Only a plain capitalised word is lowered; acronyms keep their case.
 */
function inSentence(label: string): string {
  return /^[A-Z][a-z-]+$/.test(label) ? label.toLowerCase() : label
}

function listWords(xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`
}

function SectionHead({ title, hint }: { title: string; hint: string }) {
  return (
    <div className={l.section}>
      <span className={l.sectionTitle}>{title}</span>
      <span className={l.sectionHint}>{hint}</span>
    </div>
  )
}

/**
 * Critical, Warning or Watch. A level still carrying the old `info` grade
 * prints no word at all: Info is not a severity (CONTRACT §10a rule 7).
 */
function SevWord({ severity }: { severity: Severity }) {
  if (severity === 'info') return null
  return (
    <span style={{ color: severityVar(severity) }}>
      <span aria-hidden>{SEVERITY_GLYPH[severity]}</span> {SEVERITY_LABEL[severity]}
    </span>
  )
}

// ──────────────────────────────────────────────────────────── one level

/**
 * The typed threshold. It committed on every keystroke, so clearing the box
 * to type a new number sent `Number('') === 0` — a zero level, which every
 * reading exceeds, raising alerts region-wide before the first digit landed.
 * The text is held here and committed on blur or Enter, and only a finite
 * value above zero, clamped to the slider's range; anything else, or Esc,
 * puts the box back to the level as it stands.
 */
function ThresholdBox({
  value, min, max, className, label, onCommit,
}: {
  value: number
  min: number
  max: number
  className: string
  label: string
  onCommit(v: number): void
}) {
  /** null while not being edited: the box shows the level itself. */
  const [text, setText] = useState<string | null>(null)
  const commitText = () => {
    if (text == null) return
    setText(null)
    const raw = text.trim()
    const v = Number(raw)
    if (!raw || !Number.isFinite(v) || v <= 0) return
    const clamped = Math.min(max, Math.max(min, v))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <Input
      numeric
      className={className}
      value={text ?? String(value)}
      onChange={(e) => setText(e.currentTarget.value)}
      onBlur={commitText}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commitText()
        } else if (e.key === 'Escape') {
          // Handled here: a surface's Esc (app/ui useDismiss) then skips it.
          e.preventDefault()
          setText(null)
        }
      }}
      aria-label={label}
    />
  )
}

/** The worst hit's ratio, from the reading known at the moment shown. */
function worstOf(hits: Alert[], now: CampaignTime, replaying: boolean): { alert: Alert; value: number | null } | null {
  let best: { alert: Alert; value: number | null } | null = null
  for (const a of hits) {
    const v = knownValue(a, now, replaying)
    if (!best || (v ?? -Infinity) > (best.value ?? -Infinity)) best = { alert: a, value: v }
  }
  return best
}

function LevelRow({
  level, seeded, active, open, fleetOnly, hits, def, now, replaying,
  onSelect, onToggleOpen, onChange, onRevert,
}: {
  level: ActionLevel
  seeded: number
  active: boolean
  open: boolean
  fleetOnly: boolean
  hits: Alert[]
  def: MeasureDef | undefined
  now: CampaignTime
  replaying: boolean
  onSelect(): void
  onToggleOpen(): void
  onChange(patch: Partial<ActionLevel>): void
  onRevert(): void
}) {
  const [min, max, step] = sliderRange(level, seeded)
  const edited = Math.abs(seeded - level.threshold) > 1e-9
  const decimals = def?.decimals ?? 1
  const worst = worstOf(hits, now, replaying)
  const ratio = worst?.value != null && level.threshold > 0 ? worst.value / level.threshold : null
  const unit = levelUnit(level)
  const panelId = `level-more-${level.id}`

  return (
    <div
      className={[l.level, active ? l.levelActive : '', level.enabled ? '' : l.levelOff].filter(Boolean).join(' ')}
      onMouseDown={onSelect}
      onFocusCapture={onSelect}
      role="group"
      aria-label={level.label}
    >
      <div className={l.row}>
        <div className={l.label}>
          <span className={l.labelHead}>
            <span className={l.code}>{def?.short_label ?? level.measure.toUpperCase()}</span>
            {fleetOnly ? (
              <span className={l.fleetMark} title="No reference monitor carries this channel">▨</span>
            ) : null}
            <span className={l.name} title={level.label}>{level.label}</span>
          </span>
          <span className={l.labelSub}>
            {level.severity !== 'info' ? (
              <>
                <SevWord severity={level.severity} />
                <span aria-hidden>·</span>
              </>
            ) : null}
            {active && level.kind === 'integrated' ? (
              <span className={l.avg}>
                <span>over</span>
                <Slider
                  className={l.avgSlider}
                  value={level.averaging_hours}
                  min={1}
                  max={24}
                  step={1}
                  onValueChange={(v) => onChange({ averaging_hours: v })}
                  display={`${fmtNum(level.averaging_hours, 0)} h`}
                  aria-label={`${level.label} averaging hours`}
                />
              </span>
            ) : (
              <span>{fmtNum(level.averaging_hours, 0)} h average</span>
            )}
          </span>
        </div>

        <Slider
          className={l.slider}
          value={level.threshold}
          min={min}
          max={max}
          step={step}
          onValueChange={(v) => onChange({ threshold: v })}
          display={null}
          aria-label={`${level.label} threshold`}
        />

        <span className={l.value}>
          <ThresholdBox
            className={`${l.num}${edited ? ` ${l.numEdited}` : ''}`}
            value={level.threshold}
            min={min}
            max={max}
            onCommit={(v) => onChange({ threshold: v })}
            label={`${level.label} threshold value`}
          />
          <span className={l.unit}>{unit}</span>
        </span>

        <span className={l.state}>
          {!level.enabled ? (
            <span className={l.stateDim}>off</span>
          ) : hits.length ? (
            <>
              <span style={{ color: severityVar(level.severity) }}>{hits.length} ongoing</span>
              <span className={l.stateDim}>{ratio != null ? `worst ${fmtNum(ratio, 2)}×` : 'reading not final'}</span>
            </>
          ) : (
            <span className={l.stateDim}>none ongoing</span>
          )}
        </span>

        <button
          type="button"
          className={l.more}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Hide' : 'Show'} settings for ${level.label}`}
          title="Settings"
          onClick={onToggleOpen}
        >
          <span aria-hidden>{open ? '▾' : '▸'}</span>
          {edited && !open ? <span className={l.editedDot} aria-hidden /> : null}
        </button>
      </div>

      {open ? (
        <div className={l.settings} id={panelId}>
          <Toggle
            checked={level.enabled}
            onChange={(v) => onChange({ enabled: v })}
            label="Level on"
          />
          <Toggle
            checked={level.notify_community}
            onChange={(v) => onChange({ notify_community: v })}
            label="Auto-advise residents"
          />
          <Toggle
            checked={level.notify_industry}
            onChange={(v) => onChange({ notify_industry: v })}
            label="Auto-notify operators"
          />
          <span className={l.settingsNote}>Basis: {levelBasis(level.source)}</span>
          {edited ? (
            <span className={l.revert}>
              <span className={l.settingsNote}>was {fmtNum(seeded, decimals)} {unit}</span>
              <Button size="sm" variant="ghost" onClick={onRevert}>Revert</Button>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ───────────────────────────────────────────────────────── the consequence

function Consequence({
  level, count, hits, lastEval, monitors, monitorTotal, monitorIds, pending, now, replaying, def,
}: {
  level: ActionLevel
  /** `useLiveAlerts('regulator').count` — the one count. */
  count: number
  hits: Alert[]
  lastEval: { evaluation: Evaluation; fresh: boolean } | null
  monitors: number
  monitorTotal: number
  monitorIds: Set<string> | null
  pending: boolean
  now: CampaignTime
  replaying: boolean
  def: MeasureDef | undefined
}) {
  const unit = levelUnit(level)
  const label = inSentence(def?.short_label ?? level.measure.toUpperCase())
  const dataEnd = useSession((x) => x.time.bounds?.end ?? null)

  /**
   * Spikes are judged against the peak a street ever reaches; an integrated
   * exposure against what someone standing there breathes across the window.
   * The same streets, the honest statistic for each kind of level.
   */
  const metric: 'max' | 'median' = level.kind === 'spike' ? 'max' : 'median'
  const segsQ = useSegments({ measure: level.measure as MeasureCode, metric, window: 'all' })
  const values = useMemo(() => segmentValues(segsQ.data), [segsQ.data])
  const overCount = useMemo(
    () => values.reduce((n, v) => (v >= level.threshold ? n + 1 : n), 0),
    [values, level.threshold],
  )

  const created = lastEval?.evaluation.alerts_created.length ?? 0
  const resolved = lastEval?.evaluation.alerts_resolved.length ?? 0
  const fresh = lastEval?.fresh ?? false

  const ranked = useMemo(
    () => hits
      .map((a) => ({ a, v: knownValue(a, now, replaying) }))
      .sort((x, y) => (y.v ?? -Infinity) - (x.v ?? -Infinity)),
    [hits, now, replaying],
  )
  const top = ranked[0]

  return (
    <>
      <Panel
        title={level.label}
        aside={pending ? <span className={l.pending}>re-evaluating…</span> : null}
      >
        <div className={l.impact}>
          <div className={l.hero}>
            <div className={l.heroCell}>
              <span className={`${l.heroNum}${count ? ` ${l.heroHot}` : ''}`}>{fmtNum(count, 0)}</span>
              <span className={l.heroLabel}>alerts ongoing, region-wide</span>
            </div>
            <div className={l.heroCell}>
              <span className={l.delta}>
                <span className={created ? l.deltaUp : l.deltaFlat}>+{created}</span>
                {' '}
                <span className={resolved ? l.deltaDown : l.deltaFlat}>−{resolved}</span>
              </span>
              <span className={l.heroLabel}>{lastEval ? 'from your last edit' : 'move a slider'}</span>
            </div>
          </div>
          <p className={l.note}>
            {!lastEval
              ? `${hits.length} alert${hits.length === 1 ? ' is' : 's are'} ongoing on this level. Drag its threshold and the count follows.`
              : replaying
                // The bus stamps what an edit raises at the end of the data,
                // not at the moment replay is showing — so nothing it raised
                // is on this screen, or anyone's, at this moment.
                ? `${created} raised and ${resolved} resolved when you let go, as of ${
                  dataEnd ? `${fmtDay(dataEnd)} ${fmtTime24(dataEnd)}, the end of the data` : 'the end of the data'
                }. Replay is showing an earlier moment, so they are not on this screen until it reaches the end.`
                : `${created} raised and ${resolved} resolved when you let go. The operators’ and residents’ screens already show the result.`}
          </p>

          {/* Who can reach this level at all. Concedes the monitors' duty
              cycle — they read every hour, the fleet only on the days it
              drove — so the spatial point stands on its own. */}
          <p className={l.note}>
            {monitors === 0
              ? `No reference monitor in this campaign carries ${label}, so there is no reference anchor for it: every reading below is the mobile fleet’s.`
              : `${monitors} of ${monitorTotal} reference monitors measure ${label} every hour, at ${monitors === 1 ? 'one point' : `${monitors} points`}. The mobile fleet measured it on ${fmtNum(values.length, 0)} streets, on the days it drove.`}
          </p>
        </div>
      </Panel>

      {/* instant feedback: no round trip, the count moves with the thumb */}
      <Panel
        title={`Streets · ${fmtNum(values.length, 0)}`}
        aside={
          <span className={l.over}>
            {fmtNum(overCount, 0)} {level.kind === 'spike' ? 'peaked at or above it' : 'typically at or above it'}
            {values.length ? ` (${fmtNum((overCount / values.length) * 100, 1)}%)` : ''}
          </span>
        }
      >
        <div className={l.chart}>
          {values.length ? (
            <Distribution
              values={values}
              marker={level.threshold}
              markerLabel="action level"
              unit={unit}
              decimals={def?.decimals ?? 1}
              height={132}
              bins={30}
              colorByValue={false}
              ramp="intensity"
              subtitle={
                level.kind === 'spike'
                  ? 'Highest reading on each ~200 m of street the fleet drove, whole campaign.'
                  : 'Typical reading on each ~200 m of street the fleet drove, whole campaign.'
              }
            />
          ) : (
            <p className={l.empty}>{segsQ.isPending ? 'Loading streets…' : 'No street readings for this pollutant.'}</p>
          )}
        </div>
      </Panel>

      <Panel className={l.grow} title="Currently over this level">
        {ranked.length ? (
          <div className={l.ledger}>
            {ranked.map(({ a, v }) => {
              const isNew = fresh && lastEval?.evaluation.alerts_created.includes(a.id)
              return (
                <div key={a.id} className={`${l.ledgerRow}${isNew ? ` ${l.flashIn}` : ''}`}>
                  <span className={l.ledgerGlyph} style={{ color: severityVar(a.severity) }} aria-hidden>
                    {SEVERITY_GLYPH[a.severity]}
                  </span>
                  <span className={l.ledgerWho}>{SOURCE_LABEL[sourceOf(a, monitorIds)]}</span>
                  <span className={l.ledgerWhere} title={a.title}>{whereOf(a)}</span>
                  <span className={l.ledgerVal}>
                    {v != null ? `${fmtNum(v, def?.decimals ?? 1)} ${unitText(a.unit)}` : 'not final'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className={l.empty}>
            Nothing is over this level at the moment shown.
          </p>
        )}
        {resolved && fresh ? (
          <p className={`${l.cleared} ${l.flashOut}`}>
            {resolved} alert{resolved === 1 ? '' : 's'} resolved by that edit.
          </p>
        ) : null}
      </Panel>

      {top ? (
        // Not "set just now": the server's now is frozen at the build instant,
        // so the seeded levels and any edit carry the same stamp (Aug 28
        // 13:54) and an age would call the as-issued level fresh. The basis
        // is what matters before sending anything.
        <Panel title="Act on it" aside={<span className={l.basis}>{levelBasis(level.source)}</span>}>
          <div className={l.act}>
            <PushComposer
              key={top.a.id}
              subject={subjectFor(top.a, {
                source: sourceOf(top.a, monitorIds),
                value: top.v,
                endedAt: null,
                levelLabel: level.label,
                def,
              })}
            />
          </div>
        </Panel>
      ) : null}
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
