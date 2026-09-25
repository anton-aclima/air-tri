# `core/` — the data layer

Everything the four interfaces share: wire types, a typed API client, TanStack Query
hooks, the live event stream, UI state, and the measurement/formatting language.

**You should not need to write a `fetch`, a `useQuery`, a date formatter or a colour
scale in `apps/<role>/`. If something is missing here, ask the shell agent for it
rather than forking it.**

```
core/
  types.ts      the wire types (FROZEN — orchestrator owns it)
  api.ts        one typed function per endpoint in CONTRACT §5
  queries.ts    TanStack Query hooks + query keys + mutations
  live.ts       SSE subscription → cache invalidation + toasts + live pulse
  session.ts    zustand UI state (role, persona, selection, map view, TIME CURSOR)
  clock.ts      naive campaign time: build, parse, compare, add hours
  events.ts     what had happened by the moment on screen: hasStarted, isOngoing…
  alerts.ts     useLiveAlerts(role): THE live-alert count — rail badge, page, alert pages
  measures.ts   MeasureDef → formatted value, risk, ramp colour, band label
  format.ts     dates, relative times, distances, bearings, numbers
  roles.ts      role metadata: label, org, narrative, accent, nav, landing route
  util.ts       clamp / lerp / piecewise / groupBy / debounce
```

Import with the `@/` alias: `import { useAlerts } from '@/core/queries'`.

---

## 1. Rules that are not negotiable

| Rule | Where it is implemented |
|---|---|
| Community sees no units and no acronyms | `plainName(def, 'community')`, `unitFor()` returns `''`, `formatValue(def, v, { role: 'community' })` returns a risk score |
| Community fleet positions delayed ≥3 h | `useFleet()` — `fleetDelayFor()` forces `delay_min ≥ 180` |
| Industry cannot close a concern | `updateConcernStatus(id, status, 'industry')` rejects `resolved`/`closed` |
| Two ramps, never mixed | `rampVar('aqi'…)` for health, `rampVar('map'…)` for magnitude |
| All numerals mono + tabular | the global `.num` class (in `design/base.css`), or `<Stat>` |
| `SIMULATED DATA` always visible | the shell mounts `<SimulatedBadge />` in every skin |
| One clock: naive campaign time, and "now" is the demo's, never the wall's | `core/clock`, `useNowCampaign()` — see §5, "The clock" |

---

## 2. `api.ts`

One function per endpoint. Returns the types from `types.ts`. Throws `ApiError`
(with `.status`, `.isMissing`, `.isOffline`) on failure — never a silent `{}`.
List endpoints tolerate `[...]` and `{ items: [...] }` envelopes, and GeoJSON
endpoints always resolve to a valid `FeatureCollection` (possibly empty).

**Read** — `getBootstrap` · `listCampaigns` · `getCampaign` · `getCampaignBoundary` ·
`getSegments` · `getSegmentDetail` · `listMonitors` · `getMonitor` ·
`getMonitorReadings` · `listConcerns` · `getConcern` · `listClusters` · `listSites` ·
`getSite` · `listPosts` · `listAdvisories` · `listAlerts` · `getAlert` ·
`listActionLevels` · `getFeed` · `getFleet` · `listVehicles` · `getDrivePlan` ·
`getDrivePlanCoverage` · `getWind` · `getDispersion` · `getMobileWind` ·
`getWindField` · `listDispersionModels` · `getModelVerification` ·
`getCommunityStats` · `getCampaignStats` · `getActivity` · `ping`

**Write** — `createConcern` · `corroborateConcern` · `createConcernResponse` ·
`updateConcernStatus` · `createPost` · `createMitigation` · `createAdvisory` ·
`acknowledgeAlert` · `updateActionLevel` · `createActionLevel` · `askAdvisor` ·
`regenerateDrivePlan` · `reseed` · `simulate`

**Helpers** — `API_BASE` · `apiUrl` · `queryString` · `bboxParam` · `nearParam` ·
`ApiError` · `isApiError` · `isBackendDown`

---

## 3. `queries.ts` — use these, not `api.ts`

Every hook takes `(params?, opts?)`. `opts` is a partial `UseQueryOptions` spread
**last**, so you can always override `enabled`, `staleTime`, `refetchInterval`,
`select`, `placeholderData`.

### Bootstrap and derived (no extra request)

