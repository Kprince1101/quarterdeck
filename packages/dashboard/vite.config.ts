import { defaultClientConditions, defineConfig } from 'vite';

const DASHBOARD_OUT_DIR = 'dist';

const DEV_API_TARGET = 'http://127.0.0.1:4317';

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  resolve: {
    conditions: ['@quarterdeck/source', ...defaultClientConditions],
  },
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: DASHBOARD_OUT_DIR,
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: DEV_API_TARGET, changeOrigin: true },
      '/ws': { target: DEV_API_TARGET, changeOrigin: true, ws: true },
    },
  },
});
