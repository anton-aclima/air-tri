/**
 * /industry/evidence — says who.
 *
 * The deck tells an operator to hold near 210 MW (modelled) against the 268
 * they are running, on stable nights. The first thing anyone sensible asks is **says
 * who**, and the answer has to be one click away rather than a footnote.
 *
 * So: the two distributions side by side, the roads they came from inked on
 * the map, and the null that says an arbitrary patch of road does not do this.
 * Then, underneath, the far-field question — who is downwind while it happens
 * — which is a different claim with different evidence and much weaker
 * support, and is labelled that way.
 *
 * This is where the model-versus-measurement work from phases 1–4 lives. It is
 * the evidence for the envelope, not the pitch: the owner's steering was that
 * the tier sells "maximise performance within responsible environmental
 * constraints", and "verify your consultant" is how that gets shown, not what
 * gets sold.
 */

import { BaseMap, MapOverlay, SegmentLayer } from '@/components'
import type { SegmentFeature, Theme } from '@/components'
import { fmtDistance, fmtNum, fmtPct } from '@/core/format'
import { useEnvelope, useTouchdown } from '@/core/queries'
import { useNowCampaign, useSession } from '@/core/session'
import type { EnvelopeRegime, TouchdownState } from '@/core/types'

import { Caps, Panel, Readout, styles as s, useSiteLock } from './lib'
import { streetsWindowWords, useStreetGrid } from './streets'

/**
 * One sentence per touchdown state that is NOT a finding. Figures — the
 * excess, the paired hours, the district bars, "N of M segments" — are printed
 * only for `elevated_downwind`: CONTRACT §10a.4 forbids a sample size or an
 * estimate for a stratum that failed the placebo gate. Delta Forge's result is
 * `no_detection` (1.78 ppb under a 3.28 floor, placebo ratio 0.73) and this
 * page used to print its 1.8 ppb anyway, beside "but it is over homes" — when
 * 100% of its downwind passes are on President's Island.
 */
const TOUCHDOWN_SENTENCE: Record<Exclude<TouchdownState, 'elevated_downwind'>, string> = {
  no_detection: 'Measured, inside the noise: downwind of this site in stable air the fleet finds '
    + 'no more than this estimator finds on wind that never blew.',
  contested: 'A rotated bearing matched it: a wind direction that never happened produces a '
    + 'comparable excess, so the result cannot be read as this site\u2019s plume.',
  insufficient_passes: 'Not enough to say: the fleet has not driven downwind of this site in '
    + 'stable air often enough, on both sides of the comparison.',
  not_measured: 'Not enough to say: the fleet has not driven downwind of this site in stable air.',
}

const REGIME_LABEL: Record<string, string> = {
  unstable: 'Well-mixed air',
  neutral: 'Neutral air',
  stable: 'Stable air',
}

/** Two distributions on one scale, so the comparison is looked at rather than believed. */
function Compare({ r, unit, line }: { r: EnvelopeRegime; unit: string; line: number | null }) {
  const top = Math.max(
    r.level_p90 ?? 0, r.comparison_p90 ?? 0, line ?? 0, 1,
  ) * 1.15
  const bar = (v: number | null, cls: string) =>
    v == null ? null : <div className={cls} style={{ width: `${(100 * v) / top}%` }} />

  return (
    <div className={s.evCompare}>
      <div className={s.evRow}>
        <Caps ink>Your fenceline</Caps>
        <div className={s.evTrack}>
          {bar(r.level_p90, s.evBarFenceWide)}
          {bar(r.level_p50, s.evBarFence)}
          {line != null ? <div className={s.evLine} style={{ left: `${(100 * line) / top}%` }} /> : null}
        </div>
        <span className="num">{r.level_p50 == null ? '—' : `${fmtNum(r.level_p50, 0)} ${unit}`}</span>
      </div>
      <div className={s.evRow}>
        <Caps>Comparable roads</Caps>
        <div className={s.evTrack}>
          {bar(r.comparison_p90, s.evBarCompWide)}
          {bar(r.comparison_p50, s.evBarComp)}
          {line != null ? <div className={s.evLine} style={{ left: `${(100 * line) / top}%` }} /> : null}
        </div>
        <span className="num">
          {r.comparison_p50 == null ? '—' : `${fmtNum(r.comparison_p50, 0)} ${unit}`}
        </span>
      </div>
      <span className={s.evCaption}>
        Bars are the median and the 90th percentile; the tick is the action level.{' '}
        {r.n_fenceline} fenceline passes over {r.n_episodes} episodes.
      </span>
    </div>
  )
}

