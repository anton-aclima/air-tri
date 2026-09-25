/**
 * air — the live wire.
 *
 * Subscribes to `GET /api/v1/events/stream` (SSE over the append-only
 * `activity` log) and turns every event into three things:
 *
 *   1. **cache invalidation** — so an action taken in one interface shows up in
 *      another *without a refresh*. This is the demo's whole payoff.
 *   2. **a live pulse** — a monotonically increasing counter plus the actor
 *      whose colour should flash in the shell.
 *   3. **a toast** — the notification surface, styled per role.
 *
 * The backend is written in parallel, so the connection is entirely optional:
 * if the stream 404s or the server is down we retry with backoff, report
 * `status: 'offline'`, and the app carries on.
 *
 * There is one stream per BROWSER, not per tab: one tab holds it and relays
 * every frame to the others ("the connection", below). A stream per tab used
 * up the browser's six connections to the host and starved every fetch.
 *
 * Two clocks live here and must not be confused. An event's `at` is CAMPAIGN
 * time (core/clock): the server stamps every write at its frozen now, the end
 * of the data, and an event without a stamp gets that same instant here. The
 * `connectedAt` / `pulseAt` numbers are the viewer's wall clock, because they
 * time a connection and a CSS flash, and nothing reads them as a moment in the
 * campaign.
 */

