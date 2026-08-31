/**
 * /industry/site — the campus: emission points, the fenceline ring, headroom.
 *
 * Deliberately the thinnest screen in this interface. It exists so the operator
 * can see what the scope is reasoning about, not so they can do analysis.
 */

import { fmtDistance, fmtNum, fmtPct } from '@/core/format'
import { useMonitors, useModelVerification } from '@/core/queries'
import { haversine } from '@/components'

import { Caps, Panel, Readout, Tag, envelopeOf, styles as s, useSiteLock } from './lib'

const KIND_GLYPH: Record<string, string> = {
  generator: '▮', backup: '▯', cooling_tower: '◍', substation: '⊞',
  traffic_gate: '⇥', stack: '▲',
}

export function SiteConfig() {
  const site = useSiteLock()
  const monitorsQ = useMonitors({ site_id: site?.id }, { enabled: !!site })
  const verifyQ = useModelVerification(site?.id)

  if (!site) {
    return <div className={`${s.page} ${s.sitePage}`}><div className={s.err}>No site.</div></div>
  }

  const env = envelopeOf(site)
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
            label="Headroom"
            value={env ? fmtPct(env.freePct, 0, false) : '—'}
            tone={env?.tight ? 'threat' : 'accent'}
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
          <Panel title="Safe operating envelope">
            <div className={s.envelope}>
              <div className={s.envRow}>
                <span className={`${s.envNum} num${env?.tight ? ` ${s.envNumTight}` : ''}`}>
                  {env ? fmtPct(env.freePct, 0, false) : '—'}
                </span>
                <Caps ink>left</Caps>
                <span className={s.spacer} />
                <span className="num" style={{ color: 'var(--ink-2)', fontSize: 'var(--text-xs)' }}>
                  {env ? `${fmtPct(env.usedPct, 0, false)} used` : ''}
                </span>
              </div>
              <div className={s.envBar}>
                <div className={s.envUsed} style={{ width: `${env?.usedPct ?? 0}%` }} />
                <div className={s.envTicks} />
                <div className={s.envEdge} style={{ left: `${env?.usedPct ?? 0}%` }} />
              </div>
              <span className={s.bannerSub}>
                {env?.freeMw != null
                  ? `≈ ${fmtNum(env.freeMw, 0)} MW of additional load still inside the envelope. The envelope is what the community and the regulator will tolerate, measured — not a permit line.`
                  : 'Envelope not characterised.'}
              </span>
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
