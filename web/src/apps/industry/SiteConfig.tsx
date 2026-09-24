/**
 * /industry/site — the campus: emission points, the fenceline sensors, the
 * operating envelope.
 *
 * Deliberately the thinnest screen in this interface. It exists so the operator
 * can see what the deck is reasoning about, not so they can do analysis.
 *
 * Every megawatt figure the envelope prints carries "(modelled)" where it is
 * printed: the excess and the levels are measured, the MW extrapolates them
 * (`Envelope.headroom_is_modelled`), and a big readout without the word was
 * read as a measured capacity. Never "safe" — it is an operating envelope.
 */

import { fmtDay, fmtDistance, fmtNum, fmtTime24 } from '@/core/format'
import { campaignMs } from '@/core/clock'
import { useEnvelope, useMonitors, useModelVerification } from '@/core/queries'
import { useNowCampaign } from '@/core/session'
import { haversine } from '@/components'

import {
  Caps, Panel, Readout, Tag, envelopeRead, styles as s, useCampaignWindow, useSiteLock,
} from './lib'

/** A reading older than this at the moment shown is a sensor that was not reporting. */
const STALE_MS = 2 * 3_600_000

/**
 * A megawatt headline carries "(modelled)"; a percentage (the measured cut) or
 * a sentence does not. The word is split off so the readout can set it as a
 * unit beside the number rather than at display size — whether `envelopeRead`
 * already appended it or not.
 */
function splitModelled(headline: string): { value: string; modelled: boolean } {
  const bare = headline.replace(/\s*\(modelled\)$/i, '')
  return { value: bare, modelled: bare !== headline || /\bMW$/.test(bare) }
}

const KIND_GLYPH: Record<string, string> = {
  generator: '▮', backup: '▯', cooling_tower: '◍', substation: '⊞',
  traffic_gate: '⇥', stack: '▲',
}

