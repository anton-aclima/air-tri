/**
 * regulator/alerting — the words and tests the Alerts, Action levels and Push
 * screens share. Not components, so the three .tsx files can export only
 * components and keep fast refresh (oxlint `only-export-components`).
 */

import { campaignMs } from '@/core/clock'
import type { CampaignTime } from '@/core/clock'
import type { ActionLevel, Alert, AlertKind, MeasureCode, MeasureDef, Severity } from '@/core/types'

// ────────────────────────────────────────────────────────────── who saw it

/** Who raised an alert, in the words the screens and the drafts use. */
export type PushSource = 'monitor' | 'fence' | 'fleet' | 'residents' | 'model' | 'ops' | 'agency'

/** D10: the copy says "reference monitor"; the tower glyph stays on the map. */
export const SOURCE_LABEL: Record<PushSource, string> = {
  monitor: 'Reference monitor',
  fence: 'Fence sensor',
  fleet: 'Mobile fleet',
  residents: 'Residents',
  model: 'Model check',
  ops: 'Fleet status',
  agency: 'DRAQA',
}

/**
 * Who raised it. A monitor alert is a reference monitor's only if the
 * instrument is DRAQA's; anyone else's is a fence sensor. Until the monitor
 * list loads (`monitorIds` null) a monitor alert is taken to be DRAQA's,
 * rather than flickering through "fence sensor".
 */
export function sourceOf(al: Alert, monitorIds: Set<string> | null): PushSource {
  if (al.kind === 'fleet_anomaly') return 'ops'
  if (al.kind === 'wind_shift' || al.source_type === 'model') return 'model'
  if (al.source_type === 'mobile') return 'fleet'
  if (al.source_type === 'community' || al.kind === 'concern_cluster') return 'residents'
  if (al.source_type === 'monitor') {
    return !monitorIds || monitorIds.has(al.source_id ?? '') ? 'monitor' : 'fence'
  }
  return 'agency'
}

/**
 * Where, from the title — the alert carries no place name of its own. Each
 * pattern is one of the server's title forms ("… exceeded at Riverport Road",
 * "Highest … on the network: Channel Avenue", "6 community reports clustered
 * near Paul R Lowry Road", "Methane plume crossed on Harbor Avenue"); anything
 * else keeps its whole title.
 */
export function whereOf(al: Alert): string {
  const m = / at (.+)$/.exec(al.title)
    ?? /: (.+)$/.exec(al.title)
    ?? / near (.+)$/.exec(al.title)
    ?? / on (.+)$/.exec(al.title)
  return m ? m[1].trim() : al.title
}

/** 'ug/m3' on the wire is µg/m³ on screen. */
export function unitText(u: string | null | undefined): string {
  if (!u) return ''
  return u === 'ug/m3' ? 'µg/m³' : u
}

/** The action level's name for an alert, from the levels table, else its title. */
export function levelName(al: Alert, levels: Map<string, ActionLevel>): string | null {
  const l = al.action_level_id ? levels.get(al.action_level_id) : undefined
  if (l) return l.label
  return /^(.+?) exceeded at /i.exec(al.title)?.[1] ?? null
}

/**
 * What an action level is set against, in words that name no real body. The
 * seeded levels carry `source` strings like "National standard 1-hr" (a
 * database built before phase 5 of PLAN-refocus still names a real body
 * there, so that is matched too); the actors in this demo are fictional
 * (DRAQA is), and PLAN-plume's never-say list rules out naming a real
 * standards body, so a national-standard level reads as one. The agency's own
 * screening levels keep their name.
 */
export function levelBasis(source: string | null | undefined): string {
  if (!source) return 'local'
  if (/^national standard|\b(EPA|NAAQS)\b/i.test(source)) return 'national standard'
  return source
}

// ─────────────────────────────────────────────────────── the moment shown

/** Ended by the moment shown. In replay an alert can end after it. */
export function endedBy(al: Alert, now: CampaignTime): boolean {
  return !!al.ended_at && campaignMs(al.ended_at) <= campaignMs(now)
}

/**
 * The alert's reading as it stood at the moment shown, or null when it was
 * not yet known. `value` is the peak over the alert's whole run, so in replay
 * it can come from an hour the screen has not reached: at Aug 25 05:30,
 * Riverport Road's 05:00–07:00 watch alert already carries 121.43 ppb, the
 * 06:00 reading (the 05:00 hour was 98.9). A mobile detection is one pass,
 * known the moment it starts. An alert still open at the end of the data is
 * known up to the end, which is the moment shown only when not replaying.
 */
export function knownValue(al: Alert, now: CampaignTime, replaying: boolean): number | null {
  if (al.value == null) return null
  if (al.kind === 'mobile_detection' || endedBy(al, now)) return al.value
  return !al.ended_at && !replaying ? al.value : null
}

// ─────────────────────────────────────────────────────────── push subject

export interface PushSubject {
  source: PushSource
  kind: AlertKind
  measure: MeasureCode | null
  /** The measure's short label for the operator ("NO2"). */
  measureLabel: string | null
  /** The measure's plain name for residents ("traffic and engine fumes"). */
  plainName: string | null
  severity: Severity
  /** Where, in words: a monitor's or a street's name. */
  where: string
  /** The highest reading known at the moment shown. Null when not yet known. */
  value: number | null
  threshold: number | null
  unit: string | null
  levelLabel: string | null
  startedAt: CampaignTime
  /** Null while it is still ongoing at the moment shown. */
  endedAt: CampaignTime | null
  /** The alert the message is filed against. */
  alertId: string
  /** The alert's own title, for the kinds with no reading (the model check). */
  title: string
}

/**
 * The subject for one alert as it stood at the moment shown. `value` and the
 * times are the caller's, from `knownValue` and the episode: the alert's own
 * fields are its final state, and the episode's winner can be a 06:00–07:00
 * standard alert inside a 05:00–07:00 watch run — the message is about the
 * run.
 */
export function subjectFor(
  a: Alert,
  opts: {
    source: PushSource
    value: number | null
    /** The episode's start, when the alert is one level of a longer run. */
    startedAt?: CampaignTime
    endedAt: CampaignTime | null
    levelLabel: string | null
    def: MeasureDef | undefined
  },
): PushSubject {
  return {
    source: opts.source,
    kind: a.kind,
    measure: a.measure,
    measureLabel: opts.def?.short_label ?? (a.measure ? a.measure.toUpperCase() : null),
    plainName: opts.def?.plain_name ?? null,
    severity: a.severity,
    where: whereOf(a),
    value: opts.value,
    threshold: a.threshold,
    unit: a.unit,
    levelLabel: opts.levelLabel,
    startedAt: opts.startedAt ?? a.started_at,
    endedAt: opts.endedAt,
    alertId: a.id,
    title: a.title,
  }
}
