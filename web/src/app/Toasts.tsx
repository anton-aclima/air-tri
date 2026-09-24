/**
 * air — the live notification surface.
 *
 * Every toast here came off the SSE stream in `core/live.ts`, which means it
 * came from something *somebody else* did in another interface. Clicking one
 * navigates the current role to wherever that thing lives for them.
 *
 * Its age is measured from the demo's now. A write is stamped at the end of the
 * data (the server's frozen now), so at the end it reads "just now", and while
 * replaying an earlier moment it still reads "just now" rather than "in 16 d":
 * it did just happen, in the room next door (docs/PLAN-refocus.md D1).
 */

import { useNavigate } from '@tanstack/react-router'

import s from '@/app/Toasts.module.css'
import { Icon } from '@/app/ui'
import { useLive, useLiveToasts, type Toast } from '@/core/live'
import { severityVar } from '@/core/measures'
import { actorVar } from '@/core/measures'
import { relativeTime } from '@/core/format'
import { useNowCampaign } from '@/core/session'
import type { IconName } from '@/core/roles'
import { ROLES } from '@/core/roles'

const GLYPH: Record<Toast['type'], IconName> = {
  alert: 'alert',
  concern: 'report',
  advisory: 'megaphone',
  post: 'feed',
  mitigation: 'check',
  action_level: 'threshold',
  fleet: 'fleet',
  simulate: 'director',
  activity: 'oversight',
  hello: 'aclima',
}

export function ToastHost() {
  const toasts = useLiveToasts()
  const dismiss = useLive((st) => st.dismiss)
  const navigate = useNavigate()
  const now = useNowCampaign()

  if (toasts.length === 0) return null

  return (
    <div className={s.host} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={s.toast}
          style={{
            ['--tone' as string]: severityVar(t.severity),
            ['--actor' as string]: actorVar(t.actorRole),
          }}
          onClick={() => {
            if (t.href) void navigate({ to: t.href })
            dismiss(t.id)
          }}
        >
          <span className={s.bar} aria-hidden />
          <Icon name={GLYPH[t.type] ?? 'oversight'} size={15} className={s.glyph} />
          <div className={s.text}>
            <div className={s.title}>{t.title}</div>
            {t.body ? <div className={s.body}>{t.body}</div> : null}
            <div className={s.meta}>
              {t.actorRole ? <span className={s.actor}>{ROLES[t.actorRole].label}</span> : null}
              <span>{relativeTime(t.at, now)}</span>
            </div>
          </div>
          <button
            type="button"
            className={s.close}
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation()
              dismiss(t.id)
            }}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}
