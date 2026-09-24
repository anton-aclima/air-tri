/**
 * air — role metadata.
 *
 * The four interfaces are four products on one dataset. This module is the
 * single description of what each one *is*: its label, its narrative, its
 * accent, its landing route, and its navigation. The shell reads it; the
 * landing page reads it; the role switcher reads it.
 */

import type { Role } from '@/core/types'

export type IconName =
  | 'feed' | 'map' | 'report' | 'dashboard' | 'tower' | 'alert' | 'threshold'
  | 'analysis' | 'scope' | 'contacts' | 'megaphone' | 'factory' | 'campaign'
  | 'route' | 'fleet' | 'database' | 'oversight' | 'director' | 'people'
  | 'shield' | 'wind' | 'clock' | 'close' | 'chevron' | 'search' | 'check'
  | 'plus' | 'pause' | 'play' | 'skip' | 'aclima' | 'grid' | 'radar' | 'pin'

export interface NavItem {
  to: string
  label: string
  /** Uppercase micro-label used by the dense skins. */
  code: string
  icon: IconName
  hint: string
  /** Renders as the one obvious call to action (community "Report"). */
  cta?: boolean
  /** Pull to the end of the rail (settings-ish). */
  end?: boolean
}

export interface RoleMeta {
  role: Role
  /** Product name inside the shell. */
  label: string
  /** The fictional organisation this persona belongs to (CONTRACT §2). */
  org: string
  /** One line, on the landing door. */
  tagline: string
  /**
   * The visual direction this interface is designed around (CONTRACT §6).
   * INTERNAL — never render it. It is a brief for whoever styles the room,
   * not copy: "tower defence" and "flight deck" printed on the Landing page
   * and in the persona picker read as the product taking its own metaphor
   * literally, which is the opposite of what a metaphor is for.
   */
  narrative: string
  /** Two or three sentences, on the landing door. */
  blurb: string
  /** What this audience actually wants. Landing page bullet list. */
  wants: string[]
  /** Semantic token for this actor's colour — never a hex. */
  accentVar: string
  icon: IconName
  /** Where the switcher lands you. */
  landing: string
  /** Chrome layout family — `AppShell` branches on this. */
  chrome: 'feed' | 'watchfloor' | 'scope' | 'drafting'
  /** Keyboard shortcut digit (with ⌥/Alt, or inside the switcher). */
  hotkey: '1' | '2' | '3' | '4'
  nav: NavItem[]
}

export const ROLE_ORDER: Role[] = ['community', 'regulator', 'industry', 'admin']

