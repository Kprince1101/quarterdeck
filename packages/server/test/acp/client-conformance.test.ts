import { afterEach, expect } from 'vitest';
import { createClientAdapter } from './client-adapter.ts';
import { describeAcpConformance } from './conformance/index.ts';
import { expectAllExited } from './process-check.ts';

const { adapter, spawnedPids } = createClientAdapter();

afterEach(async () => {
  const pids = spawnedPids.splice(0);
  expect(pids.length).toBeGreaterThan(0);
  await expectAllExited(pids);
});

describeAcpConformance(adapter);
