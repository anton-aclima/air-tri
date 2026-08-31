/**
 * RadarScope — the industry radar warning receiver.
 *
 * This is the one screen a datacenter operator should be able to read from three
 * metres away without interpreting anything: WHAT is wrong, WHICH WAY, HOW FAR,
 * HOW BAD. It is a plan-position indicator, not an analytics chart — so it is
 * terse, phosphor, and every readout is a fixed-width code.
 *
 *   position → bearing (clockwise from north) and range from the site
 *   shape    → who is reporting it (agency instrument, resident, our fleet, model)
 *   colour   → severity, from the shared `--sev-*` tokens
 *   size     → severity again, so it survives a colourblind reader and a glance
 *   ring     → this contact is new and unacknowledged
 *
 * Severity is never colour-alone: it is in the shape, the size, and the glyph in
 * the contact's own label.
 *
 * The reference is a modern compass instrument, not a CRT: hairline rings, small
 * ticks, one accent, and a great deal of negative space. There is no sweep, no
 * phosphor decay and no idle animation of any kind — a contact is simply THERE,
 * all the time. Motion is reserved for real state changes, so when something
 * does move on this dial it means something.
 *
 * ## The combined frame
 *
 * Pass `windField` + `site` and the observed street-level wind advects *inside the
 * scope* (nullschool-style particles, see `wind/WindFieldCanvas`). Pass
 * `modelContours` as well and the consultant's dispersion deliverable is drawn as
 * a dashed reference outline underneath it. The operator then sees three things in
 * one picture: where the threats are, where the air is actually going, and where
 * the study they paid for said it would go. The divergence between the last two is
 * the product's core argument, and it is a *shape*, not a paragraph.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type {
  Alert, AlertStatus, GeoGeometry, Position, Severity, WindField,
} from '@/core/types';
import { SEVERITY_LABEL, severityRank, severityVar } from '@/core/measures';
import { fmtBearing, fmtDistance, fmtElapsed } from '@/core/format';
import { useTheme } from '../lib/theme';
import { ALERT_KIND_CODE, SEVERITY_GLYPH } from '../lib/vizmeta';
import { niceCeil } from '../lib/vizmeta';
import { geometryPositions, toPolygons } from '../lib/geo';
import { scopeProjector } from '../lib/windField';
import { WindFieldCanvas, windSpeedLegend } from '../wind/WindFieldCanvas';
import s from './chart.module.css';
import r from './RadarScope.module.css';

export type ContactSource = 'monitor' | 'community' | 'mobile' | 'regulator' | 'model';

export interface RadarContact {
  id: string;
  /** Degrees clockwise from true north, as seen from the site. */
  bearing_deg: number;
  distance_m: number;
  severity: Severity;
  /** Long name, shown on hover / selection. */
  label?: string;
  /** Four characters, shown beside the contact. `ALERT_KIND_CODE` supplies these. */
  code?: string;
  source?: ContactSource;
  /** Pulses until acknowledged. */
  isNew?: boolean;
  startedAt?: string;
  status?: AlertStatus;
}

export interface RadarScopeProps {
  contacts: RadarContact[];
  size?: number;
  /** Outer ring range in metres. Auto-scaled to the furthest contact when omitted. */
  rangeM?: number;
  /**
   * How range maps to radius.
   *
   * `linear` is what a real PPI does and is the default. `sqrt` spreads the
   * near field out at the cost of compressing the far field — worth it when
   * the contacts cluster: a fenceline sensor set sits at ~400 m while one
   * regulator monitor sits at 6 km, and under a linear scale every fenceline
   * contact lands on top of the origin as an unreadable knot.
   */
  rangeCurve?: 'linear' | 'sqrt';
  rings?: number;
  /** Rotate the scope so this bearing points up. 0 = north up. */
  headingUp?: number;
  /** @deprecated The sweep was removed — contacts are always present. Ignored. */
  sweep?: boolean;
  selectedId?: string | null;
  onSelect?(id: string | null): void;
  /** 'all' labels every contact, 'hover' only the active one. Default 'all'. */
  labels?: 'all' | 'hover' | 'none';
  /** Name of the site at the centre. */
  ownLabel?: string;
  /** Replaces the generated status line. */
  status?: ReactNode;

