import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Output is served by Express at /v2/* in production.
// Dev: Vite on 5173 with API proxy to Express on 3001.
export default defineConfig({
  plugins: [react()],
  base: '/v2/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
});
