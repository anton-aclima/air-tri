/**
 * LayerToggles — what is on the map right now.
 *
 * Each row carries its own mark key (the same stroke or dot the layer draws), so
 * the panel doubles as a legend for the non-measurement layers. Counts are shown
 * when supplied — "3 towers, 0 alerts" answers a question the map cannot.
 */

import type { CSSProperties } from 'react';
import s from './furniture.module.css';

export interface LayerToggleItem {
  id: string;
  label: string;
  enabled: boolean;
  /** Resolved colour for the row's key. Pass `theme.css('tower')` etc. */
  color?: string;
  /** 'line' draws a stroke key, 'dot' a round one. Default 'line'. */
  keyShape?: 'line' | 'dot';
  count?: number | null;
  disabled?: boolean;
}

export interface LayerTogglesProps {
  items: LayerToggleItem[];
  onToggle(id: string, next: boolean): void;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function LayerToggles(props: LayerTogglesProps) {
  const { items, onToggle, title = 'Layers', className, style } = props;
  return (
    <div
      className={[s.panel, s.toggles, className].filter(Boolean).join(' ')}
      style={style}
      role="group"
      aria-label={title}
    >
      <span className={s.capLabel}>{title}</span>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className={[s.toggle, it.enabled ? s.toggleOn : ''].filter(Boolean).join(' ')}
          aria-pressed={it.enabled}
          disabled={it.disabled}
          onClick={() => onToggle(it.id, !it.enabled)}
        >
          <span className={[s.toggleBox, it.enabled ? s.toggleBoxOn : ''].filter(Boolean).join(' ')}>
            {it.enabled ? '✓' : ''}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {it.color && (
              <span
                className={it.keyShape === 'dot' ? undefined : s.toggleKey}
                style={it.keyShape === 'dot'
                  ? {
                    inlineSize: 8, blockSize: 8, borderRadius: 999,
                    background: it.color, display: 'inline-block',
                  }
                  : { background: it.color }}
              />
            )}
            {it.label}
          </span>
          {it.count !== null && it.count !== undefined && (
            <span className={s.toggleCount}>{it.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