  // ── the combined frame ──────────────────────────────────────────────────
  /** Site centroid. Required for the wind field and the model contours. */
  site?: Position | null;
  /** Observed street-level wind. Advects as particles inside the scope. */
  windField?: WindField | null;
  /** Particle count inside the dial. Lower than the map — it is a small frame. */
  windParticles?: number;
  /** Speed range mapped onto the ramp, m/s. */
  windSpeedDomain?: [number, number];
  /** Show the particle speed key under the dial. Default true when a field is given. */
  windLegend?: boolean;
  /**
   * The consultant's dispersion contours, drawn as a dashed reference outline.
   * Takes `DispersionModel.contours` verbatim.
   */
  modelContours?: { band: number; level: number; geometry: GeoGeometry }[] | null;
  modelLabel?: string;
  title?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** `GET /alerts?site_id=…` rows → contacts. The API supplies bearing + distance. */
export function contactsFromAlerts(alerts: Alert[]): RadarContact[] {
  return alerts
    .filter((a) => a.bearing_deg !== undefined && a.distance_m !== undefined)
    .map((a) => ({
      id: a.id,
      bearing_deg: a.bearing_deg as number,
      distance_m: a.distance_m as number,
      severity: a.severity,
      label: a.title,
      code: ALERT_KIND_CODE[a.kind] ?? a.kind.slice(0, 4).toUpperCase(),
      source: a.source_type as ContactSource,
      isNew: a.status === 'active',
      startedAt: a.started_at,
      status: a.status,
    }));
}

const SHAPE_FOR: Record<ContactSource, 'diamond' | 'circle' | 'triangle' | 'square'> = {
  monitor: 'diamond', regulator: 'diamond', community: 'circle',
  mobile: 'triangle', model: 'square',
};

const SOURCE_LABEL: Record<ContactSource, string> = {
  monitor: 'Agency instrument', regulator: 'Agency', community: 'Residents',
  mobile: 'Aclima fleet', model: 'Model',
};

const SEV_SIZE: Record<Severity, number> = { info: 5, watch: 6.5, warning: 8, critical: 10 };

function symbolPath(shape: 'diamond' | 'circle' | 'triangle' | 'square', k: number): string {
  switch (shape) {
    case 'diamond': return `M 0,${-k} L ${k},0 L 0,${k} L ${-k},0 Z`;
    case 'triangle': return `M 0,${-k} L ${k * 0.92},${k * 0.72} L ${-k * 0.92},${k * 0.72} Z`;
    case 'square': return `M ${-k * 0.82},${-k * 0.82} H ${k * 0.82} V ${k * 0.82} H ${-k * 0.82} Z`;
    default: return '';
  }
}

export function RadarScope(props: RadarScopeProps) {
  const {
    contacts, size = 300, rangeM, rangeCurve = 'linear', rings = 3, headingUp = 0,
    selectedId, onSelect, labels = 'all',
    ownLabel, status, title, className, style,
    site, windField, windParticles = 1400, windSpeedDomain,
    windLegend, modelContours, modelLabel = 'Consultant model',
  } = props;

  const rootRef = useRef<HTMLDivElement>(null);
  const theme = useTheme(rootRef);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2 - 26;

  // Outer range: a round number above the furthest contact, so the rings read
  // as "1 km / 2 km / 3 km", never "1.37 km".
  const range = useMemo(() => {
    if (rangeM) return rangeM;
    let far = contacts.reduce((mx, c) => Math.max(mx, c.distance_m || 0), 0);
    // The consultant's contour has to fit on the dial too, or the comparison the
    // whole frame exists for is cropped off the edge.
    if (site && modelContours?.length) {
      const mLon = 111320 * Math.cos((site[1] * Math.PI) / 180);
      for (const c of modelContours) {
        for (const pos of geometryPositions(c.geometry)) {
          const e = (pos[0] - site[0]) * mLon;
          const nn = (pos[1] - site[1]) * 110540;
          far = Math.max(far, Math.hypot(e, nn));
        }
      }
    }
    return Math.max(500, niceCeil(far * 1.1 || 2000));
  }, [rangeM, contacts, site, modelContours]);

  const rOf = useCallback(
    (d: number) => {
      const t = Math.min(1, Math.max(0, d) / range);
      return (rangeCurve === 'sqrt' ? Math.sqrt(t) : t) * rMax;
    },
    [range, rMax, rangeCurve],
  );
  const at = useCallback((bearing: number, dist: number): [number, number] => {
    const a = ((bearing - headingUp) * Math.PI) / 180;
    const rr = rOf(dist);
    return [cx + rr * Math.sin(a), cy - rr * Math.cos(a)];
  }, [cx, cy, headingUp, rOf]);

  const ordered = useMemo(
    () => [...contacts].sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    [contacts],
  );
  const worst = ordered[0] ?? null;
  const criticals = contacts.filter((c) => c.severity === 'critical').length;

  const active = hoverId ?? selectedId ?? null;
  const activeContact = contacts.find((c) => c.id === active) ?? null;

  const scopeColor = theme.css('scope') || theme.css('accent');

  const onKey = useCallback((e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!ordered.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown'
      || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const i = ordered.findIndex((c) => c.id === active);
      const next = ordered[(((i < 0 ? 0 : i + dir) % ordered.length) + ordered.length) % ordered.length];
      setHoverId(next.id);
      onSelect?.(next.id);
    } else if (e.key === 'Escape') {
      setHoverId(null);
      onSelect?.(null);
    }
  }, [ordered, active, onSelect]);

