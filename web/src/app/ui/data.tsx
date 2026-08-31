/**
 * air — data-display primitives.
 * Badge · Chip · SeverityDot · Stat · Table · Skeleton · Empty · Spinner ·
 * Avatar. All numerals are mono + tabular (CONTRACT §6).
 */

import clsx from 'clsx'
import type { CSSProperties, ReactNode } from 'react'

import s from '@/design/primitives.module.css'
import { Icon } from '@/app/ui/Icon'
import type { IconName } from '@/core/roles'
import type { Severity, User } from '@/core/types'
import { SEVERITY_LABEL, severityVar } from '@/core/measures'
import { fmtTrend, initials } from '@/core/format'

// ──────────────────────────────────────────────────────────────────── Badge

export type BadgeTone = 'info' | 'watch' | 'warning' | 'critical' | 'ok' | 'neutral' | 'accent'

const TONE_CLASS: Record<BadgeTone, string> = {
  info: s.badgeInfo,
  watch: s.badgeWatch,
  warning: s.badgeWarning,
  critical: s.badgeCritical,
  ok: s.badgeOk,
  neutral: s.badgeNeutral,
  accent: s.badgeAccent,
}

export interface BadgeProps {
  tone?: BadgeTone
  solid?: boolean
  className?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', solid, className, children }: BadgeProps) {
  return (
    <span className={clsx(s.badge, TONE_CLASS[tone], solid && s.badgeSolid, className)}>
      {children}
    </span>
  )
}

/** Severity as a badge — the shared alert vocabulary in every role. */
export function SeverityBadge({ severity, solid }: { severity: Severity; solid?: boolean }) {
  return (
    <Badge tone={severity} solid={solid}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  )
}

// ───────────────────────────────────────────────────────────────────── Chip

export interface ChipProps {
  active?: boolean
  /** Renders a leading dot in this colour — pass a `var(--…)`, never a hex. */
  dotColor?: string
  icon?: IconName
  small?: boolean
  onClick?: () => void
  title?: string
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export function Chip({
  active,
  dotColor,
  icon,
  small,
  onClick,
  title,
  className,
  style,
  children,
}: ChipProps) {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      aria-pressed={onClick ? active : undefined}
      className={clsx(s.chip, onClick && s.chipButton, active && s.chipActive, small && s.chipSm, className)}
      style={style}
    >
      {dotColor ? <span className={s.chipDot} style={{ background: dotColor }} /> : null}
      {icon ? <Icon name={icon} size={small ? 11 : 13} /> : null}
      {children}
    </Tag>
  )
}

// ───────────────────────────────────────────────────────────── SeverityDot

export interface SeverityDotProps {
  severity?: Severity
  /** Override the colour with any token var — risk ramps, actor colours. */
  color?: string
  size?: 'sm' | 'md' | 'lg'
  /** Radiating ring — an unacknowledged, active contact. */
  pulse?: boolean
  title?: string
  className?: string
}

export function SeverityDot({
  severity,
  color,
  size = 'md',
  pulse,
  title,
  className,
}: SeverityDotProps) {
  return (
    <span
      title={title ?? (severity ? SEVERITY_LABEL[severity] : undefined)}
      className={clsx(
        s.sevDot,
        size === 'sm' && s.sevDotSm,
        size === 'lg' && s.sevDotLg,
        pulse && s.sevDotPulse,
        className,
      )}
      style={{ color: color ?? severityVar(severity) }}
    />
  )
}

// ───────────────────────────────────────────────────────────────────── Stat

export interface StatProps {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  /** Percentage change. Positive = worse (air quality), so it renders warm. */
  trendPct?: number | null
  /** Flip the colour logic when up is good (coverage, passes). */
  trendUpIsGood?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children?: ReactNode
}

export function Stat({
  label,
  value,
  unit,
  trendPct,
  trendUpIsGood,
  size = 'md',
  className,
  children,
}: StatProps) {
  const up = (trendPct ?? 0) > 0.5
  const down = (trendPct ?? 0) < -0.5
  const good = trendUpIsGood ? up : down
  const bad = trendUpIsGood ? down : up
  return (
    <div className={clsx(s.stat, size === 'sm' && s.statSm, size === 'lg' && s.statLg, className)}>
      <span className={s.statLabel}>{label}</span>
      <span className={s.statValue}>
        {value}
        {unit ? <span className={s.statUnit}>{unit}</span> : null}
      </span>
      {trendPct != null ? (
        <span
          className={clsx(
            s.statTrend,
            good && s.trendDown,
            bad && s.trendUp,
            !good && !bad && s.trendFlat,
          )}
        >
          {fmtTrend(trendPct)}
        </span>
      ) : null}
      {children}
    </div>
  )
}

