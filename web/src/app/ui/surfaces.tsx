/**
 * air — surface primitives.
 * Card · Panel · Tabs · Tooltip · Popover · Modal · Sheet · Divider · Toolbar.
 */

import clsx from 'clsx'
import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type HTMLAttributes, type ReactNode, type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

import s from '@/design/primitives.module.css'
import p from '@/app/ui/popover.module.css'
import { Icon } from '@/app/ui/Icon'
import { IconButton } from '@/app/ui/controls'
import type { IconName } from '@/core/roles'

// ───────────────────────────────────────────────────────────────────── Card

export interface CardProps {
  title?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  /** Skip the internal padding — for a map or a chart that should bleed. */
  flush?: boolean
  interactive?: boolean
  className?: string
  bodyClassName?: string
  onClick?: () => void
  children?: ReactNode
}

export function Card({
  title,
  actions,
  footer,
  flush,
  interactive,
  className,
  bodyClassName,
  onClick,
  children,
}: CardProps) {
  const clickable = interactive || !!onClick
  return (
    <div
      className={clsx(s.card, clickable && s.cardInteractive, className)}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
    >
      {title || actions ? (
        <div className={s.cardHeader}>
          <div className={s.cardTitle}>{title}</div>
          {actions}
        </div>
      ) : null}
      {children != null ? (
        <div className={clsx(!flush && s.cardBody, bodyClassName)}>{children}</div>
      ) : null}
      {footer ? <div className={s.cardFooter}>{footer}</div> : null}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────── Panel

export interface PanelProps {
  title?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  /** Pad the scrolling body. */
  pad?: boolean
  /** No border, no background — for a pane already inside a frame. */
  flush?: boolean
  className?: string
  bodyClassName?: string
  children?: ReactNode
}

/** The dense console container: sticky micro-label header, scrolling body. */
export function Panel({
  title,
  actions,
  footer,
  pad,
  flush,
  className,
  bodyClassName,
  children,
}: PanelProps) {
  return (
    <section className={clsx(s.panel, flush && s.panelFlush, className)}>
      {title || actions ? (
        <header className={s.panelHeader}>
          <h2 className={s.panelTitle}>{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={clsx(s.panelBody, pad && s.panelPad, bodyClassName)}>{children}</div>
      {footer ? <footer className={s.panelFooter}>{footer}</footer> : null}
    </section>
  )
}

export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx(s.toolbar, className)}>{children}</div>
}

export function Spacer() {
  return <span className={s.spacer} />
}

export function Divider({ vertical, className }: { vertical?: boolean; className?: string }) {
  return <span className={clsx(vertical ? s.dividerV : s.divider, className)} />
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={s.kbd}>{children}</kbd>
}

// ───────────────────────────────────────────────────────────────────── Tabs

export interface TabItem<T extends string = string> {
  value: T
  label: string
  icon?: IconName
  count?: number
}

export interface TabsProps<T extends string = string> {
  value: T
  items: readonly TabItem<T>[]
  onValueChange: (value: T) => void
  /** Pill style instead of an underline. */
  pill?: boolean
  className?: string
}

export function Tabs<T extends string = string>({
  value,
  items,
  onValueChange,
  pill,
  className,
}: TabsProps<T>) {
  return (
    <div className={clsx(s.tabs, pill && s.tabsPill, className)} role="tablist">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          className={clsx(s.tab, item.value === value && s.tabActive)}
          onClick={() => onValueChange(item.value)}
        >
          {item.icon ? <Icon name={item.icon} size={14} /> : null}
          {item.label}
          {item.count != null ? <span className={s.tabCount}>{item.count}</span> : null}
        </button>
      ))}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────── Tooltip

export interface TooltipProps {
  content: ReactNode
  title?: string
  /** Open below instead of above. */
  below?: boolean
  /**
   * Keep it shut, whatever the pointer or focus does — for a control whose
   * own panel is open. The wrapper stays, so the child is not remounted (it
   * may be a popover's anchor, holding the focus and the anchor ref).
   */
  suppressed?: boolean
  className?: string
  children: ReactNode
}

export function Tooltip({ content, title, below, suppressed, className, children }: TooltipProps) {
  const [wanted, setWanted] = useState(false)
  const open = wanted && !suppressed
  const id = useId()
  return (
    <span
      className={clsx(s.tipWrap, className)}
      onPointerEnter={() => setWanted(true)}
      onPointerLeave={() => setWanted(false)}
      onFocus={() => setWanted(true)}
      onBlur={() => setWanted(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <span role="tooltip" id={id} className={clsx(s.tip, below && s.tipBottom)}>
          {title ? <strong className={s.tipTitle}>{title}</strong> : null}
          {content}
        </span>
      ) : null}
    </span>
  )
}

// ────────────────────────────────────────────────────────────────── Popover

/** The page gutter a popover keeps from the viewport edge, px. */
const POP_GUTTER = 16
/** Gap between the anchor's bottom edge and the popover, px. */
const POP_GAP = 8

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role'> {
  open: boolean
  onClose: () => void
  /** The element it hangs from. A press on it is not an outside click. */
  anchor: RefObject<HTMLElement | null>
  /** Which edge of the anchor the popover lines up with. */
  align?: 'start' | 'end'
  /** Preferred width, px. Never wider than the viewport less a 16px gutter each side. */
  width?: number
  /** Accessible name — a popover has no visible title to borrow one from. */
  label: string
  children?: ReactNode
}

/**
 * A non-modal panel hung under a control: no scrim, no blur, the page stays
 * live behind it. Closes on Esc (focus goes back to the anchor) or a press
 * outside both itself and the anchor.
 *
 * Portalled with fixed coordinates rather than absolutely placed inside the
 * anchor's parent, because the anchors live in the shell header, whose flex
 * row and stacking context would otherwise decide how wide it may be and what
 * it may paint over.
 *
 * On open, focus moves to the first `[data-autofocus]` inside, else to the
 * panel itself, so its keyboard handling works without a click first.
 */
export function Popover({
  open,
  onClose,
  anchor,
  align = 'end',
  width = 360,
  label,
  className,
  style,
  children,
  ...rest
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current
      if (!a) return
      const r = a.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const w = Math.min(width, vw - POP_GUTTER * 2)
      const want = align === 'end' ? r.right - w : r.left
      const left = Math.max(POP_GUTTER, Math.min(want, vw - POP_GUTTER - w))
      setPos({ top: r.bottom + POP_GAP, left, width: w })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, anchor, align, width])

  // Once per opening — not whenever the caller hands in a new `onClose` — and
  // only once it has been placed. The first frame of the first opening is
  // `visibility: hidden` (no position yet), and focus() on a hidden element
  // does nothing: measured on a fresh load, focus stayed on the chip, so Space
  // pressed the chip and shut the popover instead of playing. Later openings
  // reuse the last position, which is why only the first one failed.
  const placed = pos != null
  useEffect(() => {
    if (!open || !placed) return
    const el = ref.current
    const first = el?.querySelector<HTMLElement>('[data-autofocus]')
    ;(first ?? el)?.focus({ preventScroll: true })
  }, [open, placed])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      onClose()
      anchor.current?.focus({ preventScroll: true })
    }
    // Capture, so a map or a chart that stops propagation still closes it.
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchor])

  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      tabIndex={-1}
      className={clsx(p.pop, className)}
      style={{
        ...style,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: pos?.width ?? width,
        visibility: pos ? undefined : 'hidden',
      }}
      {...rest}
    >
      {children}
    </div>,
    document.body,
  )
}

