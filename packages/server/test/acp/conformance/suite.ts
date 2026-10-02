import { describe, it } from 'vitest';
import { CONFORMANCE_CHECKS } from './checks.ts';
import type { ConformanceAdapter } from './types.ts';

export const describeAcpConformance = (adapter: ConformanceAdapter): void => {
  describe(`ACP conformance: ${adapter.name}`, () => {
    CONFORMANCE_CHECKS.forEach((check) => {
      it(check.name, () => check.run(adapter));
    });
  });
};
