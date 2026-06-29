import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Web component tests run under jsdom. Referenced as a project by the root
// vitest.config.ts so `vitest run` covers core/server (node) + web (jsdom).
export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    root: import.meta.dirname,
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
