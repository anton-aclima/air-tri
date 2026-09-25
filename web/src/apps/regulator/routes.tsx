/**
 * regulator — the agency's three screens (docs/PLAN-refocus.md D6).
 *
 *   /regulator             Network: one map that answers, in order, what the
 *                          reference monitors report, what the fleet measured
 *                          on the streets between them with each site's
 *                          modelled plume drawn as an outline, and where
 *                          residents are reporting.
 *   /regulator/alerts      the queue.
 *   /regulator/thresholds  the action levels themselves.
 *
 * `/regulator/map` shows the Network screen as well — it was the same map on a
 * second screen. `/regulator/coverage` and `/regulator/analysis` redirect to
 * it: what they held that a regulator reads (how often a monitor sits in a
 * modelled plume, the calibration anchor, the monitor-vs-street 24-hour shape)
 * is a monitor's detail on the map now, next to the streets it is compared to.
 * `replace` so the back button does not bounce off the old address.
 */

import { createRoute, Outlet, redirect } from '@tanstack/react-router'

import { rootRoute } from '@/app/route-root'

import { AlertsQueue } from './Alerts'
import { Network } from './Network'
import { Thresholds } from './Thresholds'

const layout = createRoute({
  getParentRoute: () => rootRoute,
  path: 'regulator',
  component: Outlet,
})

const network = createRoute({ getParentRoute: () => layout, path: '/', component: Network })
const map = createRoute({ getParentRoute: () => layout, path: 'map', component: Network })
const alerts = createRoute({ getParentRoute: () => layout, path: 'alerts', component: AlertsQueue })
const thresholds = createRoute({ getParentRoute: () => layout, path: 'thresholds', component: Thresholds })

const toNetwork = () => {
  throw redirect({ to: '/regulator', replace: true })
}
const coverage = createRoute({ getParentRoute: () => layout, path: 'coverage', beforeLoad: toNetwork })
const analysis = createRoute({ getParentRoute: () => layout, path: 'analysis', beforeLoad: toNetwork })

export const regulatorRoutes = layout.addChildren([
  network, map, alerts, thresholds, coverage, analysis,
])
