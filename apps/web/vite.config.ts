import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite dev server proxies /api to the Fastify backend (default PORT 3000).
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // elkjs/lib/elk.bundled.js references 'web-worker' via its internal browserify
      // bundle (module #4 exports `typeof Worker !== "undefined" ? Worker : void 0`).
      // Vite/Rollup tries to treat it as an external ESM import which fails in the
      // browser. Alias it to the native browser Worker so bundling succeeds.
      'web-worker':
        'data:text/javascript,export default typeof Worker !== "undefined" ? Worker : undefined;',
    },
  },
  build: {
    // Built SPA is served by apps/server (main.ts looks for apps/web/dist/index.html).
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Separate chunk for graph dependencies (NFR-G2: ≤ 350 KiB gzipped)
          'graph-vendor': ['@xyflow/react', '@xyflow/system', 'elkjs'],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
});
