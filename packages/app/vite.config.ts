import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// base './' keeps built asset URLs relative so the same build works
// standalone AND embedded in a WordPress page or iframe.
export default defineConfig({
  plugins: [
    react(),
    // PWA/offline: remote launch sites (Black Rock…) have no internet, so the
    // whole app shell — including the engine and motor DB chunks — precaches.
    // Motor thrust curves fetched from thrustcurve.org already persist in
    // localStorage, so previously-loaded motors also work offline.
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Online OpenRocket',
        short_name: 'OpenRocket',
        description: 'Design model rockets and simulate flights — the real OpenRocket physics engine in your browser, offline-capable.',
        theme_color: '#101623',
        background_color: '#101623',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // woff/woff2: the self-hosted Rajdhani display face must work offline.
        globPatterns: ['**/*.{js,css,html,png,webmanifest,woff,woff2}'],
        // The engine chunk is ~2.5 MB — well over workbox's 2 MB default cap.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  base: './',
  // The engine is a linked workspace package whose entry imports a CJS
  // artifact (vendor/orkengine.cjs). Prebundle it so dev mode gets the same
  // CJS->ESM interop the production build gets from rollup-commonjs.
  optimizeDeps: {
    include: ['@online-openrocket/engine'],
  },
  build: {
    commonjsOptions: {
      // Separator-agnostic: on Windows resolved ids may use backslashes.
      include: [/vendor[\\/]orkengine\.cjs$/, /node_modules/],
    },
  },
});
