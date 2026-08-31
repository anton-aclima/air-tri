import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export interface Size { width: number; height: number }

/**
 * Measure an element. Charts are responsive: they size to their container and
 * lay out from the measured box, so nothing overflows and the x-axis band is
 * always inside the frame.
 */
export function useSize<T extends Element>(fallback: Size = { width: 640, height: 240 }): [RefObject<T | null>, Size] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<Size>(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        const h = e.contentRect.height;
        setSize((prev) => (Math.abs(prev.width - w) < 0.5 && Math.abs(prev.height - h) < 0.5
          ? prev
          : { width: w || prev.width, height: h || prev.height }));
      }
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    if (r.width) setSize({ width: r.width, height: r.height || fallback.height });
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, size];
}
