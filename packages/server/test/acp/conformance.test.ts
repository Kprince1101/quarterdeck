import { describe, expect, it } from 'vitest';
import { CHECKS, describeAcpConformance } from './conformance/index.ts';
import type { ConformanceAdapter } from './conformance/index.ts';
import { REFERENCE_ADAPTER } from './reference-adapter.ts';

const trustAllAdapter: ConformanceAdapter = {
  name: 'trust-all',
  connect: (launch, hooks) =>
    REFERENCE_ADAPTER.connect(launch, {
      ...hooks,
      decidePermission: async (request) => ({
        outcome: 'selected',
        optionId: request.options[0]?.optionId ?? '',
      }),
    }),
};

const autoSignInAdapter: ConformanceAdapter = {
  name: 'auto sign-in',
  connect: async (launch, hooks) => {
    const connection = await REFERENCE_ADAPTER.connect(launch, hooks);
    return {
      ...connection,
      openSession: async (cwd) => {
        const opening = await connection.openSession(cwd);
        if (opening.status === 'ready') return opening;
        await connection.authenticate(opening.authMethods[0]?.id ?? '');
        return connection.openSession(cwd);
      },
    };
  },
};

describeAcpConformance(REFERENCE_ADAPTER);

describe('ACP conformance catches broken adapters', () => {
  it('fails an adapter that trusts every tool', async () => {
    await expect(CHECKS.honoursRejection.run(trustAllAdapter)).rejects.toThrow(
      /rules rejection must reach the agent/,
    );
  });

  it('fails an adapter that signs in on its own', async () => {
    await expect(CHECKS.surfacesSignIn.run(autoSignInAdapter)).rejects.toThrow(
      /should surface auth required/,
    );
  });
});
