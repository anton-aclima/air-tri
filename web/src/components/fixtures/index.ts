/**
 * Gallery fixtures.
 *
 * Dev-only sample data so every component in this library can be rendered and
 * eyeballed without a backend. Real Southwest Memphis geography (CONTRACT §2
 * allows that explicitly); every actor is fictional.
 *
 * The pollutant field, the wind field and the consultant's model are all
 * deliberately *structured* — a plume corridor to the north-east, a wind rose that
 * under-weights north days — so the components are exercised on data shaped like
 * the real thing rather than on noise.
 */

import type {
  ActionLevel, Alert, Concern, ConcernCluster, DispersionModel, FleetPosition,
  IndustrySite, MeasureDef, ModelVerification, Monitor, Position, SegmentDetail,
  SeriesPoint, WindField, WindFieldCell, WindPoint,
} from '@/core/types';
import { campaignMs, fromCampaignMs } from '@/core/clock';

export { SEGMENTS } from './segments';
export { BOUNDARY } from './boundary';
import { BOUNDARY } from './boundary';
import { FOOTPRINTS } from './footprints';
import { SEGMENTS } from './segments';

export const CENTER: Position = [-90.132, 35.058];
export const BBOX: [number, number, number, number] = [-90.1735, 35.016, -90.0662, 35.1155];

/** The campaign ring, for clipping. We only hold data where we actually drove. */
const RING: Position[] = (BOUNDARY.features[0].geometry as { coordinates: Position[][] }).coordinates[0];

function inRing(lon: number, lat: number, ring: Position[] = RING): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Deterministic PRNG, so the gallery looks identical on every reload. */
function prng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0xffffffff;
  };
}
const rnd = prng(20260827);

const DAY = 86_400_000;
/**
 * Fixed "now" so screenshots are reproducible — the fixtures' own moment, not
 * the demo's (that is the session's, `useNowCampaign`).
 *
 * The fixtures live on the campaign axis (`campaignMs`, core/clock): a `Date`
 * here holds the campaign digits in its UTC fields, which is why `HOURLY` reads
 * `getUTCHours()`. `stamp` writes those digits back as naive campaign time — the
 * digits `toISOString()` wrote, without the `Z` that told everything downstream
 * they were UTC.
 */
export const NOW = new Date(campaignMs('2026-08-27T15:00:00'));
const stamp = (d: Date): string => fromCampaignMs(d.getTime());

// ───────────────────────────────────────────────────────────── measures

export const MEASURES: MeasureDef[] = [
  {
    code: 'no2', label: 'NO₂', short_label: 'NO2', unit: 'ppb', family: 'modality',
    ref_level: 21, healthy_max: 53,
    scale: [[0, 0], [10, 18], [21, 40], [35, 62], [53, 80], [80, 95], [120, 100]],
    ramp: [], decimals: 1, sort_order: 1,
    description: 'Nitrogen dioxide — mostly combustion and traffic exhaust.',
    plain_name: 'traffic exhaust',
  },
  {
    code: 'pm25', label: 'PM2.5', short_label: 'PM2.5', unit: 'µg/m³', family: 'modality',
    ref_level: 9, healthy_max: 35,
    scale: [[0, 0], [5, 16], [9, 38], [15, 55], [35, 80], [55, 93], [110, 100]],
    ramp: [], decimals: 1, sort_order: 2,
    description: 'Fine particulate matter.',
    plain_name: 'soot and dust',
  },
  {
    code: 'bc', label: 'Black carbon', short_label: 'BC', unit: 'µg/m³', family: 'modality',
    ref_level: 1.2, healthy_max: 3,
    scale: [[0, 0], [0.5, 15], [1.2, 40], [2, 62], [3, 80], [5, 94], [8, 100]],
    ramp: [], decimals: 2, sort_order: 3,
    description: 'Soot from diesel and other incomplete combustion.',
    plain_name: 'diesel soot',
  },
  {
    code: 'o3', label: 'Ozone', short_label: 'O3', unit: 'ppb', family: 'modality',
    ref_level: 60, healthy_max: 70,
    scale: [[0, 0], [30, 18], [55, 40], [70, 62], [85, 80], [105, 94], [140, 100]],
    ramp: [], decimals: 0, sort_order: 4,
    description: 'Ground-level ozone.',
    plain_name: 'smog',
  },
  {
    code: 'co2', label: 'CO₂', short_label: 'CO2', unit: 'ppm', family: 'modality',
    ref_level: 450, healthy_max: 1000,
    scale: [[380, 0], [430, 20], [500, 45], [650, 68], [900, 85], [1200, 96], [2000, 100]],
    ramp: [], decimals: 0, sort_order: 5,
    description: 'Carbon dioxide — a proxy for combustion volume.',
    plain_name: 'engine and turbine exhaust',
  },
  {
    code: 'ch4', label: 'Methane', short_label: 'CH4', unit: 'ppb', family: 'modality',
    ref_level: 1950, healthy_max: 2500,
    scale: [[1800, 0], [1900, 15], [1990, 38], [2200, 60], [2600, 82], [3200, 95], [5000, 100]],
    ramp: [], decimals: 0, sort_order: 6,
    description: 'Methane — leak indicator.',
    plain_name: 'gas leaks',
  },
];

