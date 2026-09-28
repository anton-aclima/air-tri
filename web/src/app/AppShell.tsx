/**
 * air — the application shell.
 *
 * Sets `data-role` on the wrapper (and mirrors it onto `<html>` so
 * `core/measures.ts` can resolve the per-role ramp aliases), then renders
 * chrome that is *materially different* per role — not the same bar recoloured:
 *
 *   community  · header + pill nav + one obvious CTA, page scrolls
 *   regulator  · code rail + a header with nothing but the clock and persona
 *   industry   · thin phosphor frame, corner brackets, a rail of short words
 *   admin      · drafting rail + numeric status bar along the bottom
 *
 * Status lives on the page, once (docs/PLAN-refocus.md F3). The only number
 * the shell prints for regulator and industry is the rail's alert badge, and
 * that is `useLiveAlerts(role).count` — the hook the pages count with.
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
import { useClockBounds, useTimePlayback } from '@/app/useTimePlayback'
import { ROLES, activeNav, type NavItem, type RoleMeta } from '@/core/roles'
import { timeParam, useSession } from '@/core/session'
import { useLiveAlerts } from '@/core/alerts'
import { startLive, useLiveStatus } from '@/core/live'
import { severityVar } from '@/core/measures'
import { useActiveSite, useBootstrap, useCampaignStats } from '@/core/queries'
import { fmtNum, fmtPct } from '@/core/format'
import type { Role } from '@/core/types'

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

// ──────────────────────────────────────────────────────────── status strip
//
// Admin's only. The regulator and industry strips are gone (docs/PLAN-refocus.md
// F3): the page carries the status, once. Each strip was a second verdict with
// its own filter, and they disagreed with the pages under them — in the review
// industry read "ALERTS 4 · HEADROOM 21% · STATUS ADVISORY" over a deck saying CAUTION, 3
// alerts and "22% cut needed" (21% was the retired `headroom_pct`, and it meant
// the opposite of 22%); the regulator read "ACTIVE ALERTS 13" over a page's 15.
// Admin's strip is campaign bookkeeping — segments, passes, vehicles — which no
// page repeats, so it stays.

function StripItem({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' }) {
  return (
    <span className={s.stripItem}>
      <span className={s.stripLabel}>{label}</span>
      <span className={clsx(s.stripValue, tone === 'ok' && s.stripValueOk)}>{value}</span>
    </span>
  )
}

const DASH = '—'

/**
 * Which site the industry pages are showing. A name, not a status: every
 * industry screen is one site's, and most of them never say whose. It is the
 * name alone — the numbers that used to sit beside it are the page's.
 */
function IndustrySiteName() {
  const site = useActiveSite()
  return <span className={s.campaignName}>{site?.name ?? ROLES.industry.org}</span>
}

/**
 * The admin header and status bar are the moment shown, like every other
 * number in the shell: they send `at` (absent when paused at the end, so the
 * end of the data is the stored KPIs). The timeline's `by_day` and the admin
 * pages that print "the whole campaign" call `useCampaignStats()` without it.
 */
function useMomentCampaignStats() {
  const time = useSession((st) => st.time)
  return useCampaignStats({ at: timeParam(time) })
}

function AdminStrip() {
  const stats = useMomentCampaignStats()
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
  const stats = useMomentCampaignStats()
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

/**
 * The badge is `useLiveAlerts(role).count` — the same number the page and the
 * alert pages print, from the same hook (F3). It had its own query, active
 * only and network-wide, so on industry it said 9 beside a site list of 3.
 * Its colour is the worst live level, not a fixed red: two Watch alerts in the
 * critical colour was a louder claim than any page made.
 */
function NavRail({ meta, pathname }: { meta: RoleMeta; pathname: string }) {
  const active = activeNav(meta.role, pathname)
  // Only a rail with a badge asks: admin's has none, and a null role leaves
  // the hook disabled rather than fetching a list nobody prints.
  const live = useLiveAlerts(meta.nav.some((i) => i.badge === 'alerts') ? meta.role : null)

  const badgeFor = (item: NavItem): number | null =>
    item.badge === 'alerts' && live.count > 0 ? live.count : null

  return (
    <nav className={s.rail} aria-label={`${meta.label} sections`}>
      {meta.nav.map((item) => {
        const badge = badgeFor(item)
        const title = badge
          ? `${item.label} — ${item.hint} · ${badge} live now`
          : `${item.label} — ${item.hint}`
        return (
          <Link
            key={item.to}
            to={item.to}
            title={title}
            aria-label={badge ? `${item.label}, ${badge} live now` : item.label}
            className={clsx(
              s.railItem,
              active?.to === item.to && s.railItemActive,
              item.cta && s.railCta,
              item.end && s.railEnd,
            )}
          >
            <Icon name={item.icon} size={18} />
            {item.short ? (
              <span className={s.railWord}>{item.short}</span>
            ) : (
              <span className={s.railCode}>{item.code}</span>
            )}
            {badge ? (
              <span className={s.railBadge} style={{ ['--badge' as string]: severityVar(live.worst) }}>
                {badge}
              </span>
            ) : null}
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
      {/* `data-shell-head`: a non-modal Sheet (app/ui) starts below it. */}
      <header className={s.head} data-shell-head>
        <BrandMark meta={meta} />

        {meta.role === 'community' ? (
          <>
            <NavPills meta={meta} pathname={pathname} />
            <span className={s.spacer} />
          </>
        ) : (
          <>
            {/* Regulator: nothing between the brand and the clock. Its strip
                was a second status beside the page's (F3), and the campaign
                name (F4) is on the Landing and in the timeline popup's
                footer — at 1080 it was the header width the strip lost. */}
            {meta.role === 'regulator' ? <span className={s.spacer} /> : null}
            {meta.role === 'industry' ? (
              <>
                <IndustrySiteName />
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
