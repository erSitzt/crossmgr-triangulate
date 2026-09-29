/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// RF model, setup types and presets come straight from the crossmgr-antenna submodule.
const antennaSrc = fileURLToPath(new URL('../vendor/crossmgr-antenna/web/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@antenna': antennaSrc },
    // vendor files have no node_modules of their own: resolve shared packages from web/
    dedupe: ['react', 'react-dom', 'three', '@react-three/fiber', '@react-three/drei', 'zustand'],
  },
  server: {
    port: 5174,
    fs: { allow: ['..'] },
    proxy: {
      // reader bridge (server/app.py)
      '/api': 'http://127.0.0.1:18788',
      '/ws': { target: 'ws://127.0.0.1:18788', ws: true },
    },
  },
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts'] },
});