export const NO2 = MEASURES[0];

export const ACTION_LEVELS: ActionLevel[] = [
  {
    id: 'al_no2_spike', measure: 'no2', label: 'NO₂ 1-hour', kind: 'spike',
    threshold: 53, unit: 'ppb', averaging_hours: 1, severity: 'warning', enabled: true,
    source: 'DRAQA action level', notify_community: true, notify_industry: true,
    updated_at: stamp(NOW),
  },
  {
    id: 'al_no2_dose', measure: 'no2', label: 'NO₂ 8-hour dose', kind: 'integrated',
    threshold: 38, unit: 'ppb', averaging_hours: 8, severity: 'watch', enabled: true,
    source: 'DRAQA action level', notify_community: true, notify_industry: false,
    updated_at: stamp(NOW),
  },
];

// ───────────────────────────────────────────────────────────── series

/** 90 days of daily medians with a weekly cycle and a late-campaign episode. */
export const DAILY: SeriesPoint[] = Array.from({ length: 90 }, (_, i) => {
  const t = new Date(NOW.getTime() - (89 - i) * DAY);
  const weekly = Math.sin((i / 7) * Math.PI * 2) * 2.4;
  const drift = Math.sin((i / 90) * Math.PI) * 5;
  // the generator-test episode in the last fortnight
  const episode = i > 76 && i < 84 ? 16 * Math.exp(-Math.pow(i - 80, 2) / 4) : 0;
  return {
    t: stamp(t),
    v: Number((19 + weekly + drift + episode + (rnd() - 0.5) * 3.2).toFixed(2)),
  };
});

export const DAILY_BAND = DAILY.map((p) => ({
  t: p.t,
  lo: Number(((p.v ?? 0) * 0.62).toFixed(2)),
  hi: Number(((p.v ?? 0) * 1.52).toFixed(2)),
}));

/** A second modality, for the multi-series case. */
export const DAILY_BC: SeriesPoint[] = DAILY.map((p, i) => ({
  t: p.t,
  v: Number((((p.v ?? 0) * 0.055) + Math.sin(i / 5) * 0.07 + 0.35).toFixed(3)),
}));

/** 48 hours of hourly readings — the regulator's exceedance read. */
export const HOURLY: SeriesPoint[] = Array.from({ length: 48 }, (_, i) => {
  const t = new Date(NOW.getTime() - (47 - i) * 3.6e6);
  const h = t.getUTCHours();
  // twin traffic peaks plus a turbine test overnight
  const diurnal = 14 + 17 * Math.exp(-Math.pow(h - 8, 2) / 5) + 20 * Math.exp(-Math.pow(h - 18, 2) / 6);
  const test = i > 30 && i < 38 ? 26 * Math.exp(-Math.pow(i - 34, 2) / 3) : 0;
  return { t: stamp(t), v: Number((diurnal + test + (rnd() - 0.5) * 4).toFixed(1)) };
});

export const HOURLY_BAND = HOURLY.map((p) => ({
  t: p.t,
  lo: Number(((p.v ?? 0) * 0.66).toFixed(1)),
  hi: Number(((p.v ?? 0) * 1.44).toFixed(1)),
}));

/** The diurnal fingerprint: morning and evening traffic, plus a night plateau. */
export const DIURNAL: SeriesPoint[] = Array.from({ length: 24 }, (_, h) => {
  const morning = 15 * Math.exp(-Math.pow(h - 7.5, 2) / 4.5);
  const evening = 19 * Math.exp(-Math.pow(h - 18, 2) / 6);
  const nightPlateau = h >= 22 || h <= 4 ? 7 : 0;
  return {
    t: `hour:${String(h).padStart(2, '0')}`,
    v: Number((9 + morning + evening + nightPlateau + (rnd() - 0.5) * 1.6).toFixed(1)),
  };
});

export const DIURNAL_BAND = DIURNAL.map((p) => ({
  lo: Number(((p.v ?? 0) * 0.58).toFixed(1)),
  hi: Number(((p.v ?? 0) * 1.58).toFixed(1)),
}));

/** Every segment's value, for the percentile chart. */
export const CAMPAIGN_VALUES: number[] = SEGMENTS.features
  .map((f) => f.properties.value)
  .filter((v): v is number => v !== null);

