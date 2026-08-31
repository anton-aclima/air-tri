/**
 * air — surface primitives.
 * Card · Panel · Tabs · Tooltip · Modal · Sheet · Divider · Toolbar.
 */

import clsx from 'clsx'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import s from '@/design/primitives.module.css'
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
  className?: string
  children: ReactNode
}

export function Tooltip({ content, title, below, className, children }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span
      className={clsx(s.tipWrap, className)}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
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
