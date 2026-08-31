/**
 * air — icon set.
 *
 * One 24×24 stroke geometry per `IconName` (declared in `core/roles.ts`).
 * Stroked with `currentColor` so an icon always inherits the role skin.
 */

import type { CSSProperties } from 'react'

import type { IconName } from '@/core/roles'

const PATHS: Record<IconName, string> = {
  feed: 'M4 4h16v6H4z M4 14h16 M4 19h10',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z M9 4v14 M15 6v14',
  report: 'M6 3v18 M6 4h11l-2.4 4L17 12H6',
  dashboard: 'M4 4h7v7H4z M13 4h7v4h-7z M13 11h7v9h-7z M4 14h7v6H4z',
  tower: 'M12 8v13 M8.5 21h7 M8 6.5a5.5 5.5 0 0 1 8 0 M5.5 3.8a9.5 9.5 0 0 1 13 0',
  alert: 'M12 4 2.6 20h18.8L12 4z M12 10v4 M12 17.2v.4',
  threshold: 'M4 7h10 M18 7h2 M4 17h4 M12 17h8 M16 5v4 M10 15v4',
  analysis: 'M4 4v16h16 M7 15l4-5 3 3 5-7',
  scope: 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 4v16 M4 12h16',
  contacts: 'M8 6h12 M8 12h12 M8 18h12 M4 6h.4 M4 12h.4 M4 18h.4',
  megaphone: 'M4 10v4l10 4V6L4 10z M14 8.5a4 4 0 0 1 0 7 M6 14.8V19h3v-3.2',
  factory: 'M3 21h18 M4 21V10l5 3V10l5 3V8l6 4v9 M8.5 21v-4H11v4',
  campaign: 'M4 4l16 5-7 11L4 4z M4 4h.4 M20 9h.4 M13 20h.4',
  route: 'M6 20a3 3 0 1 0 0-6h8a3 3 0 1 0 0-6H6 M6 4.5v.4 M18 19.5v.4',
  fleet: 'M4 15h16 M6.5 15 8 10h8l1.5 5 M5 15v3.5h3V15 M16 15v3.5h3V15',
  database:
    'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  oversight: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  director: 'M3 6h18v14H3z M3 10h18 M7.5 6l1.6 4 M13.5 6l1.6 4',
  people:
    'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7 M17 4.7a3.5 3.5 0 0 1 0 6.6 M18 14.3c2.4.8 4 3 4 5.7',
  shield: 'M12 3l8 3v6c0 5-3.4 8.5-8 9.5C7.4 20.5 4 17 4 12V6l8-3z',
  wind: 'M3 8h11a3 3 0 1 0-3-3 M3 14h15a3 3 0 1 1-3 3 M3 11h8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7.2V12l3.4 2',
  close: 'M6 6l12 12 M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M16.4 16.4L21 21',
  check: 'M4.5 12.5l5 5L20 7',
  plus: 'M12 5v14 M5 12h14',
  pause: 'M9.5 5v14 M14.5 5v14',
  play: 'M7.5 4.5l12 7.5-12 7.5v-15z',
  skip: 'M6.5 5l9 7-9 7V5z M18.5 5v14',
  aclima: 'M12 2l10 10-10 10L2 12 12 2z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  radar: 'M21 12a9 9 0 1 1-9-9 M12 12l7-6 M12 12h.4 M16.5 12a4.5 4.5 0 1 1-4.5-4.5',
  pin: 'M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z M12 13a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
}

export interface IconProps {
  name: IconName
  size?: number
  /** Stroke width in the 24-unit viewBox. */
  weight?: number
  className?: string
  style?: CSSProperties
  title?: string
}

export function Icon({ name, size = 18, weight = 1.6, className, style, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  )
}

/** Every icon name, for a design gallery. */
export const ICON_NAMES = Object.keys(PATHS) as IconName[]