// ───────────────────────────────────────────────────────────── sites

const SITE_DEFS = [
  {
    id: 'site_ridgeline', name: 'Ridgeline South Campus', kind: 'datacenter' as const,
    org: 'Ridgeline Compute', color: '#B58CFF', emoji: '🖧',
    capacity: 320, itLoad: 240, gens: 18, fuel: 'natural gas + diesel backup',
    headroom: 22,
    blurb: 'AI training campus. On-site gas turbines with diesel backup generators.',
  },
  {
    id: 'site_deltaforge', name: 'Delta Forge Metals', kind: 'manufacturing' as const,
    org: 'Delta Forge Metals', color: '#F2A65A', emoji: '🏭',
    capacity: null, itLoad: null, gens: 4, fuel: 'natural gas',
    headroom: 61,
    blurb: 'Secondary aluminium processing. Two melt furnaces.',
  },
  {
    id: 'site_riverport', name: 'Riverport Logistics', kind: 'logistics' as const,
    org: 'Riverport Logistics', color: '#8FA3B8', emoji: '🚛',
    capacity: null, itLoad: null, gens: 1, fuel: 'diesel',
    headroom: 74,
    blurb: 'Intermodal freight terminal. Roughly 900 truck movements a day.',
  },
];

const EMIT_KINDS = ['generator', 'cooling_tower', 'stack', 'backup', 'traffic_gate'] as const;

export const SITES: IndustrySite[] = SITE_DEFS.map((d, i) => {
  const fp = FOOTPRINTS[i * 2] ?? FOOTPRINTS[i] ?? FOOTPRINTS[0];
  const centroid = fp.centroid;
  return {
    id: d.id,
    org_id: `org_${i}`,
    name: d.name,
    kind: d.kind,
    footprint: { type: 'Polygon', coordinates: [fp.ring] },
    centroid,
    claimed_by_user_id: i === 0 ? 'user_ridgeline_ops' : null,
    claimed_at: i === 0 ? stamp(NOW) : null,
    status: 'operating',
    capacity_mw: d.capacity,
    it_load_mw: d.itLoad,
    generator_count: d.gens,
    generator_fuel: d.fuel,
    operating_since: '2024-03-01',
    blurb: d.blurb,
    brand_color: d.color,
    logo_emoji: d.emoji,
    website: null,
    headroom_pct: d.headroom,
    emission_points: Array.from({ length: i === 0 ? 4 : 2 }, (_, k) => ({
      id: `${d.id}_ep${k}`,
      site_id: d.id,
      name: `${['Turbine bank', 'Cooling tower', 'Stack', 'Backup genset', 'Gate'][k]} ${k + 1}`,
      kind: EMIT_KINDS[k % EMIT_KINDS.length],
      lon: centroid[0] + (rnd() - 0.5) * 0.004,
      lat: centroid[1] + (rnd() - 0.5) * 0.003,
      height_m: 12 + Math.round(rnd() * 30),
      active: k < 2,
      measures: ['no2', 'co2', 'bc'],
    })),
  };
});

export const RIDGELINE = SITES[0];

// ───────────────────────────────────────────────────────────── monitors

