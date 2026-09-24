/**
 * air — the persona switcher.
 *
 * Four doors, each rendered *in its own real skin* (`data-role` on the card),
 * so the four worlds are visibly different products before you even enter one.
 * ⌘K opens it, 1–4 pick a door, ⌥1–⌥4 skip it entirely.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

import s from '@/app/RoleSwitcher.module.css'
import { Avatar, Icon, Kbd } from '@/app/ui'
import { SimulatedBadge } from '@/app/SimulatedBadge'
import { ROLES, ROLE_ORDER, type RoleMeta } from '@/core/roles'
import { useSession } from '@/core/session'
import { useCampaignInfo, useUsers } from '@/core/queries'
import { useRoleSwitch } from '@/app/useRoleSwitch'
import type { Role, User } from '@/core/types'

function Door({
  meta,
  current,
  index,
  personas,
  onPick,
}: {
  meta: RoleMeta
  current: boolean
  index: number
  personas: User[]
  onPick: (role: Role, user?: User | null) => void
}) {
  return (
    <button
      type="button"
      data-role={meta.role}
      className={clsx(s.door, current && s.doorCurrent)}
      style={{
        ['--role-accent' as string]: meta.accentVar,
        animationDelay: `${index * 55}ms`,
      }}
      onClick={() => onPick(meta.role)}
    >
      <span className={s.doorTop}>
        <span className={s.doorIcon}>
          <Icon name={meta.icon} size={20} />
        </span>
        <span>
          <span className={s.doorTitle}>{meta.label}</span>
          <span className={s.doorOrg}>{meta.org}</span>
        </span>
        <span className={s.hotkey}>
          <Kbd>{meta.hotkey}</Kbd>
        </span>
      </span>

      <span className={s.tagline}>{meta.tagline}</span>
      <span className={s.blurb}>{meta.blurb}</span>

      <span className={s.wants}>
        {meta.wants.map((w) => (
          <span key={w} className={s.want}>
            <span className={s.wantDot} />
            {w}
          </span>
        ))}
      </span>

      <span className={s.personas}>
        {personas.length === 0 ? (
          <span className={s.personaHint}>Enter as {meta.label}</span>
        ) : (
          personas.slice(0, 2).map((u) => (
            <span
              key={u.id}
              className={s.personaBtn}
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation()
                onPick(meta.role, u)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.stopPropagation()
                  onPick(meta.role, u)
                }
              }}
            >
              <Avatar user={u} size="sm" />
              <span className={s.personaName}>{u.name}</span>
            </span>
          ))
        )}
      </span>
    </button>
  )
}

export function RoleSwitcher() {
  const open = useSession((st) => st.switcherOpen)
  const role = useSession((st) => st.role)
  const setSwitcherOpen = useSession((st) => st.setSwitcherOpen)
  const switchTo = useRoleSwitch()
  const users = useUsers()
  const campaign = useCampaignInfo()
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const digit = Number(e.key)
      if (digit >= 1 && digit <= ROLE_ORDER.length) {
        e.preventDefault()
        switchTo(ROLE_ORDER[digit - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, switchTo])

  if (!open) return null

  return createPortal(
    <div
      className={s.scrim}
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label="Choose an interface"
      onPointerDown={(e) => e.target === e.currentTarget && setSwitcherOpen(false)}
    >
      <header className={s.head}>
        <span className={s.wordmark}>air</span>
        <span className={s.headText}>
          One dataset. Four products. {campaign?.name ?? 'Southwest Memphis Community Air Monitoring'}
          {campaign?.subtitle ? ` · ${campaign.subtitle}` : ''}
        </span>
        <SimulatedBadge />
      </header>

      <div className={s.doors}>
        {ROLE_ORDER.map((r, i) => (
          <Door
            key={r}
            index={i}
            meta={ROLES[r]}
            current={role === r}
            personas={users.filter((u) => u.role === r)}
            onPick={switchTo}
          />
        ))}
      </div>

      <footer className={s.foot}>
        <span className={s.footItem}>
          <Kbd>1</Kbd>–<Kbd>4</Kbd> choose
        </span>
        <span className={s.footItem}>
          <Kbd>⌥</Kbd>+<Kbd>1</Kbd>–<Kbd>4</Kbd> switch from anywhere
        </span>
        <span className={s.footItem}>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd> reopen
        </span>
        <span className={s.footItem}>
          <Kbd>esc</Kbd> close
        </span>
      </footer>
    </div>,
    document.body,
  )
}

/** The full-screen cross-fade played while the skin changes. */
export function RoleWipe({ role }: { role: Role }) {
  const meta = ROLES[role]
  return createPortal(
    <div className={s.wipe} style={{ ['--role-accent' as string]: meta.accentVar }} aria-hidden>
      <span className={s.wipeLabel}>{meta.label}</span>
    </div>,
    document.body,
  )
}
