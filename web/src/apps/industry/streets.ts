/**
 * The industry room's street grid and the words for its window (phase 6, P5).
 * A plain module, not lib.tsx, so fast refresh keeps working on the components.
 */

import { bboxParam, type SegmentsParams } from '@/core/api'
import type { CampaignTime } from '@/core/clock'
import { fmtDay, fmtTime24 } from '@/core/format'
import { keepSegmentsWhile, useSegments } from '@/core/queries'
import { useSession } from '@/core/session'
import type { SegmentCollection } from '@/core/types'

/**
 * The room's street grid, bounded by the moment shown (phase 6, P5): every
 * coloured street is `GET /segments?window=todate&at=<the moment>`, the passes
 * up to then and none after. The stored `all` window it replaced is ninety days
 * and, in replay, carried passes the clock had not reached. At the end of the
 * data `todate` IS `all`, feature for feature (tests/test_passwindow.py), so
 * paused at the end nothing changes. The previous grid is held while the next
 * moment loads, but not across a pollutant switch: that reads as loading, not
 * as the last pollutant's streets under the new one's legend.
 *
 * `todate` serves only streets with a pass by then, so geometry that must not
 * come and go with the clock (the fenceline road's outline, a map fit) reads
 * `useStreetGeometry` instead.
 */
export function useStreetGrid(
  params: Omit<SegmentsParams, 'window' | 'at'> = {},
  opts: { enabled?: boolean } = {},
) {
  const sessionMeasure = useSession((x) => x.measure)
  const measure = params.measure ?? sessionMeasure
  const bbox = bboxParam(params.bbox)
  return useSegments(
    { ...params, window: 'todate' },
    {
      ...opts,
      // Held only for the same streets at another moment: a different box (the
      // next alert's page, another site in Scope) or pass floor is a different
      // grid, and holding the last one would paint its streets under this one.
      placeholderData: keepSegmentsWhile(
        (p) =>
          p.window === 'todate' &&
          p.measure === measure &&
          p.metric === (params.metric ?? p.metric) &&
          bboxParam(p.bbox) === bbox &&
          p.min_passes === params.min_passes,
      ),
    },
  )
}

/**
 * Street geometry that does not depend on the clock: the stored window, read
 * only for WHERE a road is (the fenceline outline, a fit), never for a colour
 * or a number — those come from `useStreetGrid`.
 */
export function useStreetGeometry(
  params: Pick<SegmentsParams, 'bbox' | 'limit'> = {},
  opts: { enabled?: boolean } = {},
) {
  return useSegments({ ...params, window: 'all' }, opts)
}

/**
 * The grid's window in words, from the payload's own `window.to` so the words
 * cannot name a different window than the colours. Paused at the end it is
 * `atEnd` (the words each room already used, true there because `todate` is
 * the whole campaign then); in replay, "measured to Aug 24 05:00".
 */
export function streetsWindowWords(
  grid: SegmentCollection | undefined,
  replaying: boolean,
  now: CampaignTime,
  atEnd: string,
): string {
  if (!replaying) return atEnd
  const to = grid?.window?.to ?? now
  return `measured to ${fmtDay(to)} ${fmtTime24(to)}`
}