export const MONITORS: Monitor[] = [
  {
    id: 'mon_draqa_boxtown', name: 'Boxtown Reference', code: 'BXT-01',
    owner_type: 'regulator', org_id: 'org_draqa', site_id: null,
    lon: -90.1585, lat: 35.0475, grade: 'reference', status: 'online',
    measures: ['no2', 'pm25', 'o3'], radius_m: 2400,
    install_date: '2019-06-01', last_calibrated: '2026-07-14',
    blurb: 'DRAQA federal reference monitor.',
    latest: {
      no2: { value: 31.4, ts: stamp(NOW), exceeds: false },
      pm25: { value: 11.2, ts: stamp(NOW), exceeds: true },
    },
  },
  {
    id: 'mon_draqa_riverport', name: 'Riverport FEM', code: 'RVP-02',
    owner_type: 'regulator', org_id: 'org_draqa', site_id: null,
    lon: -90.0985, lat: 35.0995, grade: 'fem', status: 'online',
    measures: ['no2', 'o3'], radius_m: 1900,
    install_date: '2021-04-11', last_calibrated: '2026-06-30',
    blurb: 'Federal-equivalent method station.',
    latest: { no2: { value: 58.9, ts: stamp(NOW), exceeds: true } },
  },
  {
    id: 'mon_ridgeline_e', name: 'Ridgeline East Fenceline', code: 'RDG-E',
    owner_type: 'industry', org_id: 'org_0', site_id: 'site_ridgeline',
    lon: -90.0985, lat: 35.0862, grade: 'lowcost', status: 'online',
    measures: ['no2', 'co2'], radius_m: 700,
    install_date: '2025-09-02', last_calibrated: '2026-08-01',
    blurb: 'Operator fenceline sensor.',
    latest: { no2: { value: 64.1, ts: stamp(NOW), exceeds: true } },
  },
  {
    id: 'mon_ridgeline_w', name: 'Ridgeline West Fenceline', code: 'RDG-W',
    owner_type: 'industry', org_id: 'org_0', site_id: 'site_ridgeline',
    lon: -90.1135, lat: 35.0845, grade: 'lowcost', status: 'degraded',
    measures: ['no2'], radius_m: 700,
    install_date: '2025-09-02', last_calibrated: '2026-08-01',
    blurb: 'Operator fenceline sensor.',
    latest: { no2: { value: 22.7, ts: stamp(NOW), exceeds: false } },
  },
  {
    id: 'mon_baw_school', name: 'Westwood School Watch', code: 'BAW-1',
    owner_type: 'community', org_id: 'org_baw', site_id: null,
    lon: -90.1745, lat: 35.0705, grade: 'lowcost', status: 'online',
    measures: ['pm25'], radius_m: 900,
    install_date: '2026-02-20', last_calibrated: null,
    blurb: 'Boxtown Air Watch community sensor.',
    latest: { pm25: { value: 14.8, ts: stamp(NOW), exceeds: true } },
  },
  {
    id: 'mon_draqa_south', name: 'South Corridor', code: 'STH-03',
    owner_type: 'regulator', org_id: 'org_draqa', site_id: null,
    lon: -90.1425, lat: 35.0245, grade: 'reference', status: 'maintenance',
    measures: ['no2', 'pm25'], radius_m: 2100,
    install_date: '2018-01-15', last_calibrated: '2026-05-02',
    blurb: 'Offline for scheduled maintenance.',
    latest: {},
  },
];

// ───────────────────────────────────────────────────────────── community

const CONCERN_KINDS = ['smell', 'noise', 'smoke', 'dust', 'health', 'traffic', 'light', 'vibration'] as const;
const CONCERN_TITLES: Record<string, string> = {
  smell: 'Sharp chemical smell again',
  noise: 'Generators running all night',
  smoke: 'Haze over the school field',
  dust: 'Grit on every car on the block',
  health: 'My daughter\'s inhaler use is up',
  traffic: 'Truck queue idling on our street',
  light: 'Flare visible from the yard',
  vibration: 'House shaking since about 4am',
};
const NAMES = ['Marisol R.', 'Dwayne T.', 'Aisha B.', 'Frank O.', 'Lena K.', 'Curtis M.', 'Nia J.', 'Ray P.'];
const AVATARS = ['🌻', '🎺', '📚', '🔧', '🪴', '⚾', '🎨', '🚲'];
const HOODS = ['Boxtown', 'Westwood', 'Riverport', 'Walker Homes'];
const STATUSES = ['new', 'corroborated', 'under_review', 'mitigation_proposed', 'resolved'] as const;

/** A cluster of 6 to the south-east of Ridgeline — cross-role loop #1. */
export const CONCERNS: Concern[] = Array.from({ length: 14 }, (_, i) => {
  const inCluster = i < 6;
  const kind = CONCERN_KINDS[i % CONCERN_KINDS.length];
  const base: Position = inCluster ? [-90.1055, 35.0765] : [-90.145, 35.06];
  const spread = inCluster ? 0.006 : 0.05;
  const hoursAgo = inCluster ? i * 0.4 + 0.3 : 6 + i * 9;
  return {
    id: `cn_${i}`,
    author: rnd() > 0.2
      ? {
        id: `user_${i}`, name: NAMES[i % NAMES.length],
        avatar_emoji: AVATARS[i % AVATARS.length],
        avatar_color: null,
        neighborhood: HOODS[i % HOODS.length],
      }
      : null,
    kind,
    severity: (1 + Math.floor(rnd() * 5)) as 1 | 2 | 3 | 4 | 5,
    title: CONCERN_TITLES[kind] ?? 'Air quality concern',
    body: 'Reported through the community app.',
    lon: base[0] + (rnd() - 0.5) * spread,
    lat: base[1] + (rnd() - 0.5) * spread * 0.7,
    address_hint: null,
    district: HOODS[i % HOODS.length],
    occurred_at: stamp(new Date(NOW.getTime() - hoursAgo * 3.6e6)),
    created_at: stamp(new Date(NOW.getTime() - hoursAgo * 3.6e6)),
    status: inCluster ? (i < 3 ? 'corroborated' : 'under_review') : STATUSES[i % STATUSES.length],
    cluster_id: inCluster ? 'cl_boxtown_se' : null,
    corroborations: inCluster ? 2 + Math.floor(rnd() * 5) : Math.floor(rnd() * 3),
    is_anonymous: rnd() > 0.85,
    photo_emoji: null,
    suspected_site_id: inCluster ? 'site_ridgeline' : null,
    responses: [],
  };
});

