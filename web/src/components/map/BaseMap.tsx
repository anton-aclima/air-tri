/**
 * BaseMap — ONE map component, two backends.
 *
 * The user chose Google Maps, so the Google path is the real one: deck.gl over
 * `GoogleMapsOverlay`, key from `VITE_GOOGLE_MAPS_API_KEY`. There is no key on
 * this machine, so the same props API also drives a MapLibre backend with
 * keyless CARTO tiles — selected automatically when the key is absent. Callers
 * never branch on which one mounted.
 *
 *   <BaseMap layers={(theme) => [...SegmentLayer({ data, theme })]}>
 *     <MapOverlay place="top-left"><MeasurePicker … /></MapOverlay>
 *     <MapOverlay place="bottom-left"><MapLegend … /></MapOverlay>
 *   </BaseMap>
 *
 * `layers` may be a plain array or a function of the resolved role `Theme`, which
 * is the ergonomic bit: layer factories need tokens, and the map already has them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { LayersList, PickingInfo } from 'deck.gl';

import type { MapSkin, Theme } from '../lib/theme';
import { useTheme } from '../lib/theme';
import { useSize } from '../lib/useSize';
import { MapContext, DEFAULT_VIEW } from './MapContext';
import type { MapView } from './MapContext';
import { MapLibreBackend } from './backends/MapLibreBackend';
import { GoogleBackend } from './backends/GoogleBackend';
import styles from './BaseMap.module.css';

export type BasemapBackend = 'google' | 'maplibre';

export interface BaseMapProps {
  /** Uncontrolled starting camera. */
  initialView?: Partial<MapView>;
  /** Controlled camera. Supply with `onViewChange` to lift view state. */
  view?: Partial<MapView>;
  onViewChange?(next: MapView): void;

  /** deck.gl layers, or a function of the resolved role theme. */
  layers?: LayersList | ((theme: Theme) => LayersList);

  /** Override the skin. Defaults to `--map-style` from the role theme. */
  skin?: MapSkin;
  /** Force a backend. Default `'auto'`: Google when a key exists, else MapLibre. */
  backend?: BasemapBackend | 'auto';

  interactive?: boolean;
  minZoom?: number;
  maxZoom?: number;
  maxPitch?: number;
  cursor?: string;
  pickingRadius?: number;
  getTooltip?: (info: PickingInfo) => string | null;
  onHover?: (info: PickingInfo) => void;
  onClick?: (info: PickingInfo) => void;

  /** The role's `--grid-overlay` over the tiles, under the data. Default true. */
  gridOverlay?: boolean;
  /** Soft inner vignette. Default true. */
  vignette?: boolean;
  /** Basemap attribution. Keep it on in anything user-facing. Default true. */
  attribution?: boolean;

  /**
   * Full-bleed content drawn above the tiles and the data, below the furniture,
   * with pointer events off. This is where `<MapWindField>` goes.
   */
  fullBleed?: ReactNode;
  /** Furniture. Wrap each child in `<MapOverlay place=…>` to place it. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onBackendChange?(backend: BasemapBackend): void;
  /** Accessible name for the map region. */
  label?: string;
}

const ATTRIBUTION: Record<BasemapBackend, string> = {
  maplibre: '© OpenStreetMap · CARTO',
  google: '© Google',
};

function readEnv(name: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return (env?.[name] ?? '').trim();
}

/**
 * Which backend to use, given the env and an explicit request.
 *
 * MapLibre is the default even when a Google key is present. The four role skins
 * are the product's visual argument, and the Google key on this machine returns
 * a stock light basemap under every skin: its Cloud project forces vector
 * rendering, and vector maps ignore the `styles` array. Verified — no auth or
 * billing error, `renderingType: 'RASTER'` doesn't override it either. A light
 * basemap under the regulator's dark tower-defense board is worse than losing
 * Google, so the keyless CARTO backend wins by default.
 *
 * To go back: set `VITE_BASEMAP=google`, having either published four cloud
 * styles (one per skin) or enabled raster styling on the key's project.
 */
export function resolveBackend(requested: BasemapBackend | 'auto' = 'auto'): BasemapBackend {
  if (requested !== 'auto') return requested;
  const forced = readEnv('VITE_BASEMAP');
  if (forced === 'google' || forced === 'maplibre') return forced;
  return 'maplibre';
}

/**
 * Overlay a partial camera onto a complete one, ignoring `undefined`.
 *
 * A plain spread does not do this: `{...DEFAULT_VIEW, ...{longitude: undefined}}`
 * yields `longitude: undefined`, and MapLibre answers that with
 * `Invalid LngLat object: (undefined, undefined)` — a throw during render, which
 * the app-level error boundary turns into a blank page for the whole interface.
 * Callers hit it constantly and reasonably:
 * `initialView={{ longitude: campaign?.center[0] }}` is undefined on every
 * render before bootstrap resolves. Falling back to the default camera for one
 * frame is the obviously correct behaviour, so do it here rather than making
 * every caller remember.
 */
