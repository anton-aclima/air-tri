/**
 * air — the application shell.
 *
 * Sets `data-role` on the wrapper (and mirrors it onto `<html>` so
 * `core/measures.ts` can resolve the per-role ramp aliases), then renders
 * chrome that is *materially different* per role — not the same bar recoloured:
 *
 *   community  · header + pill nav + one obvious CTA, page scrolls
 *   regulator  · watchfloor rail + dense network status strip
 *   industry   · thin phosphor frame, corner brackets, terse readout
 *   admin      · drafting rail + numeric status bar along the bottom
 */

import { useEffect, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'

import s from '@/app/AppShell.module.css'
import { Avatar, Icon, Kbd, Tooltip } from '@/app/ui'
import { SimulatedBadge } from '@/app/SimulatedBadge'
import { RoleSwitcher, RoleWipe } from '@/app/RoleSwitcher'
import { ToastHost } from '@/app/Toasts'
import { useShellHotkeys } from '@/app/useRoleSwitch'
import { useTimePlayback } from '@/app/useTimePlayback'
import { ROLES, activeNav, type NavItem, type RoleMeta } from '@/core/roles'
import { useSession } from '@/core/session'
import { startLive, useLive, useLiveStatus } from '@/core/live'
import {
  useActiveSite,
  useAlerts,
  useBootstrap,
  useCampaignStats,
  useMonitors,
} from '@/core/queries'
import { fmtNum, fmtPct } from '@/core/format'
import type { Role } from '@/core/types'

const FALLBACK_CAMPAIGN = 'Southwest Memphis Community Air Monitoring'

// ───────────────────────────────────────────────────────────────── live dot

function LivePulse() {
  const status = useLiveStatus()
  const pulse = useLive((st) => st.pulse)
  const pulseRole = useLive((st) => st.pulseRole)
  const unseen = useLive((st) => st.unseen)
  const on = status === 'open'

  return (
    <Tooltip
      below
      title={on ? 'Live' : 'Not receiving events'}
      content={
        on
          ? 'Connected to the activity stream. Anything anyone does in any interface arrives here immediately.'
          : 'The event stream is not connected. Screens will still load, they just will not update by themselves.'
      }
    >
      <span className={clsx(s.live, on ? s.liveOn : s.liveOff)}>
        <span className={s.liveDot}>
          {pulse > 0 ? (
            <span
              key={pulse}
              className={s.pulseRing}
              style={{
                ['--pulse-color' as string]: pulseRole
                  ? `var(--actor-${pulseRole})`
                  : 'var(--accent)',
              }}
            />
          ) : null}
        </span>
        {on ? 'Live' : status === 'offline' ? 'No stream' : 'Linking'}
        {unseen > 0 ? <span className={s.unseen}>{unseen}</span> : null}
      </span>
    </Tooltip>
  )
}

// ──────────────────────────────────────────────────────────────── brand

function BrandMark({ meta }: { meta: RoleMeta }) {
  const toggleSwitcher = useSession((st) => st.toggleSwitcher)
  return (
    <button type="button" className={s.brand} onClick={toggleSwitcher} title="Switch interface (⌘K)">
      <span className={s.mark}>air</span>
      <span className={s.markDot} />
      <span className={s.roleTag}>{meta.label}</span>
    </button>
  )
}

// ─────────────────────────────────────────────────────────────── persona

function PersonaChip({ meta }: { meta: RoleMeta }) {
  const user = useSession((st) => st.user)
  const toggleSwitcher = useSession((st) => st.toggleSwitcher)
  return (
    <button
      type="button"
      className={s.persona}
      onClick={toggleSwitcher}
      title="Switch persona (⌘K)"
    >
      <Avatar user={user} name={user?.name ?? meta.label} size="sm" />
      <span className={s.personaText}>
        <span className={s.personaName}>{user?.name ?? 'Pick a persona'}</span>
        <span className={s.personaOrg}>{user?.title ?? meta.org}</span>
      </span>
      <span className={s.personaKbd}>
        <Kbd>⌘K</Kbd>
      </span>
    </button>
  )
}

// ────────────────────────────────────────────────────────── status strips

function StripItem({
  label,
  value,
  tone,
}: {
  label: string
  value: ReactNode
  tone?: 'warn' | 'ok' | 'threat'
}) {
  return (
    <span className={s.stripItem}>
      <span className={s.stripLabel}>{label}</span>
      <span
        className={clsx(
          s.stripValue,
          tone === 'warn' && s.stripValueWarn,
          tone === 'ok' && s.stripValueOk,
          tone === 'threat' && s.stripValueThreat,
        )}
      >
        {value}
      </span>
    </span>
  )
}

const DASH = '—'

function RegulatorStrip() {
  const monitors = useMonitors({ owner_type: 'regulator' })
  const alerts = useAlerts({ status: 'active' })
  const online = monitors.data?.filter((m) => m.status === 'online').length
  const total = monitors.data?.length
  const active = alerts.data?.length
  const critical = alerts.data?.filter((a) => a.severity === 'critical').length ?? 0
  return (
    <div className={s.strip}>
      <StripItem
        label="Towers"
        value={total ? `${online ?? 0}/${total}` : DASH}
        tone={total && online === total ? 'ok' : total ? 'warn' : undefined}
      />
      <StripItem
        label="Active alerts"
        value={active != null ? fmtNum(active, 0) : DASH}
        tone={critical > 0 ? 'threat' : active ? 'warn' : undefined}
      />
      <StripItem label="Critical" value={alerts.data ? fmtNum(critical, 0) : DASH} tone={critical ? 'threat' : undefined} />
    </div>
  )
}

function IndustryStrip() {
  const site = useActiveSite()
  const alerts = useAlerts({ status: 'active', site_id: site?.id })
  const contacts = alerts.data?.length
  const critical = alerts.data?.some((a) => a.severity === 'critical')
  const caution = alerts.data?.some((a) => a.severity === 'warning')
  const threat = critical || caution
  return (
    <div className={s.strip}>
      <span className={s.campaignName}>{site?.name ?? ROLES.industry.org}</span>
      <StripItem
        label="Alerts"
        value={contacts != null ? fmtNum(contacts, 0) : DASH}
        tone={threat ? 'threat' : contacts ? 'warn' : 'ok'}
      />
      <StripItem
        label="Headroom"
        /* `headroom_pct` is the share of the safe envelope *used*, not left. */
        value={site?.headroom_pct != null ? fmtPct(100 - site.headroom_pct, 0, false) : DASH}
        tone={site?.headroom_pct != null && 100 - site.headroom_pct < 25 ? 'threat' : undefined}
      />
      {/* Civil annunciator levels, matching the page below: act now / act soon /
          be aware. "THREAT" was the radar metaphor leaking into the chrome. */}
      <StripItem
        label="Status"
        value={critical ? 'WARNING' : caution ? 'CAUTION' : contacts ? 'ADVISORY' : 'NORMAL'}
        tone={threat ? 'threat' : 'ok'}
      />
    </div>
  )
}

function AdminStrip() {
  const stats = useCampaignStats()
  return (
    <div className={s.strip}>
      <StripItem label="Segments" value={stats.data ? fmtNum(stats.data.segments, 0) : DASH} />
      <StripItem label="Mean passes" value={stats.data ? fmtNum(stats.data.mean_passes, 1) : DASH} />
      <StripItem
        label="Vehicles"
        value={stats.data ? fmtNum(stats.data.vehicles_active, 0) : DASH}
        tone={stats.data?.vehicles_active ? 'ok' : undefined}
      />
    </div>
  )
}

function AdminStatusBar() {
  const stats = useCampaignStats()
  const status = useLiveStatus()
  const d = stats.data
  return (
    <footer className={s.foot}>
      <span className={s.footItem}>
        <span className={s.footKey}>coverage</span>
        <span className={s.footValue}>
          {d ? fmtPct(d.segments_at_target / Math.max(1, d.segments)) : DASH}
        </span>
      </span>
      <span className={s.footItem}>
        <span className={s.footKey}>passes</span>
        <span className={s.footValue}>{d ? fmtNum(d.passes_total, 0) : DASH}</span>
      </span>
      <span className={s.footItem}>
        <span className={s.footKey}>km driven</span>
        <span className={s.footValue}>{d ? fmtNum(d.km_driven, 0) : DASH}</span>
      </span>
      <span className={s.footItem}>
        <span className={s.footKey}>concerns</span>
        <span className={s.footValue}>
          {d ? `${fmtNum(d.concerns_open, 0)}/${fmtNum(d.concerns_total, 0)}` : DASH}
        </span>
      </span>
      <span className={s.footItem}>
        <span className={s.footKey}>freshness</span>
        <span className={s.footValue}>{d ? `${fmtNum(d.data_freshness_min, 0)} min` : DASH}</span>
      </span>
      <span className={s.footItem} style={{ marginLeft: 'auto' }}>
        <span className={s.footKey}>stream</span>
        <span className={s.footValue}>{status}</span>
      </span>
    </footer>
  )
}

// ───────────────────────────────────────────────────────────────────── nav

function NavRail({ meta, pathname }: { meta: RoleMeta; pathname: string }) {
  const active = activeNav(meta.role, pathname)
  const alerts = useAlerts({ status: 'active' })
  const alertCount = alerts.data?.length ?? 0

  const badgeFor = (item: NavItem): number | null => {
    if (!alertCount) return null
    return item.icon === 'alert' || item.icon === 'contacts' ? alertCount : null
  }

  return (
    <nav className={s.rail} aria-label={`${meta.label} sections`}>
      {meta.nav.map((item) => {
        const badge = badgeFor(item)
        return (
          <Link
            key={item.to}
            to={item.to}
            title={`${item.label} — ${item.hint}`}
            className={clsx(
              s.railItem,
              active?.to === item.to && s.railItemActive,
              item.cta && s.railCta,
              item.end && s.railEnd,
            )}
          >
            <Icon name={item.icon} size={18} />
            <span className={s.railCode}>{item.code}</span>
            {badge ? <span className={s.railBadge}>{badge}</span> : null}
          </Link>
        )
      })}
    </nav>
  )
}

function NavPills({ meta, pathname }: { meta: RoleMeta; pathname: string }) {
  const active = activeNav(meta.role, pathname)
  return (
    <nav className={s.pills} aria-label="Community sections">
      {meta.nav.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={clsx(
            s.pill,
            active?.to === item.to && s.pillActive,
            item.cta && s.pillCta,
          )}
        >
          <Icon name={item.icon} size={16} />
          {item.label}
        </Link>
      ))}
    </nav>
  )
}

