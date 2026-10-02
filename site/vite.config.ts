import { resolve } from 'node:path';
import { defaultClientConditions, defineConfig } from 'vite';

const SITE = import.meta.dirname;

const SITE_OUT_DIR = 'dist';

const DEMO_ENTRY = 'demo/index.html';

export default defineConfig({
  root: SITE,
  base: './',
  publicDir: 'public',
  resolve: {
    conditions: ['@quarterdeck/source', ...defaultClientConditions],
  },
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: SITE_OUT_DIR,
    assetsDir: 'demo/assets',
    emptyOutDir: true,
    rollupOptions: { input: resolve(SITE, DEMO_ENTRY) },
  },
  server: { host: '127.0.0.1' },
});
