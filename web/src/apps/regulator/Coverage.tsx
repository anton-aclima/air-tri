/**
 * /regulator/coverage — do my instruments stand where the plume goes?
 *
 * Answered from this campaign's own record rather than from a siting rule of
 * thumb. Four blocks, and the fourth is the one that makes the other three
 * believable.
 *
 * EVERYTHING ON THIS SCREEN EXCEPT THE CONCESSION IS MODELLED. "In a plume"
 * means inside a cone from the dispersion kernel driven by the hourly wind
 * record — nobody measured the air at these towers and compared it to
 * anything. `basis` ships in every payload and is printed beside the verdict,
 * not tucked into a tooltip, because the number is arresting and the caveat
 * has to travel at the same speed.
 *
 * WHAT WAS DELIBERATELY NOT BUILT
 * -------------------------------
 * No recommendation. Siting a regulatory instrument involves land access,
 * power, security and network-design rules this product knows nothing about,
 * and telling a public agency where to put one is the closest this whole
 * system comes to regulatory advice. Every row in the last panel reads "these
 * streets carry the most unobserved plume-hours in this record" and the
 * server's own `framing` string is rendered above them, so the disclaimer
 * cannot be dropped by editing this file.
 */

import { useMemo } from 'react'

import { fmtNum, fmtPct } from '@/core/format'
import { useCalibration, useInterception, useResidency, useSiting } from '@/core/queries'
import type { InstrumentCoverage } from '@/core/types'

import { Caps, Panel, Readout, styles as s } from './lib'

/** Under this share of hours, a tower is "effectively never" in a plume. */
const RARELY = 0.02

function Bar({ share, tone }: { share: number; tone?: 'threat' | 'accent' }) {
  return (
    <div className={s.covTrack}>
      <div
        className={tone === 'threat' ? s.covBarThreat : s.covBar}
        style={{ width: `${Math.max(1, Math.min(100, share * 100))}%` }}
      />
    </div>
  )
}

function InstrumentRow({ i }: { i: InstrumentCoverage }) {
  const rare = i.share < RARELY
  return (
    <div className={s.covRow}>
      <span className={s.covName}>
        {i.name}
        {i.status !== 'online' ? <Caps>{i.status}</Caps> : null}
      </span>
      <Bar share={i.share} tone={rare ? 'threat' : 'accent'} />
      <span className={`${s.covNum} num`}>{fmtPct(i.share * 100, 1, false)}</span>
    </div>
  )
}