import type { QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'

import { apiUrl } from '@/core/api'
import { naive } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import { INVALIDATE, qk } from '@/core/queries'
import { nowCampaign, useSession } from '@/core/session'
import type { Role, Severity } from '@/core/types'
import { humanize } from '@/core/format'
import { uid } from '@/core/util'

// ─────────────────────────────────────────────────────────────────── shapes

export type LiveEventType =
  | 'activity' | 'alert' | 'concern' | 'post' | 'advisory'
  | 'mitigation' | 'fleet' | 'action_level' | 'simulate' | 'hello'

export interface LiveEvent {
  id: string
  type: LiveEventType
  /** Naive campaign time — see the header. */
  at: CampaignTime
  actorRole: Role | null
  verb: string | null
  objectType: string | null
  objectId: string | null
  severity: Severity | null
  title: string
  body: string | null
  /** Roles this event is addressed to, when the server says. */
  audience: Role[] | null
  payload: Record<string, unknown> | null
  /** True when we synthesised it locally (an optimistic echo of our own write). */
  local: boolean
}

export interface Toast {
  id: string
  type: LiveEventType
  severity: Severity
  title: string
  body: string | null
  /** Naive campaign time. Print with `relativeTime(at, useNowCampaign())`. */
  at: CampaignTime
  /** Whose colour the toast wears. */
  actorRole: Role | null
  /** Where clicking it should go, when we can work it out. */
  href: string | null
  /** Stays until dismissed. */
  sticky: boolean
}

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'retrying' | 'offline'

const RING = 80
const TOAST_MAX = 4
const TOAST_MS = 7000

// ────────────────────────────────────────────────────────────────── the store

export interface LiveState {
  status: LiveStatus
  attempts: number
  /** Wall-clock ms, for the connection only — not a campaign time. */
  connectedAt: number | null
  /** Increments on every event. Watch this to flash something. */
  pulse: number
  /** Wall-clock ms of the last pulse, for animation timing only. */
  pulseAt: number
  /** Who caused the most recent pulse — flash *their* colour. */
  pulseRole: Role | null
  lastEvent: LiveEvent | null
  events: LiveEvent[]
  toasts: Toast[]
  /**
   * Unseen event count since the user last looked at the notification surface.
   * @deprecated Nothing ever calls `markSeen`, so it only grows; the shell's
   * counter goes with the LIVE chip (docs/PLAN-refocus.md S3). Delete this once
   * no screen reads it.
   */
  unseen: number

  setStatus: (status: LiveStatus, attempts?: number) => void
  ingest: (event: LiveEvent) => void
  toast: (toast: Omit<Toast, 'id' | 'at'> & { at?: string }) => string
  dismiss: (id: string) => void
  clearToasts: () => void
  markSeen: () => void
}

export const useLive = create<LiveState>()((set) => ({
  status: 'idle',
  attempts: 0,
  connectedAt: null,
  pulse: 0,
  pulseAt: 0,
  pulseRole: null,
  lastEvent: null,
  events: [],
  toasts: [],
  unseen: 0,

  setStatus: (status, attempts) =>
    set((s) => ({
      status,
      attempts: attempts ?? s.attempts,
      connectedAt: status === 'open' ? Date.now() : s.connectedAt,
    })),

  ingest: (event) =>
    set((s) => ({
      pulse: s.pulse + 1,
      pulseAt: Date.now(),
      pulseRole: event.actorRole,
      lastEvent: event,
      events: [event, ...s.events].slice(0, RING),
      unseen: s.unseen + 1,
    })),

  toast: (input) => {
    const id = uid('toast')
    set((s) => ({
      toasts: [
        ...s.toasts.filter((t) => t.title !== input.title || t.body !== input.body),
        { ...input, id, at: input.at ? naive(input.at) : stampNow() },
      ].slice(-TOAST_MAX),
    }))
    if (!input.sticky) {
      setTimeout(() => {
        useLive.getState().dismiss(id)
      }, TOAST_MS)
    }
    return id
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clearToasts: () => set({ toasts: [] }),
  markSeen: () => set({ unseen: 0 }),
}))

/**
 * The stamp for an event that arrived without one: the instant the server
 * stamps writes with (`timeutil.now` — the end of the data), not the wall
 * clock, which is weeks past it, and not the cursor, because a write lands at
 * the end whatever moment is being replayed. Toasts then read "just now" on
 * every screen (D1).
 */
function stampNow(): CampaignTime {
  const { time } = useSession.getState()
  return time.bounds?.end ?? nowCampaign(time)
}

// ───────────────────────────────────────────────────────────────── selectors

export const useLiveStatus = (): LiveStatus => useLive((s) => s.status)
export const useLiveToasts = (): Toast[] => useLive((s) => s.toasts)
export const useLiveEvents = (): LiveEvent[] => useLive((s) => s.events)
/** @deprecated See `LiveState.unseen`. */
export const useLiveUnseen = (): number => useLive((s) => s.unseen)

/** `{ pulse, at, role }` — bump a CSS animation off `pulse`. */
export function useLivePulse(): { pulse: number; at: number; role: Role | null } {
  const pulse = useLive((s) => s.pulse)
  const at = useLive((s) => s.pulseAt)
  const role = useLive((s) => s.pulseRole)
  return { pulse, at, role }
}

// ─────────────────────────────────────────────────────────── event parsing

const EVENT_TYPES: LiveEventType[] = [
  'activity', 'alert', 'concern', 'post', 'advisory',
  'mitigation', 'fleet', 'action_level', 'simulate', 'hello',
]

function str(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

const ROLES_SET = new Set<string>(['community', 'regulator', 'industry', 'admin'])
const SEVS = new Set<string>(['info', 'watch', 'warning', 'critical'])

function asRole(v: unknown): Role | null {
  return typeof v === 'string' && ROLES_SET.has(v) ? (v as Role) : null
}

function asSeverity(v: unknown): Severity | null {
  return typeof v === 'string' && SEVS.has(v) ? (v as Severity) : null
}

/** Map whatever the server sent into a `LiveEvent`. Never throws. */
export function parseLiveEvent(eventName: string, raw: string): LiveEvent | null {
  let data: Record<string, unknown> = {}
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      data = record(parsed) ?? { summary: raw }
    } catch {
      data = { summary: raw }
    }
  }

  const payload = record(data.payload) ?? data
  const objectType = str(data, 'object_type', 'objectType', 'kind') ?? null
  const declared = EVENT_TYPES.includes(eventName as LiveEventType)
    ? (eventName as LiveEventType)
    : null
  const inferred = EVENT_TYPES.includes((objectType ?? '') as LiveEventType)
    ? (objectType as LiveEventType)
    : null
  const type = declared && declared !== 'activity' ? declared : (inferred ?? declared ?? 'activity')

  const verb = str(data, 'verb', 'action')
  const title =
    str(data, 'title', 'summary') ??
    str(payload, 'title', 'summary') ??
    (verb ? humanize(`${verb} ${objectType ?? ''}`.trim()) : humanize(type))
  // A `Z` or offset is dropped, not converted: the digits are the truth.
  const ts = str(data, 'ts', 'at', 'created_at')

  return {
    id: str(data, 'id', 'event_id') ?? uid('ev'),
    type,
    at: ts ? naive(ts) : stampNow(),
    actorRole: asRole(data.actor_role ?? data.actorRole ?? payload.actor_role),
    verb,
    objectType,
    objectId: str(data, 'object_id', 'objectId', 'id'),
    severity: asSeverity(data.severity ?? payload.severity),
    title,
    body: str(data, 'body', 'detail') ?? str(payload, 'body', 'detail'),
    audience: Array.isArray(data.audience)
      ? (data.audience.filter((r): r is Role => asRole(r) !== null))
      : null,
    payload,
    local: false,
  }
}

// ─────────────────────────────────────────────────────────── invalidation

/** Which caches an event dirties. Trimming this breaks the cross-role loops. */
export function invalidationsFor(event: LiveEvent): readonly (readonly unknown[])[] {
  switch (event.type) {
    case 'concern':
      return INVALIDATE.concern
    case 'alert':
      return event.objectId
        ? [...INVALIDATE.alert, qk.alerts.detail(event.objectId)]
        : INVALIDATE.alert
    case 'advisory':
      return INVALIDATE.advisory
    case 'post':
      return INVALIDATE.post
    case 'mitigation':
      return INVALIDATE.mitigation
    case 'action_level':
      return INVALIDATE.actionLevel
    case 'fleet':
      return INVALIDATE.fleet
    case 'simulate':
      return INVALIDATE.everything
    case 'hello':
      return []
    case 'activity':
    default:
      // An unclassified activity row could be anything — refresh the cheap,
      // shared surfaces rather than guessing. The regulator's Network payload
      // counts the alerts and the reports, so it goes with them.
      return [qk.feed.all, qk.activity.all, qk.alerts.all, qk.concerns.all, qk.stats.all, qk.regulator.all]
  }
}

/** Where a toast for this event should navigate the current role. */
export function hrefFor(event: LiveEvent, role: Role | null): string | null {
  const id = event.objectId
  switch (event.type) {
    // Industry lands on `/industry`, the map, not its old `/industry/scope`
    // alias: the alias named the retired radar and is free to go with it, and
    // a toast that navigates to a removed route lands on Not Found.
    case 'concern':
      if (role === 'community' && id) return `/community/c/${id}`
      if (role === 'regulator') return '/regulator/alerts'
      if (role === 'industry') return '/industry'
      return '/admin/oversight'
    case 'alert':
      if (role === 'industry') return id ? `/industry/alerts/${id}` : '/industry'
      if (role === 'regulator') return '/regulator/alerts'
      if (role === 'community') return '/community'
      return '/admin/oversight'
    case 'advisory':
      return role === 'community' ? '/community' : '/regulator/alerts'
    case 'post':
    case 'mitigation':
      return role === 'community' ? '/community' : '/industry/outreach'
    case 'action_level':
      return role === 'regulator' ? '/regulator/thresholds' : null
    case 'fleet':
      return null
    default:
      return null
  }
}

/** Fleet pings are constant — they pulse, they never toast. */
function shouldToast(event: LiveEvent, role: Role | null): boolean {
  if (event.type === 'fleet' || event.type === 'hello') return false
  if (event.audience && event.audience.length > 0 && role) return event.audience.includes(role)
  return true
}

// ─────────────────────────────────────────────────────────── the connection
//
// ONE stream per browser, not one per tab.
//
// Over HTTP/1.1 — the vite dev server, or any plain-http host — a browser
// keeps at most six connections open to one host:port for ALL its tabs
// together, and an EventSource holds one for as long as its tab is open. With
// five tabs on the demo (a role each, and one more), every fetch in every tab
// shared the one connection left. Measured in phase 5: /regulator/network
// requests queued 5–25 s and failed at the 25 s timeout without reaching the
// server, and the timeline's event ticks never loaded.
//
// So the tabs elect a leader with a Web Lock. The leader holds the only
// EventSource and relays every frame over a BroadcastChannel; every other tab
// handles a relayed frame exactly as if its own stream had read it — its own
// role decides the toast and the link. When the leader goes, the lock passes
// to another tab, which reconnects with `?since=` the newest id any tab has
// seen, so the handover replays what fell between and nothing older. A browser
// without either API opens a stream per tab, as it always did.

const LOCK_NAME = 'air.live.stream'
const CHANNEL_NAME = 'air.live'

/** What the tabs say to each other on `CHANNEL_NAME`. */
type Relay =
  /** One SSE frame, as the leader's stream read it. */
  | { kind: 'frame'; name: string; data: string; id: string }
  /** The leader's connection state, and the newest id it has seen. */
  | { kind: 'status'; status: LiveStatus; attempts: number; lastId: number }
  /** A tab that just started asks the leader for its status. */
  | { kind: 'ask' }

interface Connection {
  refs: number
  source: EventSource | null
  timer: ReturnType<typeof setTimeout> | null
  flush: ReturnType<typeof setTimeout> | null
  pending: Set<string>
  pendingKeys: (readonly unknown[])[]
  closed: boolean
  /** Bumped on every start, so a lock granted to an earlier start lets go at once. */
  gen: number
  /** This tab holds the stream. Always, when the browser cannot share one. */
  leader: boolean
  channel: BroadcastChannel | null
  /** Withdraws a lock request that has not been granted yet. */
  abort: AbortController | null
  /** Settles the held lock's promise, which releases the lock. */
  unlock: (() => void) | null
  /** The newest SSE id this tab has seen, read or relayed: `?since=` on a reconnect. */
  lastId: number
}

const conn: Connection = {
  refs: 0,
  source: null,
  timer: null,
  flush: null,
  pending: new Set(),
  pendingKeys: [],
  closed: false,
  gen: 0,
  leader: false,
  channel: null,
  abort: null,
  unlock: null,
  lastId: 0,
}

function relay(msg: Relay): void {
  try {
    conn.channel?.postMessage(msg)
  } catch {
    /* the channel closed under us: this tab is stopping */
  }
}

/** Set this tab's status and, when it holds the stream, every other tab's. */
function report(status: LiveStatus, attempts: number): void {
  useLive.getState().setStatus(status, attempts)
  if (conn.leader) relay({ kind: 'status', status, attempts, lastId: conn.lastId })
}

function noteId(id: string | number): void {
  const n = typeof id === 'number' ? id : Number(id)
  if (id !== '' && Number.isFinite(n) && n > conn.lastId) conn.lastId = n
}

/** Coalesce a burst of events into one round of invalidation. */
function scheduleInvalidate(qc: QueryClient, keys: readonly (readonly unknown[])[]): void {
  for (const key of keys) {
    const sig = JSON.stringify(key)
    if (conn.pending.has(sig)) continue
    conn.pending.add(sig)
    conn.pendingKeys.push(key)
  }
  if (conn.flush) return
  conn.flush = setTimeout(() => {
    const keysToRun = conn.pendingKeys
    conn.pendingKeys = []
    conn.pending.clear()
    conn.flush = null
    for (const key of keysToRun) void qc.invalidateQueries({ queryKey: key })
  }, 180)
}

/**
 * Handle one event: invalidate, pulse, maybe toast. Exported so the Demo
 * Director (and tests) can inject an event without a server.
 */
export function handleLiveEvent(qc: QueryClient, event: LiveEvent, role: Role | null): void {
  const store = useLive.getState()
  store.ingest(event)
  const keys = invalidationsFor(event)
  if (keys.length) scheduleInvalidate(qc, keys)
  if (shouldToast(event, role)) {
    store.toast({
      type: event.type,
      severity: event.severity ?? (event.type === 'alert' ? 'warning' : 'info'),
      title: event.title,
      body: event.body,
      actorRole: event.actorRole,
      href: hrefFor(event, role),
      sticky: event.severity === 'critical',
      at: event.at,
    })
  }
}

/** Synthesise a local event — an optimistic echo of our own write. */
export function emitLocal(
  qc: QueryClient,
  role: Role | null,
  input: Partial<LiveEvent> & { type: LiveEventType; title: string },
): void {
  handleLiveEvent(qc, {
    id: uid('local'),
    at: stampNow(),
    actorRole: role,
    verb: null,
    objectType: null,
    objectId: null,
    severity: null,
    body: null,
    audience: null,
    payload: null,
    local: true,
    ...input,
  }, role)
}

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000]

