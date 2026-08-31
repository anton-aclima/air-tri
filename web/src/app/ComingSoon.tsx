/**
 * air — temporary route placeholder.
 *
 * The four `apps/<role>/routes.tsx` modules render this so the application
 * runs today. Each app agent replaces their module entirely — nothing here is
 * meant to survive.
 *
 * It doubles as a skin proof: primitives, both measurement ramps and the
 * global time cursor, rendered in whichever role skin is active.
 */

import s from '@/app/ComingSoon.module.css'
import { Badge, Button, Card, Chip, Panel, SeverityDot, Stat, StatRow } from '@/app/ui'
import { TimeCursor } from '@/app/TimeCursor'
import { ROLES } from '@/core/roles'
import type { Role } from '@/core/types'
import { rampGradient, RISK_BANDS } from '@/core/measures'

export interface ComingSoonProps {
  role: Role
  /** Screen name, e.g. "Map". */
  title: string
  /** Route path, shown so the app agent knows exactly what they are replacing. */
  route: string
  /** What the owning agent is going to build here. */
  bullets?: string[]
}

export function ComingSoon({ role, title, route, bullets = [] }: ComingSoonProps) {
  const meta = ROLES[role]
  return (
    <div className={s.wrap} style={{ ['--role-accent' as string]: meta.accentVar }}>
      <header className={s.head}>
        <div className={s.headText}>
          <span className={s.eyebrow}>
            {meta.label} · {meta.narrative}
          </span>
          <h1 className={s.title}>{title}</h1>
          <p className={s.sub}>{meta.blurb}</p>
          <code className={s.route}>{route}</code>
        </div>
      </header>

      <TimeCursor />

      <div className={s.grid}>
        <Panel title="Planned for this screen" pad>
          <div className={s.list}>
            {(bullets.length ? bullets : meta.wants).map((b) => (
              <span key={b} className={s.listItem}>
                <span className={s.bullet} />
                {b}
              </span>
            ))}
          </div>
        </Panel>

        <Panel title="Measurement ramps" pad>
          <div className={s.rampRow}>
            <span className={s.rampLabel}>Public health · risk</span>
            <div className={s.ramp} style={{ background: rampGradient('aqi') }} />
            <span className={s.rampLabel}>Analytical magnitude · this role</span>
            <div className={s.ramp} style={{ background: rampGradient('map') }} />
            <div className={s.sampler}>
              {RISK_BANDS.map((b, i) => (
                <Chip key={b.label} small dotColor={`var(--ramp-aqi-${i})`}>
                  {b.label}
                </Chip>
              ))}
            </div>
          </div>
        </Panel>

        <Panel title="Shell check" pad>
          <StatRow>
            <Stat label="Segments" value="—" />
            <Stat label="Passes" value="—" />
            <Stat label="Alerts" value="—" />
          </StatRow>
          <div className={s.sampler} style={{ marginTop: 'var(--s-4)' }}>
            <Badge tone="critical">critical</Badge>
            <Badge tone="warning">warning</Badge>
            <Badge tone="watch">watch</Badge>
            <Badge tone="ok">clear</Badge>
            <SeverityDot severity="critical" pulse />
            <SeverityDot severity="warning" />
            <SeverityDot severity="info" />
          </div>
          <div className={s.sampler} style={{ marginTop: 'var(--s-4)' }}>
            <Button variant="primary" size="sm">
              Primary
            </Button>
            <Button variant="secondary" size="sm">
              Secondary
            </Button>
            <Button variant="ghost" size="sm">
              Ghost
            </Button>
          </div>
        </Panel>
      </div>

      <Card title={`${meta.label} interface`}>
        This route is a placeholder from the shell agent. The {role} agent owns{' '}
        <code>src/apps/{role}/</code> and will replace it. The shell, routing, theming, primitives,
        API client, query hooks and the live event stream underneath are real.
      </Card>
    </div>
  )
}
