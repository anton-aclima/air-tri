/// <reference types="google.maps" />
/**
 * Google Maps backend — the real path.
 *
 * deck.gl rides on `GoogleMapsOverlay`, so Google owns the camera and the deck
 * layers stay registered to its tiles.
 *
 * Styling deliberately ignores `VITE_GOOGLE_MAPS_MAP_ID`. A cloud Map ID carries
 * exactly one style, but the product needs four — the role skins are what make
 * the regulator's screen read as a dark tower-defense board and the community's
 * as warm paper. Google drops `styles` whenever a mapId is present, so passing
 * one collapses all four narratives into whichever style Cloud Console holds.
 * The token-generated `styles` array is therefore the primary path, not a
 * fallback. Cost: raster styling, so no tilt/heading and no Advanced Markers.
 * To go back to vector, publish four cloud styles and pass a per-skin id.
 */

import { useEffect, useRef, useState } from 'react';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { importLibrary, setOptions } from '@googlemaps/js-api-loader';

/** `setOptions` is global and warns on any call after the first. */
let loaderConfigured = false;

import type { BackendProps } from './types';
import { googleMapStyles } from '../styles/mapStyles';

export interface GoogleBackendProps extends BackendProps {
  apiKey: string;
  /** Reserved: a per-skin cloud Map ID. Ignored today — see the file header. */
  mapId?: string;
}

export function GoogleBackend(props: GoogleBackendProps) {
  const {
    apiKey, view, onViewChange, layers, skin, theme, interactive,
    minZoom, maxZoom, cursor, pickingRadius, getTooltip, onHover, onClick,
    onReady, onError,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlayRef = useRef<GoogleMapsOverlay | null>(null);
  const [ready, setReady] = useState(false);
  /** Set while we are driving the camera ourselves, so we don't echo back. */
  const writing = useRef(false);
  const latestView = useRef(view);
  latestView.current = view;

  // ── boot ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!apiKey) return;

    if (!loaderConfigured) {
      setOptions({ key: apiKey, v: 'weekly' });
      loaderConfigured = true;
    }
    importLibrary('maps')
      .then(({ Map }) => {
        if (cancelled || !hostRef.current) return;
        const v = latestView.current;
        const map = new Map(hostRef.current, {
          center: { lng: v.longitude, lat: v.latitude },
          zoom: v.zoom,
          heading: v.bearing,
          tilt: v.pitch,
          minZoom,
          maxZoom,
          isFractionalZoomEnabled: true,
          disableDefaultUI: true,
          clickableIcons: false,
          keyboardShortcuts: interactive,
          gestureHandling: interactive ? 'greedy' : 'none',
          // A Cloud project with a *default* Map ID makes the JS API pick vector
          // rendering, and vector maps ignore `styles` outright — the map comes
          // back in Google's stock light style no matter the skin. Forcing
          // RASTER is what actually hands styling back to us.
          renderingType: 'RASTER' as google.maps.RenderingType,
          styles: googleMapStyles(theme, skin),
        });
        mapRef.current = map;

        const overlay = new GoogleMapsOverlay({ layers: [] });
        overlay.setMap(map);
        overlayRef.current = overlay;

        const emit = () => {
          if (writing.current) return;
          const c = map.getCenter();
          if (!c) return;
          onViewChange({
            longitude: c.lng(),
            latitude: c.lat(),
            zoom: map.getZoom() ?? latestView.current.zoom,
            bearing: map.getHeading() ?? 0,
            pitch: map.getTilt() ?? 0,
          });
        };
        map.addListener('bounds_changed', emit);
        map.addListener('idle', emit);
        map.addListener('heading_changed', emit);
        map.addListener('tilt_changed', emit);

        setReady(true);
        onReady?.();
      })
      .catch((e: unknown) => {
        onError?.(e instanceof Error ? e.message : 'Google Maps failed to load');
      });

    return () => {
      cancelled = true;
      overlayRef.current?.setMap(null);
      overlayRef.current?.finalize();
      overlayRef.current = null;
      mapRef.current = null;
    };
    // Only the key rebuilds the map; everything else is applied incrementally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // ── layers & interaction ────────────────────────────────────────────────
  useEffect(() => {
    overlayRef.current?.setProps({
      layers,
      getTooltip,
      onHover,
      onClick,
      pickingRadius,
    });
  }, [layers, getTooltip, onHover, onClick, pickingRadius, ready]);

  // ── skin ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setOptions({ styles: googleMapStyles(theme, skin) });
  }, [theme, skin, ready]);

  // ── controlled camera ───────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const moved = !c
      || Math.abs(c.lng() - view.longitude) > 1e-7
      || Math.abs(c.lat() - view.latitude) > 1e-7
      || Math.abs((map.getZoom() ?? 0) - view.zoom) > 1e-3
      || Math.abs((map.getHeading() ?? 0) - view.bearing) > 1e-3
      || Math.abs((map.getTilt() ?? 0) - view.pitch) > 1e-3;
    if (!moved) return;
    writing.current = true;
    map.moveCamera({
      center: { lng: view.longitude, lat: view.latitude },
      zoom: view.zoom,
      heading: view.bearing,
      tilt: view.pitch,
    });
    // release on the next tick, after Google has emitted its own events
    const id = window.setTimeout(() => { writing.current = false; }, 0);
    return () => window.clearTimeout(id);
  }, [view.longitude, view.latitude, view.zoom, view.bearing, view.pitch]);

  useEffect(() => {
    if (hostRef.current && cursor) hostRef.current.style.cursor = cursor;
  }, [cursor]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}