/** Both halves of the shared stream exist here (see "the connection"). */
function canShare(): boolean {
  return typeof BroadcastChannel !== 'undefined'
    && typeof navigator !== 'undefined'
    && 'locks' in navigator
    && navigator.locks != null
}

/**
 * Open the stream — or join the one another tab holds. Returns a disposer.
 * Reference-counted, so React StrictMode's double-mount does not open two.
 */
export function startLive(qc: QueryClient, getRole: () => Role | null): () => void {
  conn.refs += 1
  if (conn.refs > 1) return () => release()

  conn.closed = false
  conn.gen += 1
  const gen = conn.gen
  const stopped = () => conn.closed || gen !== conn.gen

  const deliver = (name: string, data: string, id: string) => {
    noteId(id)
    const event = parseLiveEvent(name, data)
    if (event) handleLiveEvent(qc, event, getRole())
  }

  const open = (attempt: number) => {
    if (stopped()) return
    report(attempt === 0 ? 'connecting' : 'retrying', attempt)

    // A reconnect asks only for what it missed. Without `since` the server
    // replays its whole buffer, and every old write toasted again.
    const params = conn.lastId > 0 ? { since: conn.lastId } : undefined
    let source: EventSource
    try {
      source = new EventSource(apiUrl('/events/stream', params))
    } catch {
      retry(attempt + 1)
      return
    }
    conn.source = source

    source.onopen = () => report('open', 0)

    const onFrame = (name: string) => (e: MessageEvent<string>) => {
      relay({ kind: 'frame', name, data: e.data, id: e.lastEventId })
      deliver(name, e.data, e.lastEventId)
    }

    for (const name of EVENT_TYPES) source.addEventListener(name, onFrame(name) as EventListener)
    source.onmessage = onFrame('activity')

    source.onerror = () => {
      source.close()
      if (conn.source === source) conn.source = null
      retry(attempt + 1)
    }
  }

  const retry = (attempt: number) => {
    if (stopped()) return
    const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]
    report(attempt >= BACKOFF.length ? 'offline' : 'retrying', attempt)
    conn.timer = setTimeout(() => open(attempt), delay)
  }

  if (!canShare()) {
    conn.leader = true
    open(0)
  } else {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    conn.channel = channel
    channel.onmessage = (e: MessageEvent<Relay>) => {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return
      if (msg.kind === 'frame') {
        if (!conn.leader) deliver(msg.name, msg.data, msg.id)
      } else if (msg.kind === 'status') {
        if (conn.leader) return
        noteId(msg.lastId)
        useLive.getState().setStatus(msg.status, msg.attempts)
      } else if (msg.kind === 'ask' && conn.leader) {
        const st = useLive.getState()
        relay({ kind: 'status', status: st.status, attempts: st.attempts, lastId: conn.lastId })
      }
    }

    // Until the leader answers — or this tab becomes it — the stream is
    // being reached for, as far as this tab can tell.
    useLive.getState().setStatus('connecting', 0)
    relay({ kind: 'ask' })

    const abort = new AbortController()
    conn.abort = abort
    navigator.locks
      .request(LOCK_NAME, { signal: abort.signal }, () => {
        if (stopped()) return undefined
        conn.abort = null
        conn.leader = true
        open(0)
        // Held until this tab stops; closing the tab releases it too.
        return new Promise<void>((resolve) => {
          conn.unlock = resolve
        })
      })
      .catch(() => {
        /* withdrawn: this tab stopped before its turn came */
      })
  }

  function release() {
    conn.refs = Math.max(0, conn.refs - 1)
    if (conn.refs > 0) return
    // The tabs left behind wait for the next leader rather than read "open".
    if (conn.leader) relay({ kind: 'status', status: 'connecting', attempts: 0, lastId: conn.lastId })
    conn.closed = true
    if (conn.timer) clearTimeout(conn.timer)
    if (conn.flush) clearTimeout(conn.flush)
    conn.timer = null
    conn.flush = null
    conn.source?.close()
    conn.source = null
    conn.abort?.abort()
    conn.abort = null
    conn.unlock?.()
    conn.unlock = null
    conn.channel?.close()
    conn.channel = null
    conn.leader = false
    useLive.getState().setStatus('idle', 0)
  }

  return () => release()
}
