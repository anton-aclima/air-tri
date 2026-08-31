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
 */

import type { QueryClient } from '@tanstack/react-query'
import { create } from 'zustand'

import { apiUrl } from '@/core/api'
import { INVALIDATE, qk } from '@/core/queries'
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
  at: string
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
  at: string
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
  connectedAt: number | null
  /** Increments on every event. Watch this to flash something. */
  pulse: number
  pulseAt: number
  /** Who caused the most recent pulse — flash *their* colour. */
  pulseRole: Role | null
  lastEvent: LiveEvent | null
  events: LiveEvent[]
  toasts: Toast[]
  /** Unseen event count since the user last looked at the notification surface. */
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
        { ...input, id, at: input.at ?? new Date().toISOString() },
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

// ───────────────────────────────────────────────────────────────── selectors

export const useLiveStatus = (): LiveStatus => useLive((s) => s.status)
export const useLiveToasts = (): Toast[] => useLive((s) => s.toasts)
export const useLiveEvents = (): LiveEvent[] => useLive((s) => s.events)
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

  return {
    id: str(data, 'id', 'event_id') ?? uid('ev'),
    type,
    at: str(data, 'ts', 'at', 'created_at') ?? new Date().toISOString(),
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
      // shared surfaces rather than guessing.
      return [qk.feed.all, qk.activity.all, qk.alerts.all, qk.concerns.all, qk.stats.all]
  }
}

/** Where a toast for this event should navigate the current role. */
export function hrefFor(event: LiveEvent, role: Role | null): string | null {
  const id = event.objectId
  switch (event.type) {
    case 'concern':
      if (role === 'community' && id) return `/community/c/${id}`
      if (role === 'regulator') return '/regulator/alerts'
      if (role === 'industry') return '/industry/scope'
      return '/admin/oversight'
    case 'alert':
      if (role === 'industry') return id ? `/industry/alerts/${id}` : '/industry/scope'
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

interface Connection {
  refs: number
  source: EventSource | null
  timer: ReturnType<typeof setTimeout> | null
  flush: ReturnType<typeof setTimeout> | null
  pending: Set<string>
  pendingKeys: (readonly unknown[])[]
  closed: boolean
}

const conn: Connection = {
  refs: 0,
  source: null,
  timer: null,
  flush: null,
  pending: new Set(),
  pendingKeys: [],
  closed: false,
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
    at: new Date().toISOString(),
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

/**
 * Open the stream. Returns a disposer. Reference-counted, so React StrictMode's
 * double-mount does not open two sockets.
 */
export function startLive(qc: QueryClient, getRole: () => Role | null): () => void {
  conn.refs += 1
  if (conn.refs > 1) return () => release()

  conn.closed = false

  const open = (attempt: number) => {
    if (conn.closed) return
    useLive.getState().setStatus(attempt === 0 ? 'connecting' : 'retrying', attempt)

    let source: EventSource
    try {
      source = new EventSource(apiUrl('/events/stream'))
    } catch {
      retry(attempt + 1)
      return
    }
    conn.source = source

    source.onopen = () => {
      useLive.getState().setStatus('open', 0)
    }

    const onEvent = (name: string) => (e: MessageEvent<string>) => {
      const event = parseLiveEvent(name, e.data)
      if (event) handleLiveEvent(qc, event, getRole())
    }

    for (const name of EVENT_TYPES) source.addEventListener(name, onEvent(name) as EventListener)
    source.onmessage = onEvent('activity')

    source.onerror = () => {
      source.close()
      conn.source = null
      retry(attempt + 1)
    }
  }

  const retry = (attempt: number) => {
    if (conn.closed) return
    const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)]
    useLive.getState().setStatus(attempt >= BACKOFF.length ? 'offline' : 'retrying', attempt)
    conn.timer = setTimeout(() => open(attempt), delay)
  }

  open(0)

  function release() {
    conn.refs = Math.max(0, conn.refs - 1)
    if (conn.refs > 0) return
    conn.closed = true
    if (conn.timer) clearTimeout(conn.timer)
    if (conn.flush) clearTimeout(conn.flush)
    conn.timer = null
    conn.flush = null
    conn.source?.close()
    conn.source = null
    useLive.getState().setStatus('idle', 0)
  }

  return () => release()
}
