/**
 * MapLibre backend — the one that always works.
 *
 * Keyless CARTO vector tiles, restyled from the role tokens on load, with
 * deck.gl mounted as a MapLibre control (`MapboxOverlay`) so the base map keeps
 * ownership of the camera: inertia, keyboard panning and pinch-zoom all come for
 * free and the deck layers stay perfectly registered to the tiles.
 */

import { useEffect, useRef } from 'react';
import { Map, useControl } from 'react-map-gl/maplibre';
import type { MapRef } from 'react-map-gl/maplibre';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { MapboxOverlayProps } from '@deck.gl/mapbox';
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

import type { BackendProps } from './types';
import { BASE_STYLE_URL, applyMapLibreSkin } from '../styles/mapStyles';
import type { StyleTarget } from '../styles/mapStyles';

/*
 * MapLibre 6 finds its tile-parsing worker at `new URL('./maplibre-gl-worker.mjs',
 * import.meta.url)` — next to its own module. In a production build that is
 * `/assets/maplibre-gl-worker.mjs`, which Vite never emits: on the deployed
 * demo it 404'd, the worker never started, and the basemap drew nothing while
 * deck.gl kept drawing on its own canvas (the symptom vite.config.ts describes
 * for the dev-server variant). `?worker&url` makes Vite bundle the worker —
 * with the shared chunk it imports — into a real file and hands back its URL.
 * Set once, before any map is created.
 */
setWorkerUrl(maplibreWorkerUrl);

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

export function MapLibreBackend(props: BackendProps) {
  const {
    view, onViewChange, layers, skin, theme, interactive,
    minZoom, maxZoom, maxPitch, cursor, pickingRadius,
    getTooltip, onHover, onClick, onReady, onError,
  } = props;

  const mapRef = useRef<MapRef | null>(null);

  // Re-tint the loaded style whenever the role skin changes. Cheap: it walks the
  // style's layer list and sets flat paint colours, no reload.
  useEffect(() => {
    const m = mapRef.current?.getMap();
    if (!m) return;
    try {
      applyMapLibreSkin(m as unknown as StyleTarget, theme, skin);
    } catch { /* style not loaded yet; onLoad will handle it */ }
  }, [theme, skin]);

  return (
    <Map
      ref={mapRef}
      longitude={view.longitude}
      latitude={view.latitude}
      zoom={view.zoom}
      bearing={view.bearing}
      pitch={view.pitch}
      onMove={(e) => onViewChange({
        longitude: e.viewState.longitude,
        latitude: e.viewState.latitude,
        zoom: e.viewState.zoom,
        bearing: e.viewState.bearing,
        pitch: e.viewState.pitch,
      })}
      onLoad={(e) => {
        applyMapLibreSkin(e.target as unknown as StyleTarget, theme, skin);
        onReady?.();
      }}
      onError={(e) => onError?.(e.error?.message ?? 'Base map failed to load')}
      mapStyle={BASE_STYLE_URL[skin]}
      minZoom={minZoom}
      maxZoom={maxZoom}
      maxPitch={maxPitch}
      cursor={cursor}
      attributionControl={false}
      dragRotate={interactive}
      scrollZoom={interactive}
      dragPan={interactive}
      keyboard={interactive}
      doubleClickZoom={interactive}
      touchZoomRotate={interactive}
      reuseMaps
      style={{ position: 'absolute', inset: 0 }}
    >
      <DeckOverlay
        layers={layers}
        getTooltip={getTooltip}
        onHover={onHover}
        onClick={onClick}
        pickingRadius={pickingRadius}
      />
    </Map>
  );
}
