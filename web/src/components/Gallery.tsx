/**
 * ComponentGallery — dev-only harness.
 *
 * Renders every component in this library against representative fixture data, at
 * any of the four `data-role` skins. It exists so the library can be *looked at*
 * rather than only typechecked, and so the four UI agents can see what they are
 * composing before they wire a backend.
 *
 * Open `/gallery.html` in the dev server. `?role=community|regulator|industry|admin`
 * picks a skin (`?role=all` stacks them), `?map=0` skips the WebGL sections.
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { MeasureCode, Monitor, Role, SegmentMetric } from '@/core/types';
import { unitFor } from '@/core/measures';

import { BaseMap, MapOverlay } from './map/BaseMap';
import { SegmentLayer, segmentDomain } from './map/layers/SegmentLayer';
import type { DualEncoding } from './map/layers/SegmentLayer';
import { BoundaryLayer } from './map/layers/BoundaryLayer';
import { MonitorLayer } from './map/layers/MonitorLayer';
import { SiteLayer } from './map/layers/SiteLayer';
import { ConcernLayer } from './map/layers/ConcernLayer';
import { FleetLayer } from './map/layers/FleetLayer';
import { BEYOND_ENVELOPE_NOTE, DispersionLayer, FiledStudyLayer } from './map/layers/WindLayer';
import { DrivePlanLayer } from './map/layers/DrivePlanLayer';
import { MapWindField } from './wind/MapWindField';
import { ModelVerificationPanel } from './wind/ModelVerificationPanel';

import { MapLegend } from './map/furniture/MapLegend';
import { MeasurePicker, MetricPicker } from './map/furniture/Pickers';
import { MapScale } from './map/furniture/MapScale';
import { NorthCompass } from './map/furniture/NorthCompass';
import { MiniRose } from './map/furniture/MiniRose';
import { MapTooltip, MapPopover } from './map/furniture/MapTooltip';
import { LayerToggles } from './map/furniture/LayerToggles';
import { SegmentInspector } from './map/furniture/SegmentInspector';
import { PlumeSwatch } from './map/furniture/PlumeSwatch';

import { TimeSeries } from './charts/TimeSeries';
import { DiurnalClock } from './charts/DiurnalClock';
import { SeasonalStrip, CalendarHeat } from './charts/SeasonalStrip';
import { Sparkline } from './charts/Sparkline';
import { RiskDial } from './charts/RiskDial';
import { Gauge } from './charts/Gauge';
import { Distribution } from './charts/Distribution';
import { AlertTimeline, timelineFromAlerts } from './charts/AlertTimeline';
import { WindRose } from './charts/WindRose';
import { CompassBearing } from './charts/CompassBearing';
import { RadarScope, contactsFromAlerts } from './charts/RadarScope';

import { usePulse, useFleetAnimation } from './lib/anim';
import { makeColorScale } from './lib/scales';
import * as fx from './fixtures';
import g from './Gallery.module.css';

const ROLES: Role[] = ['community', 'regulator', 'industry', 'admin'];

// Visual direction, not metaphor (PLAN-refocus F5): each room's metaphor is
// how it LOOKS, and the metaphor's words stay out of anything a user reads.
const ROLE_BLURB: Record<Role, string> = {
  community: 'Warm paper, big type, plain words. No units, no acronyms, one obvious button.',
  regulator: 'Cool cyan on slate. Reference monitors with their coverage, our fleet between them, the modelled plume as a hairline over measured streets.',
  industry: 'Phosphor green on near-black, mono numerals, square corners. One map and one line of status: the operating envelope, and what is downwind.',
  admin: 'Blueprint grid, numeric readouts, everything visible.',
};

function useQuery() {
  return useMemo(() => {
    if (typeof window === 'undefined') return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);
}

export type GallerySection =
  | 'hero' | 'registers' | 'frame' | 'verify' | 'charts' | 'furniture' | 'driveplan';

const ALL_SECTIONS: GallerySection[] = ['hero', 'registers', 'frame', 'verify', 'charts', 'furniture', 'driveplan'];

export interface ComponentGalleryProps {
  /** Overrides the `?role=` query parameter. */
  role?: Role | 'all';
  /** Overrides `?map=`. WebGL sections are heavy in a screenshot loop. */
  showMap?: boolean;
  /** Overrides `?section=` — a comma-separated subset, for targeted review. */
  sections?: GallerySection[];
}

