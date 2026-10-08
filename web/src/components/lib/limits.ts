/**
 * Published ANNUAL limits for the pollutants a street map can be read
 * against — the waterlines on `RampKey`.
 *
 * Owner decisions (2026-10-08, docs/PLAN-community.md): the community map
 * shows real concentrations, EPA and WHO are NAMED, and only ANNUAL limits are
 * drawn. Naming them is a recorded exception to the fictional-actors rule, and
 * a narrow one: these are published reference values, quoted as numbers. Every
 * advisory, alert and finding in the demo is still issued by the invented
 * agency (DRAQA); nothing here says EPA or WHO said anything about these
 * streets.
 *
 * Annual only, because a street's colour is a median over many passes across
 * weeks — a long-term average. Held against a 1-hour or 24-hour limit it
 * would be the R3 mistake (an hourly value judged against an 8-hour rule) in
 * reverse. Pollutants with no annual limit (ozone, CO, black carbon, the
 * index) get none, and the key says so rather than inventing one.
 *
 * Units are the data's own (`measure_def.unit`): NO2 in ppb, PM2.5 in µg/m³.
 * WHO publishes NO2 in µg/m³; 10 µg/m³ is 5.3 ppb at 25 °C and 1 atm
 * (× 24.45 / 46.01).
 */

export interface PublishedLimit {
  body: 'WHO' | 'EPA';
  /** As drawn on the key and the street card ("WHO guideline"). The key says once that every line is annual. */
  label: string;
  /** In the measure's own unit. */
  value: number;
  /** Where the number comes from, for the key's title attribute. */
  source: string;
}

export const ANNUAL_LIMITS: Readonly<Record<string, readonly PublishedLimit[]>> = {
  no2: [
    {
      body: 'WHO',
      label: 'WHO guideline',
      value: 5.3,
      source: 'WHO global air quality guidelines (2021): 10 µg/m³ annual mean, 5.3 ppb at 25 °C',
    },
    {
      body: 'EPA',
      label: 'EPA standard',
      value: 53,
      source: 'US EPA National Ambient Air Quality Standard: 53 ppb annual mean',
    },
  ],
  pm25: [
    {
      body: 'WHO',
      label: 'WHO guideline',
      value: 5,
      source: 'WHO global air quality guidelines (2021): 5 µg/m³ annual mean',
    },
    {
      body: 'EPA',
      label: 'EPA standard',
      value: 9,
      source: 'US EPA primary National Ambient Air Quality Standard (2024): 9.0 µg/m³ annual mean',
    },
  ],
};

/** The annual limits for a measure code, lowest first; empty when none exists. */
export function annualLimits(measure: string | null | undefined): readonly PublishedLimit[] {
  if (!measure) return [];
  return [...(ANNUAL_LIMITS[measure] ?? [])].sort((a, b) => a.value - b.value);
}

/** The data's unit as people write it: 'ug/m3' → 'µg/m³'. */
export function displayUnit(unit: string | null | undefined): string {
  if (!unit) return '';
  return unit.replace(/^ug\/m3$/i, 'µg/m³').replace(/^mg\/m3$/i, 'mg/m³');
}