  // One projector shared by the particle canvas and the SVG contour outline, so
  // the two are registered to each other to the pixel.
  const projector = useMemo(
    () => (site
      ? scopeProjector({
        site, rangeM: range, rMax, cx, cy, headingUp, width: size, height: size,
      })
      : null),
    [site, range, rMax, cx, cy, headingUp, size],
  );

  /** The consultant's contours, as dashed outlines in scope pixels. */
  const contourPaths = useMemo(() => {
    if (!projector || !modelContours?.length) return [];
    const out: { key: string; d: string; band: number }[] = [];
    const pt: [number, number] = [0, 0];
    for (const c of modelContours) {
      for (const poly of toPolygons(c.geometry)) {
        for (const [ri, ring] of poly.entries()) {
          if (ring.length < 3) continue;
          const parts: string[] = [];
          for (const pos of ring) {
            projector.project(pos[0], pos[1], pt);
            parts.push(`${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`);
          }
          out.push({ key: `${c.band}-${c.level}-${ri}`, d: `M ${parts.join(' L ')} Z`, band: c.band });
        }
      }
    }
    return out;
  }, [projector, modelContours]);

  const showWindLegend = windLegend ?? Boolean(windField?.cells?.length);
  const windDomain: [number, number] = windSpeedDomain ?? [0, 8];
  const windKey = useMemo(
    () => windSpeedLegend(theme, windDomain, 'intensity', 'scope'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theme, windDomain[0], windDomain[1]],
  );

  // Rings stay evenly spaced in *radius* and carry whatever distance that radius
  // means under the active curve, so their labels remain literally true.
  const ringValues = Array.from({ length: rings }, (_, i) => {
    const f = (i + 1) / rings;
    return range * (rangeCurve === 'sqrt' ? f * f : f);
  });