// ──────────────────────────────────────────────────────────── Modal / Sheet

function useDismiss(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
}

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  footer?: ReactNode
  wide?: boolean
  className?: string
  children?: ReactNode
}

export function Modal({ open, onClose, title, footer, wide, className, children }: ModalProps) {
  useDismiss(onClose)
  if (!open) return null
  return createPortal(
    <div className={s.scrim} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx(s.modal, wide && s.modalWide, className)} role="dialog" aria-modal="true">
        {title ? (
          <header className={s.modalHeader}>
            <h2 className={s.modalTitle}>{title}</h2>
            <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          </header>
        ) : null}
        <div className={s.modalBody}>{children}</div>
        {footer ? <footer className={s.modalFooter}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}

export interface SheetProps extends Omit<ModalProps, 'wide'> {
  side?: 'right' | 'left' | 'bottom'
}

/** Edge-anchored drawer — segment detail, alert detail, report form. */
export function Sheet({ open, onClose, title, footer, side = 'right', className, children }: SheetProps) {
  useDismiss(onClose)
  if (!open) return null
  return createPortal(
    <div
      className={clsx(s.scrim, s.sheetScrim)}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={clsx(
          s.sheet,
          side === 'left' && s.sheetLeft,
          side === 'bottom' && s.sheetBottom,
          className,
        )}
        role="dialog"
        aria-modal="true"
      >
        {title ? (
          <header className={s.modalHeader}>
            <h2 className={s.modalTitle}>{title}</h2>
            <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
          </header>
        ) : null}
        <div className={s.modalBody}>{children}</div>
        {footer ? <footer className={s.modalFooter}>{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  )
}
