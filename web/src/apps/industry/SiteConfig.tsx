/**
 * /industry/site — the campus: emission points, the fenceline ring, headroom.
 *
 * Deliberately the thinnest screen in this interface. It exists so the operator
 * can see what the scope is reasoning about, not so they can do analysis.
 */

import { fmtDistance, fmtNum } from '@/core/format'
import { useEnvelope, useMonitors, useModelVerification } from '@/core/queries'
import { haversine } from '@/components'

import {
  Caps, Panel, Readout, Tag, envelopeRead, styles as s, useCampaignWindow, useSiteLock,
} from './lib'

const KIND_GLYPH: Record<string, string> = {
  generator: '▮', backup: '▯', cooling_tower: '◍', substation: '⊞',
  traffic_gate: '⇥', stack: '▲',
}

export function SiteConfig() {
  const site = useSiteLock()
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
            value={env ? env.headline : '—'}
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
            title="Safe operating envelope"
            aside={env ? <Caps>{env.episodes} episodes</Caps> : null}
          >
            <div className={s.envelope}>
              <div className={s.envRow}>
                <span className={`${s.envNum} num${env?.binding ? ` ${s.envNumTight}` : ''}`}>
                  {env ? env.headline : '—'}
                </span>
                <Caps ink>in stable air</Caps>
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

          <Panel title="Fenceline ring" aside={<Caps>{(monitorsQ.data ?? []).length} sensors</Caps>}>
            {(monitorsQ.data ?? []).map((m) => {
              const d = haversine([m.lon, m.lat], site.centroid)
              const exceeds = Object.values(m.latest ?? {}).some((l) => l?.exceeds)
              return (
                <div key={m.id} className={s.ep}>
                  <span className={exceeds ? s.epOff : s.epOn} style={exceeds ? { color: 'var(--threat)' } : undefined}>
                    {exceeds ? '▲' : '◇'}
                  </span>
                  <span className={s.epName}>{m.name}</span>
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
                  <Tag tone={verifyQ.data.verdict === 'understates' ? 'threat' : undefined}>
                    {verifyQ.data.verdict.replace('_', ' ')}
                  </Tag>
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
