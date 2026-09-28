/**
 * community — the neighbourhood dashboard.
 *
 * One score, seven plain-language contributors, and the best and worst streets
 * by name. No axes, no units; the only chart is a dial and a row of bars.
 */

import { Link } from '@tanstack/react-router'

import s from '@/apps/community/community.module.css'
import { adviceFor, trendWords, usePlaces } from '@/apps/community/lib'
import { FootNote, MeterRow, RiskPill, SimNote } from '@/apps/community/parts'
import { Skeleton } from '@/app/ui'
import { RiskDial } from '@/components'
import { happenedBy } from '@/core/events'
import { fmtNum } from '@/core/format'
import { useCommunityStats, useConcerns, useFlags } from '@/core/queries'
import { useNowCampaign } from '@/core/session'

export function Dashboard() {
  const places = usePlaces()
  const { data: stats, isLoading } = useCommunityStats()
  // Counted up to the demo's now: in replay, "reports from neighbours" is how
  // many had been posted by the moment on screen, not the campaign's total.
  // 400, the map's key: the campaign holds 204, and 200 read "200" at the end.
  const concerns = happenedBy(useConcerns({ limit: 400 }).data, useNowCampaign())
  const flags = useFlags()

  return (
    <div className={s.page}>
      <SimNote />

      <header style={{ marginBottom: 'var(--s-5)' }}>
        <h1 className={s.hello}>How {places.homeName} is trending</h1>
        <p className={s.helloSub}>
          Everything below is a score out of 100. Lower is better. There are no units and no
          acronyms anywhere on this page — that is deliberate.
        </p>
      </header>

      <section className={s.today} style={{ marginBottom: 'var(--s-5)' }}>
        <RiskDial
          risk={stats?.overall_risk ?? null}
          size={168}
          label="Score"
          bandLabel={stats?.overall_label}
          trendPct={stats?.trend_pct ?? null}
        />
        <div className={s.todayBody}>
          <div className={s.todayKicker}>Across every street we drove</div>
          <h2 className={s.todayHead}>
            {stats ? `${stats.overall_label} — ${trendWords(stats.trend_pct)}` : 'Measuring…'}
          </h2>
          <p className={s.todayLine}>{adviceFor(stats?.overall_risk)}</p>
          <div className={s.todayChips}>
            <span className={s.riskPill}>
              <b className="num">{stats ? fmtNum(stats.monitored_km, 0) : '—'}</b>
              <span>kilometres of street measured</span>
            </span>
            {/* To date when the server counts it (`passes_to_date`, up to the
                clock); otherwise the campaign's total, said as such — at Aug 12
                that total held 12,006 passes not yet driven. */}
            <span className={s.riskPill}>
              <b className="num">
                {stats ? (stats.passes_to_date ?? stats.passes_total).toLocaleString() : '—'}
              </b>
              <span>
                {stats && stats.passes_to_date == null
                  ? 'times our cars drove them over the whole campaign'
                  : 'times our cars drove them'}
              </span>
            </span>
            <span className={s.riskPill}>
              <b className="num">{concerns.length}</b>
              <span>reports from neighbours</span>
            </span>
          </div>
        </div>
      </section>

      <div className={s.cardGrid}>
        <section className={s.tile}>
          <div>
            <h2 className={s.railTitle}>What is in the air here</h2>
            <p className={s.tileBody}>
              Seven different things, each scored on the same 0–100 scale. The words are the plain
              names — the technical ones are for the agency&rsquo;s screen, not yours.
            </p>
          </div>
          {isLoading ? <Skeleton height={200} /> : null}
          {stats?.by_measure.map((m) => (
            <MeterRow key={m.measure} name={m.plain_name} sub={m.label} risk={m.risk} />
          ))}
        </section>

        <section className={s.tile}>
          <div>
            <h2 className={s.railTitle}>Streets worth asking about</h2>
            <p className={s.tileBody}>
              The highest-scoring blocks we measured. A single street can score badly while the
              street behind it is fine — that is the whole point of driving every one of them.
            </p>
          </div>
          {stats?.worst_streets.map((w) => (
            <MeterRow key={w.segment_id} name={w.name} sub={w.district ?? undefined} risk={w.risk} />
          ))}
          <div className={s.railFoot}>
            <Link to="/community/map">Find these on the map</Link>
          </div>
        </section>

        <section className={s.tile}>
          <div>
            <h2 className={s.railTitle}>The quietest streets</h2>
            <p className={s.tileBody}>
              Same neighbourhood, same week. Worth knowing which way to walk.
            </p>
          </div>
          {stats?.best_streets.map((w) => (
            <MeterRow key={w.segment_id} name={w.name} sub={w.district ?? undefined} risk={w.risk} />
          ))}
        </section>

        <section className={s.tile}>
          <div>
            <h2 className={s.railTitle}>Where the numbers come from</h2>
          </div>
          <div className={s.kv}>
            <span>Measured by</span>
            <span>Cars that drive your streets over and over</span>
          </div>
          <div className={s.kv}>
            <span>How often a street is re-driven</span>
            <span>Dozens of times over three months</span>
          </div>
          <div className={s.kv}>
            <span>Car positions shown to you</span>
            <span>At least {Math.round((flags?.community_fleet_delay_min ?? 180) / 60)} hours old</span>
          </div>
          <div className={s.kv}>
            <span>Who can close your report</span>
            <span>Only the regional air agency</span>
          </div>
          <p className={s.tileBody}>
            The agency also runs a handful of fixed monitors.{' '}
            <Link to="/community/status">See what they cover — and what they miss.</Link>
          </p>
        </section>
      </div>

      <div style={{ marginTop: 'var(--s-5)' }} className={s.explainer}>
        <h2 className={s.explainerTitle}>What a score of {stats?.overall_risk ?? '—'} means</h2>
        <p className={s.explainerBody}>
          The score is built from health guidelines, not from how this neighbourhood compares to
          itself. A low number does not mean &ldquo;good for around here&rdquo;; it means the same
          thing it would mean anywhere.
        </p>
        <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
          <RiskPill risk={10} label="Clean" />
          <RiskPill risk={30} label="Fair" />
          <RiskPill risk={50} label="Moderate" />
          <RiskPill risk={62} label="Elevated" />
          <RiskPill risk={78} label="High" />
          <RiskPill risk={90} label="Very high" />
        </div>
      </div>

      <FootNote>
        Simulated data for a demonstration. Real Southwest Memphis streets; invented people,
        companies and agency.
      </FootNote>
    </div>
  )
}