  return (
    <div ref={rootRef} className={[r.scope, className].filter(Boolean).join(' ')} style={style}>
      {title && <span className={r.scopeTitle}>{title}</span>}

      <div className={r.dial} style={{ inlineSize: size, blockSize: size }}>
        {/* Observed wind, advecting inside the scope. Under the SVG so the range
            rings, the sweep and the contacts all stay crisp on top of it. */}
        {projector && windField?.cells?.length ? (
          <WindFieldCanvas
            field={windField}
            projector={projector}
            theme={theme}
            particles={windParticles}
            keep={0.9}
            speedDomain={windDomain}
            speedScale={0.5}
            colorToken="scope"
            opacity={0.62}
            lineWidth={1}
            maxAge={80}
          />
        ) : null}

      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={s.plot}
        style={{ position: 'absolute', inset: 0, inlineSize: size, maxInlineSize: '100%' }}
        tabIndex={0}
        role="img"
        aria-label={
          contacts.length
            ? `Radar scope, ${contacts.length} contacts. Worst: ${worst?.label ?? worst?.code ?? ''} `
              + `${SEVERITY_LABEL[worst?.severity ?? 'info']} at bearing ${fmtBearing(worst?.bearing_deg)}, `
              + `${fmtDistance(worst?.distance_m)}.`
            : 'Radar scope, no contacts.'
        }
        onKeyDown={onKey}
        onPointerLeave={() => setHoverId(null)}
      >
        {/* A flat face. No gradient, no glare — it exists only to hold the
            particle field down against the page. */}
        <circle cx={cx} cy={cy} r={rMax} fill={theme.css('bg-sunk')} fillOpacity={0.35} />

        {/* The consultant's deliverable, as a reference outline. The observed
            particles flow over it; where they leave it, the study was wrong. */}
        {contourPaths.map((cp) => (
          <path
            key={cp.key}
            d={cp.d}
            fill="none"
            stroke={theme.css('ink-2')}
            strokeWidth={cp.band === 0 ? 1.8 : 1.2}
            strokeDasharray={cp.band === 0 ? '6 4' : '3 4'}
            opacity={cp.band === 0 ? 0.85 : 0.5}
            strokeLinejoin="round"
          />
        ))}

        {/* range rings */}
        {ringValues.map((v, i) => (
          <circle
            key={v}
            cx={cx} cy={cy} r={rOf(v)}
            fill="none"
            stroke={theme.css('line-strong')}
            strokeOpacity={i === ringValues.length - 1 ? 0.9 : 0.45}
            strokeWidth={i === ringValues.length - 1 ? 1 : 0.75}
          />
        ))}

        {/* Range labels on the rings themselves — the numbers a compass shows,
            rather than a legend the reader has to hold in their head. */}
        {ringValues.map((v) => {
          const rr = rOf(v);
          return (
            <text
              key={`lab-${v}`}
              x={cx + 4} y={cy - rr - 3}
              className={r.ringLabel}
              fill={theme.css('ink-3')}
            >
              {v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)} km` : `${Math.round(v)} m`}
            </text>
          );
        })}

        {/* bearing ticks: 10° minor, 30° major, cardinals labelled */}
        <g>
          {Array.from({ length: 36 }, (_, i) => i * 10).map((deg) => {
            const major = deg % 30 === 0;
            const [x0, y0] = at(deg, range * (major ? 0.945 : 0.972));
            const [x1, y1] = at(deg, range);
            return (
              <line
                key={deg}
                x1={x0} y1={y0} x2={x1} y2={y1}
                stroke={theme.css('ink-3')}
                strokeOpacity={major ? 0.75 : 0.35}
                strokeWidth={major ? 1 : 0.75}
              />
            );
          })}
          {[['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([lab, deg]) => {
            const [tx, ty] = at(deg as number, range * 1.13);
            return (
              <text
                key={lab as string}
                x={tx} y={ty}
                textAnchor="middle" dy="0.34em"
                className={r.cardinal}
                fill={theme.css('ink-3')}
              >{lab}</text>
            );
          })}
        </g>

        {/* The bearing that matters, marked the way a compass marks heading: a
            short arc on the outer ring. Position and colour, nothing else. */}
        {worst && (() => {
          const [x0, y0] = at(worst.bearing_deg - 7, range);
          const [x1, y1] = at(worst.bearing_deg + 7, range);
          return (
            <path
              d={`M ${x0} ${y0} A ${rMax} ${rMax} 0 0 1 ${x1} ${y1}`}
              fill="none"
              stroke={severityVar(worst.severity)}
              strokeWidth={3}
              strokeLinecap="butt"
            />
          );
        })()}

        {/* ownship — one dot and one hairline ring. This is where you are. */}
        <g>
          <circle cx={cx} cy={cy} r={6} fill="none" stroke={scopeColor} strokeWidth={1} opacity={0.55} />
          <circle cx={cx} cy={cy} r={2} fill={scopeColor} />
        </g>

        {/* contacts, worst drawn last so it is never buried */}
        <g>
          {[...ordered].reverse().map((c) => {
            const [x, y] = at(c.bearing_deg, c.distance_m);
            const k = SEV_SIZE[c.severity];
            const shape = SHAPE_FOR[c.source ?? 'monitor'] ?? 'diamond';
            const col = severityVar(c.severity);
            const on = c.id === active;
            const showLabel = labels === 'all' || (labels === 'hover' && on);
            const flipLabel = y > cy;
            return (
              <g
                key={c.id}
                className={s.markFocus}
                tabIndex={onSelect ? 0 : -1}
                role={onSelect ? 'button' : undefined}
                aria-label={`${c.code ?? ''} ${c.label ?? ''} ${SEVERITY_LABEL[c.severity]} bearing ${fmtBearing(c.bearing_deg)} range ${fmtDistance(c.distance_m)}`}
                onPointerEnter={() => setHoverId(c.id)}
                onFocus={() => setHoverId(c.id)}
                onClick={() => onSelect?.(c.id === selectedId ? null : c.id)}
                style={{ cursor: onSelect ? 'pointer' : 'default' }}
              >
                {/* generous transparent hit target — a 10px symbol is a pinpoint */}
                <circle cx={x} cy={y} r={16} fill="transparent" />

                {/* Unacknowledged: a static outer ring. Nothing on this dial
                    animates while the world is standing still. */}
                {c.isNew && (
                  <circle cx={x} cy={y} r={k + 5} fill="none" stroke={col} strokeWidth={1} opacity={0.55} />
                )}
                {on && <circle cx={x} cy={y} r={k + 7} fill="none" stroke={theme.css('ink')} strokeWidth={1} opacity={0.7} />}

                {shape === 'circle'
                  ? <circle cx={x} cy={y} r={k * 0.86} fill={col} stroke={theme.css('bg-sunk')} strokeWidth={2} />
                  : (
                    <path
                      d={symbolPath(shape, k)}
                      transform={`translate(${x},${y})`}
                      fill={col}
                      stroke={theme.css('bg-sunk')}
                      strokeWidth={2}
                    />
                  )}

                {showLabel && (
                  <text
                    x={x} y={y + (flipLabel ? k + 13 : -k - 6)}
                    textAnchor="middle"
                    className={r.contactCode}
                    fill={theme.css('ink')}
                  >
                    {c.code ?? '····'}
                  </text>
                )}
                {on && (
                  <text
                    x={x} y={y + (flipLabel ? k + 23 : -k - 16)}
                    textAnchor="middle"
                    className={r.contactMeta}
                    fill={theme.css('ink-2')}
                  >
                    {fmtBearing(c.bearing_deg)} · {fmtDistance(c.distance_m)}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {ownLabel && (
          <text x={size - 4} y={size - 5} textAnchor="end" className={r.readout} fill={theme.css('ink-3')}>
            {ownLabel.toUpperCase()}
          </text>
        )}
      </svg>
      </div>

      {/* Two keys, because the frame carries two encodings that are not severity:
          particle colour = observed wind speed, dashed outline = the model. */}
      {(showWindLegend || contourPaths.length > 0) && (
        <div className={r.windKey}>
          {showWindLegend && (
            <span className={r.windKeyItem}>
              <span className={r.windRamp} style={{ background: windKey.gradient }} />
              WIND {windKey.lo}–{windKey.hi} M/S
            </span>
          )}
          {contourPaths.length > 0 && (
            <span className={r.windKeyItem}>
              <span className={r.modelDash} />
              {modelLabel.toUpperCase()}
            </span>
          )}
        </div>
      )}

      {/* status line: the one line a glance has to land on */}
      <div className={r.statusLine}>
        {status ?? (
          contacts.length === 0 ? (
            <span className={r.clear}>◆ NO CONTACTS</span>
          ) : (
            <>
              <span className={r.count}>{contacts.length} CONTACT{contacts.length === 1 ? '' : 'S'}</span>
              {criticals > 0 && (
                <span className={r.critical}>{SEVERITY_GLYPH.critical} {criticals} CRITICAL</span>
              )}
              {worst && (
                <span className={r.bearing}>
                  {SEVERITY_GLYPH[worst.severity]} {worst.code ?? ''} {fmtBearing(worst.bearing_deg)} · {fmtDistance(worst.distance_m)}
                </span>
              )}
            </>
          )
        )}
      </div>

      {/* the selected contact, spelled out — no interpretation required */}
      {activeContact && (
        <dl className={r.detail}>
          <div>
            <dt>CONTACT</dt>
            <dd>{activeContact.label ?? activeContact.code ?? activeContact.id}</dd>
          </div>
          <div>
            <dt>SEVERITY</dt>
            <dd style={{ color: severityVar(activeContact.severity) }}>
              {SEVERITY_GLYPH[activeContact.severity]} {SEVERITY_LABEL[activeContact.severity].toUpperCase()}
            </dd>
          </div>
          <div>
            <dt>BEARING</dt>
            <dd>{fmtBearing(activeContact.bearing_deg)}</dd>
          </div>
          <div>
            <dt>RANGE</dt>
            <dd>{fmtDistance(activeContact.distance_m)}</dd>
          </div>
          <div>
            <dt>SOURCE</dt>
            <dd>{SOURCE_LABEL[activeContact.source ?? 'monitor']}</dd>
          </div>
          {activeContact.startedAt && (
            <div>
              <dt>UP FOR</dt>
              <dd>{fmtElapsed(activeContact.startedAt)}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}
