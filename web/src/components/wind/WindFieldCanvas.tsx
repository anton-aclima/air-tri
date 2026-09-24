/**
 * WindFieldCanvas — particle advection, earth.nullschool.net style.
 *
 * A canvas overlay, not deck.gl geometry, because the effect *is* frame history:
 * a few thousand particles are stepped through the field and each frame strokes a
 * 1px line from a particle's old position to its new one. Nothing clears the
 * canvas — instead the existing pixels are faded a few percent per frame, and
 * that decay is the trail.
 *
 * The fade uses `destination-in` at ~0.94 alpha rather than painting the
 * background colour over the top: this canvas sits above a live basemap and the
 * road grid, so it has to fade toward TRANSPARENT, not toward a colour. Painting
 * bg over it would grey out the map underneath.
 *
 * Two frames, one engine. The caller supplies a `Projector`, so the same particle
 * simulation runs over a Web Mercator map (regulator) and inside a site-locked
 * radar scope (industry). Particles live in lon/lat and are projected only for
 * drawing — which is exactly what makes that possible, and what lets the map pan
 * and zoom without restarting the simulation.
 *
 * Hot-loop discipline: no allocation per particle per frame. Segments accumulate
 * into preallocated Float32Arrays, one per speed bucket, and each bucket is a
 * single `beginPath`/`stroke`.
 *
 * A camera move re-projects, it does not draw. Each particle remembers the
 * screen point it was last drawn at; when the projector changes, that point
 * belongs to the OLD camera, and stroking from it to the particle's new
 * position draws the pan itself — a long straight streak radiating from the
 * zoom pivot, one per particle. Those streaks then fade to a residue the 8-bit
 * alpha never quite clears (a pixel at alpha ≤ 6 times 0.92 rounds back to
 * itself), which is how street-coloured ink lingered over unmeasured fields
 * seconds after a re-centre. So a new projector re-projects every particle
 * before the next step, and a new `viewKey` also wipes the trails.
 *
 * The residue itself is swept. Multiplying by `keep` can never take an 8-bit
 * alpha of 1–6 to zero, so every pixel a particle ever crossed kept a faint
 * floor of ink — measured on the deck, pixels at alpha ≤ 6 went from 2k to
 * 60k within 2.5 s of a wipe and stayed. A few times a second the canvas is
 * redrawn onto itself through an SVG filter that subtracts 7/255 of alpha,
 * which clears that floor and shortens a live trail by a frame or two. Where
 * `ctx.filter` is unsupported the sweep is skipped: the old behaviour.
 */

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { WindField } from '@/core/types';
import type { Theme } from '../lib/theme';
import { rgbaCss, withAlpha } from '../lib/theme';
import { useReducedMotion } from '../lib/anim';
import { buildFieldIndex, emptySample, mercatorProjector, scopeProjector } from '../lib/windField';
import type { FieldIndex, Projector } from '../lib/windField';

export interface WindFieldCanvasProps {
  field: WindField | null | undefined;
  /** Geography → canvas pixels. See `mercatorProjector` / `scopeProjector`. */
  projector: Projector | null;
  theme: Theme;
  /**
   * Changes when the camera moves. The canvas is wiped (not restarted) so old
   * trails do not smear across a pan. Round it — a per-pixel key wipes constantly.
   */
  viewKey?: string | number;
  /** Particle count. 3–6k is the nullschool range; scale down for small frames. */
  particles?: number;
  /**
   * Fraction of each frame's alpha kept. 0.94 is a medium tail, 0.98 a long smear,
   * 0.85 nearly dots.
   */
  keep?: number;
  /** Speed range mapped onto the ramp, m/s. Auto from the field when omitted. */
  speedDomain?: [number, number];
  /** Frames before a particle is recycled, so density stays even. */
  maxAge?: number;
  /** Multiplies the physical step. Higher = faster, longer streaks. */
  speedScale?: number;
  ramp?: 'map' | 'intensity' | 'aqi';
  /**
   * `'ramp'` (default): colour by speed through `ramp`. `'neutral'`: every
   * particle in one quiet ink (`--ink-2`, or `colorToken` when given), speed
   * carried by alpha over a floor so slow air still reads. For a map whose
   * ramp is also the MEASURED street ramp — industry's `--ramp-map-*` is
   * `--ramp-intensity-*` — where wind drawn in that ramp reads as measured
   * ink over ground nobody drove (CONTRACT §10b: measurement is the only
   * inked thing). Matches a plain `--ink-2` legend line.
   */
  colorMode?: 'ramp' | 'neutral';
  /**
   * Paint every particle in this token instead of the ramp, with SPEED carried by
   * brightness. This is the radar-scope idiom — a magenta magnitude ramp over a
   * phosphor dial fights the narrative and reads as a second data series.
   */
  colorToken?: string;
  /** Peak stroke alpha. Keep it low — wind is context, not data. */
  opacity?: number;
  lineWidth?: number;
  /** Particles below this confidence are never seeded. */
  minConfidence?: number;
  running?: boolean;
  className?: string;
  style?: CSSProperties;
}

