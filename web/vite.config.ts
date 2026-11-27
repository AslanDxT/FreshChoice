import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.ico', 'favicon.svg', 'logo.svg', 'logo-mono.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Fresh Choice Rooster',
        short_name: 'Fresh Choice',
        description: 'Workforce scheduling for Fresh Choice supermarkets',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#FBF8F5',
        theme_color: '#ED7F6E',
        icons: [
          // New logo (Nov 2026) on the light-mode background. "any" icons are the rounded brand
          // tile with transparent corners (desktop and launchers show them as-is); the maskable
          // one is full-bleed because Android cuts its own shape. Versioned names so installed
          // apps and caches pick up the new icon instead of keeping an old one.
          { src: '/pwa-any-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-any-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Only the app shell is cached. API responses (private data) are never cached by the
        // service worker, so nothing personal is left on a shared device.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
