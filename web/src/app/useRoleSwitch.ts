/**
 * air — persona switching and shell hotkeys.
 *
 * Switching persona is the most-used control in the demo: it changes the role,
 * the theme, the routes and the entire visual language. It must feel like
 * stepping into a different product, and it must be fast.
 */

import { useCallback, useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { ROLES, ROLE_ORDER } from '@/core/roles'
import type { Role, User } from '@/core/types'
import { useSession } from '@/core/session'
import { refreshTokenCache } from '@/core/measures'

/** How long the cross-fade wipe is on screen. Keep in sync with the CSS. */
export const SWITCH_MS = 460

interface StartViewTransition {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> }
}

/**
 * Returns `switchTo(role, user?)`. Sets the role (and optionally the persona),
 * runs the cross-fade, and navigates to that role's landing route.
 */
export function useRoleSwitch(): (role: Role, user?: User | null) => void {
  const navigate = useNavigate()
  const setRole = useSession((s) => s.setRole)
  const setPersona = useSession((s) => s.setPersona)
  const setTransitioningTo = useSession((s) => s.setTransitioningTo)
  const setSwitcherOpen = useSession((s) => s.setSwitcherOpen)

  return useCallback(
    (role: Role, user?: User | null) => {
      const current = useSession.getState().role
      setSwitcherOpen(false)
      if (current === role && !user) {
        void navigate({ to: ROLES[role].landing })
        return
      }

      setTransitioningTo(role)

      const apply = () => {
        setRole(role)
        if (user) setPersona(user)
        // The per-role ramp aliases change with the skin.
        refreshTokenCache()
        void navigate({ to: ROLES[role].landing })
      }

      const doc = document as Document & StartViewTransition
      if (typeof doc.startViewTransition === 'function') {
        doc.startViewTransition(apply)
      } else {
        apply()
      }

      window.setTimeout(() => setTransitioningTo(null), SWITCH_MS)
    },
    [navigate, setPersona, setRole, setSwitcherOpen, setTransitioningTo],
  )
}

/**
 * Global keyboard shortcuts:
 *   ⌘K / Ctrl+K   toggle the persona switcher
 *   ⌥1 … ⌥4       jump straight to a role
 *   Esc           close the switcher
 *   , / .         step the time cursor an hour
 *   L             snap the time cursor back to live
 */
export function useShellHotkeys(): void {
  const switchTo = useRoleSwitch()
  const toggleSwitcher = useSession((s) => s.toggleSwitcher)
  const setSwitcherOpen = useSession((s) => s.setSwitcherOpen)
  const stepTime = useSession((s) => s.stepTime)
  const goLive = useSession((s) => s.goLive)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        toggleSwitcher()
        return
      }

      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const digit = Number(e.key)
        if (digit >= 1 && digit <= ROLE_ORDER.length) {
          e.preventDefault()
          switchTo(ROLE_ORDER[digit - 1])
        }
        return
      }

      if (typing) return

      if (e.key === 'Escape') {
        setSwitcherOpen(false)
        return
      }
      if (e.key === ',') stepTime(-1)
      else if (e.key === '.') stepTime(1)
      else if (e.key.toLowerCase() === 'l') goLive()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goLive, setSwitcherOpen, stepTime, switchTo, toggleSwitcher])
}
