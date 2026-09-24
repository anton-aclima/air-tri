/**
 * MiniRose — which way the wind usually came from, as map furniture.
 *
 * PLAN-refocus C3 / owner decision D3: the community map's "Usually" mode drew
 * nothing, which read as broken. What it draws instead is this — one small
 * rose beside the scale, TIED TO NO COMPANY. It is fed the campaign's
 * met-record rose (`WindClimatology.rose`), which describes the wind over the
 * whole area and says nothing about any site. A fan at each site was the
 * alternative and was rejected: the default view would then point a shape
 * from Ridgeline at Boxtown (PLAN-plume Decision 10).
 *
 * Deliberately NOT `WindRose` at a small size. That is a chart — grid rings
 * with a percentage, filled petals, a hover readout, a table twin — and every
 * one of those is wrong here:
 *
 *  - **No numbers.** Community copy carries no units, and a percentage at
 *    64 px is a number nobody can read and everybody will quote.
 *  - **Outline only.** On this map a fill means measurement (CONTRACT §10b):
 *    the coloured streets. A filled rose over them would read as one more
 *    measured thing.
 *  - **Frequency only, 16 sectors.** Petals scale to the largest sector, so
 *    the rim is "most often", not a value.
 *
 * Styled from tokens by class (furniture.module.css), so it follows the role
 * skin without a theme read.
 */

import type { CSSProperties, ReactNode } from 'react';
import { compassWords } from '@/core/format';
import { openPetal } from '../../charts/roseGeometry';
import s from './furniture.module.css';

/** One sector. `WindClimatology.rose` and `RoseBin[]` both fit. */
export interface MiniRoseBin { dir_deg: number; freq: number }

export interface MiniRoseProps {
  /**
   * Pre-binned frequencies — `WindClimatology.rose` (percent) or any
   * `RoseBin[]` (fraction). The unit does not matter: petals are scaled to the
   * largest sector, and nothing is printed. Re-binned to 16 sectors by
   * nearest direction.
   */
  rose: readonly MiniRoseBin[] | null | undefined;
  /** Diameter in px. Default 64. */
  size?: number;
  /** A short line beside the rose, e.g. `PLUME_COPY.usually.mapKey`. */
  caption?: ReactNode;
  /**
   * The rose's accessible name. Default names the most common direction in
   * words — "Wind rose. The wind came most often from the south-southwest."
   */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

const SECTORS = 16;
const STEP = 360 / SECTORS;
/** Petal half-width as a share of a sector, as `WindRose` draws them. */
const HALF = 0.42;

function binned(rose: readonly MiniRoseBin[]): number[] {
  const out = Array.from({ length: SECTORS }, () => 0);
  for (const b of rose) {
    if (!Number.isFinite(b.dir_deg) || !Number.isFinite(b.freq) || b.freq <= 0) continue;
    const d = ((b.dir_deg % 360) + 360) % 360;
    out[Math.round(d / STEP) % SECTORS] += b.freq;
  }
  return out;
}

export function MiniRose(props: MiniRoseProps) {
  const { rose, size = 64, caption, label, className, style } = props;

  const freq = rose?.length ? binned(rose) : null;
  const max = freq ? Math.max(...freq) : 0;
  // Nothing to say, so say nothing: furniture that renders an empty circle
  // while the climatology loads reads as "the wind never blew".
  if (!freq || !(max > 0)) return null;

  const c = size / 2;
  // Room above the rim for the N; the same margin all round keeps it centred.
  const rMax = c - 8;
  // The hub, where the petals' open inner ends stop. A fifth of the radius:
  // any smaller and sixteen sides converge into a dark knot at 64 px.
  const r0 = Math.max(3, rMax * 0.2);
  const top = freq.indexOf(max);
  const name = label ?? `Wind rose. The wind came most often from the ${compassWords(top * STEP)}.`;

  return (
    <div className={[s.miniRose, className].filter(Boolean).join(' ')} style={style}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={name}
        className={s.miniRoseSvg}
      >
        <circle cx={c} cy={c} r={rMax} className={s.miniRoseRim} />
        <line x1={c} y1={c - rMax} x2={c} y2={c - rMax + 3} className={s.miniRoseRim} />
        <text
          x={c} y={c - rMax - 2.5}
          textAnchor="middle"
          fontSize={Math.max(7, size * 0.11)}
          className={s.miniRoseNorth}
        >N</text>
        {freq.map((f, i) => {
          const r1 = r0 + (rMax - r0) * (f / max);
          // A petal under a pixel long is a smudge on the hub, not a direction.
          if (r1 - r0 < 1) return null;
          const deg = i * STEP;
          return (
            <path
              key={deg}
              d={openPetal(c, c, r0, r1, deg - STEP * HALF, deg + STEP * HALF)}
              className={s.miniRosePetal}
            />
          );
        })}
        <circle cx={c} cy={c} r={r0} className={s.miniRoseHub} />
      </svg>
      {caption ? <span className={s.miniRoseCaption}>{caption}</span> : null}
    </div>
  );
}
