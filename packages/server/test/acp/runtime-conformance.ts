import { tmpdir } from 'node:os';
import type { RuntimeAdapter, RuntimeLaunch } from '@quarterdeck/server';
import { afterEach, describe, expect } from 'vitest';
import { createClientAdapter } from './client-adapter.ts';
import type { ClientAdapter } from './client-adapter.ts';
import { describeAcpConformance } from './conformance/index.ts';
import { expectAllExited } from './process-check.ts';

export const describeClientConformance = ({
  adapter,
  spawnedPids,
}: ClientAdapter): void => {
  describe(adapter.name, () => {
    afterEach(async () => {
      const pids = spawnedPids.splice(0);
      expect(pids.length).toBeGreaterThan(0);
      await expectAllExited(pids);
    });

    describeAcpConformance(adapter);
  });
};

export const describeRuntimeConformance = (
  runtime: RuntimeAdapter,
  base: Partial<RuntimeLaunch> = {},
): void => {
  describeClientConformance(
    createClientAdapter(`${runtime.displayName} adapter`, (launch, options) =>
      runtime.connect({ cwd: tmpdir(), ...base, command: launch }, options),
    ),
  );
};
