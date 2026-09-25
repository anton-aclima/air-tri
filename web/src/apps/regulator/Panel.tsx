/**
 * The regulator's card: a titled panel whose body owns its own overflow, so a
 * page at 960 px and wider never scrolls (F4). Its own file so that `lib.tsx`
 * exports no component and the screens keep fast refresh.
 */

import type { ReactNode } from 'react'

import s from './regulator.module.css'

function Caps({ children }: { children: ReactNode }) {
  return <span className={`${s.caps} ${s.capsInk}`}>{children}</span>
}

export function Panel({
  title, aside, children, className, bodyClass, flat,
}: {
  title?: ReactNode
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  flat?: boolean
}) {
  return (
    <section className={[s.panel, flat ? s.panelFlat : '', className ?? ''].filter(Boolean).join(' ')}>
      {title ? (
        <header className={s.panelHead}>
          <Caps>{title}</Caps>
          <span className={s.spacer} />
          {aside}
        </header>
      ) : null}
      <div className={[s.panelBody, bodyClass ?? ''].filter(Boolean).join(' ')}>{children}</div>
    </section>
  )
}