export function Evidence() {
  const site = useSiteLock()
  const envQ = useEnvelope(site?.id)
  const tdQ = useTouchdown(site?.id)
  // The roads' colours are the passes up to the moment shown (`todate&at`,
  // P5); at the end of the data that is the whole campaign, as it was.
  const segsQ = useStreetGrid()
  const now = useNowCampaign()
  const replaying = useSession((x) => x.time.cursor != null)
  const gridWords = streetsWindowWords(segsQ.data, replaying, now, '')

  if (!site) {
    return <div className={`${s.page} ${s.sitePage}`}><div className={s.err}>No site.</div></div>
  }

  const env = envQ.data
  const stable = env?.regimes.find((r) => r.regime === 'stable')
  const watch = stable?.thresholds.length
    ? stable.thresholds.reduce((a, b) => (a.threshold <= b.threshold ? a : b))
    : null
  const fenceIds = new Set(env?.fenceline_segment_ids ?? [])
  const compIds = new Set(env?.comparison_segment_ids ?? [])
  const td = tdQ.data
  // Said from the payload, never assumed: the district the downwind passes
  // actually fell in. Whether that district is homes is not in the data.
  const topDistrict = [...(td?.districts ?? [])].sort((a, b) => b.share - a.share).find((d) => d.n_downwind > 0) ?? null

  /*
    The road grid, in three registers. The fenceline is the only inked thing —
    it is the measurement the claim rests on. The comparison set is drawn faint
    because it is context, and everything else is left alone: a road that is
    neither is not evidence for or against anything, and colouring it would
    imply it was.
  */
  const layers = (theme: Theme) => {
    const all = segsQ.data?.features ?? []
    const pick = (want: Set<string>) =>
      all.filter((f: SegmentFeature) => want.has(f.properties.id))
    return [
      ...SegmentLayer({
        id: 'ev-comparison', data: { type: 'FeatureCollection', features: pick(compIds) },
        theme, baseWidthM: 6, widthMaxPixels: 2, casing: false, dualEncode: 'none',
      }),
      ...SegmentLayer({
        id: 'ev-fenceline', data: { type: 'FeatureCollection', features: pick(fenceIds) },
        theme, baseWidthM: 34, widthMinPixels: 4, dualEncode: 'none',
      }),
    ]
  }

  return (
    <div className={`${s.page} ${s.sitePage}`}>
      <div className={`${s.banner} ${stable?.state === 'binding' ? s.bannerThreat : s.bannerClear}`}>
        <div className={s.bannerLine}>
          <span className={s.bannerHead}>Says who</span>
          <span className={s.bannerSub}>
            {env == null
              ? 'Loading the measurements behind your envelope.'
              : stable?.excess == null
                ? `We have not driven ${site.name}'s fenceline on enough stable nights to say. `
                  + 'That is a sampling gap, not a clean result.'
                : `${env.fenceline_roads.join(', ')} ${env.fenceline_roads.length > 1 ? 'run' : 'runs'} `
                  + `${fmtNum(stable.excess, 0)} ${env.unit} over roads of the same class more than `
                  + `${fmtDistance(2000)} from any site, in stable air. `
                  + `Same instrument, same nights.`}
          </span>
        </div>
        <div className={s.bannerStats}>
          <Readout label="Fenceline passes" value={fmtNum(stable?.n_fenceline ?? 0, 0)} />
          <Readout label="Compared against" value={fmtNum(stable?.n_comparison ?? 0, 0)} />
          <Readout label="Episodes" value={fmtNum(stable?.n_episodes ?? 0, 0)} />
          <Readout
            label="Over the level"
            value={watch ? fmtPct(watch.share_over * 100, 0, false) : '—'}
            tone={watch && watch.share_over > 0.2 ? 'threat' : undefined}
            big
          />
        </div>
      </div>

      <div className={s.siteBody}>
        <Panel title="The roads this rests on" aside={<Caps>{env?.fenceline_roads.join(' · ')}</Caps>}>
          <BaseMap layers={layers} initialView={{ longitude: site.centroid[0], latitude: site.centroid[1], zoom: 12.4 }}>
            <MapOverlay place="bottom-left">
              <span className={s.mapCaption}>
                Thick: your fenceline, within {env ? fmtDistance(env.fenceline_m) : '—'} of a running
                source. Faint: the comparison roads, over 2 km from every site.
                {gridWords ? ` Colour ${gridWords}; a road not driven by then is not drawn.` : ''}
              </span>
            </MapOverlay>
          </BaseMap>
        </Panel>

        <div className={s.scrollStack}>
          {(env?.regimes ?? []).map((r) => (
            <Panel
              key={r.regime}
              title={REGIME_LABEL[r.regime] ?? r.regime}
              aside={<Caps>{fmtPct(r.share_of_hours * 100, 0, false)} of hours</Caps>}
            >
              {r.state === 'insufficient' ? (
                <span className={s.bannerSub}>
                  Not enough paired episodes to compare. {r.n_fenceline} fenceline passes over{' '}
                  {r.n_episodes} usable nights — the fleet was there, but not alongside enough
                  comparison road on the same night.
                </span>
              ) : (
                <Compare r={r} unit={env?.unit ?? ''} line={watch?.threshold ?? null} />
              )}
            </Panel>
          ))}

          <Panel title="Could any road do this?" aside={<Caps>the null</Caps>}>
            <span className={s.bannerSub}>
              {env?.decoy_null?.n
                ? `We ran the identical comparison around ${env.decoy_null.n} road clusters at least `
                  + `2.5 km from every site, treating each as if it were a fenceline. They average `
                  + `${fmtNum(env.decoy_null.mean ?? 0, 1)} ${env.unit} and the worst is `
                  + `${fmtNum(env.decoy_null.abs_max ?? 0, 1)}. Yours is `
                  + `${fmtNum(stable?.excess ?? 0, 0)}.`
                : 'The null has not been computed for this build.'}
            </span>
          </Panel>

          {/*
            A DIFFERENT CLAIM, with much weaker support, and it has to look
            like one. The fenceline result is 32 standard deviations off its
            null; the touchdown is a few ppb over 14 paired hours and says
            nothing about any threshold. Putting them in one panel would lend
            the second the first one's authority.
          */}
          <Panel
            title="And who is downwind while it happens"
            aside={td ? <Caps>{td.site.state.replace(/_/g, ' ')}</Caps> : null}
          >
            {!td ? (
              <span className={s.bannerSub}>
                {tdQ.isError ? 'The downwind test is unavailable.' : 'Reading the downwind test…'}
              </span>
            ) : td.site.state !== 'elevated_downwind' || td.site.excess == null ? (
              <span className={s.bannerSub}>
                {td.site.state === 'elevated_downwind'
                  ? TOUCHDOWN_SENTENCE.insufficient_passes
                  : TOUCHDOWN_SENTENCE[td.site.state]}
              </span>
            ) : (
              <>
                <span className={s.bannerSub}>
                  {fmtDistance(td.site.r_lo_m)} to {fmtDistance(td.site.r_hi_m)} downwind in stable
                  air we measure {fmtNum(td.site.excess, 1)} {env?.unit} above matched control roads,
                  over {td.site.n_hours} paired hours, and a rotated bearing does not reproduce it.
                  That is a smaller and much less certain result than the fenceline above, and it is
                  an increment over control roads, not a level, so it says nothing about any
                  action level.
                  {topDistrict
                    ? ` ${fmtPct(topDistrict.share * 100, 0, false)} of those downwind passes were in ${topDistrict.district}.`
                    : ''}
                </span>
                <div className={s.evDistricts}>
                  {td.districts.filter((d) => d.n_downwind > 0).slice(0, 3).map((d) => (
                    <div key={d.district} className={s.evRow}>
                      <Caps ink>{d.district}</Caps>
                      <div className={s.evTrack}>
                        <div className={s.evBarComp} style={{ width: `${100 * d.share}%` }} />
                      </div>
                      <span className="num">{fmtPct(d.share * 100, 0, false)}</span>
                    </div>
                  ))}
                </div>
                <span className={s.evCaption}>
                  Share of downwind passes by district. {td.site.n_supported_segments} of{' '}
                  {td.features.length} road segments carry enough passes to say anything at all.
                </span>
              </>
            )}
          </Panel>

          {env ? (
            <Panel title="What is measured and what is not">
              <span className={s.bannerSub}>{env.headroom_is_modelled}</span>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  )
}