```ts
useBootstrap()                  // { campaign, measures, orgs, users, action_levels, sites, flags }
useMeasures('modality')         // MeasureDef[], sorted
useMeasure('no2')               // MeasureDef | undefined
useActiveMeasure()              // the session's current measure, resolved
useCampaignInfo()               // Campaign | undefined
useOrgs() / useUsers(role?)     // Org[] / User[]
useFlags()                      // advisor_mode, basemap, community_fleet_delay_min, now
useBootstrapSites()             // IndustrySite[] straight from the bootstrap payload
useActiveSite()                 // the site the industry persona operates
```

### Reads

```ts
useCampaigns()  useCampaign(id)  useCampaignBoundary(id)

useSegments({ measure?, metric?, window?, bbox?, min_passes?, limit? })
    // ← THE road grid. measure/metric/window default to the session store.
useSegmentDetail(id, opts?, { at }?) // daily + diurnal + per-measure stats; `at` bounds every figure to the moment shown
useSelectedSegment()            // whatever is selected in the session

useMonitors({ owner_type?, grade?, site_id? })   useMonitor(id)
useMonitorReadings(id, { measure?, from?, to?, interval? })   // defaults to the time cursor

useConcerns({ status?, kind?, since?, near?, cluster_id?, limit?, at? })
useConcern(id)                  useConcernClusters({ campaign_id?, at? })  // alias: useClusters()

useSites()  useSite(id)  usePosts({ site_id?, kind? })  useAdvisories({ audience? })

useAlerts({ role?, status?, severity?, kind?, site_id?, at? })
    // role defaults to the active persona. Pass site_id to get bearing_deg +
    // distance_m. "Live" is isOngoing(alert, now) from core/events (or the
    // server's `ongoing`), never status === 'active'.
useAlert(id, siteId?)           useActionLevels()

useLiveAlerts(role)             // core/alerts. { alerts, notices, count, bySeverity, worst, all, folded, loading, error }
    // The ONE count (docs/PLAN-refocus.md F3): the nav badge, a page's status
    // and the alert pages all print `count`, so they cannot disagree (they
    // read 9 / 4 / 3 / 5 on one industry screen). Live = isOngoing at the
    // demo's now (active AND acknowledged, never ended); industry is scoped to
    // the locked `siteId`; concurrent levels from one source fold to the
    // highest (`foldConcurrent`). Severity words: SEVERITY_LABEL only.
    // Industry counts places, not models: the wind-shift study alert (and
    // anything with no bearing from the site) is in `notices`, never `count`,
    // and nothing past INDUSTRY_NEAR_M (7 km, the deck's reach) is counted.
    // Severity `info` is operational news, not an alert now, in every room:
    // it goes to `notices` (the fleet's "Redwing out of service"), never to
    // count / bySeverity / worst. Mobile detections have no ended_at and stay
    // ongoing: a standing finding, counted.
    // A list that must match the count lists `alerts`.

useFeed({ role?, since?, limit?, at? })  // merged social feed

useFleet({ at?, delay_min? })   // at ← time cursor; delay_min ← role (community ≥180)
useVehicles()  useDrivePlan()  useDrivePlanCoverage(planId)

useWind()  useCurrentWind()  useDispersion({ site_id, at?, outline? })
    // outline: true → DispersionPlumeOutlined: the bands PLUS each site's
    // outline (part 'inside' | 'beyond' the detection envelope) and axis.
    // Narrow with isBandFeature / isOutlineFeature / isAxisFeature (core/api).
    // Default off, and then the request is exactly what it always was.
useMobileWind({ from?, to?, bbox?, quality? })   // fleet anemometry, quality: 'good' by default
useWindField({ cell_m? })                        // binned OBSERVED wind → particle overlay
useDispersionModels(siteId)                      // the consultant's deliverables
useModelVerification(siteId, { model_id?, from?, to? })  // assumed vs observed rose

useTouchdown(siteId, { measure?, from?, to?, regime? })  // MEASURED plume. Verdict = data.site.state;
                                                        // per-feature state is EVIDENCE, never a finding
useCoverage(campaignId?, cellM?)                         // where a car has actually been. cell_m is a SIDE

useCommunityStats({ window?, at? })  useCampaignStats()  useActivity({ since?, limit? })
```