export const ROLES: Record<Role, RoleMeta> = {
  community: {
    role: 'community',
    label: 'Community',
    org: 'Boxtown Air Watch',
    tagline: 'What is the air doing on my street?',
    narrative: 'social feed',
    blurb:
      'Residents report what they smell, hear and see, corroborate each other, and watch what the agency and the operators actually say back. Plain words, no units, no acronyms.',
    wants: ['Report a concern', 'See what neighbours reported', 'See what the air did on my street'],
    accentVar: 'var(--actor-community)',
    icon: 'people',
    landing: '/community',
    chrome: 'feed',
    hotkey: '1',
    nav: [
      { to: '/community', label: 'Feed', code: 'FEED', icon: 'feed', hint: 'What is happening near you' },
      { to: '/community/map', label: 'Map', code: 'MAP', icon: 'map', hint: 'Your streets, block by block' },
      { to: '/community/dashboard', label: 'Dashboard', code: 'DASH', icon: 'dashboard', hint: 'How the neighbourhood is trending' },
      { to: '/community/report', label: 'Report a concern', code: 'RPT', icon: 'report', hint: 'Smell, noise, smoke, dust', cta: true },
    ],
  },

  regulator: {
    role: 'regulator',
    label: 'Regulator',
    org: 'Delta Regional Air Quality Authority',
    tagline: 'What my monitors report, and what the streets around them add.',
    narrative: 'tower defence',
    blurb:
      'What your reference monitors report, what the fleet measures on every street between them, where each site\'s plume is modelled to go, and what residents are reporting — with one button to warn the public.',
    wants: ['Watch the action levels', 'Extend the network', 'Push an advisory'],
    accentVar: 'var(--actor-regulator)',
    icon: 'tower',
    landing: '/regulator',
    chrome: 'watchfloor',
    hotkey: '2',
    nav: [
      { to: '/regulator', label: 'Watchfloor', code: 'WATCH', icon: 'shield', hint: 'Network status at a glance' },
      { to: '/regulator/map', label: 'Map', code: 'MAP', icon: 'map', hint: 'Monitors, fleet, road grid' },
      { to: '/regulator/alerts', label: 'Alerts', code: 'ALRT', icon: 'alert', hint: 'Exceedances and exposures' },
      { to: '/regulator/thresholds', label: 'Action levels', code: 'THRS', icon: 'threshold', hint: 'The action levels you set' },
      { to: '/regulator/analysis', label: 'Analysis', code: 'ANLY', icon: 'analysis', hint: 'Diurnal, dispersion, ranking' },
    ],
  },

  industry: {
    role: 'industry',
    label: 'Industry',
    org: 'Ridgeline Compute',
    tagline: 'How hard can I run without crossing a line?',
    narrative: 'flight deck',
    blurb:
      'Run at the top of your operating envelope — the regulator\'s action levels on your own fenceline roads, measured street by street — alongside what is downwind of you now and what residents are saying.',
    wants: ['Watch the margin', 'Answer the community', 'Protect the headroom'],
    accentVar: 'var(--actor-industry)',
    icon: 'radar',
    landing: '/industry',
    chrome: 'scope',
    hotkey: '3',
    nav: [
      { to: '/industry', label: 'Flight deck', code: 'DECK', icon: 'scope', hint: 'Map, gauges and what is nearby' },
      { to: '/industry/alerts', label: 'Alerts', code: 'ALRT', icon: 'contacts', hint: 'Everything active, on a timeline' },
      { to: '/industry/community', label: 'Community', code: 'COMM', icon: 'people', hint: 'What your neighbours are reporting' },
      { to: '/industry/outreach', label: 'Outreach', code: 'OUTR', icon: 'megaphone', hint: 'Post, respond, propose mitigation' },
      { to: '/industry/evidence', label: 'Evidence', code: 'EVID', icon: 'analysis', hint: 'The measurements your envelope rests on' },
      { to: '/industry/site', label: 'Site', code: 'SITE', icon: 'factory', hint: 'Your campus and emission points' },
    ],
  },

  admin: {
    role: 'admin',
    label: 'Aclima',
    org: 'Aclima',
    tagline: 'Draw the campaign. Drive it. Keep the shared record.',
    narrative: 'drafting table',
    blurb:
      'Campaign boundary, drive plan, fleet, the morning mission brief, and the full log of every move all three sides have made.',
    wants: ['Plan the campaign', 'Tune the drive plan', 'Run the demo'],
    accentVar: 'var(--actor-aclima)',
    icon: 'aclima',
    landing: '/admin',
    chrome: 'drafting',
    hotkey: '4',
    nav: [
      { to: '/admin', label: 'Overview', code: 'OVR', icon: 'grid', hint: 'Campaign KPIs' },
      { to: '/admin/campaign', label: 'Campaign', code: 'CMPGN', icon: 'campaign', hint: 'Boundary, window, targets' },
      // Sheet 08, placed third: it is read every morning, so it sits where the
      // hand goes. The other sheets keep their numbers until nothing else is
      // in flight (PLAN-plume decision 20).
      { to: '/admin/brief', label: 'Mission brief', code: 'BRIEF', icon: 'wind', hint: '07:00 — the call, the routes, yesterday' },
      { to: '/admin/driveplan', label: 'Drive plan', code: 'PLAN', icon: 'route', hint: 'Routes, passes, coverage' },
      { to: '/admin/fleet', label: 'Fleet', code: 'FLEET', icon: 'fleet', hint: 'Vehicles and live positions' },
      { to: '/admin/data', label: 'Data', code: 'DATA', icon: 'database', hint: 'Measures, ramps, breakpoints' },
      { to: '/admin/oversight', label: 'Oversight', code: 'OVRST', icon: 'oversight', hint: 'Everything everyone did' },
      { to: '/admin/director', label: 'Demo director', code: 'DRCT', icon: 'director', hint: 'Fire a scripted scenario', cta: true, end: true },
    ],
  },
}

export function roleMeta(role: Role): RoleMeta {
  return ROLES[role]
}

export function navFor(role: Role): NavItem[] {
  return ROLES[role].nav
}

/** The role a pathname belongs to, or `null` for the landing page. */
export function roleFromPath(pathname: string): Role | null {
  const seg = pathname.split('/').filter(Boolean)[0]
  return (ROLE_ORDER as string[]).includes(seg ?? '') ? (seg as Role) : null
}

/** Deepest matching nav item for a pathname — drives the active state. */
export function activeNav(role: Role, pathname: string): NavItem | undefined {
  const items = navFor(role)
  let best: NavItem | undefined
  for (const item of items) {
    if (pathname === item.to || pathname.startsWith(`${item.to}/`)) {
      if (!best || item.to.length > best.to.length) best = item
    }
  }
  return best
}

/** Every role except this one — "who else sees this" affordances. */
export function otherRoles(role: Role | null): RoleMeta[] {
  return ROLE_ORDER.filter((r) => r !== role).map((r) => ROLES[r])
}
