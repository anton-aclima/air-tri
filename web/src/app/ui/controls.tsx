/**
 * air — interactive primitives.
 * Button · IconButton · Toggle · Slider · Select · Field · Input · Textarea ·
 * Segmented. Styling lives in `design/primitives.module.css`; every rule uses
 * semantic tokens, so all four skins work with zero component changes.
 */

import clsx from 'clsx'
import type {
  ButtonHTMLAttributes,
  ChangeEvent,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

import s from '@/design/primitives.module.css'
import { Icon } from '@/app/ui/Icon'
import type { IconName } from '@/core/roles'

// ─────────────────────────────────────────────────────────────────── Button

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'quiet' | 'danger' | 'cta'
export type ControlSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  size?: ControlSize
  icon?: IconName
  iconEnd?: IconName
  block?: boolean
  loading?: boolean
  children?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconEnd,
  block,
  loading,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={clsx(s.btn, s[variant], s[size], block && s.block, className)}
      {...rest}
    >
      {loading ? <span className={s.spinner} /> : icon ? <Icon name={icon} size={size === 'lg' ? 18 : 15} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={size === 'lg' ? 18 : 15} /> : null}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName
  label: string
  size?: ControlSize
  active?: boolean
  bordered?: boolean
}

export function IconButton({
  icon,
  label,
  size = 'md',
  active,
  bordered,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={clsx(
        s.iconBtn,
        size === 'sm' && s.iconBtnSm,
        size === 'lg' && s.iconBtnLg,
        bordered && s.iconBtnBordered,
        active && s.iconBtnActive,
        className,
      )}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : size === 'lg' ? 20 : 16} />
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────── Toggle

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  className?: string
}

export function Toggle({ checked, onChange, label, disabled, className }: ToggleProps) {
  return (
    <label className={clsx(s.toggle, disabled && s.toggleDisabled, className)}>
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className={clsx(s.toggleTrack, checked && s.toggleTrackOn)}>
        <span className={s.toggleKnob} />
      </span>
      {label ? <span className={s.toggleLabel}>{label}</span> : null}
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────── Slider

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  value: number
  min?: number
  max?: number
  step?: number
  onValueChange: (value: number) => void
  /** Formatted readout on the right. Pass `null` to hide it. */
  display?: string | null
}

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onValueChange,
  display,
  className,
  ...rest
}: SliderProps) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <span className={clsx(s.sliderWrap, className)}>
      <input
        type="range"
        className={s.slider}
        style={{ ['--slider-pct' as string]: `${pct}%` }}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onValueChange(Number(e.currentTarget.value))}
        {...rest}
      />
      {display === null ? null : <span className={s.sliderValue}>{display ?? value}</span>}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────── Field

export interface FieldProps {
  label?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  row?: boolean
  className?: string
  children: ReactNode
}

export function Field({ label, hint, error, required, row, className, children }: FieldProps) {
  return (
    <label className={clsx(s.field, row && s.fieldRow, className)}>
      {label ? (
        <span className={s.fieldLabel}>
          {label}
          {required ? <span className={s.fieldReq}>*</span> : null}
        </span>
      ) : null}
      {children}
      {error ? (
        <span className={s.fieldError}>{error}</span>
      ) : hint ? (
        <span className={s.fieldHint}>{hint}</span>
      ) : null}
    </label>
  )
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
  /** Mono + tabular numerals. */
  numeric?: boolean
}

export function Input({ invalid, numeric, className, ...rest }: InputProps) {
  return (
    <input
      className={clsx(s.input, invalid && s.inputInvalid, numeric && s.inputNum, className)}
      {...rest}
    />
  )
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export function Textarea({ invalid, className, ...rest }: TextareaProps) {
  return <textarea className={clsx(s.textarea, invalid && s.inputInvalid, className)} {...rest} />
}

// ─────────────────────────────────────────────────────────────────── Select

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T extends string = string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value' | 'children' | 'size'> {
  value: T
  options: readonly SelectOption<T>[]
  onValueChange: (value: T) => void
  size?: 'sm' | 'md'
}

export function Select<T extends string = string>({
  value,
  options,
  onValueChange,
  size = 'md',
  className,
  ...rest
}: SelectProps<T>) {
  return (
    <span className={clsx(s.selectWrap, className)}>
      <select
        className={clsx(s.select, size === 'sm' && s.selectSm)}
        value={value}
        onChange={(e) => onValueChange(e.currentTarget.value as T)}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <span className={s.selectArrow}>
        <Icon name="chevron" size={12} style={{ rotate: '90deg' }} />
      </span>
    </span>
  )
}

// ─────────────────────────────────────────────────────────────── Segmented

export interface SegmentedProps<T extends string = string> {
  value: T
  options: readonly { value: T; label: string; icon?: IconName; title?: string }[]
  onValueChange: (value: T) => void
  className?: string
}

/** The measure / metric / window picker. Compact, works in every skin. */
export function Segmented<T extends string = string>({
  value,
  options,
  onValueChange,
  className,
}: SegmentedProps<T>) {
  return (
    <div className={clsx(s.seg, className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          title={o.title ?? o.label}
          className={clsx(s.segItem, o.value === value && s.segItemActive)}
          onClick={() => onValueChange(o.value)}
        >
          {o.icon ? <Icon name={o.icon} size={13} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  )
}
