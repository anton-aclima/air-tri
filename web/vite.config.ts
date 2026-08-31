import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

/**
 * air — Vite config.
 *
 *  · `@/` resolves to `web/src/` (mirrored in tsconfig.app.json `paths`).
 *  · `/api` proxies to the FastAPI server on :8000, including the
 *    `/api/v1/events/stream` SSE endpoint — compression is disabled on the
 *    proxy so events are flushed straight through instead of buffered.
 *  · The same proxy is wired into `preview`, so `npm run preview` talks to the
 *    real API too.
 */
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: 'http://localhost:8000',
    changeOrigin: true,
    configure: (proxy) => {
      // Server-Sent Events: no buffering, no re-encoding.
      proxy.on('proxyReq', (proxyReq) => {
        proxyReq.setHeader('accept-encoding', 'identity')
      })
      // The backend is written in parallel and may simply not be up yet.
      // Swallow ECONNREFUSED so the dev server keeps serving the app.
      proxy.on('error', () => {})
    },
  },
}

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },

  server: {
    port: 5173,
    strictPort: false,
    proxy: apiProxy,
  },

  preview: {
    port: 4173,
    proxy: apiProxy,
  },

  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 2400,
  },
})
