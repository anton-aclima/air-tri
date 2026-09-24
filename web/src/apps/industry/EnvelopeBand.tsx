/**
 * The typical day — "run full by day, hold near 210 MW on stable nights".
 *
 * The one thing the deck's status line cannot say. The line reads the air of
 * the moment; this reads the campaign: which regime each hour of the day
 * usually sits in (from the met record), and what the measured envelope
 * allows in that regime. It is the owner's core message drawn — maximise
 * performance within the constraint — and it is a climatology, not a
 * forecast: no hour here is a prediction for tonight.
 *
 * Two forms, because two of the three sites have no MW rating:
 *
 *   · with a rating (Ridgeline), bars of the MW the air has room for
 *     (modelled), capped at the rating, labelled in the bars, against a line
 *     at the load being run;
 *   · without one (Delta Forge, Riverport: `load_mw` null), one compact strip
 *     of the STATE by hour — no cut needed / cut needed — with stable hours
 *     outlined. It used to draw 24 identical full-height bars there, told
 *     apart by outline alone, under half a panel of empty space.
 *
 * Every MW and every "no cut" is modelled, and says so.
 */

import { fmtNum } from '@/core/format'
import type { Envelope } from '@/core/types'

import { hourRun, regimeWord, styles as s } from './lib'
import type { EnvelopeHour } from './lib'

const W = 240
const H = 64
const TOP = 4
const BAR = 10

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`

/** The longest run of consecutive hours (no wrap) sharing `key`, per key. */
function longestRuns(hours: EnvelopeHour[], key: (h: EnvelopeHour) => string | null) {
  const best = new Map<string, { start: number; len: number }>()
  let start = 0
  for (let i = 1; i <= hours.length; i++) {
    const k = key(hours[start])
    if (i < hours.length && key(hours[i]) === k) continue
    const len = i - start
    if (k != null && len > (best.get(k)?.len ?? 0)) best.set(k, { start, len })
    start = i
  }
  return best
}

export function EnvelopeBand({
  hours, env, capacityMw, nowHour, metHours,
}: {
  hours: EnvelopeHour[] | null
  env: Envelope | undefined
  capacityMw: number | null | undefined
  /** The hour of the moment shown, marked on the band. */
  nowHour: number | null
  /** Hours of met record behind the typical day. */
  metHours: number
}) {
  if (!env || !hours) {
    return <span className={s.reportNote}>The typical day needs the envelope and the campaign's wind record.</span>
  }
  const stable = env.regimes.find((r) => r.regime === 'stable')
  const load = env.load_mw
  const hasMw = hours.some((h) => h.mw != null) && load != null
  const holdRun = hourRun(hours, (h) => h.hold)
  const stableRun = hourRun(hours, (h) => h.regime === 'stable')
  const holdMw = hours.find((h) => h.hold && h.mw != null)?.mw ?? null
  const unknown = hours.some((h) => !h.known)

  let lead: string
  if (hasMw && holdMw != null && holdRun) {
    lead = `Full load by day (modelled); hold near ${fmtNum(holdMw, 0)} MW (modelled) in stable air, most nights ${holdRun}.`
  } else if (hasMw) {
    lead = 'Full load in every hour of the typical day (modelled).'
  } else if (holdRun) {
    lead = `A cut is needed on the typical stable night (modelled), most nights ${holdRun}.`
  } else {
    lead = `No cut needed at typical activity in any ${unknown ? 'characterised ' : ''}hour (modelled).`
      + (stableRun ? ` Stable air most nights ${stableRun}.` : '')
  }

  const stableNights = `${stable?.n_episodes ?? 0} measured stable night${stable?.n_episodes === 1 ? '' : 's'}`
  const basis = `Typical, from ${stableNights} and ${fmtNum(metHours, 0)} hours of this campaign's weather — not a forecast.`

  return (
    <div className={s.band}>
      <span className={s.bandLead}>{lead}</span>
      {hasMw && load != null
        ? <MwBars hours={hours} load={load} capacityMw={capacityMw} lead={lead} />
        : <StateStrip hours={hours} lead={lead} />}
      {/* Ticks and the "now" mark in HTML, not SVG text: the chart stretches
          to the panel's width, and stretched text is unreadable. */}
      <div className={s.bandAxis} aria-hidden>
        {[0, 6, 12, 18].map((h) => (
          <span key={h} className={s.bandTick} style={{ gridColumn: `${h + 1} / span 3` }}>
            {String(h).padStart(2, '0')}
          </span>
        ))}
        {nowHour != null ? (
          <span className={s.bandNow} style={{ gridColumn: `${nowHour + 1} / span 1` }}>▲</span>
        ) : null}
      </div>
      <span className={s.bandCaption}>
        {hasMw && load != null
          ? `Bars: the MW the air has room for (modelled), capped at the ${fmtNum(capacityMw ?? load, 0)} MW rating. Line: running ${fmtNum(load, 0)} MW. `
          : `Filled: no cut needed${holdRun ? '; amber: cut needed' : ''}; outlined: stable air${unknown ? '; dashed: not characterised' : ''}. `}
        {basis}
        {nowHour != null ? ' ▲ marks the hour shown.' : ''}
      </span>
    </div>
  )
}

