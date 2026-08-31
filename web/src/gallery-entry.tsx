/**
 * Dev-only probe at `/gallery.html`.
 *
 * Exists to answer one question the app itself can't yet answer: do deck.gl
 * layers survive a headless screenshot? It renders the road grid over the
 * basemap with nothing else in the way — no router, no SSE, no app shell — so a
 * blank capture can only mean the map stack is at fault.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@fontsource-variable/inter';
import '@fontsource-variable/instrument-sans';
import '@fontsource-variable/jetbrains-mono';
import './design/tokens.css';

import { BaseMap } from './components/map/BaseMap';
import { SegmentLayer } from './components/map/layers/SegmentLayer';
import type { SegmentCollection } from './core/types';

function Probe() {
  const q = new URLSearchParams(location.search);
  const backend = (q.get('backend') ?? 'auto') as 'auto' | 'google' | 'maplibre';
  const role = q.get('role') ?? 'regulator';
  const [data, setData] = useState<SegmentCollection | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/segments?measure=no2&limit=1500')
      .then((r) => r.json())
      .then(setData)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div data-role={role} style={{ position: 'absolute', inset: 0 }}>
      <BaseMap
        initialView={{ longitude: -90.128, latitude: 35.055, zoom: 12.4 }}
        backend={backend}
        layers={(t) => SegmentLayer({ data, theme: t })}
      />
      <div
        style={{
          position: 'absolute', top: 12, left: 12, zIndex: 50,
          font: '600 13px/1.4 ui-monospace, monospace',
          background: 'rgba(0,0,0,.72)', color: '#4FD1E0',
          padding: '8px 12px', borderRadius: 6,
        }}
      >
        {err ? `error: ${err}` : `${role} / ${backend} — features: ${data?.features.length ?? 'loading…'}`}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Probe />
  </StrictMode>,
);