interface Particle {
  lon: number; lat: number;
  /** Previous screen position — the stroke's start point. */
  px: number; py: number;
  age: number;
  life: number;
  conf: number;
  live: boolean;
}

/** Speed buckets — the whole field draws in this many stroke batches. */
const BUCKETS = 7;

/** Frames between residue sweeps (see the header): ~0.4 s at 60 fps. */
const SWEEP_EVERY = 24;
const SWEEP_FILTER_ID = 'air-wind-residue-sweep';

/**
 * The residue sweep's filter, added to the document once: alpha minus 7/255,
 * clamped at 0, colour untouched (`color-interpolation-filters: sRGB`, or the
 * default linearRGB round trip would shift the ink). Null where a canvas
 * cannot take a filter, and the sweep is skipped.
 */
function sweepFilter(ctx: CanvasRenderingContext2D): string | null {
  if (typeof document === 'undefined' || !('filter' in ctx)) return null;
  if (!document.getElementById(SWEEP_FILTER_ID)) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    const filter = document.createElementNS(NS, 'filter');
    filter.setAttribute('id', SWEEP_FILTER_ID);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const transfer = document.createElementNS(NS, 'feComponentTransfer');
    const funcA = document.createElementNS(NS, 'feFuncA');
    funcA.setAttribute('type', 'linear');
    funcA.setAttribute('slope', '1');
    funcA.setAttribute('intercept', String(-7 / 255));
    transfer.appendChild(funcA);
    filter.appendChild(transfer);
    svg.appendChild(filter);
    document.body.appendChild(svg);
  }
  return `url(#${SWEEP_FILTER_ID})`;
}

/** `colorMode: 'neutral'` paints in this token unless `colorToken` overrides. */
const NEUTRAL_TOKEN = 'ink-2';

/**
 * Bucket `i`'s share of the peak alpha when one token carries speed. The
 * scope's floor (0.22) suits a phosphor dial; over a basemap the slowest
 * buckets at 0.22 × a context-level opacity vanished, so neutral keeps more.
 */
function bucketAlpha(i: number, neutral: boolean): number {
  const t = i / (BUCKETS - 1);
  return neutral ? 0.45 + t * 0.55 : 0.22 + t * 0.78;
}

/** The single token a canvas paints in, or null when it colours by ramp. */
function singleToken(colorMode: 'ramp' | 'neutral' | undefined, colorToken: string | undefined): string | null {
  return colorToken ?? (colorMode === 'neutral' ? NEUTRAL_TOKEN : null);
}

/**
 * Peak particle alpha per basemap skin. The community's warm-paper `light` map
 * has a fraction of the headroom the regulator's near-black `dark` shell does;
 * the same stroke that whispers over one scribbles over the other.
 */
const SKIN_ALPHA: Record<string, number> = {
  light: 0.42,
  blueprint: 0.72,
  dark: 1,
  night: 1,
};