export function ComponentGallery(props: ComponentGalleryProps) {
  const q = useQuery();
  const roleParam = (props.role ?? q.get('role') ?? 'regulator') as Role | 'all';
  const showMap = props.showMap ?? q.get('map') !== '0';
  const raw = q.get('section');
  const sections = props.sections
    ?? (raw ? raw.split(',').filter((x): x is GallerySection => ALL_SECTIONS.includes(x as GallerySection)) : ALL_SECTIONS);
  const roles = roleParam === 'all' ? ROLES : [roleParam];

  return (
    <>
      {roles.map((role) => (
        <div key={role} data-role={role} className={g.page}>
          <RolePanel role={role} showMap={showMap} activeRole={roleParam} sections={sections} />
        </div>
      ))}
    </>
  );
}

function Section(p: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className={g.section}>
      <div className={g.sectionHead}>
        <h2 className={g.h2}>{p.title}</h2>
        {p.note && <p className={g.note}>{p.note}</p>}
      </div>
      {p.children}
    </section>
  );
}

function Card(p: { label?: string; center?: boolean; children: ReactNode }) {
  return (
    <div className={[g.card, p.center ? g.cardCenter : ''].filter(Boolean).join(' ')}>
      {p.label && <span className={g.cardLabel}>{p.label}</span>}
      {p.children}
    </div>
  );
}

/**
 * The three model registers of CONTRACT §10b on one map, over measured
 * streets: Aclima's model as a hairline with its axis and reach tick, the
 * same outline dashed past the detection envelope, and the filed study
 * dotted in its own colour. The test is the contract's — they must be told
 * apart before the key is read — so the key is small and in a corner.
 *
 * Reference monitors by name, without rings, one lit: the industry deck's
 * "lit only when downwind". Hover a muted one for its label.
 */
function RegistersSection() {
  const [hover, setHover] = useState<string | null>(null);
  const domain = useMemo(() => segmentDomain(fx.SEGMENTS), []);
  const reference = useMemo(() => fx.MONITORS.filter((m) => m.grade !== 'lowcost'), []);
  const c = fx.RIDGELINE.centroid;
  return (
    <Section
      title="Model registers — CONTRACT §10b"
      note={
        'Measured streets are the only filled ink. Aclima\'s model is a hairline with a '
        + 'centreline and a reach tick where measurement range ends; past it the same line is '
        + 'dashed. The filed study is dotted, in its own colour, so the two outlines never '
        + 'share a pattern. Nothing here is filled but the streets.'
      }
    >
      <div className={g.mapFrame}>
        <BaseMap
          initialView={{ longitude: c[0] - 0.012, latitude: c[1] - 0.03, zoom: 11.9 }}
          layers={(theme) => [
            ...SegmentLayer({
              data: fx.SEGMENTS, theme, metric: 'median', dualEncode: 'width',
              scale: makeColorScale(theme, { domain }),
            }),
            ...FiledStudyLayer({ contours: fx.DISPERSION_MODEL.contours, theme }),
            ...DispersionLayer({ data: fx.DISPERSION_OUTLINE, theme, style: 'outline' }),
            ...SiteLayer({ data: fx.SITES, theme, labels: true }),
            ...MonitorLayer({
              data: reference, theme, rings: false, labelBy: 'name', sizePx: 20,
              emphasizeIds: ['mon_draqa_boxtown'], hoveredId: hover,
              onHover: (info) => setHover((info.object as Monitor | undefined)?.id ?? null),
            }),
          ]}
        >
          <MapOverlay place="bottom-left">
            <div className={g.registerKey}>
              <span className={g.registerRow}><PlumeSwatch register="model" />Today&rsquo;s plume (model)</span>
              <span className={g.registerRow}><PlumeSwatch register="beyond" />{BEYOND_ENVELOPE_NOTE}</span>
              <span className={g.registerRow}><PlumeSwatch register="filed" />Filed study</span>
            </div>
          </MapOverlay>
        </BaseMap>
      </div>
    </Section>
  );
}