export const CLUSTERS: ConcernCluster[] = [
  {
    id: 'cl_boxtown_se',
    label: 'Boxtown south-east',
    centroid: [-90.1055, 35.0765],
    radius_m: 600,
    count: 6,
    kinds: ['smell', 'noise', 'smoke'],
    first_at: stamp(new Date(NOW.getTime() - 2.4 * 3.6e6)),
    last_at: stamp(new Date(NOW.getTime() - 0.3 * 3.6e6)),
    status: 'active',
    site_id: 'site_ridgeline',
  },
];

// ───────────────────────────────────────────────────────────── fleet

const CALL_SIGNS = ['AC-01', 'AC-02', 'AC-03', 'AC-04', 'AC-05'];

export const FLEET: FleetPosition[] = CALL_SIGNS.map((cs, i) => {
  // Walk each vehicle along a real segment so the trail follows actual streets.
  const feat = SEGMENTS.features[(i * 97 + 13) % SEGMENTS.features.length];
  const coords = feat.geometry.coordinates;
  const trail: Position[] = [];
  for (let k = 0; k < Math.min(14, coords.length); k++) trail.push(coords[k] as Position);
  const head = trail[trail.length - 1] ?? CENTER;
  const prev = trail[trail.length - 2] ?? head;
  return {
    vehicle_id: `veh_${i}`,
    label: `Aclima ${cs}`,
    call_sign: cs,
    status: i === 4 ? 'charging' : 'driving',
    lon: head[0],
    lat: head[1],
    heading_deg: (Math.atan2(head[0] - prev[0], head[1] - prev[1]) * 180) / Math.PI,
    speed_kph: 18 + Math.round(rnd() * 22),
    segment_id: feat.properties.id,
    ts: stamp(NOW),
    delay_min: 0,
    trail,
  };
});

// ───────────────────────────────────────────────────────────── alerts

export const ALERTS: Alert[] = [
  {
    id: 'al_1', kind: 'exceedance', severity: 'critical', measure: 'no2',
    value: 64.1, threshold: 53, unit: 'ppb',
    source_type: 'monitor', source_id: 'mon_ridgeline_e',
    lon: -90.0985, lat: 35.0862, site_id: 'site_ridgeline',
    action_level_id: 'al_no2_spike',
    started_at: stamp(new Date(NOW.getTime() - 4.2 * 3.6e6)), ended_at: null,
    status: 'active',
    title: 'NO₂ over 1-hour action level, east fenceline',
    body: 'Reference-grade confirmation pending.',
    recommendation: 'Stage down turbine bank 2 or shift load west.',
    audience: ['regulator', 'industry'],
    created_at: stamp(new Date(NOW.getTime() - 4.2 * 3.6e6)),
    bearing_deg: 95, distance_m: 1180,
  },
  {
    id: 'al_2', kind: 'concern_cluster', severity: 'warning', measure: null,
    value: 6, threshold: 3, unit: null,
    source_type: 'community', source_id: 'cl_boxtown_se',
    lon: -90.1055, lat: 35.0765, site_id: 'site_ridgeline',
    action_level_id: null,
    started_at: stamp(new Date(NOW.getTime() - 2.4 * 3.6e6)), ended_at: null,
    status: 'active',
    title: 'Six resident reports within 600 m in 2 hours',
    body: 'Smell and noise, Boxtown south-east.',
    recommendation: 'Acknowledge publicly and post a mitigation.',
    audience: ['industry', 'regulator'],
    created_at: stamp(new Date(NOW.getTime() - 2.4 * 3.6e6)),
    bearing_deg: 148, distance_m: 1620,
  },
  {
    id: 'al_3', kind: 'integrated_exposure', severity: 'watch', measure: 'no2',
    value: 41.2, threshold: 38, unit: 'ppb',
    source_type: 'model', source_id: null,
    lon: -90.1745, lat: 35.0705, site_id: 'site_ridgeline',
    action_level_id: 'al_no2_dose',
    started_at: stamp(new Date(NOW.getTime() - 9.6 * 3.6e6)), ended_at: null,
    status: 'acknowledged',
    title: '8-hour dose trending over watch level near Westwood School',
    body: null,
    recommendation: 'Monitor; wind veer expected after 18:00.',
    audience: ['regulator'],
    created_at: stamp(new Date(NOW.getTime() - 9.6 * 3.6e6)),
    bearing_deg: 265, distance_m: 3420,
  },
  {
    id: 'al_4', kind: 'mobile_detection', severity: 'warning', measure: 'ch4',
    value: 3120, threshold: 1950, unit: 'ppb',
    source_type: 'mobile', source_id: 'veh_02',
    lon: -90.0895, lat: 35.0685, site_id: 'site_ridgeline',
    action_level_id: null,
    started_at: stamp(new Date(NOW.getTime() - 1.1 * 3.6e6)), ended_at: null,
    status: 'active',
    title: 'Methane anomaly the stationary network cannot see',
    body: 'Repeated on three passes.',
    recommendation: 'Survey the gas header on the south apron.',
    audience: ['regulator', 'industry'],
    created_at: stamp(new Date(NOW.getTime() - 1.1 * 3.6e6)),
    bearing_deg: 202, distance_m: 2260,
  },
  {
    id: 'al_5', kind: 'exceedance', severity: 'info', measure: 'pm25',
    value: 11.2, threshold: 9, unit: 'µg/m³',
    source_type: 'monitor', source_id: 'mon_draqa_boxtown',
    lon: -90.1585, lat: 35.0475, site_id: 'site_ridgeline',
    action_level_id: null,
    started_at: stamp(new Date(NOW.getTime() - 26 * 3.6e6)),
    ended_at: stamp(new Date(NOW.getTime() - 18 * 3.6e6)),
    status: 'resolved',
    title: 'PM2.5 daily mean over reference, Boxtown',
    body: null, recommendation: null,
    audience: ['regulator'],
    created_at: stamp(new Date(NOW.getTime() - 26 * 3.6e6)),
    bearing_deg: 318, distance_m: 5240,
  },
];

