/**
 * industry — the operator's deck: a map, one line of status, one side panel.
 *
 * `/industry` is the deck. (The `/industry/scope` alias is gone: nothing links
 * to it any more, and the retired RWR was the only reason for the name.)
 */

import { createRoute, Outlet } from '@tanstack/react-router'

import { rootRoute } from '@/app/route-root'

import { Community } from './Community'
import { Contacts } from './Contacts'
import { ContactDetail } from './ContactDetail'
import { Evidence } from './Evidence'
import { Outreach } from './Outreach'
import { Scope } from './Scope'
import { SiteConfig } from './SiteConfig'

const layout = createRoute({
  getParentRoute: () => rootRoute,
  path: 'industry',
  component: Outlet,
})

const deck = createRoute({ getParentRoute: () => layout, path: '/', component: Scope })
const contacts = createRoute({ getParentRoute: () => layout, path: 'alerts', component: Contacts })

const contactDetail = createRoute({
  getParentRoute: () => layout,
  path: 'alerts/$alertId',
  component: function ContactDetailRoute() {
    const { alertId } = contactDetail.useParams()
    return <ContactDetail alertId={alertId} />
  },
})

const community = createRoute({ getParentRoute: () => layout, path: 'community', component: Community })
const outreach = createRoute({ getParentRoute: () => layout, path: 'outreach', component: Outreach })
const siteConfig = createRoute({ getParentRoute: () => layout, path: 'site', component: SiteConfig })
// "Says who" — the measurements the deck's envelope rests on.
const evidence = createRoute({ getParentRoute: () => layout, path: 'evidence', component: Evidence })

export const industryRoutes = layout.addChildren([
  deck, contacts, contactDetail, community, outreach, siteConfig, evidence,
])