function mergeView(base: MapView, patch?: Partial<MapView>): MapView {
  if (!patch) return base;
  const out = { ...base };
  for (const k of Object.keys(patch) as (keyof MapView)[]) {
    const v = patch[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function BaseMap(props: BaseMapProps) {
  const {
    initialView, view: controlledView, onViewChange, layers,
    skin: skinOverride, backend: backendProp = 'auto',
    interactive = true, minZoom = 9, maxZoom = 19, maxPitch = 60,
    cursor, pickingRadius = 4, getTooltip, onHover, onClick,
    gridOverlay = true, vignette = true, attribution = true,
    fullBleed, children, className, style, onBackendChange,
    label = 'Campaign map',
  } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const theme = useTheme(rootRef);
  const [sizeRef, size] = useSize<HTMLDivElement>({ width: 800, height: 520 });

  const skin: MapSkin = skinOverride ?? theme.skin;
  const apiKey = readEnv('VITE_GOOGLE_MAPS_API_KEY');
  const mapId = readEnv('VITE_GOOGLE_MAPS_MAP_ID');

  const [failed, setFailed] = useState<string | null>(null);
  const requested = resolveBackend(backendProp);
  // A Google failure (bad key, blocked referrer) must not leave a blank panel:
  // fall through to the backend that needs no credentials.
  const backend: BasemapBackend = failed && requested === 'google' ? 'maplibre' : requested;

  useEffect(() => { onBackendChange?.(backend); }, [backend, onBackendChange]);

  const [innerView, setInnerView] = useState<MapView>(() => mergeView(DEFAULT_VIEW, initialView));
  const view: MapView = useMemo(
    () => (controlledView
      ? mergeView(mergeView(DEFAULT_VIEW, initialView), controlledView)
      : innerView),
    [controlledView, initialView, innerView],
  );

  const handleView = useCallback((next: MapView) => {
    if (!controlledView) setInnerView(next);
    onViewChange?.(next);
  }, [controlledView, onViewChange]);

  const setView = useCallback((patch: Partial<MapView>) => {
    handleView({ ...view, ...patch });
  }, [handleView, view]);

  const resolvedLayers: LayersList = useMemo(
    () => (typeof layers === 'function' ? layers(theme) : (layers ?? [])),
    [layers, theme],
  );

  const ctx = useMemo(() => ({
    view, backend, theme, setView, size,
  }), [view, backend, theme, setView, size]);

  const backendProps = {
    view,
    onViewChange: handleView,
    layers: resolvedLayers,
    skin,
    theme,
    interactive,
    minZoom,
    maxZoom,
    maxPitch,
    cursor,
    pickingRadius,
    getTooltip,
    onHover,
    onClick,
    onError: setFailed,
  };

  return (
    <MapContext.Provider value={ctx}>
      <div
        ref={(el) => { rootRef.current = el; sizeRef.current = el; }}
        className={[styles.root, className].filter(Boolean).join(' ')}
        style={style}
        role="region"
        aria-label={label}
      >
        <div className={styles.canvas}>
          {backend === 'google'
            ? <GoogleBackend {...backendProps} apiKey={apiKey} mapId={mapId} />
            : <MapLibreBackend {...backendProps} />}
        </div>

        {gridOverlay && <div className={styles.grid} aria-hidden="true" />}
        {fullBleed && <div className={styles.fullBleed}>{fullBleed}</div>}
        {vignette && <div className={styles.vignette} aria-hidden="true" />}

        <div className={styles.overlay}>{children}</div>

        {attribution && (
          <div className={styles.attribution}>{ATTRIBUTION[backend]}</div>
        )}
      </div>
    </MapContext.Provider>
  );
}

// ───────────────────────────────────────────────────────────── placement

export type OverlayPlace =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

const PLACE: Record<OverlayPlace, CSSProperties> = {
  'top-left': { gridArea: '1 / 1', justifySelf: 'start', alignSelf: 'start' },
  'top-center': { gridArea: '1 / 2', justifySelf: 'center', alignSelf: 'start' },
  'top-right': { gridArea: '1 / 3', justifySelf: 'end', alignSelf: 'start' },
  'middle-left': { gridArea: '2 / 1', justifySelf: 'start', alignSelf: 'center' },
  'middle-right': { gridArea: '2 / 3', justifySelf: 'end', alignSelf: 'center' },
  'bottom-left': { gridArea: '3 / 1', justifySelf: 'start', alignSelf: 'end' },
  'bottom-center': { gridArea: '3 / 2', justifySelf: 'center', alignSelf: 'end' },
  'bottom-right': { gridArea: '3 / 3', justifySelf: 'end', alignSelf: 'end' },
};

/** Positions one piece of furniture in the map's overlay grid. */
export function MapOverlay(p: {
  place?: OverlayPlace;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}) {
  const { place = 'top-left', children, style, className } = p;
  return (
    <div className={className} style={{ ...PLACE[place], display: 'grid', gap: 'var(--s-2)', ...style }}>
      {children}
    </div>
  );
}
