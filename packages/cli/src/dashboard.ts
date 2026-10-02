import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const DASHBOARD_MANIFEST = '@quarterdeck/dashboard/package.json';

export const resolveDashboardDir = (): string | undefined => {
  try {
    const manifest = createRequire(import.meta.url).resolve(DASHBOARD_MANIFEST);
    return join(dirname(manifest), 'dist');
  } catch {
    return undefined;
  }
};
