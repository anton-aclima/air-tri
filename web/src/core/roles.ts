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
  /**
   * A short word the rail prints instead of `code`. Codes read as a cockpit
   * panel ("DECK · ALRT · COMM · OUTR"), and a reader has to decode each one;
   * a word needs no key (docs/PLAN-refocus.md F4, CONTRACT §10a.7). Rooms
   * move to words one at a time — industry first — so the rail takes both.
   */
  short?: string
  icon: IconName
  /** Plain language: what is on the page, never how the page is styled. */
  hint: string
  /** The rail shows the room's live alert count on this item (`useLiveAlerts`). */
  badge?: 'alerts'
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
    wants: [
      'See what your reference monitors report',
      'See what the streets between them add',
      'Set action levels and warn the public',
    ],
    accentVar: 'var(--actor-regulator)',
    icon: 'tower',
    landing: '/regulator',
    chrome: 'watchfloor',
    hotkey: '2',
    // Three items, in words (D6, F4). Network is one map that answers the
    // owner's three questions in order — monitors, then the fleet and the
    // modelled plumes, then residents — so Watchfloor and Map were one screen
    // split in two, and Coverage and Analysis are a monitor's detail on it
    // (their routes redirect there). "Levels" and not "Action levels": the
    // rail word has to fit 60px unclipped.
    nav: [
      { to: '/regulator', label: 'Network', short: 'Network', code: 'NET', icon: 'map', hint: 'Your reference monitors, the streets measured between them, the modelled plumes and resident reports' },
      { to: '/regulator/alerts', label: 'Alerts', short: 'Alerts', code: 'ALRT', icon: 'alert', hint: 'Exceedances and resident clusters at the time shown', badge: 'alerts' },
      { to: '/regulator/thresholds', label: 'Action levels', short: 'Levels', code: 'LVLS', icon: 'threshold', hint: 'The action levels you set, and what each one would trip' },
    ],
  },

  industry: {
    role: 'industry',
    label: 'Industry',
    org: 'Ridgeline Compute',
    // The room's message is performance inside the air's constraints (owner,
    // 2026-09-23): how hard to run comes first, what is downwind second, and
    // checking the filed study is a supporting view, not a headline. The
    // avionics are the look — mono numerals, phosphor, square corners — and
    // none of their words reach the copy: "Flight deck", "Watch the margin"
    // and "Protect the headroom" (the retired `headroom_pct`) all read as the
    // metaphor taken literally.
    tagline: 'How hard can I run, given the air around my site?',
    narrative: 'flight deck',
    blurb:
      'Run as hard as the air allows. The fleet measures your fenceline roads against the agency\'s action levels; the map shows the wind, where your emissions are modelled to go, and what residents report.',
    wants: [
      'See how hard you can run, hour by hour',
      'See what lies downwind of you',
      'Respond to residents with the measurements',
    ],
    accentVar: 'var(--actor-industry)',
    icon: 'radar',
    landing: '/industry',
    chrome: 'scope',
    hotkey: '3',
    // Words on the rail, not codes (F4). The first item is the map because the
    // screen is a map: "Flight deck" named the metaphor, not what is on it.
    nav: [
      { to: '/industry', label: 'Map', short: 'Map', code: 'MAP', icon: 'map', hint: 'Your site, the wind, and the streets measured around it' },
      { to: '/industry/alerts', label: 'Alerts', short: 'Alerts', code: 'ALRT', icon: 'alert', hint: 'Alerts near your site at the time shown', badge: 'alerts' },
      { to: '/industry/community', label: 'Reports', short: 'Reports', code: 'RPTS', icon: 'people', hint: 'What residents near you are reporting' },
      { to: '/industry/outreach', label: 'Outreach', short: 'Outreach', code: 'OUTR', icon: 'megaphone', hint: 'Post updates, respond to residents, propose mitigation' },
      { to: '/industry/evidence', label: 'Evidence', short: 'Evidence', code: 'EVID', icon: 'analysis', hint: 'The street measurements behind how hard you can run' },
      { to: '/industry/site', label: 'Site', short: 'Site', code: 'SITE', icon: 'factory', hint: 'Your campus, emission points and the filed study' },
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
