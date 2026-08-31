/**
 * air — the route tree.
 *
 * Code-based TanStack Router. No file-based routing, no codegen. The root
 * route renders the shell; each of the four apps owns one `routes.tsx` module
 * that exports a single route (its layout route, children already attached).
 *
 *   /                          persona picker / landing
 *   /community  …              apps/community/routes.tsx
 *   /regulator  …              apps/regulator/routes.tsx
 *   /industry   …              apps/industry/routes.tsx
 *   /admin      …              apps/admin/routes.tsx
 */

import { createRoute, createRouter } from '@tanstack/react-router'

import { rootRoute } from '@/app/route-root'
import { Landing } from '@/app/Landing'
import { communityRoutes } from '@/apps/community/routes'
import { regulatorRoutes } from '@/apps/regulator/routes'
import { industryRoutes } from '@/apps/industry/routes'
import { adminRoutes } from '@/apps/admin/routes'

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Landing,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  communityRoutes,
  regulatorRoutes,
  industryRoutes,
  adminRoutes,
])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
})
