/**
 * community — the route tree.
 *
 * A social app for people who have never heard of PM2.5:
 *   /community                 the feed
 *   /community/report          report a concern
 *   /community/map             the street map + every report
 *   /community/dashboard       how the neighbourhood is trending
 *   /community/status          what the air agency is saying
 *   /community/outreach        the companies, and where their limits are
 *   /community/c/$concernId    one report and its thread
 */

import { createRoute, Outlet } from '@tanstack/react-router'

import { ConcernDetail } from '@/apps/community/ConcernDetail'
import { Dashboard } from '@/apps/community/Dashboard'
import { Feed } from '@/apps/community/Feed'
import { MapScreen } from '@/apps/community/MapScreen'
import { Outreach } from '@/apps/community/Outreach'
import { Report } from '@/apps/community/Report'
import { Status } from '@/apps/community/Status'
import { rootRoute } from '@/app/route-root'
import { CONCERN_KINDS } from '@/apps/community/lib'
import type { ConcernKind } from '@/core/types'

const layout = createRoute({
  getParentRoute: () => rootRoute,
  path: 'community',
  component: Outlet,
})

const feed = createRoute({
  getParentRoute: () => layout,
  path: '/',
  component: Feed,
})

/** `?kind=smell` — the feed's composer chips deep-link straight into step 1. */
const report = createRoute({
  getParentRoute: () => layout,
  path: 'report',
  validateSearch: (search: Record<string, unknown>): { kind?: ConcernKind } => {
    const k = search.kind
    return typeof k === 'string' && (CONCERN_KINDS as string[]).includes(k)
      ? { kind: k as ConcernKind }
      : {}
  },
  component: ReportScreen,
})

function ReportScreen() {
  const { kind } = report.useSearch()
  return <Report key={kind ?? 'any'} initialKind={kind} />
}

const map = createRoute({
  getParentRoute: () => layout,
  path: 'map',
  component: MapScreen,
})

const dashboard = createRoute({
  getParentRoute: () => layout,
  path: 'dashboard',
  component: Dashboard,
})

const status = createRoute({
  getParentRoute: () => layout,
  path: 'status',
  component: Status,
})

const outreach = createRoute({
  getParentRoute: () => layout,
  path: 'outreach',
  component: Outreach,
})

const concern = createRoute({
  getParentRoute: () => layout,
  path: 'c/$concernId',
  component: ConcernScreen,
})

function ConcernScreen() {
  const { concernId } = concern.useParams()
  return <ConcernDetail concernId={concernId} />
}

export const communityRoutes = layout.addChildren([
  feed,
  report,
  map,
  dashboard,
  status,
  outreach,
  concern,
])