export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx(s.statRow, className)}>{children}</div>
}

// ──────────────────────────────────────────────────────────────────── Table

export interface Column<T> {
  key: string
  header: ReactNode
  /** Right-aligned mono cell. */
  numeric?: boolean
  width?: string
  render: (row: T, index: number) => ReactNode
}

export interface TableProps<T> {
  columns: readonly Column<T>[]
  rows: readonly T[]
  rowKey: (row: T, index: number) => string
  onRowClick?: (row: T, index: number) => void
  activeKey?: string | null
  dense?: boolean
  empty?: ReactNode
  className?: string
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  activeKey,
  dense,
  empty,
  className,
}: TableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>
  return (
    <div className={clsx(s.tableWrap, className)}>
      <table className={clsx(s.table, dense && s.tableDense)}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width }} className={clsx(c.numeric && s.numCell)}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row, i)
            return (
              <tr
                key={key}
                className={clsx(onRowClick && s.rowClickable, activeKey === key && s.rowActive)}
                onClick={onRowClick ? () => onRowClick(row, i) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={clsx(c.numeric && s.numCell)}>
                    {c.render(row, i)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ───────────────────────────────────────────────────────────────── Skeleton

export interface SkeletonProps {
  width?: string | number
  height?: string | number
  /** Text-line shaped, for paragraph placeholders. */
  text?: boolean
  radius?: string
  className?: string
}

export function Skeleton({ width, height, text, radius, className }: SkeletonProps) {
  return (
    <div
      className={clsx(s.skeleton, text && s.skeletonText, className)}
      style={{ width: width ?? '100%', height: text ? undefined : (height ?? 16), borderRadius: radius }}
    />
  )
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={className}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} text width={i === lines - 1 ? '62%' : '100%'} />
      ))}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────── Empty

export interface EmptyProps {
  icon?: IconName
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}

export function Empty({ icon, title, children, action, className }: EmptyProps) {
  return (
    <div className={clsx(s.empty, className)}>
      {icon ? <Icon name={icon} size={28} className={s.emptyIcon} /> : null}
      {title ? <div className={s.emptyTitle}>{title}</div> : null}
      {children ? <div className={s.emptyBody}>{children}</div> : null}
      {action ? <div className={s.emptyAction}>{action}</div> : null}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────── Spinner

export function Spinner({ large, className }: { large?: boolean; className?: string }) {
  return <span className={clsx(s.spinner, large && s.spinnerLg, className)} role="status" aria-label="Loading" />
}

// ─────────────────────────────────────────────────────────────────── Avatar

export interface AvatarProps {
  /** Pass a whole `User` and the emoji/colour/initials are worked out. */
  user?: Pick<User, 'name' | 'avatar_emoji' | 'avatar_color'> | null
  emoji?: string | null
  name?: string | null
  color?: string | null
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Coloured ring — "this is you", or the actor colour. */
  ring?: string
  className?: string
}

export function Avatar({ user, emoji, name, color, size = 'md', ring, className }: AvatarProps) {
  const glyph = emoji ?? user?.avatar_emoji ?? null
  const who = name ?? user?.name ?? null
  const bg = color ?? user?.avatar_color ?? null
  return (
    <span
      className={clsx(
        s.avatar,
        size === 'sm' && s.avatarSm,
        size === 'lg' && s.avatarLg,
        size === 'xl' && s.avatarXl,
        ring && s.avatarRing,
        className,
      )}
      style={{
        background: bg ?? undefined,
        color: ring ?? undefined,
        borderColor: bg ?? undefined,
      }}
      title={who ?? undefined}
      aria-hidden={!who}
    >
      <span style={{ color: bg ? 'var(--ink-inv)' : undefined }}>{glyph ?? initials(who)}</span>
    </span>
  )
}

export function AvatarStack({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx(s.avatarStack, className)}>{children}</span>
}
