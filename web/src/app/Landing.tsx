/**
 * air — landing page.
 *
 * What air is, the three-way standoff, and four doors in. Aclima sits in the
 * middle of the diagram because that is the entire product thesis: three sides
 * want different things from the same air, and somebody has to hold the
 * measurements everyone argues from.
 */

import { Button, Icon, Kbd } from '@/app/ui'
import s from '@/app/Landing.module.css'
import { SimulatedBadge } from '@/app/SimulatedBadge'
import { useRoleSwitch } from '@/app/useRoleSwitch'
import { ROLES, ROLE_ORDER, type RoleMeta } from '@/core/roles'
import { useSession } from '@/core/session'
import { useCampaignInfo } from '@/core/queries'
import { fmtNum } from '@/core/format'
import type { Role } from '@/core/types'

// Diagram geometry — one place, so the SVG stays readable.
const HUB = { x: 260, y: 252 }
interface Node {
  role: Role
  x: number
  y: number
  sub: string
  anchor: 'middle' | 'start' | 'end'
  /** Text offsets, kept clear of the spokes and the standoff edges. */
  labelDy: number
  subDy: number
}

const NODES: Node[] = [
  { role: 'community', x: 260, y: 62, sub: 'reports what it smells like', anchor: 'middle', labelDy: -52, subDy: -36 },
  { role: 'regulator', x: 64, y: 398, sub: 'owns the legal line', anchor: 'start', labelDy: 44, subDy: 60 },
  { role: 'industry', x: 456, y: 398, sub: 'wants to keep building', anchor: 'end', labelDy: 44, subDy: 60 },
]

/** Spoke from the node's rim to the hub's rim, so it never runs under a label. */
function spoke(n: Node): string {
  const dx = HUB.x - n.x
  const dy = HUB.y - n.y
  const len = Math.hypot(dx, dy)
  const ux = dx / len
  const uy = dy / len
  return `M${n.x + ux * 24} ${n.y + uy * 24} L${HUB.x - ux * 46} ${HUB.y - uy * 46}`
}

function Standoff() {
  return (
    <svg viewBox="0 0 520 470" className={s.diagram} role="img" aria-label="The three-way standoff, with Aclima in the middle">
      {/* the standoff: each side against the other two */}
      <g>
        <path className={s.edge} d="M260 62 L64 400" />
        <path className={s.edge} d="M64 400 L456 400" />
        <path className={s.edge} d="M456 400 L260 62" />
      </g>

      {/* spokes into the hub, plus a packet of data flowing inward */}
      {NODES.map((n) => (
        <g key={`spoke-${n.role}`} style={{ color: `var(--actor-${n.role})` }}>
          <path className={s.spoke} stroke="currentColor" d={spoke(n)} />
          <path
            className={s.flow}
            stroke="currentColor"
            d={spoke(n)}
            style={{ animationDelay: `${NODES.indexOf(n) * 900}ms` }}
          />
        </g>
      ))}

      {/* Aclima: the arbitrator */}
      <g>
        <circle className={s.pulseCircle} cx={HUB.x} cy={HUB.y} r={46} />
        <circle className={s.hubRing} cx={HUB.x} cy={HUB.y} r={64} />
        <circle className={s.hubRing} cx={HUB.x} cy={HUB.y} r={84} strokeDasharray="2 7" />
        <g className={s.hubSweep}>
          <path
            d={`M${HUB.x} ${HUB.y} L${HUB.x + 63} ${HUB.y} A63 63 0 0 0 ${HUB.x + 54} ${HUB.y - 32} Z`}
            fill="var(--accent)"
            opacity="0.14"
          />
          <path
            d={`M${HUB.x} ${HUB.y} L${HUB.x + 63} ${HUB.y}`}
            stroke="var(--accent)"
            strokeWidth="1"
            opacity="0.45"
          />
        </g>
        <circle className={s.hubCore} cx={HUB.x} cy={HUB.y} r={44} />
        <text className={s.hubLabel} x={HUB.x} y={HUB.y - 2} textAnchor="middle">
          Aclima
        </text>
        <text className={s.hubSub} x={HUB.x} y={HUB.y + 14} textAnchor="middle">
          arbitrator
        </text>
      </g>

      {/* the three sides */}
      {NODES.map((n) => {
        const meta = ROLES[n.role]
        return (
          <g key={n.role} style={{ color: `var(--actor-${n.role})` }}>
            <circle className={s.nodeGlow} cx={n.x} cy={n.y} r={34} />
            <circle className={s.nodeRing} cx={n.x} cy={n.y} r={22} />
            <text className={s.nodeLabel} x={n.x} y={n.y + n.labelDy} textAnchor={n.anchor}>
              {meta.label}
            </text>
            <text className={s.nodeSub} x={n.x} y={n.y + n.subDy} textAnchor={n.anchor}>
              {n.sub}
            </text>
            <g transform={`translate(${n.x - 9} ${n.y - 9})`}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <use href={`#air-node-${n.role}`} />
              </svg>
            </g>
          </g>
        )
      })}
    </svg>
  )
}

