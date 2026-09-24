/**
 * air — the persona switcher.
 *
 * Four doors, each rendered *in its own real skin* (`data-role` on the card),
 * so the four worlds are visibly different products before you even enter one.
 * ⌘K opens it, 1–4 pick a door, ⌥1–⌥4 skip it entirely.
 *
 * Every persona is on its door. The door used to show the first two, which
 * left Riverport's terminal manager — the only way into the Riverport deck,
 * since no industry page picks a site — reachable only by editing
 * localStorage. The chips are compact (first name, the full name, title and
 * organisation on hover and to assistive tech), and a persona at a company
 * other than the door's own carries that company's short name, because on the
 * industry door the persona IS the choice of site.
 */

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

import s from '@/app/RoleSwitcher.module.css'
import { Avatar, Icon, Kbd } from '@/app/ui'
import { SimulatedBadge } from '@/app/SimulatedBadge'
import { ROLES, ROLE_ORDER, type RoleMeta } from '@/core/roles'
import { useSession } from '@/core/session'
import { useCampaignInfo, useOrgs, useUsers } from '@/core/queries'
import { useRoleSwitch } from '@/app/useRoleSwitch'
import type { Org, Role, User } from '@/core/types'

/**
 * The chip's name: the first name, without an honorific ("Dr. Priya
 * Raghunathan" → "Priya"). A team account named after its organisation
 * ("Aclima Data Ops") keeps its whole name — "Aclima" alone would read as the
 * company, not a person in it.
 */
function chipName(u: User, org: Org | undefined): string {
  const bare = u.name.replace(/^(dr|mr|mrs|ms|mx|prof)\.?\s+/i, '').trim()
  const first = bare.split(/\s+/)[0] ?? bare
  const orgWords = [org?.short_name, org?.name].filter(Boolean).map((w) => w!.split(/\s+/)[0].toLowerCase())
  return orgWords.includes(first.toLowerCase()) ? u.name : first
}

function Door({
  meta,
  current,
  index,
  personas,
  orgs,
  onPick,
}: {
  meta: RoleMeta
  current: boolean
  index: number
  personas: User[]
  orgs: Org[]
  onPick: (role: Role, user?: User | null) => void
}) {
  const orgOf = (u: User) => orgs.find((o) => o.id === u.org_id)
  // The door's own organisation (`meta.org`, by name): its personas need no
  // tag, and they come first. Everyone else, grouped by their company.
  const home = orgs.find((o) => o.name === meta.org)?.id ?? null
  const ordered = [...personas].sort((a, b) => {
    const ha = Number(a.org_id !== home)
    const hb = Number(b.org_id !== home)
    if (ha !== hb) return ha - hb
    const oa = orgOf(a)?.short_name ?? orgOf(a)?.name ?? ''
    const ob = orgOf(b)?.short_name ?? orgOf(b)?.name ?? ''
    return oa.localeCompare(ob) || a.name.localeCompare(b.name)
  })
  // Tag a persona with its company only on a door that spans companies
  // (industry): residents with no organisation are not "somewhere else".
  const spansCompanies = new Set(personas.map((u) => u.org_id).filter((o) => o != null)).size > 1
    && personas.every((u) => orgOf(u)?.kind === 'company')
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
          ordered.map((u) => {
            const org = orgOf(u)
            const tag = spansCompanies && u.org_id !== home ? (org?.short_name ?? org?.name ?? null) : null
            const full = [u.name, u.title, org?.name].filter(Boolean).join(' · ')
            return (
              <span
                key={u.id}
                className={s.personaBtn}
                role="button"
                tabIndex={0}
                title={full}
                aria-label={`Enter as ${full}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onPick(meta.role, u)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    onPick(meta.role, u)
                  }
                }}
              >
                <Avatar user={u} size="sm" className={s.personaAvatar} />
                <span className={s.personaName}>{chipName(u, org)}</span>
                {tag && <span className={s.personaOrg}>{tag}</span>}
              </span>
            )
          })
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
  const orgs = useOrgs()
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
            orgs={orgs}
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