export function WindFieldCanvas(props: WindFieldCanvasProps) {
  const {
    field, projector, theme, viewKey, particles = 3600, keep = 0.92,
    speedDomain, maxAge = 110, speedScale = 1, ramp = 'intensity', colorMode = 'ramp', colorToken,
    opacity = 0.42, lineWidth = 1, minConfidence = 0.04,
    running = true, className, style,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();

  // Everything the loop reads lives in a ref, so a pan or a prop tweak is picked
  // up on the next frame instead of tearing down the simulation.
  const live = useRef({
    projector, viewKey, theme, speedDomain, ramp, colorMode, colorToken, opacity, lineWidth,
    speedScale, keep, minConfidence, maxAge, particles,
  });
  live.current = {
    projector, viewKey, theme, speedDomain, ramp, colorMode, colorToken, opacity, lineWidth,
    speedScale, keep, minConfidence, maxAge, particles,
  };

  const indexRef = useRef<FieldIndex | null>(null);
  const fieldKey = `${field?.from ?? ''}|${field?.to ?? ''}|${field?.cells?.length ?? 0}|${field?.cell_size_m ?? 0}`;
  const idxReady = useRef(0);
  useEffect(() => {
    indexRef.current = buildFieldIndex(field);
    idxReady.current += 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey]);

  const width = Math.round(projector?.width ?? 0);
  const height = Math.round(projector?.height ?? 0);
  const staticKey = reduced ? viewKey : null;

  // Wipe on camera move — no restart, so particles keep their positions.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, [viewKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const idx = indexRef.current;
    const proj0 = live.current.projector;
    if (!canvas || !idx || !proj0 || width < 2 || height < 2) return;

    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';

    const [d0, d1] = live.current.speedDomain
      ?? [0, Math.max(1.5, idx.maxSpeed || idx.meanSpeed * 2 || 6)];

    const token = singleToken(live.current.colorMode, live.current.colorToken);
    const neutral = live.current.colorMode === 'neutral';
    const single = token ? live.current.theme.color(token) : null;
    const bucketColors = Array.from({ length: BUCKETS }, (_, i) => {
      const t = i / (BUCKETS - 1);
      return single ?? live.current.theme.rampColor(0.18 + t * 0.82, undefined, live.current.ramp);
    });
    // A light basemap has far less headroom than a dark one: the same alpha that
    // reads as a whisper over near-black reads as scribble over warm paper. Key
    // this off `--map-style` (the ground being drawn over), NOT `theme.dark`
    // (the shell polarity) — they are not the same thing for every role.
    const skinAlpha = SKIN_ALPHA[live.current.theme.skin] ?? 1;
    // One token: speed rides on alpha. A ramp: speed rides on hue at full alpha.
    const bucketStroke = bucketColors.map((c, i) => rgbaCss(withAlpha(
      c,
      skinAlpha * (single
        ? live.current.opacity * bucketAlpha(i, neutral)
        : live.current.opacity),
    )));

    const bbox = idx.bbox;
    const geo: [number, number] = [0, 0];
    const scr: [number, number] = [0, 0];
    const sample = emptySample();

    /** Rejection-sample a start position: inside the frame AND trusted enough. */
    const seed = (p: Particle, firstRun: boolean) => {
      const proj = live.current.projector;
      if (!proj) { p.live = false; return; }
      for (let tries = 0; tries < 10; tries++) {
        let sx: number;
        let sy: number;
        if (proj.clip === 'circle') {
          // Seed inside the projector's OWN circle — a scope ring is smaller
          // than its square box, and seeding the inscribed circle sprays
          // particles into the corners outside the dial.
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * (proj.r ?? Math.min(width, height) / 2);
          sx = (proj.cx ?? width / 2) + rr * Math.cos(a);
          sy = (proj.cy ?? height / 2) + rr * Math.sin(a);
        } else {
          sx = Math.random() * width;
          sy = Math.random() * height;
        }
        proj.unproject(sx, sy, geo);
        if (geo[0] < bbox[0] || geo[0] > bbox[2] || geo[1] < bbox[1] || geo[1] > bbox[3]) continue;
        idx.sample(geo[0], geo[1], sample);
        // The honesty rule, made visual: where we did not really measure, fewer
        // particles get seeded, so sparse data LOOKS sparse.
        if (sample.conf < live.current.minConfidence) continue;
        if (Math.random() > sample.conf) continue;
        p.lon = geo[0];
        p.lat = geo[1];
        p.px = sx;
        p.py = sy;
        p.conf = sample.conf;
        p.age = firstRun ? Math.random() * live.current.maxAge : 0;
        p.life = live.current.maxAge * (0.6 + Math.random() * 0.8);
        p.live = true;
        return;
      }
      p.live = false;
    };

    const n = Math.max(1, Math.round(live.current.particles));
    const pool: Particle[] = new Array(n);
    for (let i = 0; i < n; i++) {
      pool[i] = { lon: 0, lat: 0, px: 0, py: 0, age: 0, life: maxAge, conf: 0, live: false };
      seed(pool[i], true);
    }

    // Degrees per frame per m/s. ~9× real time is what makes a streak read as a
    // streak rather than a dot; tune the per-frame weight with `speedScale`, not
    // by lowering this (dropping it starves the scope, which is a small frame to
    // begin with).
    const cosLat = Math.max(0.2, Math.cos(((bbox[1] + bbox[3]) / 2) * (Math.PI / 180)));
    const dtLat = (1 / 110540) * 9 * live.current.speedScale;
    const dtLon = ((1 / 111320) * 9 * live.current.speedScale) / cosLat;

    // Preallocated segment buffers: 4 floats per segment, one buffer per bucket.
    const segs = Array.from({ length: BUCKETS }, () => new Float32Array(n * 4));
    const segN = new Int32Array(BUCKETS);

    // ── reduced motion: one static streamline field, drawn once ────────────
    if (reduced) {
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = live.current.lineWidth;
      const proj = live.current.projector;
      const seeds = Math.max(24, Math.round(n / 14));
      for (let k = 0; k < seeds; k++) {
        const p: Particle = { lon: 0, lat: 0, px: 0, py: 0, age: 0, life: 0, conf: 0, live: false };
        seed(p, false);
        if (!p.live || !proj) continue;
        idx.sample(p.lon, p.lat, sample);
        const t = (sample.speed - d0) / Math.max(0.001, d1 - d0);
        const bi = Math.max(0, Math.min(BUCKETS - 1, Math.round(t * (BUCKETS - 1))));
        ctx.strokeStyle = rgbaCss(withAlpha(
          bucketColors[bi],
          live.current.opacity * (0.35 + p.conf * 0.65) * (single ? bucketAlpha(bi, neutral) : 1),
        ));
        ctx.beginPath();
        proj.project(p.lon, p.lat, scr);
        ctx.moveTo(scr[0], scr[1]);
        for (let step = 0; step < 36; step++) {
          idx.sample(p.lon, p.lat, sample);
          if (sample.conf < live.current.minConfidence) break;
          p.lon += sample.u * dtLon;
          p.lat += sample.v * dtLat;
          proj.project(p.lon, p.lat, scr);
          ctx.lineTo(scr[0], scr[1]);
        }
        ctx.stroke();
      }
      return;
    }

    // ── the animation ─────────────────────────────────────────────────────
    let raf = 0;
    let stopped = false;
    // The camera the particles' `px/py` were last projected with.
    let drawnWith: Projector | null = live.current.projector;
    let drawnKey = live.current.viewKey;
    const sweep = sweepFilter(ctx);
    let frames = 0;

    const frame = () => {
      if (stopped) return;
      const proj = live.current.projector;
      if (!proj) { raf = requestAnimationFrame(frame); return; }

      // 0. A new camera: re-project, so no segment spans two cameras (see the
      //    header). A new projector object with the same camera re-projects to
      //    the same points, which is harmless; only a new `viewKey` wipes.
      if (proj !== drawnWith) {
        if (live.current.viewKey !== drawnKey) {
          ctx.clearRect(0, 0, width, height);
          drawnKey = live.current.viewKey;
        }
        for (let i = 0; i < n; i++) {
          const p = pool[i];
          if (!p.live) continue;
          proj.project(p.lon, p.lat, scr);
          p.px = scr[0];
          p.py = scr[1];
        }
        drawnWith = proj;
      }

      // 1. Fade what is already there toward transparent. THIS is the trail.
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = `rgba(0,0,0,${live.current.keep})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
      // 1b. Now and then, clear the floor the fade cannot (see the header).
      if (sweep && ++frames % SWEEP_EVERY === 0) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'copy';
        ctx.filter = sweep;
        ctx.drawImage(canvas, 0, 0);
        ctx.restore();
      }

      segN.fill(0);
      const halfW = proj.cx ?? width / 2;
      const halfH = proj.cy ?? height / 2;
      const rClip = proj.r ?? Math.min(width, height) / 2;

      // 2. Step every particle, bucket its segment by speed.
      for (let i = 0; i < n; i++) {
        const p = pool[i];
        if (!p.live) { seed(p, false); continue; }

        idx.sample(p.lon, p.lat, sample);
        if (sample.conf < live.current.minConfidence || sample.speed <= 0.001) {
          seed(p, false);
          continue;
        }

        p.lon += sample.u * dtLon;
        p.lat += sample.v * dtLat;
        p.age += 1;

        proj.project(p.lon, p.lat, scr);
        const nx = scr[0];
        const ny = scr[1];

        const outside = proj.clip === 'circle'
          ? ((nx - halfW) * (nx - halfW) + (ny - halfH) * (ny - halfH)) > rClip * rClip
          : nx < -4 || ny < -4 || nx > width + 4 || ny > height + 4;

        if (outside || p.age > p.life) { seed(p, false); continue; }

        const sx = p.px;
        const sy = p.py;
        p.px = nx;
        p.py = ny;

        // Confidence thins the DRAW RATE, not the alpha: an uncertain region
        // genuinely shows fewer streaks rather than paler ones.
        if (p.conf < 0.95 && Math.random() > 0.3 + p.conf * 0.7) continue;

        const t = (sample.speed - d0) / Math.max(0.001, d1 - d0);
        const bi = Math.max(0, Math.min(BUCKETS - 1, Math.round(t * (BUCKETS - 1))));
        const k = segN[bi];
        if (k * 4 + 3 < segs[bi].length) {
          const buf = segs[bi];
          buf[k * 4] = sx;
          buf[k * 4 + 1] = sy;
          buf[k * 4 + 2] = nx;
          buf[k * 4 + 3] = ny;
          segN[bi] = k + 1;
        }
      }

      // 3. One path per colour bucket.
      ctx.lineWidth = live.current.lineWidth;
      for (let bi = 0; bi < BUCKETS; bi++) {
        const count = segN[bi];
        if (!count) continue;
        const buf = segs[bi];
        ctx.strokeStyle = bucketStroke[bi];
        ctx.beginPath();
        for (let k = 0; k < count; k++) {
          ctx.moveTo(buf[k * 4], buf[k * 4 + 1]);
          ctx.lineTo(buf[k * 4 + 2], buf[k * 4 + 3]);
        }
        ctx.stroke();
      }

      raf = requestAnimationFrame(frame);
    };

    if (running) raf = requestAnimationFrame(frame);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
    // Deliberately NOT keyed on the projector: panning must not restart the sim.
    // Reduced motion draws once, so it IS redrawn per camera (`staticKey`) —
    // the wipe on `viewKey` would otherwise leave it blank after a pan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, width, height, reduced, running, particles, maxAge, theme.role, theme.skin, ramp, colorMode, colorToken, idxReady.current, staticKey]);

  if (!projector) return null;

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        inlineSize: '100%',
        blockSize: '100%',
        pointerEvents: 'none',
        ...(projector.clip === 'circle' ? { borderRadius: '50%' } : null),
        ...style,
      }}
    />
  );
}

// ───────────────────────────────────────────────────────── helpers

/** Projector for a flat Web Mercator map view. */
export function mapProjector(
  view: { longitude: number; latitude: number; zoom: number; bearing?: number } | null,
  size: { width: number; height: number },
): Projector | null {
  if (!view || size.width < 2 || size.height < 2) return null;
  return mercatorProjector(view, size.width, size.height);
}

/** Projector for a site-locked radar scope of `size` pixels square. */
export function makeScopeProjector(opts: {
  site: [number, number];
  rangeM: number;
  size: number;
  headingUp?: number;
}): Projector {
  const { site, rangeM, size, headingUp = 0 } = opts;
  return scopeProjector({
    site,
    rangeM,
    rMax: size / 2,
    cx: size / 2,
    cy: size / 2,
    headingUp,
    width: size,
    height: size,
  });
}

/** A rounded camera signature — pass as `viewKey` so pans wipe, not restart. */
export function viewSignature(view: { longitude: number; latitude: number; zoom: number; bearing?: number } | null): string {
  if (!view) return 'none';
  return [
    view.longitude.toFixed(4),
    view.latitude.toFixed(4),
    view.zoom.toFixed(2),
    Math.round(view.bearing ?? 0),
  ].join(',');
}

/** Legend stops for the particle field, so speed colour is never unexplained. */
export function windSpeedLegend(
  theme: Theme,
  domain: [number, number],
  ramp: 'map' | 'intensity' | 'aqi' = 'intensity',
  /** Pass the same `colorToken` the canvas got, or the key will lie. */
  colorToken?: string,
  /** And the same `colorMode`. */
  colorMode: 'ramp' | 'neutral' = 'ramp',
) {
  const token = singleToken(colorMode, colorToken);
  const single = token ? theme.color(token) : null;
  const stops = Array.from({ length: BUCKETS }, (_, i) => {
    const t = i / (BUCKETS - 1);
    return single
      ? rgbaCss(withAlpha(single, bucketAlpha(i, colorMode === 'neutral')))
      : rgbaCss(theme.rampColor(0.18 + t * 0.82, undefined, ramp));
  });
  return {
    stops,
    lo: domain[0],
    hi: domain[1],
    gradient: `linear-gradient(90deg, ${stops.join(', ')})`,
  };
}