function Door({ meta, onEnter }: { meta: RoleMeta; onEnter: (role: Role) => void }) {
  return (
    <button
      type="button"
      data-role={meta.role}
      className={s.door}
      style={{ ['--role-accent' as string]: meta.accentVar }}
      onClick={() => onEnter(meta.role)}
    >
      <span className={s.doorHead}>
        <span className={s.doorIcon}>
          <Icon name={meta.icon} size={18} />
        </span>
        <span>
          <span className={s.doorTitle}>{meta.label}</span>
          <span className={s.doorOrg}>{meta.org}</span>
        </span>
      </span>
      <span className={s.doorTagline}>{meta.tagline}</span>
      <span className={s.doorFoot}>
        <span className={s.doorNarrative}>{meta.narrative}</span>
        <span className={s.enter}>
          Enter <Icon name="chevron" size={12} />
        </span>
      </span>
    </button>
  )
}

export function Landing() {
  const switchTo = useRoleSwitch()
  const toggleSwitcher = useSession((st) => st.toggleSwitcher)
  const campaign = useCampaignInfo()

  const region = campaign?.region ?? 'Boxtown · Westwood · Riverport'
  const days =
    campaign?.start_date && campaign?.end_date
      ? Math.max(
          1,
          Math.round(
            (new Date(campaign.end_date).getTime() - new Date(campaign.start_date).getTime()) /
              86_400_000,
          ),
        )
      : 90

  return (
    <div className={s.page}>
      {/* icon geometry reused by the diagram nodes */}
      <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
        <defs>
          <path
            id="air-node-community"
            d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7 M17 4.7a3.5 3.5 0 0 1 0 6.6 M18 14.3c2.4.8 4 3 4 5.7"
          />
          <path id="air-node-regulator" d="M12 8v13 M8.5 21h7 M8 6.5a5.5 5.5 0 0 1 8 0 M5.5 3.8a9.5 9.5 0 0 1 13 0" />
          <path
            id="air-node-industry"
            d="M3 21h18 M4 21V10l5 3V10l5 3V8l6 4v9 M8.5 21v-4H11v4"
          />
        </defs>
      </svg>

      <header className={s.top}>
        <span className={s.wordmark}>
          <span className={s.mark}>air</span>
          <span className={s.markDot} />
        </span>
        <span className={s.byline}>Aclima · hyperlocal air measurement</span>
        <SimulatedBadge />
      </header>

      <section className={s.hero}>
        <div className={s.copy}>
          <span className={s.eyebrow}>
            <span className={s.eyebrowRule} />
            {campaign?.name ?? 'Southwest Memphis Community Air Monitoring'}
          </span>

          <h1 className={s.h1}>
            Three sides want different things from the same air. <em>air</em> holds the
            measurements they argue from.
          </h1>

          <p className={s.lede}>
            A fleet drives every street, over and over, and every 200-metre road segment gets a
            number. One dataset, rendered four ways: a feed for residents, a watchfloor for the
            agency, a radar scope for the operator, and a drafting table for us.
          </p>

          <div className={s.metaRow}>
            <span className={s.metaChip}>
              <Icon name="pin" size={12} /> {region}
            </span>
            <span className={s.metaChip}>
              <b>{fmtNum(days, 0)}</b> days of history
            </span>
            <span className={s.metaChip}>
              <b>{fmtNum(campaign?.fleet_size ?? 5, 0)}</b> vehicles
            </span>
            <span className={s.metaChip}>
              <b>{fmtNum(campaign?.target_passes ?? 25, 0)}</b> passes / segment
            </span>
            <span className={s.metaChip}>
              <b>7</b> modalities
            </span>
          </div>

          <div className={s.ctaRow}>
            <Button variant="primary" size="lg" icon="aclima" onClick={toggleSwitcher}>
              Choose an interface
            </Button>
            <span className={s.hint}>
              or press <Kbd>⌥</Kbd>
              <Kbd>1</Kbd>–<Kbd>4</Kbd> anywhere
            </span>
          </div>
        </div>

        <div className={s.diagramWrap}>
          <Standoff />
        </div>
      </section>

      <nav className={s.doors} aria-label="Choose an interface">
        {ROLE_ORDER.map((r) => (
          <Door key={r} meta={ROLES[r]} onEnter={switchTo} />
        ))}
      </nav>
    </div>
  )
}
