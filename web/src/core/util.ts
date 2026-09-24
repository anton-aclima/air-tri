/**
 * air — tiny shared utilities. No dependencies, no DOM, no React.
 */

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Inverse lerp, clamped to 0–1. Returns 0 when the range is degenerate. */
export function invLerp(a: number, b: number, v: number): number {
  if (b === a) return 0
  return clamp((v - a) / (b - a), 0, 1)
}

/** Piecewise-linear interpolation over a sorted `[x, y]` breakpoint table. */
export function piecewise(points: readonly (readonly [number, number])[], x: number): number {
  if (points.length === 0) return 0
  if (points.length === 1) return points[0][1]
  const pts = [...points].sort((a, b) => a[0] - b[0])
  if (x <= pts[0][0]) return pts[0][1]
  const last = pts[pts.length - 1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    if (x <= x1) {
      const [x0, y0] = pts[i - 1]
      return lerp(y0, y1, invLerp(x0, x1, x))
    }
  }
  return last[1]
}

/** Inverse of `piecewise` — given a y, find the x. Used for legend ticks. */
export function piecewiseInverse(points: readonly (readonly [number, number])[], y: number): number {
  if (points.length === 0) return 0
  const pts = [...points].sort((a, b) => a[1] - b[1])
  if (pts.length === 1 || y <= pts[0][1]) return pts[0][0]
  const last = pts[pts.length - 1]
  if (y >= last[1]) return last[0]
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    if (y <= y1) {
      const [x0, y0] = pts[i - 1]
      return lerp(x0, x1, invLerp(y0, y1, y))
    }
  }
  return last[0]
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Stable, human-sortable id for client-side objects (toasts, optimistic rows).
 * The wall clock here only makes ids unique across reloads; it is never read
 * back as a time, so it is not the demo's now and need not be (core/clock).
 */
let seq = 0
export function uid(prefix = 'id'): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}`
}

export function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>
  for (const item of items) {
    const k = key(item)
    ;(out[k] ??= []).push(item)
  }
  return out
}

export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)]
}

/** Trailing-edge debounce. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}
