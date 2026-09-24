/**
 * PlumeSwatch — the legend mark for one model register.
 *
 * A few pixels of the same stroke the map draws, read from the same
 * `PLUME_STROKE` table as `DispersionLayer` style 'outline' and
 * `FiledStudyLayer`, so the key cannot drift from the marks it explains.
 * CONTRACT §10b asks for the registers to be told apart before a label is
 * read, and a key whose dash differs from the map's is a label that lies.
 *
 * Colour is `var(--token)`, not a resolved value, so it follows the role skin
 * it sits in with no theme hook. `model` ends in the reach tick, as the axis
 * does on the map — the line reaches the tick and the claim stops there.
 */

import type { CSSProperties } from 'react';
import { PLUME_STROKE } from '../../lib/vizmeta';
import type { PlumeRegister } from '../../lib/vizmeta';

export interface PlumeSwatchProps {
  register: Exclude<PlumeRegister, 'axis'>;
  /** Pixel length of the stroke. Default 22. */
  width?: number;
  className?: string;
  style?: CSSProperties;
}

export function PlumeSwatch(props: PlumeSwatchProps) {
  const { register, width = 22, className, style } = props;
  const spec = PLUME_STROKE[register];
  const h = 10;
  const mid = h / 2;
  // deck.gl dashes are multiples of the line width; SVG's are pixels.
  const dash = spec.dash ? spec.dash.map((d) => d * spec.width).join(' ') : undefined;
  const stroke = `var(--${spec.token})`;
  return (
    <svg
      className={className}
      style={{ flex: 'none', verticalAlign: 'middle', ...style }}
      width={width}
      height={h}
      viewBox={`0 0 ${width} ${h}`}
      aria-hidden="true"
      focusable="false"
    >
      <line
        x1={0.5} y1={mid} x2={width - 0.5} y2={mid}
        stroke={stroke}
        strokeOpacity={spec.alpha}
        strokeWidth={spec.width}
        strokeDasharray={dash}
      />
      {register === 'model' && (
        <line
          x1={width - 1} y1={mid - 3.5} x2={width - 1} y2={mid + 3.5}
          stroke={stroke}
          strokeOpacity={spec.alpha}
          strokeWidth={1.35}
        />
      )}
    </svg>
  );
}
