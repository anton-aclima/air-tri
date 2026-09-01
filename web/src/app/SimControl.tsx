/**
 * air — the simulation control panel.
 *
 * Every number in this product is generated, and the demo is driven by a single
 * variable: what time it is. That variable was previously implicit — "now" came
 * from the viewer's wall clock, and the dataset silently ended at whatever
 * instant it was built. A demo shown three days later opened on empty wind
 * queries and alerts aged "up 2 d 21 h", which reads as a broken product rather
 * than as the end of the data.
 *
 * So the `SIMULATED DATA` marker, which the contract already requires on every
 * screen, becomes the door to the machinery behind it: set the clock, run it,
 * and see the dataset's real extent. Being able to say "this is generated, and
 * here is the generator" is a stronger honesty claim than a badge alone.
 */

import { useEffect, useMemo, useState } from 'react'

import { Button, Field, Modal, Segmented, Select, Toggle } from '@/app/ui'
import { fmtDayFull, fmtTime24 } from '@/core/format'
import { useBootstrap, useCampaignInfo } from '@/core/queries'
import { PLAYBACK_SPEEDS, resolveNow, useSession } from '@/core/session'

import s from '@/app/SimControl.module.css'

const STEPS: { label: string; hours: number }[] = [
  { label: '−24 h', hours: -24 },
  { label: '−6 h', hours: -6 },
  { label: '−1 h', hours: -1 },
  { label: '+1 h', hours: 1 },
  { label: '+6 h', hours: 6 },
  { label: '+24 h', hours: 24 },
]

