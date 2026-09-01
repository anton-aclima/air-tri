/**
 * Animation primitives. Every one of these is a no-op under
 * `prefers-reduced-motion: reduce` — the sweep freezes at a legible angle rather
 * than disappearing, so nothing is lost, only the motion.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/core/session';
import type { FleetPosition, Position } from '@/core/types';
import { alongPath, lerpPosition } from './geo';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/**
 * A 0→1 sawtooth that wraps every `periodMs`. The heartbeat behind the tower
 * sweep, the radar trace, the wind particles and the exceedance pulse.
 * Freezes at `frozenAt` under reduced motion, so the sweep is still *visible*,
 * just static.
 */
export function usePhase(periodMs = 3200, opts: { running?: boolean; frozenAt?: number } = {}): number {
  const { running = true, frozenAt = 0.18 } = opts;
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState(reduced ? frozenAt : 0);

  useEffect(() => {
    if (reduced || !running || periodMs <= 0) {
      setPhase(reduced ? frozenAt : 0);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const loop = (t: number) => {
      setPhase(((t - t0) % periodMs) / periodMs);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [periodMs, running, reduced, frozenAt]);

  return phase;
}

/** A 0→1→0 triangle wave. For pulsing new contacts / exceeding monitors. */
export function usePulse(periodMs = 1400, opts?: { running?: boolean }): number {
  const p = usePhase(periodMs, { ...opts, frozenAt: 1 });
  return p <= 0.5 ? p * 2 : 2 - p * 2;
}

/** `Date.now()` on a coarse interval — for "still up for 4h 12m" readouts. */
/**
 * "Now" as a ticking epoch — the DEMO's now, not the viewer's.
 *
 * Charts use this for a right-hand edge and for "still running" durations, so
 * it has to agree with the simulation clock. Reading `Date.now()` directly
 * meant pinning the clock moved every query and every age while a timeline's
 * axis stayed anchored to real time — the same event drawn in two different
 * places on one screen.
 *
 * A pinned cursor needs no interval; only a live clock ticks.
 */
export function useNow(intervalMs = 30_000): number {
  const cursor = useSession((s) => s.time.cursor);
  const [wall, setWall] = useState(() => Date.now());
  useEffect(() => {
    if (cursor) return undefined;
    const id = setInterval(() => setWall(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, cursor]);
  return cursor ? Date.parse(cursor) : wall;
}

function easeInOut(t: number) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

export interface AnimatedFleetPosition extends FleetPosition {
  /** Interpolated position for this frame. Feed this to `FleetLayer`. */
  animated: Position;
  /** Interpolated heading for this frame, degrees clockwise from north. */
  animatedHeading: number;
}

type Fix = { position: Position; heading: number };

/**
 * Smoothly walks each vehicle from where it visually was to where the newest poll
 * says it is, following the reported `trail` rather than cutting the corner — so
 * the dots look like they are driving the streets, not teleporting between them.
 *
 * `durationMs` should sit just under the poll interval.
 */
export function useFleetAnimation(
  positions: FleetPosition[] | undefined,
  opts: { durationMs?: number } = {},
): AnimatedFleetPosition[] {
  const { durationMs = 4000 } = opts;
  const reduced = useReducedMotion();
  const [frame, setFrame] = useState(0);
  const live = useRef(new Map<string, Fix>());
  const from = useRef(new Map<string, Fix>());
  const latest = useRef<FleetPosition[]>([]);
  latest.current = positions ?? [];

  const key = useMemo(
    () => (positions ?? []).map((p) => `${p.vehicle_id}@${p.ts}`).join('|'),
    [positions],
  );

  useEffect(() => {
    const list = latest.current;
    if (!list.length) return;

    // Snapshot the current visual state as this leg's origin.
    for (const p of list) {
      from.current.set(
        p.vehicle_id,
        live.current.get(p.vehicle_id) ?? { position: [p.lon, p.lat], heading: p.heading_deg ?? 0 },
      );
    }

    const commit = (e: number) => {
      for (const p of list) {
        const a = from.current.get(p.vehicle_id);
        const target: Position = [p.lon, p.lat];
        if (!a) {
          live.current.set(p.vehicle_id, { position: target, heading: p.heading_deg ?? 0 });
          continue;
        }
        const tail = p.trail && p.trail.length >= 2 ? p.trail.slice(-4) : null;
        if (tail) {
          const route: Position[] = [a.position, ...tail, target];
          const { position, heading } = alongPath(route, e);
          live.current.set(p.vehicle_id, { position, heading: e > 0.92 ? (p.heading_deg ?? heading) : heading });
        } else {
          live.current.set(p.vehicle_id, {
            position: lerpPosition(a.position, target, e),
            heading: p.heading_deg ?? a.heading,
          });
        }
      }
    };

    if (reduced || durationMs <= 0) {
      commit(1);
      setFrame((f) => f + 1);
      return;
    }

    let raf = 0;
    const t0 = performance.now();
    const loop = (t: number) => {
      const raw = Math.min(1, (t - t0) / durationMs);
      commit(easeInOut(raw));
      setFrame((f) => (f + 1) % 1_000_000);
      if (raw < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [key, durationMs, reduced]);

  return useMemo(() => (positions ?? []).map((p) => {
    const l = live.current.get(p.vehicle_id);
    return {
      ...p,
      animated: l?.position ?? [p.lon, p.lat],
      animatedHeading: l?.heading ?? p.heading_deg ?? 0,
    };
  }), [positions, frame]);
}
