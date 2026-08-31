/**
 * regulator — the watchtower.
 *
 * Five screens, in the order the agency works: what is over the line, where the
 * network can and cannot see, the queue, the tripwires themselves, and the
 * analysis a data scientist runs before anyone signs a notice.
 */

import { createRoute, Outlet } from '@tanstack/react-router'

import { rootRoute } from '@/app/route-root'

import { AlertsQueue } from './Alerts'
import { Analysis } from './Analysis'
import { MapScreen } from './MapScreen'
import { Thresholds } from './Thresholds'
import { Watchfloor } from './Watchfloor'

const layout = createRoute({
  getParentRoute: () => rootRoute,
  path: 'regulator',
  component: Outlet,
})

const watchfloor = createRoute({ getParentRoute: () => layout, path: '/', component: Watchfloor })
const map = createRoute({ getParentRoute: () => layout, path: 'map', component: MapScreen })
const alerts = createRoute({ getParentRoute: () => layout, path: 'alerts', component: AlertsQueue })
const thresholds = createRoute({ getParentRoute: () => layout, path: 'thresholds', component: Thresholds })
const analysis = createRoute({ getParentRoute: () => layout, path: 'analysis', component: Analysis })

export const regulatorRoutes = layout.addChildren([
  watchfloor, map, alerts, thresholds, analysis,
])