// ───────────────────────────────────────────────────────────── wind

/**
 * The observed field: a south-westerly that channels along the river and veers
 * toward the north as it crosses the campaign — which is exactly the regime the
 * consultant's model under-weights. `n` and `dir_sd` degrade toward the edges,
 * where our vehicles drive less, so the particle field visibly thins there.
 */
export const WIND_FIELD: WindField = (() => {
  const cellSize = 500;
  const dLat = cellSize / 110540;
  const dLon = cellSize / (111320 * Math.cos((35.07 * Math.PI) / 180));
  const cells: WindFieldCell[] = [];
  const nx = Math.floor((BBOX[2] - BBOX[0]) / dLon);
  const ny = Math.floor((BBOX[3] - BBOX[1]) / dLat);

  for (let iy = 0; iy <= ny; iy++) {
    for (let ix = 0; ix <= nx; ix++) {
      const lon = BBOX[0] + ix * dLon;
      const lat = BBOX[1] + iy * dLat;
      if (!inRing(lon, lat)) continue;
      const fx = ix / Math.max(1, nx);
      const fy = iy / Math.max(1, ny);

      // base SW flow veering north-east across the campaign
      let dir = 214 + fy * 34 - fx * 18;
      // river channelling along the western edge
      const riverPull = Math.exp(-Math.pow((fx - 0.12) / 0.16, 2));
      dir += riverPull * 22;
      // a gentle meander so streamlines are not parallel lines
      dir += Math.sin(fx * 5.2) * 7 + Math.cos(fy * 4.1) * 6;

      const speed = 2.6
        + 1.9 * Math.sin(fy * 2.4 + 0.6)
        + 1.3 * Math.cos(fx * 3.1)
        + riverPull * 1.7;

      // coverage: strong in the middle where the drive plan concentrates
      const centrality = Math.exp(-(Math.pow(fx - 0.5, 2) + Math.pow(fy - 0.52, 2)) / 0.14);
      const n = Math.max(0, Math.round(2 + centrality * 22));
      const dirSd = 6 + (1 - centrality) * 46;

      cells.push({
        lon: Number(lon.toFixed(5)),
        lat: Number(lat.toFixed(5)),
        speed_ms: Number(Math.max(0.4, speed).toFixed(2)),
        dir_deg: Number(((dir % 360) + 360).toFixed(1)) % 360,
        n,
        dir_sd: Number(dirSd.toFixed(1)),
      });
    }
  }
  return {
    cells,
    cell_size_m: cellSize,
    from: stamp(new Date(NOW.getTime() - 30 * DAY)),
    to: stamp(NOW),
    n_obs: cells.reduce((t, c) => t + c.n, 0),
    source: 'mobile',
  };
})();

