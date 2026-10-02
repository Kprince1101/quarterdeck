import { dirname } from 'node:path';
import type {
  PermissionOption,
  RequestPermissionOutcome,
} from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionLayers } from '@quarterdeck/rules';
import { createPermissionPolicy } from '@quarterdeck/server';
import type { CardAnswer, CardHuman } from '@quarterdeck/server';
import { createClientAdapter } from './client-adapter.ts';
import type { PermissionWiring } from './client-adapter.ts';
import { CHECKS } from './conformance/index.ts';
import { createRecorder, withTimeout } from './conformance/recorder.ts';
import { agentText } from './conformance/updates.ts';
import { FAKE_PERMISSION_PATH, fakeAgentLaunch } from './fake-agent/index.ts';
import { expectAllExited } from './process-check.ts';

interface PolicySetup {
  name: string;
  loadLayers: () => Promise<PermissionLayers>;
  cardHuman?: CardHuman;
}

const FAKE_REPO_DIR = dirname(FAKE_PERMISSION_PATH);

const CARD_EVERYTHING: PermissionLayers = {
  machine: { default: 'ask', rules: [] },
};

const editRules = (decision: 'allow' | 'deny'): PermissionLayers => ({
  machine: {
    default: 'ask',
    rules: [{ kind: 'edit', pattern: 'config.json', decision }],
  },
});

const ANSWERS: Record<PermissionOption['kind'], CardAnswer> = {
  allow_once: 'allow',
  allow_always: 'allow',
  reject_once: 'deny',
  reject_always: 'deny',
};

const cardAnswer = (
  outcome: RequestPermissionOutcome,
  options: readonly PermissionOption[],
): CardAnswer => {
  if (outcome.outcome === 'cancelled') return 'deny';
  const chosen = options.find((option) => option.optionId === outcome.optionId);
  if (!chosen) return 'deny';
  return ANSWERS[chosen.kind];
};

const noCardExpected: CardHuman = () =>
  Promise.reject(new Error('the rules should have answered'));

const policyWiring =
  ({ loadLayers, cardHuman }: PolicySetup): PermissionWiring =>
  (hooks) =>
  (request) =>
    createPermissionPolicy({
      repoDir: FAKE_REPO_DIR,
      loadLayers,
      cardHuman:
        cardHuman ??
        (async () =>
          cardAnswer(await hooks.decidePermission(request), request.options)),
    })(request);

const spawnedPids: number[] = [];

const policyAdapter = (setup: PolicySetup) => {
  const client = createClientAdapter({
    name: setup.name,
    permissions: policyWiring(setup),
  });
  return {
    adapter: client.adapter,
    track: () => spawnedPids.push(...client.spawnedPids.splice(0)),
  };
};

const runCheck = async (
  check: (typeof CHECKS)[keyof typeof CHECKS],
  setup: PolicySetup,
) => {
  const { adapter, track } = policyAdapter(setup);
  try {
    await check.run(adapter);
  } finally {
    track();
  }
};

const promptPermission = async (setup: PolicySetup) => {
  const { adapter, track } = policyAdapter(setup);
  const recorder = createRecorder(() =>
    Promise.reject(new Error('the policy should not consult the recorder')),
  );
  const connection = await adapter.connect(fakeAgentLaunch(), recorder.hooks);
  try {
    const opening = await connection.openSession(FAKE_REPO_DIR);
    if (opening.status !== 'ready') throw new Error('session/new failed');
    const stopReason = await withTimeout(
      'prompt permission',
      connection.prompt(opening.sessionId, 'permission'),
    );
    return {
      stopReason,
      text: agentText(recorder.updates, opening.sessionId),
    };
  } finally {
    await connection.close();
    track();
  }
};

afterEach(async () => {
  const pids = spawnedPids.splice(0);
  expect(pids.length).toBeGreaterThan(0);
  await expectAllExited(pids);
});

describe('permission policy over spawnAcpClient', () => {
  it('applies a rules allow without carding anyone', async () => {
    expect(
      await promptPermission({
        name: 'rules allow',
        loadLayers: () => Promise.resolve(editRules('allow')),
        cardHuman: noCardExpected,
      }),
    ).toEqual({
      stopReason: 'end_turn',
      text: 'permission granted: allow-once',
    });
  });

  it('applies a rules deny without carding anyone', async () => {
    expect(
      await promptPermission({
        name: 'rules deny',
        loadLayers: () => Promise.resolve(editRules('deny')),
        cardHuman: noCardExpected,
      }),
    ).toEqual({
      stopReason: 'end_turn',
      text: 'permission rejected: reject-once',
    });
  });

  it('lets the repo layer tighten a machine allow into a card', async () => {
    const cardHuman = vi.fn<CardHuman>(() => Promise.resolve('deny'));

    const result = await promptPermission({
      name: 'repo tightens',
      loadLayers: () =>
        Promise.resolve({
          ...editRules('allow'),
          repo: { rules: [{ kind: 'edit', decision: 'ask' }] },
        }),
      cardHuman,
    });

    expect(result.text).toBe('permission rejected: reject-once');
    expect(cardHuman).toHaveBeenCalledOnce();
  });

  it(CHECKS.failsClosedOnRulesError.name, () =>
    runCheck(CHECKS.failsClosedOnRulesError, {
      name: 'rules lookup throws',
      loadLayers: () => Promise.reject(new Error('rules lookup failed')),
      cardHuman: noCardExpected,
    }),
  );

  describe('with every request carded to the human', () => {
    const carded: PolicySetup = {
      name: 'card the human',
      loadLayers: () => Promise.resolve(CARD_EVERYTHING),
    };

    it(CHECKS.routesPermissionToRules.name, () =>
      runCheck(CHECKS.routesPermissionToRules, carded),
    );

    it(CHECKS.honoursRejection.name, () =>
      runCheck(CHECKS.honoursRejection, carded),
    );

    it(`${CHECKS.failsClosedOnRulesError.name} (card fails)`, () =>
      runCheck(CHECKS.failsClosedOnRulesError, carded));

    it(CHECKS.cancelsPendingPermission.name, () =>
      runCheck(CHECKS.cancelsPendingPermission, carded),
    );
  });
});