export function SiteConfig() {
  const site = useSiteLock()
  const now = useNowCampaign()
  const monitorsQ = useMonitors({ site_id: site?.id }, { enabled: !!site })
  // The campaign, not the last 30 days — see `useCampaignWindow`.
  const verifyWin = useCampaignWindow()
  const verifyQ = useModelVerification(site?.id, verifyWin ?? {}, {
    enabled: !!site?.id && !!verifyWin,
  })
  // Reported for stable air: that is the regime that binds, and the one an
  // operator plans around. `envelopeRead` explains why this is no longer
  // `site.headroom_pct`. Above the early return, with the rest of the hooks —
  // `useSiteLock` can resolve to undefined on the first render.
  const envQ = useEnvelope(site?.id)
  const env = envelopeRead(envQ.data, 'stable')
  const head = env ? splitModelled(env.headline) : null

  if (!site) {
    return <div className={`${s.page} ${s.sitePage}`}><div className={s.err}>No site.</div></div>
  }

  const active = site.emission_points.filter((e) => e.active).length

  return (
    <div className={`${s.page} ${s.sitePage}`}>
      <div className={`${s.banner} ${s.bannerClear}`}>
        <div className={s.bannerLine}>
          <span className={s.bannerHead}>{site.name}</span>
          <span className={s.bannerSub}>{site.blurb}</span>
        </div>
        <div className={s.bannerStats}>
          <Readout label="Capacity" value={fmtNum(site.capacity_mw, 0)} unit="MW" />
          <Readout label="IT load" value={fmtNum(site.it_load_mw, 0)} unit="MW" />
          <Readout label="Emission points" value={`${active}/${site.emission_points.length}`} />
          <Readout
            label="Envelope · stable air"
            value={head ? head.value : '—'}
            unit={head?.modelled ? '(modelled)' : undefined}
            tone={env?.binding ? 'threat' : 'accent'}
            big
          />
        </div>
      </div>

      <div className={s.siteBody}>
        <Panel title="Emission points" aside={<Caps>{active} active</Caps>}>
          {site.emission_points.map((e) => (
            <div key={e.id} className={s.ep}>
              <span className={e.active ? s.epOn : s.epOff}>{KIND_GLYPH[e.kind] ?? '·'}</span>
              <span className={s.epName}>{e.name}</span>
              <span className={s.contactCode}>{e.kind.replace('_', ' ')}</span>
              <span className={`${s.epNum} num`}>{e.height_m != null ? `${fmtNum(e.height_m, 0)} m` : '—'}</span>
              <span className={`${s.epNum} ${e.active ? s.epOn : s.epOff}`}>{e.active ? 'ON' : 'OFF'}</span>
            </div>
          ))}
        </Panel>

        <div className={s.scrollStack}>
          <Panel
            title="Operating envelope"
            aside={env ? <Caps>{env.episodes} episodes</Caps> : null}
          >
            <div className={s.envelope}>
              <div className={s.envRow}>
                <span className={`${s.envNum} num${env?.binding ? ` ${s.envNumTight}` : ''}`} style={{ whiteSpace: 'nowrap' }}>
                  {head ? head.value : '—'}
                </span>
                <Caps ink>{head?.modelled ? '(modelled) · in stable air' : 'in stable air'}</Caps>
                <span className={s.spacer} />
                <span className="num" style={{ color: 'var(--ink-2)', fontSize: 'var(--text-xs)' }}>
                  {env?.loadMw != null ? `${fmtNum(env.loadMw, 0)} MW now` : ''}
                </span>
              </div>
              {/* The bar is now how much of the site's own contribution has to
                  go, not a notional share of a constant. Empty is good. */}
              <div className={s.envBar}>
                <div className={s.envUsed} style={{ width: `${env?.cutPct ?? 0}%` }} />
                <div className={s.envTicks} />
                <div className={s.envEdge} style={{ left: `${env?.cutPct ?? 0}%` }} />
              </div>
              <span className={s.bannerSub}>
                {env ? env.detail : 'Envelope not characterised.'}
              </span>
              {envQ.data ? (
                <span className={s.bannerSub}>{envQ.data.headroom_is_modelled}</span>
              ) : null}
            </div>
          </Panel>

          <Panel title="Fenceline sensors" aside={<Caps>{(monitorsQ.data ?? []).length} sensors</Caps>}>
            {(monitorsQ.data ?? []).map((m) => {
              const d = haversine([m.lon, m.lat], site.centroid)
              // Readings at the moment shown only. An offline sensor keeps its
              // last value as `latest`; that is not a reading now.
              const fresh = Object.values(m.latest ?? {})
                .filter((l): l is NonNullable<typeof l> => !!l && campaignMs(now) - campaignMs(l.ts) <= STALE_MS)
              const exceeds = fresh.some((l) => l.exceeds)
              const last = Object.values(m.latest ?? {})
                .reduce<string | null>((a, l) => (l && (!a || l.ts > a) ? l.ts : a), null)
              return (
                <div key={m.id} className={s.ep}>
                  {/* ▲ over a level now · ◇ reporting, under · · no reading now */}
                  <span className={exceeds || !fresh.length ? s.epOff : s.epOn} style={exceeds ? { color: 'var(--threat)' } : undefined}>
                    {exceeds ? '▲' : fresh.length ? '◇' : '·'}
                  </span>
                  {/* "Fenceline NW": the panel already says whose. */}
                  <span className={s.epName} title={!fresh.length && last ? `${m.name} · no reading since ${fmtDay(last)} ${fmtTime24(last)}` : m.name}>
                    {m.name.replace(/^.*?\bfenceline\s+/i, 'Fenceline ')}
                    {!fresh.length && last ? (
                      <span style={{ color: 'var(--ink-3)' }}> · last reading {fmtDay(last)}</span>
                    ) : null}
                  </span>
                  <span className={s.contactCode}>{m.measures.join(' ')}</span>
                  <span className={`${s.epNum} num`}>{fmtDistance(d, 1)}</span>
                  <span className={`${s.epNum}`}>{m.status.toUpperCase()}</span>
                </div>
              )
            })}
            {!(monitorsQ.data ?? []).length ? <div className={s.err}>No fenceline sensors on file.</div> : null}
          </Panel>

          {verifyQ.data ? (
            <Panel title="Dispersion study on file">
              <div className={s.form}>
                <div className={s.strip} style={{ padding: 0, borderTop: 0 }}>
                  {/* Neutral, not the threat red: the filed study is a supporting
                      comparison (D9), not an alarm about the air. */}
                  <Tag>{verifyQ.data.verdict.replace('_', ' ')}</Tag>
                  <span className={s.bannerSub}>{verifyQ.data.model.vendor}</span>
                </div>
                <span className={s.postBody}>{verifyQ.data.summary}</span>
                <Caps>{fmtNum(verifyQ.data.n_obs, 0)} fleet wind observations behind this</Caps>
              </div>
            </Panel>
          ) : null}
        </div>
      </div>
    </div>
  )
}
