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

import { useEffect, useMemo, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'

import s from '@/app/AppShell.module.css'
import { Avatar, Icon, Kbd, Tooltip } from '@/app/ui'
import { SimulatedBadge } from '@/app/SimulatedBadge'
import { RoleSwitcher, RoleWipe } from '@/app/RoleSwitcher'
import { ToastHost } from '@/app/Toasts'
import { useShellHotkeys } from '@/app/useRoleSwitch'
import { useClockBounds, useTimePlayback } from '@/app/useTimePlayback'
import { ROLES, activeNav, type NavItem, type RoleMeta } from '@/core/roles'
import { useNowCampaign, useSession } from '@/core/session'
import { isOngoing } from '@/core/events'
import { startLive, useLiveStatus } from '@/core/live'
import {
  useActiveSite,
  useAlerts,
  useBootstrap,
  useCampaignStats,
  useMonitors,
} from '@/core/queries'
import { fmtNum, fmtPct } from '@/core/format'
import type { Alert, Role } from '@/core/types'

const FALLBACK_CAMPAIGN = 'Southwest Memphis Community Air Monitoring'

// ────────────────────────────────────────────────────────────── the stream

/**
 * Says so only when the activity stream is down. It replaced a permanent LIVE
 * chip: "live" was the wall clock, which the demo no longer follows (at the
 * end of the data it is paused, D1), and its unseen counter only ever grew
 * because nothing marked events seen. The SIMULATED DATA chip is the clock
 * now; the stream earns header room only when it is not doing its job.
 * `idle` (before the deferred connect, or `?live=0`) and the first
 * `connecting` attempt are not failures and show nothing.
 */
function StreamNotice() {
  const status = useLiveStatus()
  if (status !== 'retrying' && status !== 'offline') return null
  return (
    <Tooltip
      below
      title="Not receiving events"
      content="The event stream is not connected. Screens still load; they just will not update by themselves when someone acts in another interface."
    >
      <span className={s.noStream}>No stream</span>
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
      // Below 1280 the chip is the avatar alone, so the name travels here.
      title={`${user?.name ?? 'Pick a persona'} — switch persona (⌘K)`}
      aria-label={`${user?.name ?? 'Pick a persona'}, switch persona`}
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

/**
 * The alerts live at the moment on screen, for the header strip and the rail
 * badge: one query and one test, so the two cannot disagree with each other or
 * with the page. Live is `isOngoing` — begun and not yet ended at the demo's
 * now — whatever the status says. Counting `status: 'active'` put ended alerts
 * in the header during replay: at Aug 25 13:54 the header said "Active alerts
 * 2" over a page saying "0 LIVE", and at the end 13 over the page's 6. The
 * industry deck is one site's, so its count is that site's too (the rail said
 * 9 over a Contacts list of 2). It is the site the industry pages lock
 * (`siteId`, written by `useSiteLock`), the same key the timeline's ticks use —
 * not `useActiveSite`'s fallback, which lands on another company's site until
 * the lock is written.
 */
function useLiveAlerts(): Alert[] | undefined {
  const role = useSession((st) => st.role)
  const siteId = useSession((st) => st.siteId)
  const now = useNowCampaign()
  const industry = role === 'industry'
  const alerts = useAlerts(
    industry ? { site_id: siteId ?? undefined } : {},
    { enabled: !industry || siteId != null },
  )
  return useMemo(() => alerts.data?.filter((a) => isOngoing(a, now)), [alerts.data, now])
}

function RegulatorStrip() {
  const monitors = useMonitors({ owner_type: 'regulator' })
  const live = useLiveAlerts()
  const online = monitors.data?.filter((m) => m.status === 'online').length
  const total = monitors.data?.length
  const active = live?.length
  const critical = live?.filter((a) => a.severity === 'critical').length ?? 0
  return (
    <div className={s.strip}>
      <StripItem
        label="Monitors"
        value={total ? `${online ?? 0}/${total}` : DASH}
        tone={total && online === total ? 'ok' : total ? 'warn' : undefined}
      />
      <StripItem
        label="Live alerts"
        value={active != null ? fmtNum(active, 0) : DASH}
        tone={critical > 0 ? 'threat' : active ? 'warn' : undefined}
      />
      <StripItem label="Critical" value={live ? fmtNum(critical, 0) : DASH} tone={critical ? 'threat' : undefined} />
    </div>
  )
}

function IndustryStrip() {
  const site = useActiveSite()
  const live = useLiveAlerts()
  const contacts = live?.length
  const critical = live?.some((a) => a.severity === 'critical')
  const caution = live?.some((a) => a.severity === 'warning')
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
  const alertCount = useLiveAlerts()?.length ?? 0

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
  const pill = (item: RoleMeta['nav'][number]) => (
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
  )
  // The call to action lives OUTSIDE the scrolling pill track. Inside it, the
  // track's overflow-x clipped "Report a concern" to a third of its width at
  // 1080 — the one button this whole interface exists to put in reach.
  return (
    <nav className={s.pillsWrap} aria-label="Community sections">
      <div className={s.pills}>
        {meta.nav.filter((i) => !i.cta).map(pill)}
      </div>
      {meta.nav.filter((i) => i.cta).map(pill)}
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
  useClockBounds()
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
        <StreamNotice />
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