function hourTitle(h: EnvelopeHour, mwText: string | null): string {
  return `${hh(h.hour)} · ${regimeWord(h.regime).toLowerCase()} most of the campaign`
    + ` (stable ${fmtNum(h.pStable * 100, 0)}% of ${h.n} h)`
    + (mwText ? ` · ${mwText}` : '')
    + (h.hold ? ' · needs a cut on the typical night (modelled)' : h.known ? ' · no cut needed (modelled)' : ' · not characterised')
}

/** Ridgeline's form: MW bars, labelled in the bars, against the load line. */
function MwBars({
  hours, load, capacityMw, lead,
}: { hours: EnvelopeHour[]; load: number; capacityMw: number | null | undefined; lead: string }) {
  // Headroom above nameplate is an extrapolation the plant cannot run at, so
  // the scale stops just above the larger of capacity and load.
  const top = Math.max(capacityMw ?? 0, load, 1) * 1.08
  const y = (mw: number) => TOP + (H - TOP) * (1 - Math.min(mw, top) / top)
  const full = capacityMw ?? load
  // One label per distinct bar height, on its longest run, when the run is
  // wide enough to hold it: "352 MW" over the day, "210 MW" over the night —
  // at the foot of the bars, clear of the load line that crosses the tall ones.
  const runs = longestRuns(hours, (h) => (h.mw == null ? null : String(Math.round(h.mw))))
  const labels = [...runs.entries()]
    .filter(([, r]) => r.len >= 3)
    .map(([mw, r]) => ({ mw: Number(mw), ...r, hold: hours[r.start].hold }))
  // The load line's own label, at whichever end has no bar above the line.
  const clear = (from: number, to: number) => hours.slice(from, to).every((h) => h.mw == null || h.mw < load * 0.97)
  const loadSide = clear(18, 24) ? 'end' : clear(0, 6) ? 'start' : null
  return (
    <div className={s.bandChart}>
      <svg
        className={s.bandSvg}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Typical day: ${lead}`}
        preserveAspectRatio="none"
      >
        {hours.map((h) => {
          const x = h.hour * BAR
          const mwText = h.mw != null ? `room for about ${fmtNum(h.mw, 0)} MW (modelled)` : null
          return (
            <g key={h.hour}>
              <title>{hourTitle(h, mwText)}</title>
              {/* the hit target is the full column, bigger than the bar */}
              <rect x={x} y={0} width={BAR} height={H} fill="transparent" />
              {h.mw == null ? (
                <rect x={x + 1} y={TOP} width={BAR - 2} height={H - TOP} className={s.bandBarNone} />
              ) : (
                <rect
                  x={x + 1} y={y(h.mw)} width={BAR - 2} height={Math.max(1, H - y(h.mw))}
                  className={h.hold ? s.bandBarHold : s.bandBarRoom}
                />
              )}
            </g>
          )
        })}
        <line x1={0} x2={W} y1={y(load)} y2={y(load)} className={s.bandLoad} />
      </svg>
      {labels.map((l) => (
        <span
          key={l.mw}
          className={`${s.bandLabel} num${l.hold ? ` ${s.bandLabelHold}` : ''}`}
          style={{ left: `${(l.start / 24) * 100}%`, width: `${(l.len / 24) * 100}%`, top: H - 13 }}
          aria-hidden
        >
          {fmtNum(l.mw, 0)} MW{l.mw >= full ? ' · full' : ''}
        </span>
      ))}
      {loadSide ? (
        <span
          className={`${s.bandLoadLabel} num`}
          style={{ top: y(load) - 13, ...(loadSide === 'end' ? { right: 0 } : { left: 0 }) }}
          aria-hidden
        >
          running {fmtNum(load, 0)}
        </span>
      ) : null}
    </div>
  )
}

/** The form for a site with no MW rating: the state by hour, in one strip. */
function StateStrip({ hours, lead }: { hours: EnvelopeHour[]; lead: string }) {
  return (
    <div className={s.bandStrip} role="img" aria-label={`Typical day: ${lead}`}>
      {hours.map((h) => (
        <span
          key={h.hour}
          title={hourTitle(h, null)}
          className={!h.known ? s.bandCellNone
            : h.hold ? s.bandCellHold
              : h.regime === 'stable' ? s.bandCellStable : s.bandCellRoom}
        />
      ))}
    </div>
  )
}