/** Hourly wind for the rose and the time series. */
export const WIND_POINTS: WindPoint[] = Array.from({ length: 720 }, (_, i) => {
  const t = new Date(NOW.getTime() - (719 - i) * 3.6e6);
  // the real regime: SW-dominant, but a genuine secondary north mode
  const northDay = Math.sin(i / 61) > 0.72;
  const base = northDay ? 8 : 222;
  const dir = (base + (rnd() - 0.5) * 62 + 360) % 360;
  return {
    ts: stamp(t),
    speed_ms: Number((1.4 + rnd() * 5.4 + (northDay ? 1.1 : 0)).toFixed(2)),
    dir_deg: Number(dir.toFixed(1)),
    gust_ms: null,
    temp_c: Number((22 + Math.sin(i / 24) * 7).toFixed(1)),
    rh: null,
    pbl_m: null,
    stability: northDay ? 'D' : 'C',
  };
});

// ───────────────────────────────────────────── the consultant's model

/** 16-point rose helper. */
function rose(weights: number[], speeds: number[]) {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w, i) => ({
    dir_deg: i * 22.5,
    freq: Number((w / total).toFixed(4)),
    mean_speed_ms: speeds[i] ?? 3,
  }));
}

// N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW
const ASSUMED_W = [2, 2, 3, 3, 4, 5, 6, 8, 11, 15, 18, 12, 6, 3, 2, 2];
const OBSERVED_W = [9, 8, 5, 3, 4, 4, 5, 7, 10, 13, 15, 9, 4, 2, 2, 4];
const SPEEDS = [3.6, 3.4, 3.0, 2.7, 2.6, 2.8, 3.0, 3.2, 3.5, 3.9, 4.2, 3.8, 3.2, 2.9, 3.0, 3.3];

export const DISPERSION_MODEL: DispersionModel = {
  id: 'dm_ridgeline_2025',
  site_id: 'site_ridgeline',
  name: 'Ridgeline South — NO₂ dispersion study',
  vendor: 'Cardinal Environmental Partners',
  method: 'AERMOD 23132, 5-year MET',
  // The study the operator filed. Drawn as a dashed outline, never filled.
  model_tier: 'permit',
  measure: 'no2',
  averaging_hours: 1,
  issued_at: '2025-11-18',
  assumed_wind: rose(ASSUMED_W, SPEEDS),
  notes: 'Assumes airport MET tower, 10 m, 2019–2023.',
  // A cone pointing NE — downwind of the assumed SW-dominant rose only.
  contours: [0, 1, 2].map((band) => {
    const centroid = RIDGELINE.centroid;
    const reach = 2600 - band * 780;
    const halfWidth = 26 - band * 5;
    const ring: Position[] = [centroid];
    for (let a = -halfWidth; a <= halfWidth; a += 3) {
      const bearing = 41 + a;
      const rad = (bearing * Math.PI) / 180;
      const dLatM = Math.cos(rad) * reach;
      const dLonM = Math.sin(rad) * reach;
      ring.push([
        centroid[0] + dLonM / (111320 * Math.cos((centroid[1] * Math.PI) / 180)),
        centroid[1] + dLatM / 110540,
      ]);
    }
    ring.push(centroid);
    return {
      band,
      level: [53, 38, 21][band],
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
    };
  }),
};

export const MODEL_VERIFICATION: ModelVerification = (() => {
  const assumed = DISPERSION_MODEL.assumed_wind;
  const observed = rose(OBSERVED_W, SPEEDS);
  const bias = observed.map((o, i) => ({
    dir_deg: o.dir_deg,
    assumed_freq: assumed[i].freq,
    observed_freq: o.freq,
    delta: Number(((o.freq - assumed[i].freq) * 100).toFixed(2)),
  }));
  return {
    site_id: 'site_ridgeline',
    model: DISPERSION_MODEL,
    observed_wind: observed,
    bearing_bias: bias,
    understated_bearings: bias.filter((b) => b.delta > 3.5).map((b) => b.dir_deg),
    disagreement: 0.28,
    // Percentages 0-100, matching `GET /sites/{id}/model-verification` and the
    // `assumed_freq` / `observed_freq` scale in core/types.ts. NOT fractions.
    affected_districts: [
      { district: 'Boxtown', assumed_freq: 4, observed_freq: 17 },
      { district: 'Westwood', assumed_freq: 5, observed_freq: 13 },
    ],
    verdict: 'understates',
    summary:
      'The study assumed a south-west dominant rose from the airport tower. Our street-level '
      + 'anemometers measured a real secondary north mode: 17% of hours carry the plume toward '
      + 'Boxtown against the 4% assumed.',
    n_obs: WIND_FIELD.n_obs,
  };
})();

// ───────────────────────────────────────────────────────────── segment detail