// ─────────────────────────────────────────────────────────────── the shell

export interface AppShellProps {
  role: Role | null
  children: ReactNode
}

export function AppShell({ role, children }: AppShellProps) {
  const pathname = useRouterState({ select: (st) => st.location.pathname })
  const qc = useQueryClient()
  const transitioningTo = useSession((st) => st.transitioningTo)
  const setRole = useSession((st) => st.setRole)
  const sessionRole = useSession((st) => st.role)
  const bootstrap = useBootstrap()
  const campaign = bootstrap.data?.campaign
  const offline = bootstrap.isError

  useShellHotkeys()
  useTimePlayback()

  // The URL is the source of truth for which skin is on screen.
  useEffect(() => {
    if (role !== sessionRole) setRole(role)
  }, [role, sessionRole, setRole])

  // Mirror the role onto <html> so token reads in core/measures resolve the
  // per-role ramp aliases, and so overscroll never flashes the wrong colour.
  useEffect(() => {
    document.documentElement.dataset.role = role ?? 'none'
  }, [role])

  // One SSE subscription for the whole app. Deferred a beat so an open stream
  // never delays first paint (and `?live=0` skips it entirely, which is how the
  // screenshot tooling gets a page that reaches network idle).
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('live') === '0') return
    let dispose: (() => void) | undefined
    const t = window.setTimeout(() => {
      dispose = startLive(qc, () => useSession.getState().role)
    }, 1200)
    return () => {
      window.clearTimeout(t)
      dispose?.()
    }
  }, [qc])

  const meta = role ? ROLES[role] : null

  if (!meta) {
    return (
      <div className={clsx(s.shell, s.bare)} data-role="none">
        <div className={s.main}>{children}</div>
        <ToastHost />
        <RoleSwitcher />
        {transitioningTo ? <RoleWipe role={transitioningTo} /> : null}
      </div>
    )
  }

  return (
    <div
      className={s.shell}
      data-role={meta.role}
      style={{ ['--role-accent' as string]: meta.accentVar }}
    >
      <header className={s.head}>
        <BrandMark meta={meta} />

        {meta.role === 'community' ? (
          <>
            <NavPills meta={meta} pathname={pathname} />
            <span className={s.spacer} />
          </>
        ) : (
          <>
            {meta.role === 'regulator' ? (
              <>
                <span className={s.campaignName}>{campaign?.name ?? FALLBACK_CAMPAIGN}</span>
                <span className={s.spacer} />
                <RegulatorStrip />
              </>
            ) : null}
            {meta.role === 'industry' ? (
              <>
                <IndustryStrip />
                <span className={s.spacer} />
              </>
            ) : null}
            {meta.role === 'admin' ? (
              <>
                <span className={s.campaignName}>{campaign?.name ?? FALLBACK_CAMPAIGN}</span>
                <span className={s.spacer} />
                <AdminStrip />
              </>
            ) : null}
          </>
        )}

        {offline ? (
          <Tooltip
            below
            title="Backend not reachable"
            content="air is running without its API. Layout and theming are live; numbers will appear once the server is up."
          >
            <span className={s.offline}>API offline</span>
          </Tooltip>
        ) : null}
        <SimulatedBadge control />
        <LivePulse />
        <PersonaChip meta={meta} />
      </header>

      {meta.role === 'community' ? null : <NavRail meta={meta} pathname={pathname} />}

      <main className={s.main} key={meta.role}>
        {children}
        {meta.role === 'industry' ? (
          <div className={s.brackets} aria-hidden>
            <span />
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </main>

      {meta.role === 'admin' ? <AdminStatusBar /> : null}

      <ToastHost />
      <RoleSwitcher />
      {transitioningTo ? <RoleWipe role={transitioningTo} /> : null}
    </div>
  )
}
