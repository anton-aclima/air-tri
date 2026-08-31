/**
 * air — the root route.
 *
 * Lives in its own module so the four `apps/<role>/routes.tsx` files can use it
 * as their parent (`getParentRoute: () => rootRoute`) without importing
 * `router.tsx`, which would be circular.
 */

import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'

import { AppShell } from '@/app/AppShell'
import { NotFound } from '@/app/NotFound'
import { roleFromPath } from '@/core/roles'

function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <AppShell role={roleFromPath(pathname)}>
      <Outlet />
    </AppShell>
  )
}

export const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
})
