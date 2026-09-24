/**
 * air — the one clock.
 *
 * Every timestamp in this product is NAIVE CAMPAIGN TIME: `YYYY-MM-DDTHH:MM:SS`,
 * no `Z`, no offset. That is what the generator writes and what the server
 * compares. The browser reads a naive string as local time and prints it with
 * local getters, so the digits round-trip unchanged whatever the viewer's zone —
 * "floating" time. It only breaks when something converts to UTC on the way:
 *
 *   `toISOString()`  wrote the cursor as UTC. In a Pacific browser the server
 *                    then served an hour seven hours away from the one on
 *                    screen, and past the end of the data after one step.
 *   `Date.now()`     mixed the wall clock into a world that ended weeks ago.
 *
 * So: build strings with `toCampaign`, read them with `parseCampaign`, and take
 * "now" from the session (`useNow`), never from the wall. A `Z` or offset on an
 * incoming string is dropped, not converted — the server does the same, and the
 * digits are the truth.
 *
 * Hour arithmetic goes through `addHours`, which works on the digits via
 * `Date.UTC`, so a daylight-saving change in the viewer's zone cannot skip or
 * repeat an hour inside a window.
 */

export type CampaignTime = string

const pad = (n: number) => String(n).padStart(2, '0')

/** A `Date` read with LOCAL getters → naive campaign time. */
export function toCampaign(d: Date): CampaignTime {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** The digits only: strip a trailing `Z`, an offset or fractional seconds. */
export function naive(text: string): CampaignTime {
  const t = text.trim()
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(t)
  if (!m) return t
  return `${m[1]}T${m[2] ?? '00'}:${m[3] ?? '00'}:${m[4] ?? '00'}`
}

/**
 * Naive campaign time → a `Date` whose LOCAL fields equal the digits. A
 * date-only `2026-05-31` is local midnight, not UTC midnight (which is what
 * `new Date('2026-05-31')` gives).
 */
export function parseCampaign(text: string): Date {
  const n = naive(text)
  const [d, t] = n.split('T')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi, se] = (t ?? '00:00:00').split(':').map(Number)
  return new Date(y, (mo ?? 1) - 1, da ?? 1, h ?? 0, mi ?? 0, se ?? 0)
}

/** Milliseconds on the campaign's own axis — for ordering and differences. */
export function campaignMs(text: string): number {
  const n = naive(text)
  const [d, t] = n.split('T')
  const [y, mo, da] = d.split('-').map(Number)
  const [h, mi, se] = (t ?? '00:00:00').split(':').map(Number)
  return Date.UTC(y, (mo ?? 1) - 1, da ?? 1, h ?? 0, mi ?? 0, se ?? 0)
}

/** The inverse of `campaignMs`. */
export function fromCampaignMs(ms: number): CampaignTime {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** Shift by hours on the digits. DST-proof: no local-time arithmetic. */
export function addHours(t: CampaignTime, hours: number): CampaignTime {
  return fromCampaignMs(campaignMs(t) + hours * 3_600_000)
}

/** Round down to a grid of `minutes` — for query keys that must not churn. */
export function floorTo(t: CampaignTime, minutes: number): CampaignTime {
  const q = minutes * 60_000
  return fromCampaignMs(Math.floor(campaignMs(t) / q) * q)
}

export function clampTime(t: CampaignTime, lo: CampaignTime, hi: CampaignTime): CampaignTime {
  const v = campaignMs(t)
  if (v < campaignMs(lo)) return naive(lo)
  if (v > campaignMs(hi)) return naive(hi)
  return naive(t)
}

/** Hours from `a` to `b`, on the campaign axis. */
export function hoursBetween(a: CampaignTime, b: CampaignTime): number {
  return (campaignMs(b) - campaignMs(a)) / 3_600_000
}