function RolePanel(props: {
  role: Role; showMap: boolean; activeRole: Role | 'all'; sections: GallerySection[];
}) {
  const { role, showMap, activeRole, sections } = props;
  const on = (x: GallerySection) => sections.includes(x);
  const plain = role === 'community';

  const [measure, setMeasure] = useState<MeasureCode>('no2');
  const [metric, setMetric] = useState<SegmentMetric>(plain ? 'risk' : 'median');
  const [dual, setDual] = useState<DualEncoding>('width');
  const [layers, setLayers] = useState<Record<string, boolean>>({
    segments: true, boundary: true, monitors: true, sites: true,
    concerns: true, fleet: true, wind: true, plume: role === 'regulator',
    // Industry's street ramp IS the measured ramp, so its wind is drawn in
    // neutral ink (MapWindField colorMode 'neutral'); the toggle shows both.
    windNeutral: role === 'industry',
  });

  const def = fx.MEASURES.find((m) => m.code === measure) ?? fx.NO2;
  const pulse = usePulse(1400);
  const fleet = useFleetAnimation(fx.FLEET, { durationMs: 5000 });

  const domain = useMemo(() => segmentDomain(fx.SEGMENTS), []);
  const contacts = useMemo(() => contactsFromAlerts(fx.ALERTS), []);
  const timeline = useMemo(() => timelineFromAlerts(fx.ALERTS), []);

  const unit = plain ? '' : unitFor(def);

  return (
    <>
      <header className={g.header}>
        <div className={g.brand}>
          <span className={g.roleName}>{role}</span>
          <h1 className={g.h1}>air — component library</h1>
          <p className={g.note}>{ROLE_BLURB[role]}</p>
        </div>
        <div className={g.stack}>
          <span className={g.sim}>◆ Simulated data</span>
          <nav className={g.tabs}>
            {[...ROLES, 'all' as const].map((r) => (
              <a
                key={r}
                className={[g.tab, r === activeRole ? g.tabOn : ''].filter(Boolean).join(' ')}
                href={`?role=${r}`}
              >{r}</a>
            ))}
          </nav>
        </div>
      </header>

      {/* ── THE HERO ─────────────────────────────────────────────────────── */}
      {showMap && on('hero') && (
        <Section
          title="The road grid"
          note={
            'The flagship visualisation: ~200 m road segments coloured by magnitude and '
            + 'weighted by persistence, so how much and how often read at the same time. '
            + 'Real Southwest Memphis street geometry; simulated values from a plume field.'
          }
        >
          <div className={[g.mapFrame, g.mapFrameTall].join(' ')}>
            <BaseMap
              initialView={{ longitude: fx.CENTER[0], latitude: fx.CENTER[1], zoom: 12.6 }}
              fullBleed={layers.wind ? <MapWindField
                    field={fx.WIND_FIELD}
                    colorMode={layers.windNeutral ? 'neutral' : 'ramp'}
                    particles={5200}
                    opacity={0.34}
                    speedScale={0.42}
                    keep={0.965}
                    lineWidth={1}
                  /> : null}
              layers={(theme) => [
                ...(layers.boundary ? BoundaryLayer({ data: fx.BOUNDARY, theme }) : []),
                ...(layers.segments
                  ? SegmentLayer({
                    data: fx.SEGMENTS,
                    theme,
                    metric,
                    dualEncode: dual,
                    scale: makeColorScale(theme, { domain }),
                    selectedId: fx.SEGMENT_DETAIL.id,
                  })
                  : []),
                ...(layers.plume ? DispersionLayer({ data: fx.DISPERSION_PLUME, theme, maxOpacity: 0.18 }) : []),
                ...(layers.sites ? SiteLayer({ data: fx.SITES, theme, pulse, labels: true }) : []),
                ...(layers.monitors
                  ? MonitorLayer({ data: fx.MONITORS, theme, pulse, measure, sizePx: 26 })
                  : []),
                ...(layers.concerns
                  ? ConcernLayer({ data: fx.CONCERNS, clusters: fx.CLUSTERS, theme, pulse })
                  : []),
                ...(layers.fleet ? FleetLayer({ data: fleet, theme, pulse }) : []),
              ]}
            >
              <MapOverlay place="top-left">
                <MeasurePicker
                  measures={fx.MEASURES}
                  value={measure}
                  onChange={setMeasure}
                  plainLanguage={plain}
                  showHue
                />
                {!plain && (
                  <MetricPicker value={metric} onChange={setMetric} />
                )}
              </MapOverlay>

              <MapOverlay place="top-right">
                <NorthCompass alwaysVisible />
                <LayerToggles
                  items={[
                    { id: 'segments', label: 'Road grid', enabled: layers.segments },
                    { id: 'boundary', label: 'Campaign', enabled: layers.boundary },
                    { id: 'monitors', label: 'Instruments', enabled: layers.monitors, count: fx.MONITORS.length },
                    { id: 'sites', label: 'Emitters', enabled: layers.sites, count: fx.SITES.length },
                    { id: 'concerns', label: 'Reports', enabled: layers.concerns, count: fx.CONCERNS.length },
                    { id: 'fleet', label: 'Our fleet', enabled: layers.fleet, count: fx.FLEET.length },
                    { id: 'wind', label: 'Wind field', enabled: layers.wind },
                    { id: 'windNeutral', label: 'Wind in neutral ink', enabled: layers.windNeutral },
                    { id: 'plume', label: 'Model plume', enabled: layers.plume },
                  ]}
                  onToggle={(id, next) => setLayers((s) => ({ ...s, [id]: next }))}
                />
              </MapOverlay>

              <MapOverlay place="bottom-left">
                <MapLegend
                  scale={null}
                  domain={domain}
                  measure={def}
                  metric={metric}
                  dualEncode={dual}
                  plainLanguage={plain}
                />
                <MapScale units={plain ? 'imperial' : 'metric'} />
              </MapOverlay>
            </BaseMap>
          </div>

          <div className={g.row}>
            <span className={g.cardLabel}>Dual encoding</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['width', 'opacity', 'both', 'none'] as DualEncoding[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDual(d)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 'var(--r-pill)',
                    border: `1px solid ${d === dual ? 'var(--accent)' : 'var(--line)'}`,
                    background: d === dual ? 'var(--accent)' : 'var(--surface)',
                    color: d === dual ? 'var(--accent-ink)' : 'var(--ink-2)',
                    font: 'inherit',
                    fontSize: 'var(--text-xs)',
                    cursor: 'pointer',
                  }}
                >{d}</button>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* ── THE MODEL REGISTERS ──────────────────────────────────────────── */}
      {showMap && on('registers') && <RegistersSection />}

      {/* ── THE COMBINED FRAME (retired from the deck) ───────────────────── */}
      {on('frame') && (
      <Section
        title="RadarScope — retired from the industry deck"
        note={
          'Kept for reference until the backlog removes it (PLAN-refocus D8). The deck now '
          + 'tells this on the map: the wind our vehicles measured as particles, and the filed '
          + 'study as a dotted outline the operator can switch on to compare.'
        }
      >
        <div className={g.stage}>
          <RadarScope
            contacts={contacts}
            size={420}
            site={fx.RIDGELINE.centroid}
            windField={showMap ? fx.WIND_FIELD : null}
            windParticles={1500}
            windSpeedDomain={[0, 8]}
            modelContours={fx.DISPERSION_MODEL.contours}
            modelLabel={fx.DISPERSION_MODEL.vendor ?? 'Consultant model'}
            ownLabel={fx.RIDGELINE.name}
            title="Ridgeline South Campus — passive radar"
            selectedId={contacts[0]?.id}
            onSelect={() => {}}
          />
          <div className={g.stack}>
            <AlertTimeline
              alerts={timeline}
              title="How long each contact has been up"
              subtitle="Open bars with a live edge are still running."
              rowHeight={26}
              showTable={false}
            />
            <div className={g.row}>
              {contacts.slice(0, 3).map((c) => (
                <CompassBearing
                  key={c.id}
                  bearing={c.bearing_deg}
                  distanceM={c.distance_m}
                  severity={c.severity}
                  label={c.code}
                />
              ))}
            </div>
          </div>
        </div>
      </Section>
      )}

      {/* ── VERIFY YOUR CONSULTANT ───────────────────────────────────────── */}
      {on('verify') && (
      <Section
        title="Verify your consultant"
        note={
          'Our vehicles carry anemometers, so we hold observed street-level wind — not just a '
          + 'model. The gap between the assumed rose and the measured one is the part of an '
          + 'expensive study that was wrong, and who it lands on.'
        }
      >
        <div className={g.gridWide + ' ' + g.grid}>
          <Card>
            <ModelVerificationPanel data={fx.MODEL_VERIFICATION} roseSize={230} />
          </Card>
          <Card label="WindRose · observations, stacked by speed">
            <WindRose
              points={fx.WIND_POINTS}
              size={250}
              mode="speed"
              nObs={fx.WIND_POINTS.length}
              title="Observed wind, 30 days"
              subtitle="Petals point the way the wind comes FROM."
              showTable={false}
            />
          </Card>
        </div>
      </Section>
      )}

      {/* ── CHARTS ──────────────────────────────────────────────────────── */}
      {on('charts') && (
      <Section
        title="Charts"
        note="One instrument family: hairline solid axes, 2px lines, tabular numerals, a legend whenever there are two or more series, and a table twin so no value is gated behind a hover."
      >
        <div className={[g.grid, g.gridWide].join(' ')}>
          <Card label="TimeSeries · action levels + shaded exceedance">
            <TimeSeries
              series={[
                { id: 'no2', label: 'NO₂ median', points: fx.HOURLY, band: fx.HOURLY_BAND },
              ]}
              thresholds={[
                { id: 'spike', label: '1-h action level', value: 53, severity: 'warning' },
                { id: 'dose', label: '8-h watch', value: 38, severity: 'watch' },
              ]}
              height={220}
              unit="ppb"
              brushable
              title="Boxtown Reference — last 48 hours"
              subtitle="Shaded bands are time spent over an action level."
            />
          </Card>

          <Card label="TimeSeries · multi-series, 90 days">
            <TimeSeries
              series={[
                { id: 'no2', label: 'NO₂', points: fx.DAILY, band: fx.DAILY_BAND },
                { id: 'bc', label: 'Black carbon ×10', points: fx.DAILY_BC.map((p) => ({ t: p.t, v: (p.v ?? 0) * 10 })) },
              ]}
              thresholds={[{ id: 'ref', label: 'reference', value: 21, severity: 'info' }]}
              height={220}
              unit="ppb"
              title="Campaign to date"
              subtitle="Two modalities indexed to one axis — never a second y-scale."
            />
          </Card>

          <Card label="DiurnalClock · the signature visual" center>
            <DiurnalClock
              points={fx.DIURNAL}
              band={fx.DIURNAL_BAND}
              size={280}
              measure={def}
              plainLanguage={plain}
              refLevel={plain ? null : def.ref_level}
              title="Through the day"
              subtitle="Midnight at the top, hours clockwise. Night hours washed."
              showTable={false}
            />
          </Card>

          <Card label="DiurnalClock · ring mode" center>
            <DiurnalClock
              points={fx.DIURNAL}
              size={220}
              mode="ring"
              measure={def}
              plainLanguage={plain}
              title="Compact form"
              subtitle="Constant radius, colour only — for a dense panel."
              showTable={false}
            />
          </Card>

          <Card label="SeasonalStrip · 90 days">
            <SeasonalStrip
              points={fx.DAILY}
              unit={unit}
              title="Campaign season"
              subtitle="A barcode of daily intensity."
              markers={[{ t: fx.DAILY[80].t, label: 'turbine test' }]}
            />
          </Card>

          <Card label="CalendarHeat · weeks × weekdays">
            <CalendarHeat
              points={fx.DAILY}
              unit={unit}
              title="Day by day"
              subtitle="Exposes the weekly cycle a strip hides."
            />
          </Card>

          <Card label="Distribution · where does this street sit">
            <Distribution
              values={fx.CAMPAIGN_VALUES}
              marker={fx.SEGMENT_PROPS?.value ?? null}
              markerLabel={fx.SEGMENT_DETAIL.name ?? 'this street'}
              unit={unit}
              height={170}
              title="Against the whole campaign"
              subtitle="756 monitored segments."
            />
          </Card>

          <Card label="AlertTimeline">
            <AlertTimeline
              alerts={timeline}
              title="Alert durations"
              subtitle="Severity in colour and glyph; live bars pulse."
            />
          </Card>

          <Card label="RiskDial · community headline" center>
            <RiskDial risk={58} trendPct={-12} label="Air quality today" size={210} />
          </Card>

          <Card label="Gauge · one value against one limit">
            <div className={g.stack}>
              <Gauge
                value={64.1} domain={[0, 90]} threshold={53}
                thresholdLabel="action level" unit="ppb" label="East fenceline NO₂"
              />
              <Gauge
                value={22} domain={[0, 100]} threshold={80}
                thresholdLabel="permit ceiling" unit="%" label="Headroom used"
                ramp="aqi"
              />
              <Gauge
                value={fx.MODEL_VERIFICATION.disagreement * 100} domain={[0, 100]}
                threshold={15} thresholdLabel="tolerance" unit="%"
                label="Model disagreement" decimals={0}
              />
            </div>
          </Card>

          <Card label="Sparkline · trend at the size of a word">
            <div className={g.stack}>
              {fx.MEASURES.slice(0, 5).map((m, i) => (
                <div key={m.code} style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-2)' }}>
                    {plain ? m.plain_name : m.label}
                  </span>
                  <Sparkline
                    points={fx.DAILY.slice(-30 - i * 3, -1 - i * 3).map((p) => ({ t: p.t, v: (p.v ?? 0) * (1 - i * 0.1) }))}
                    width={132}
                    height={28}
                    threshold={plain ? null : m.ref_level}
                    ariaLabel={`30-day trend for ${m.label}`}
                  />
                </div>
              ))}
            </div>
          </Card>

          <Card label="WindRose · two roses superimposed" center>
            <WindRose
              rose={fx.MODEL_VERIFICATION.observed_wind}
              compare={fx.DISPERSION_MODEL.assumed_wind}
              roseLabel="Observed"
              compareLabel="Assumed"
              mode="freq"
              size={240}
              nObs={fx.MODEL_VERIFICATION.n_obs}
              title="Assumed vs observed"
              showTable={false}
            />
          </Card>

          <Card label="MiniRose · map furniture, no numbers" center>
            <MiniRose
              rose={fx.MODEL_VERIFICATION.observed_wind}
              caption="Where the wind came from, last three months"
            />
          </Card>

          <Card label="CompassBearing">
            <div className={g.stack}>
              <CompassBearing bearing={95} distanceM={1180} severity="critical" label="East fenceline" />
              <CompassBearing bearing={148} distanceM={1620} severity="warning" label="Resident cluster" />
              <CompassBearing bearing={265} distanceM={3420} severity="watch" label="Westwood School" />
            </div>
          </Card>

          <Card label="RadarScope · standalone, no wind" center>
            <RadarScope contacts={contacts} size={280} ownLabel="Ridgeline South" />
          </Card>
        </div>
      </Section>
      )}

      {/* ── FURNITURE ───────────────────────────────────────────────────── */}
      {on('furniture') && (
      <Section
        title="Map furniture"
        note="Everything that floats over a map. One panel treatment, four skins, no per-role code."
      >
        <div className={g.grid}>
          <Card label="MapLegend · with the dual-encoding key">
            <MapLegend domain={domain} measure={def} metric={metric} dualEncode="width" plainLanguage={plain} />
          </Card>
          <Card label="MapLegend · opacity encoding">
            <MapLegend domain={domain} measure={def} metric="persistence" dualEncode="opacity" plainLanguage={plain} />
          </Card>
          <Card label="MeasurePicker">
            <div className={g.stack}>
              <MeasurePicker measures={fx.MEASURES} value={measure} onChange={setMeasure} plainLanguage={plain} showHue />
              <MeasurePicker measures={fx.MEASURES} value={measure} onChange={setMeasure} variant="chips" plainLanguage={plain} showUnit={!plain} />
              <MeasurePicker measures={fx.MEASURES} value={measure} onChange={setMeasure} variant="select" plainLanguage={plain} />
            </div>
          </Card>
          <Card label="MetricPicker">
            <div className={g.stack}>
              <MetricPicker value={metric} onChange={setMetric} />
              <MetricPicker value={metric} onChange={setMetric} variant="chips" longLabels />
            </div>
          </Card>
          <Card label="MapScale · NorthCompass">
            <div className={g.row} style={{ alignItems: 'flex-start' }}>
              <MapScale zoom={12.1} latitude={35.058} units="both" />
              <NorthCompass bearing={38} pitch={0} alwaysVisible readout />
              <NorthCompass bearing={0} alwaysVisible />
            </div>
          </Card>
          <Card label="LayerToggles">
            <LayerToggles
              items={[
                { id: 'segments', label: 'Road grid', enabled: true },
                { id: 'monitors', label: 'Instruments', enabled: true, count: 6 },
                { id: 'concerns', label: 'Reports', enabled: false, count: 14 },
                { id: 'fleet', label: 'Our fleet', enabled: true, count: 5 },
              ]}
              onToggle={() => {}}
            />
          </Card>
          <Card label="MapTooltip · MapPopover (positioned inline for the gallery)">
            <div className={g.tooltipDemo}>
              <MapTooltip
                x={30} y={30}
                subtitle="Residential · 198 m"
                title={fx.SEGMENT_DETAIL.name ?? 'Weaver Road'}
                hero={{ value: String(fx.SEGMENT_PROPS?.median ?? '—'), unit }}
                rows={[
                  { label: 'P90', value: `${fx.SEGMENT_PROPS?.p90 ?? '—'} ${unit}` },
                  { label: 'Persistence', value: `${Math.round((fx.SEGMENT_PROPS?.persistence ?? 0) * 100)}%` },
                  { label: 'Passes', value: String(fx.SEGMENT_PROPS?.n_passes ?? 0) },
                ]}
                style={{ position: 'absolute', left: 12, top: 12 }}
              />
            </div>
          </Card>
        </div>

        <div className={g.grid}>
          <Card label="SegmentInspector · full detail">
            <SegmentInspector
              segment={fx.SEGMENT_PROPS}
              detail={fx.SEGMENT_DETAIL}
              measure={def}
              measureCode={measure}
              metric={metric}
              plainLanguage={plain}
              campaignValues={fx.CAMPAIGN_VALUES}
              domain={domain}
              onClose={() => {}}
              style={{ inlineSize: '100%' }}
            />
          </Card>
          <Card label="MapPopover · anchored card with actions">
            <div className={g.tooltipDemo} style={{ blockSize: 260 }}>
              <MapPopover
                x={16} y={16}
                subtitle="Community cluster"
                title="Six reports in 2 hours"
                actions={[
                  { label: 'Acknowledge', onClick: () => {}, primary: true },
                  { label: 'Open thread', onClick: () => {} },
                ]}
                onClose={() => {}}
                style={{ position: 'absolute', left: 12, top: 12 }}
              >
                <p className={g.note}>
                  Smell and noise, Boxtown south-east, 600 m radius. Industry may propose a
                  mitigation but cannot close a resident&apos;s concern.
                </p>
              </MapPopover>
            </div>
          </Card>
        </div>
      </Section>
      )}

      {/* ── ADMIN: DRIVE PLAN ───────────────────────────────────────────── */}
      {showMap && on('driveplan') && (
        <Section
          title="DrivePlanLayer · coverage mode"
          note="Passes ÷ target on one sequential ramp. Under-covered segments draw thicker, because the gap is what the admin is hunting for."
        >
          <div className={g.mapFrame} style={{ blockSize: 420 }}>
            <BaseMap
              initialView={{ longitude: fx.CENTER[0], latitude: fx.CENTER[1], zoom: 12.6 }}
              layers={(theme) => [
                ...BoundaryLayer({ data: fx.BOUNDARY, theme, glow: false }),
                ...DrivePlanLayer({
                  mode: 'coverage',
                  coverage: fx.COVERAGE,
                  segments: fx.SEGMENTS,
                  theme,
                  target: 25,
                }),
              ]}
            >
              <MapOverlay place="bottom-left"><MapScale /></MapOverlay>
            </BaseMap>
          </div>
        </Section>
      )}
    </>
  );
}

export default ComponentGallery;