export const SEGMENT_DETAIL: SegmentDetail = (() => {
  // pick a mid-corridor segment with a name, so the inspector reads well
  const feat = SEGMENTS.features.find((f) => f.properties.name && f.properties.n_passes > 30)
    ?? SEGMENTS.features[0];
  const p = feat.properties;
  const stats = MEASURES.reduce((acc, m) => {
    const k = m.ref_level ?? 1;
    acc[m.code] = {
      median: Number((k * 0.9).toFixed(2)),
      p10: Number((k * 0.55).toFixed(2)),
      p90: Number((k * 1.7).toFixed(2)),
      max: Number((k * 2.6).toFixed(2)),
      persistence: Number((0.2 + rnd() * 0.6).toFixed(2)),
      risk: Math.round(25 + rnd() * 55),
      n_passes: p.n_passes,
    };
    return acc;
  }, {} as SegmentDetail['stats']);
  stats.no2 = {
    median: p.median ?? 0, p10: (p.median ?? 0) * 0.6, p90: p.p90 ?? 0,
    max: p.max ?? 0, persistence: p.persistence ?? 0, risk: p.risk ?? 0,
    n_passes: p.n_passes,
  };

  const daily = { no2: DAILY } as SegmentDetail['daily'];
  const diurnalMap = { no2: DIURNAL } as SegmentDetail['diurnal'];
  const rank = { no2: p.risk ?? 50 } as SegmentDetail['rank_pct'];

  const coords = feat.geometry.coordinates;
  return {
    id: p.id,
    name: p.name,
    road_class: p.road_class,
    district: 'Boxtown',
    geometry: coords as Position[],
    length_m: p.length_m,
    mid: coords[Math.floor(coords.length / 2)] as Position,
    n_passes: p.n_passes,
    first_pass: stamp(new Date(NOW.getTime() - 89 * DAY)),
    last_pass: stamp(NOW),
    stats,
    daily,
    diurnal: diurnalMap,
    rank_pct: rank,
    nearest_site: { id: 'site_ridgeline', name: 'Ridgeline South Campus', distance_m: 1180, bearing_deg: 95 },
  };
})();

export const SEGMENT_PROPS = SEGMENT_DETAIL
  ? SEGMENTS.features.find((f) => f.properties.id === SEGMENT_DETAIL.id)?.properties
  : undefined;

// ───────────────────────────────────────────── live plume & coverage

/**
 * `GET /wind/dispersion` — the plume under the wind blowing *now*, as opposed to
 * the consultant's contour under the rose they assumed. Deliberately pointed
 * south-south-west, over Boxtown: this is the north-wind regime the study
 * under-weights, so the two shapes visibly disagree on the map.
 */
export const DISPERSION_PLUME: import('@/core/types').DispersionPlume = {
  type: 'FeatureCollection',
  features: [0, 1, 2].map((band) => {
    const c = RIDGELINE.centroid;
    // Stable night air, class F. Three things the fixture has to show, because
    // they are what the kernel produces and the gallery is where the register
    // gets designed: the plume STARTS 900 m out (aloft over the fenceline,
    // clean ground underneath), the bands are contours so they nest outward
    // from there, and the outermost one is past the 4 km detection envelope
    // and must render dashed with no fill.
    const ONSET = 900;
    const EDGES = [900, 2600, 4200, 6000];
    const [r0, r1] = [EDGES[band], EDGES[band + 1]];
    const half = 13 - band * 2;
    const mLon = 111320 * Math.cos((c[1] * Math.PI) / 180);
    const at = (r: number, a: number): Position => {
      const rad = ((196 + a) * Math.PI) / 180;
      return [c[0] + (Math.sin(rad) * r) / mLon, c[1] + (Math.cos(rad) * r) / 110540];
    };
    const ring: Position[] = [];
    for (let a = -half; a <= half; a += 2) ring.push(at(r1, a));
    for (let a = half; a >= -half; a -= 2) ring.push(at(r0, a * 0.6));
    ring.push(ring[0]);
    return {
      type: 'Feature' as const,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
      properties: {
        site_id: 'site_ridgeline',
        measure: 'no2' as const,
        level: [0.53, 0.16, 0.05][band],
        band,
        ts: stamp(NOW),
        n_sources: 13,
        x_onset_m: ONSET,
        x_peak_m: 2140,
        x_reach_m: 6000,
        reach_m: 6000,
        truncated: false,
        lofted: true,
        n_elevated: 11,
        elevated_touchdown_m: 860,
        elevated_peak_m: 2140,
        beyond_envelope: r1 > 4000,
        detection_envelope_m: 4000,
        wind_dir_deg: 16,
        wind_speed_ms: 1.5,
        stability: 'F',
      },
    };
  }),
};

/** `GET /drive-plan/{id}/coverage` — passes against a 25-pass target. */
export const COVERAGE: import('@/core/types').CoverageCell[] = SEGMENTS.features.map((f) => {
  const passes = f.properties.n_passes;
  return {
    segment_id: f.properties.id,
    passes,
    target: 25,
    pct: Math.min(1, passes / 25),
  };
});