export function Coverage() {
  const interceptQ = useInterception()
  const residencyQ = useResidency()
  const sitingQ = useSiting(8)
  const calQ = useCalibration()

  const d = interceptQ.data
  const ref = useMemo(
    () => (d?.instruments ?? []).filter((i) => i.grade === 'reference'),
    [d],
  )
  const others = useMemo(
    () => (d?.instruments ?? []).filter((i) => i.grade !== 'reference'),
    [d],
  )
  const summary = d?.reference_summary
  const con = d?.concession
  const res = residencyQ.data

  return (
    <div className={`${s.page} ${s.covPage}`}>
      {/* ── the verdict, with its basis in the same breath ──────────────── */}
      <div className={`${s.verdict} ${summary && summary.n_rarely > 0 ? s.verdictOver : s.verdictClear}`}>
        <div className={s.verdictMark}>
          <span className={s.verdictGlyph}>◎</span>
          <span className={s.verdictWord}>COVERAGE</span>
        </div>
        <div className={s.verdictLines}>
          <span className={s.verdictHead}>
            {summary == null
              ? 'Working out where your instruments stand'
              : `${summary.n_rarely} of your ${summary.n} reference instruments are almost never in a plume`}
          </span>
          {/*
            The basis on its own line, not appended to the headline. It read as
            "...almost never in a plumemodelled — air.dispersion" when these
            were one span, which is both unreadable and exactly the kind of
            caveat-swallowing this screen exists to avoid.
          */}
          <span className={s.sub}>{d?.basis ?? ''}</span>
        </div>
        <div className={s.verdictStats}>
          <Readout
            label="Best placed"
            value={summary ? fmtPct(summary.best_share * 100, 1, false) : '—'}
            tone="accent"
          />
          <Readout
            label="Worst placed"
            value={summary ? fmtPct(summary.worst_share * 100, 1, false) : '—'}
            tone={summary && summary.worst_share < RARELY ? 'over' : undefined}
          />
          <Readout
            label="Plume-hours nothing watched"
            value={res ? fmtPct(res.unobserved_share * 100, 0, false) : '—'}
            tone={res && res.unobserved_share > 0.4 ? 'over' : undefined}
            big
          />
        </div>
      </div>

      <div className={s.covBody}>
        <Panel
          title="Hours each instrument stands inside a modelled plume"
          aside={d ? <Caps>{fmtNum(d.n_hours, 0)} hours</Caps> : null}
        >
          {ref.map((i) => <InstrumentRow key={i.monitor_id} i={i} />)}
          {/*
            The operator's own fenceline ring, under a divider. It belongs on
            this screen — it is instrumentation in the region and a regulator
            should see it — but it is not theirs and must not be totalled in
            with the reference network above.
          */}
          {others.length ? (
            <>
              <div className={s.covDivider}>
                <Caps>not the agency&rsquo;s — operator fenceline and community sensors</Caps>
              </div>
              {others.map((i) => <InstrumentRow key={i.monitor_id} i={i} />)}
            </>
          ) : null}
        </Panel>

        {/* ── the concession, in the same payload as the win ─────────────── */}
        <Panel title="What four points do well, and what they cannot do">
          {/*
            EVERY NUMBER COMPUTED. This panel carried "8,598 records" and
            "5.7% vs 1.4%" copied out of a design document; measured on this
            campaign the records are 21,500 and the shares are 8.4% and 4.8%.
            The finding held and the margin did not — 1.75x, not 4x — which is
            why the losing number ships in the same payload as the winning one
            rather than being written down beside it.
          */}
          <div className={s.covCompare}>
            <div className={s.covRow}>
              <span className={s.covName}>Places measured</span>
              <span className={`${s.covNum} num`}>
                {con ? `${fmtNum(con.n_reference_instruments, 0)} vs ${fmtNum(con.n_segments, 0)}` : '—'}
              </span>
            </div>
            <div className={s.covRow}>
              <span className={s.covName}>Records in this campaign</span>
              <span className={`${s.covNum} num`}>
                {con ? `${fmtNum(con.n_reference_readings, 0)} vs ${fmtNum(con.n_fleet_passes, 0)}` : '—'}
              </span>
            </div>
            <div className={s.covRow}>
              <span className={s.covName}>Share of own record taken in a plume</span>
              <span className={`${s.covNum} num`}>
                {con
                  ? `${fmtPct(con.reference_share * 100, 1, false)} vs ${fmtPct(con.fleet_share * 100, 1, false)}`
                  : '—'}
              </span>
            </div>
          </div>
          <p className={s.sub}>
            An always-on instrument beats a moving one on duty cycle, and yours does here — a
            larger share of your own record is taken while a plume is overhead
            {con ? ` (${fmtPct(con.reference_share * 100, 1, false)} against ${fmtPct(con.fleet_share * 100, 1, false)})` : ''}.
            What four points cannot do is tell you where the fifth should go.
          </p>
        </Panel>

        {/* ── siting: an observation, never advice ───────────────────────── */}
        <Panel
          title="Streets carrying the most unobserved plume-hours"
          aside={res ? <Caps>{fmtNum(res.unobserved_hours, 0)} in total</Caps> : null}
        >
          {/* Rendered from the server's own string, so it cannot be dropped here. */}
          <p className={s.sub}>{sitingQ.data?.framing ?? ''}</p>
          {(sitingQ.data?.candidates ?? []).map((c) => (
            <div key={c.segment_id} className={s.covRow}>
              <span className={s.covName}>
                {c.name ?? c.segment_id}
                <Caps>{c.district ?? '—'}</Caps>
              </span>
              <Bar share={c.unobserved_share} />
              <span className={`${s.covNum} num`}>
                {fmtNum(c.unobserved_hours, 0)} of {fmtNum(c.plume_hours, 0)}
              </span>
            </div>
          ))}
        </Panel>

        {/* ── P7-D: what can be anchored at all ──────────────────────────── */}
        <Panel
          title="Which channels a reference instrument can anchor"
          aside={calQ.data ? <Caps>{calQ.data.n_anchored} of {calQ.data.n_measures}</Caps> : null}
        >
          {(calQ.data?.channels ?? []).map((ch) => (
            <div key={ch.code} className={s.covRow}>
              <span className={s.covName}>
                {ch.plain_name}
                <Caps>{ch.code}</Caps>
              </span>
              <span className={s.covAnchor}>
                {ch.anchored
                  ? `${ch.n_reference_anchors} reference ${ch.n_reference_anchors === 1 ? 'instrument' : 'instruments'}`
                  : 'no reference anchor in this campaign'}
              </span>
              <span className={`${s.covNum} num`}>
                {ch.anchored && ch.age_days != null ? `${fmtNum(ch.age_days, 0)} d` : '—'}
              </span>
            </div>
          ))}
          <p className={s.sub}>
            The channels your towers can anchor are the channels your towers already carry. The
            ones a mobile network uniquely adds — soot, methane, and everything derived from
            them — are the ones nothing in this region can anchor. A single &ldquo;calibrated&rdquo;
            badge on a node would be false for most of what that node measures.
          </p>
        </Panel>
      </div>
    </div>
  )
}

export default Coverage