The five event lists — concerns, clusters, alerts, feed, community stats — send
`at: timeParam(time)` by default, and the server cuts at it **before** its LIMIT.
Include the key yourself to override: `{ at: undefined }` is the whole record up to
the end of the data (the timeline's event ticks). They, and the series hooks, keep
the previous data on screen while the next step loads (`TIMED`).

### Mutations

```ts
useCreateConcern()          // → industry RWR + regulator queue   (loop 1)
useCorroborate()
useCreateConcernResponse()
useUpdateConcernStatus()    // regulator/admin; industry may not resolve
useCreatePost()
useCreateMitigation()       // → community feed + regulator alert  (loop 3)
useCreateAdvisory()         // → community feed                    (loop 2)
useAcknowledgeAlert()
useUpdateActionLevel()      // re-evaluates alerts immediately     (loop 2)
useCreateActionLevel()
useAskAdvisor()             // industry "what do I do about it"
useSimulate()               // Demo Director scenarios
useRegenerateDrivePlan()  useReseed()
```

All mutations already invalidate the *other* interfaces' caches. Do not add your own
`invalidateQueries` unless you have a key that isn't in `qk`.

### Keys and plumbing

`qk` (all query keys, grouped) · `STALE` (the stale-time table) · `INVALIDATE`
(invalidation groups reused by `live.ts`) · `createQueryClient()` · `QueryOpts<T>`.

```ts
queryClient.invalidateQueries({ queryKey: qk.alerts.all })
```

### Backend down

`npm run dev` works with no API. Queries land in `isError`; `ApiError.status === 0`
means "not reachable". Retries stop immediately in that case. **Render an empty state,
never a crash** — `data` is always possibly `undefined`.

---

## 4. `live.ts` — the cross-role payoff

The shell opens one `EventSource` on `/api/v1/events/stream` and, per event,
invalidates the right keys, bumps a pulse, and raises a toast. **An action in one
interface shows up in another without a refresh.** You get this for free — just use
the hooks above.

One stream per **browser**, not per tab. Over HTTP/1.1 (the vite dev server) a
browser allows six connections to a host across all its tabs, and an `EventSource`
holds one for the tab's lifetime; five open tabs left every fetch in all of them
queued behind one connection (phase 5: `/regulator/network` failing at the 25 s
timeout, timeline ticks never loading). So the tabs elect a leader with a Web Lock
(`air.live.stream`); it holds the only stream and relays each frame over the
`air.live` BroadcastChannel, and every tab handles the frame as its own. When the
leader closes, the next tab reconnects with `?since=<newest id seen>`, so the
handover replays only the gap. Without Web Locks or BroadcastChannel, one stream
per tab, as before. `GET /api/v1/events/status` → `subscribers` counts streams.

```ts
useLiveStatus()   // 'idle' | 'connecting' | 'open' | 'retrying' | 'offline'
useLivePulse()    // { pulse, at, role } — bump a CSS animation off `pulse`
useLiveEvents()   // last 80 LiveEvents, newest first (admin oversight ticker)
useLiveToasts()   // the toast queue (the shell renders it)
useLiveUnseen()   // deprecated: nothing marks events seen, so it only grows
useLive           // the raw store: .toast({...}), .dismiss(id), .clearToasts()
```

An event's `at` is naive campaign time. Writes are stamped at the server's frozen now
(the end of the data), and an event that arrives without a stamp gets the same
instant, so a toast reads "just now" whichever moment is on screen.

Also exported: `parseLiveEvent`, `invalidationsFor`, `hrefFor`, `handleLiveEvent`,
`emitLocal(qc, role, {...})` (synthesise an event locally — handy for optimistic
feedback), `startLive(qc, getRole)`, and the `LiveEvent` / `Toast` types.

Add `?live=0` to the URL to skip the stream (headless screenshots need this: an open
SSE connection never reaches network idle).

---

## 5. `session.ts` — UI state

```ts
useSession(s => s.…)   // the store
useRole()  usePersona()  useSelection()  useMapView()  useTime()
useMeasureCode()  useMetric()  useStatWindow()  useSiteId()
```

State: `role` · `personaByRole` · `user` · `siteId` · `selection`
(`segmentId`/`alertId`/`concernId`/`monitorId`/`siteId`/`clusterId`) · `mapView` ·
`time` (`cursor`/`playing`/`speed`/`windowHours`/`bounds`) · `measure` · `metric` ·
`statWindow` · `switcherOpen` · `transitioningTo`.

Actions: `setRole` · `setPersona` · `setSite` · `select(patch)` · `clearSelection` ·
`setMapView` · `flyTo(center, zoom?)` · `resetView` · `setMeasure` · `setMetric` ·
`setStatWindow` · `setTimeCursor` · `stepTime(hours)` · `goToEnd` · `setTimeBounds` · `setPlaying` ·
`togglePlaying` · `setSpeed` · `setWindowHours` · `setSwitcherOpen` ·
`toggleSwitcher` · `reset`.

### The clock

Every timestamp is **naive campaign time**, `YYYY-MM-DDTHH:MM:SS`: no `Z`, no
offset, America/Chicago digits. `toISOString()` wrote the cursor as UTC and the
server served an hour seven hours away in a Pacific browser, so never use it for a
campaign time. Build and read through `core/clock`:

```ts
toCampaign(date)  parseCampaign(t)  campaignMs(t)  addHours(t, h)  floorTo(t, min)
```

`time.cursor === null` means **paused at the end of the data** — never live, never
the wall clock (D1). `time.bounds` is `{ start, end }`: campaign start to the build
instant, loaded once by the shell. The cursor is clamped into them, and at or past
the end it becomes `null`.

```ts
useNowCampaign()   // the demo's now, naive — cursor ?? bounds.end
useDemoClock()     // the same, as a Date
nowCampaign(time)  resolveNow(time)   // non-hook forms
timeParam(time)    // string | undefined — pass into ?at= (undefined = the end)
timeRange(time)    // { from, to } for the trailing window
useTimeRange()     // hook form: { from, to, at }
```

Never `Date.now()` or `new Date()` for "now". Animation timing (`performance.now`,
rAF) is not "now" and stays on the wall clock.

**Events follow the clock** (`core/events`): `hasStarted(e, now)`, `isOngoing(e,
now)` (the definition of "live"), `isOpenCase`, `isRecent`, `happenedBy(list,
now)`. Anything that had not begun by `now` does not render.

Time-aware hooks (`useFleet`, `useMonitorReadings`, `useWind`, `useMobileWind`,
`useWindField`, `useDispersion`, `useMonitors`/`useMonitor`, `useAlert`,
`useCalibration`, and the five event lists above) already default to the clock.
Every one of them waits for `time.bounds` whatever `enabled` the caller passes:
before the bootstrap lands `nowCampaign` has only the wall clock to offer, and a
fresh /industry load fired `/wind?to=2026-09-23T19:00` on a campaign ending Aug 28,
whose empty answer then sat on screen as the placeholder for the real one. The
report window on every map (`useWindowedReports`, from `@/components`) ends at the
same instant the rows' ages are measured from.

Persisted to `localStorage` under `air.session.v1` — but never the cursor: a reload
always opens at the end of the data.

Other helpers: `DEFAULT_VIEW`, `EMPTY_SELECTION`, `PLAYBACK_SPEEDS`,
`fleetDelayFor(role, configured?)`, `landingFor(role)`.

---

## 6. `measures.ts` — the measurement language

```ts
// naming — community never sees a unit or an acronym
plainName(def, role)      shortName(def, role)      unitFor(def, role)

// values
formatValue(def, v, { role?, unit?, decimals?, asRisk? })   // "23.4 ppb" | "61"
formatValueParts(def, v, opts)                              // { value, unit }
formatMetric(def, v, metric, role)                          // persistence → "62%"
riskFromValue(def, v)     valueForRisk(def, risk)           // measure_def.scale
exceedsRef(def, v)        metricIsUnitless(metric)
METRIC_LABEL  METRIC_LABEL_SHORT
findMeasure(measures, code)   measuresOf(measures, family?)

// risk bands (0–100)
riskBand(risk)  riskLabel(risk)  riskLabelShort(risk)  riskColorVar(risk)  riskRgb(risk)
RISK_BANDS      // [{ min, label, short }] — 7 bands, 1:1 with --ramp-aqi-*

// ramps: 'aqi' (health) | 'intensity' | 'map' (per-role alias) | 'intensity-light'
rampVar(family, i)      // 'var(--ramp-aqi-3)'    — inline styles
rampVars(family)        // all stops, for legends
rampGradient(family)    // 'linear-gradient(...)' — legend bars
rampColor(family, t)    // nearest stop as var()
rampIndex(family, t)    rampStops(family)
rampRgb(family, t)      // [r,g,b] interpolated  — deck.gl
rampRgba(family, t, a)  // [r,g,b,a]
rampT(def, v, metric)   // any metric → 0–1, health-anchored
segmentRgba(def, props, metric, family?, usePersistence?)   // ← the road grid colour
persistAlpha(p)         familyForRole(role)      rgbCss(rgb, a?)

// tokens at runtime (never hard-code a hex)
tokenRgb('--sev-warning')   tokenNumber('--persist-3')   refreshTokenCache()

// severity + actors
SEVERITY_ORDER  SEVERITY_LABEL  SEVERITY_PLAIN  severityRank  severityVar  severityRgb
modalityVar(code)  modalityRgb(code)  actorVar(role)
```

`rampRgb` and friends read the *live* tokens off `<html data-role>`, so colours follow
the role skin automatically. Call `refreshTokenCache()` if you ever change tokens by
hand.

---

## 7. `format.ts`

```ts
EMPTY                      // '—' — every formatter returns this for null
fmtNum  fmtAuto  fmtCompact  fmtPct  fmtSigned  fmtTrend  fmtRange  padNum
pluralize  countOf  titleCase  humanize  initials  truncate  pctWidth
fmtDay  fmtDayFull  isoDate  fmtTime  fmtTime24  fmtClock  fmtDateTime  fmtStamp
fmtHourLabel               // diurnal axis: 0 → '12a'
relativeTime  relativeShort  fmtElapsed  fmtDuration  fmtDurationMin
fmtDistance  fmtDistanceImperial  fmtKm
compassPoint  compassWords  fmtBearing  fmtDegrees  fmtWind  fmtWindWords
distanceBetween(a, b)  bearingBetween(a, b)  fmtLatLon
```

`relativeTime(t, now)`, `relativeShort(t, now)` and `fmtElapsed(since, until)` **require**
their `now`: pass `useNowCampaign()`. A time after `now` is never printed as "in 2 d"
or as a past duration. Every date formatter reads strings as naive campaign time, so a
date-only `2026-05-31` is local midnight, not the UTC midnight `new Date()` gives.

---

## 8. `roles.ts`

```ts
ROLES         // Record<Role, RoleMeta>
ROLE_ORDER    // ['community','regulator','industry','admin']
roleMeta(role)  navFor(role)  roleFromPath(pathname)  activeNav(role, pathname)  otherRoles(role)
```

`RoleMeta`: `label` · `org` · `tagline` · `narrative` · `blurb` · `wants` ·
`accentVar` · `icon` · `landing` · `chrome` · `hotkey` · `nav[]`.
`NavItem`: `to` · `label` · `code` · `icon` · `hint` · `cta?` · `end?`.
`IconName` is the union the `<Icon>` primitive draws.

---

## 9. What the shell gives you (`@/app/…`)

```ts
import { Button, IconButton, Chip, Badge, SeverityBadge, SeverityDot, Card, Panel,
         Toolbar, Spacer, Divider, Kbd, Field, Input, Textarea, Select, Segmented,
         Slider, Toggle, Tabs, Tooltip, Modal, Sheet, Stat, StatRow, Table,
         Skeleton, SkeletonText, Empty, Spinner, Avatar, AvatarStack, Icon } from '@/app/ui'
import { TimeCursor } from '@/app/TimeCursor'
import { SimulatedBadge } from '@/app/SimulatedBadge'
import { rootRoute } from '@/app/route-root'     // parent for your routes.tsx
```

Primitives are skin-agnostic: they read semantic tokens only. Global utility classes
from `design/base.css`: `.num` (mono + tabular), `.caps`, `.truncate`, `.scroll-y`,
`.sr-only`.

### Your `routes.tsx`

Export **one route object** with its children attached, parented to `rootRoute`:

```tsx
import { createRoute, Outlet } from '@tanstack/react-router'
import { rootRoute } from '@/app/route-root'

const layout = createRoute({ getParentRoute: () => rootRoute, path: 'community', component: Outlet })
const feed   = createRoute({ getParentRoute: () => layout, path: '/', component: Feed })
const detail = createRoute({ getParentRoute: () => layout, path: 'c/$concernId', component: Concern })

export const communityRoutes = layout.addChildren([feed, detail])
```

`detail.useParams()` is typed. `<Link to="…">` takes a plain string (the router is
deliberately not type-registered, so five agents can add routes in parallel).
`@/router` assembles the four modules — do not edit it.

The shell owns the header/rail/footer, the persona switcher (⌘K, ⌥1–4), toasts and
the `SIMULATED DATA` badge. Your route renders **inside** `<main>`: for the dense
roles that box does not scroll, so give your own panes `overflow: auto`; the community
skin scrolls the page for you.
