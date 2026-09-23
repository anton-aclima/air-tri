/**
 * admin — the drafting table.
 *
 * Seven sheets in one drawing set, in the order a campaign is actually built:
 * the cover page, the boundary, the plan, the fleet, the measurement language,
 * the oversight record, and the panel a presenter drives the demo from.
 *
 * Sheet 08, the Mission Brief, is the eighth drawing and the third in the nav:
 * it is what a fleet lead opens every morning. Renumbering the other seven to
 * match is deferred (PLAN-plume decision 20).
 */

import { createRoute, Outlet } from '@tanstack/react-router'

import { rootRoute } from '@/app/route-root'

import { Campaign } from './Campaign'
import { Data } from './Data'
import { Brief } from './Brief'
import { Director } from './Director'
import { DrivePlan } from './DrivePlan'
import { Fleet } from './Fleet'
import { Overview } from './Overview'
import { Oversight } from './Oversight'

const layout = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin',
  component: Outlet,
})

const overview = createRoute({ getParentRoute: () => layout, path: '/', component: Overview })
const campaign = createRoute({ getParentRoute: () => layout, path: 'campaign', component: Campaign })
const driveplan = createRoute({ getParentRoute: () => layout, path: 'driveplan', component: DrivePlan })
const fleet = createRoute({ getParentRoute: () => layout, path: 'fleet', component: Fleet })
const data = createRoute({ getParentRoute: () => layout, path: 'data', component: Data })
const oversight = createRoute({ getParentRoute: () => layout, path: 'oversight', component: Oversight })
const brief = createRoute({ getParentRoute: () => layout, path: 'brief', component: Brief })
const director = createRoute({ getParentRoute: () => layout, path: 'director', component: Director })

export const adminRoutes = layout.addChildren([
  overview, campaign, brief, driveplan, fleet, data, oversight, director,
])
