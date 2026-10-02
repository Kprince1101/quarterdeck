import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const SOURCE_CONDITIONS = ['@quarterdeck/source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions: SOURCE_CONDITIONS },
  ssr: { resolve: { conditions: SOURCE_CONDITIONS } },
  test: { env: { DATABASE_URL: '' } },
});