const WINDOWS = [
  { value: '1', label: '1 hour' },
  { value: '6', label: '6 hours' },
  { value: '24', label: '24 hours' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
  { value: '720', label: '30 days' },
  { value: '2160', label: '90 days — the whole campaign' },
]

/** `Date` → the `YYYY-MM-DDTHH:mm` a `datetime-local` input wants, in local time. */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function SimControl({ open, onClose }: { open: boolean; onClose: () => void }) {
  const time = useSession((x) => x.time)
  const setTimeCursor = useSession((x) => x.setTimeCursor)
  const stepTime = useSession((x) => x.stepTime)
  const goLive = useSession((x) => x.goLive)
  const setPlaying = useSession((x) => x.setPlaying)
  const setSpeed = useSession((x) => x.setSpeed)
  const setWindowHours = useSession((x) => x.setWindowHours)

  const campaign = useCampaignInfo()
  const flags = useBootstrap().data?.flags
  const generatedAt = flags?.generated_at ?? null

  const now = resolveNow(time)
  const [draft, setDraft] = useState(() => toLocalInput(now))
  // Keep the field in step with the clock while it is running or being nudged,
  // but never fight the user mid-edit.
  useEffect(() => { if (open) setDraft(toLocalInput(resolveNow(time))) }, [open, time])

  /**
   * How far the wall clock has run past the end of the generated data.
   *
   * This is the failure that is worth surfacing: nothing errors, queries just
   * come back empty and every "up for" duration inflates.
   */
  const drift = useMemo(() => {
    if (!generatedAt || time.cursor) return null
    const end = new Date(generatedAt).getTime()
    const hours = (Date.now() - end) / 3_600_000
    return hours > 2 ? { end, hours } : null
  }, [generatedAt, time.cursor])

  const apply = (value: string) => {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return
    // Never scrub past the end of the data — there is nothing there.
    const cap = generatedAt ? new Date(generatedAt).getTime() : Date.now()
    setTimeCursor(new Date(Math.min(d.getTime(), cap)).toISOString())
  }

  return (
    <Modal open={open} onClose={onClose} title="Simulation control" wide>
      <div className={s.body}>
        <section className={s.section}>
          <div className={s.clockRow}>
            <div>
              <div className={s.clockLabel}>The demo's now</div>
              <div className={`${s.clock} num`}>{fmtTime24(now)}</div>
              <div className={s.clockDay}>{fmtDayFull(now)}</div>
            </div>
            <span className={time.cursor ? s.pinChip : s.liveChip}>
              {time.cursor ? 'Pinned' : 'Following the clock'}
            </span>
          </div>

          {drift ? (
            <div className={s.drift}>
              <strong>The wall clock is {Math.round(drift.hours / 24)} day
                {Math.round(drift.hours / 24) === 1 ? '' : 's'} past the end of this dataset.</strong>
              {' '}Live windows are querying a period the generator never filled, so wind and
              readings come back empty and every duration reads too long. Pin the clock to the
              end of the data to see the demo as it was built.
              <div className={s.driftAct}>
                <Button size="sm" onClick={() => generatedAt && setTimeCursor(generatedAt)}>
                  Pin to end of data
                </Button>
              </div>
            </div>
          ) : null}

          <div className={s.steps}>
            {STEPS.map((st) => (
              <Button key={st.label} size="sm" variant="secondary" onClick={() => stepTime(st.hours)}>
                {st.label}
              </Button>
            ))}
          </div>

          <div className={s.setRow}>
            <Field label="Set the clock">
              <input
                className={s.dt}
                type="datetime-local"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={(e) => apply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') apply((e.target as HTMLInputElement).value) }}
              />
            </Field>
            <div className={s.setActions}>
              <Button size="sm" variant="secondary" onClick={() => apply(draft)}>Set</Button>
              <Button size="sm" variant="ghost" onClick={goLive} disabled={!time.cursor}>
                Follow the clock
              </Button>
            </div>
          </div>
        </section>

        <section className={s.section}>
          <div className={s.rowHead}>Playback</div>
          <div className={s.controls}>
            <Toggle
              checked={time.playing}
              onChange={setPlaying}
              label={time.playing ? 'Running' : 'Paused'}
            />
            <Segmented
              value={String(time.speed)}
              onValueChange={(v) => setSpeed(Number(v))}
              options={PLAYBACK_SPEEDS.map((sp) => ({
                value: String(sp),
                label: `${sp}×`,
                title: `${sp} simulated minutes per real second`,
              }))}
            />
          </div>
          <p className={s.note}>
            Speed is simulated minutes per real second. Everything on screen re-queries as the
            clock moves — this is what drives the whole demo.
          </p>
        </section>

        <section className={s.section}>
          <div className={s.rowHead}>Analysis window</div>
          <Select
            value={String(time.windowHours)}
            onValueChange={(v) => setWindowHours(Number(v))}
            options={WINDOWS}
          />
          <p className={s.note}>
            How far back every trailing series looks from the clock above. Widening it fills the
            wind field and the histories; narrowing it sharpens what counts as “now”.
          </p>
        </section>

        <section className={s.section}>
          <div className={s.rowHead}>This dataset</div>
          <dl className={s.facts}>
            <dt>Campaign</dt><dd>{campaign?.name ?? '—'}</dd>
            <dt>Covers</dt>
            <dd className="num">{campaign ? `${campaign.start_date} → ${campaign.end_date}` : '—'}</dd>
            <dt>Generated</dt>
            <dd className="num">{generatedAt ? generatedAt.replace('T', ' ') : '—'}</dd>
            <dt>Fleet</dt>
            <dd className="num">
              {campaign ? `${campaign.fleet_size} vehicles · ${campaign.target_passes} passes target` : '—'}
            </dd>
            <dt>Community fleet delay</dt>
            <dd className="num">{flags ? `${flags.community_fleet_delay_min} min` : '—'}</dd>
            <dt>Advisor</dt><dd>{flags?.advisor_mode ?? '—'}</dd>
          </dl>
          <p className={s.note}>
            Real streets and real neighbourhood names. Every person, company, agency, reading
            and alert is invented.
          </p>
        </section>
      </div>
    </Modal>
  )
}
