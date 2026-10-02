import { resolve } from 'node:path';
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionLayers } from '@quarterdeck/rules';
import { createPermissionPolicy } from '@quarterdeck/server';
import type { CardHuman, PermissionPolicyOptions } from '@quarterdeck/server';
import { REPO_DIR, layersArb } from './arbitraries.ts';

const OPTIONS: PermissionOption[] = [
  { optionId: 'yes-always', name: 'Always', kind: 'allow_always' },
  { optionId: 'yes', name: 'Once', kind: 'allow_once' },
  { optionId: 'no-always', name: 'Never', kind: 'reject_always' },
  { optionId: 'no', name: 'Not now', kind: 'reject_once' },
];

const editRequest = (
  options: PermissionOption[] = OPTIONS,
  path = resolve(REPO_DIR, 'src/a.ts'),
): RequestPermissionRequest => ({
  sessionId: 'session-1',
  toolCall: { toolCallId: 'edit-1', kind: 'edit', locations: [{ path }] },
  options,
});

const layersWith = (decision: 'allow' | 'ask' | 'deny'): PermissionLayers => ({
  machine: { default: 'deny', rules: [{ kind: 'edit', decision }] },
});

const policyFor = (
  layers: PermissionLayers,
  overrides: Partial<PermissionPolicyOptions> = {},
) =>
  createPermissionPolicy({
    repoDir: REPO_DIR,
    cardHuman: () => Promise.reject(new Error('no card expected')),
    loadLayers: () => Promise.resolve(layers),
    ...overrides,
  });

const selected = (optionId: string): RequestPermissionResponse => ({
  outcome: { outcome: 'selected', optionId },
});

const optionArb = fc.record({
  optionId: fc.string({ minLength: 1 }),
  name: fc.string(),
  kind: fc.constantFrom(
    'allow_once' as const,
    'allow_always',
    'reject_once',
    'reject_always',
  ),
});

describe('permission policy', () => {
  it('selects allow-once for an allowed request', async () => {
    expect(await policyFor(layersWith('allow'))(editRequest())).toEqual(
      selected('yes'),
    );
  });

  it('selects reject-once for a denied request', async () => {
    expect(await policyFor(layersWith('deny'))(editRequest())).toEqual(
      selected('no'),
    );
  });

  it('cards the human for an ask and applies the answer', async () => {
    const cardHuman = vi.fn<CardHuman>(() => Promise.resolve('allow'));
    const policy = policyFor(layersWith('ask'), { cardHuman });

    expect(await policy(editRequest())).toEqual(selected('yes'));
    expect(cardHuman).toHaveBeenCalledWith({
      sessionId: 'session-1',
      toolCall: editRequest().toolCall,
      request: {
        kind: 'edit',
        cwd: REPO_DIR,
        paths: [resolve(REPO_DIR, 'src/a.ts')],
      },
    });

    cardHuman.mockResolvedValueOnce('deny');
    expect(await policy(editRequest())).toEqual(selected('no'));
  });

  it('treats a card that fails as a rejection the agent sees', async () => {
    const policy = policyFor(layersWith('ask'), {
      cardHuman: () => Promise.reject(new Error('dashboard gone')),
    });

    expect(await policy(editRequest())).toEqual(selected('no'));
  });

  it('cards an allowed write outside the repo instead of allowing it', async () => {
    const cardHuman = vi.fn<CardHuman>(() => Promise.resolve('deny'));
    const policy = policyFor(layersWith('allow'), { cardHuman });

    expect(await policy(editRequest(OPTIONS, resolve('/etc/hosts')))).toEqual(
      selected('no'),
    );
    expect(cardHuman).toHaveBeenCalledOnce();
  });

  it('fails closed when the rules lookup throws', async () => {
    const onRulesError = vi.fn();
    const cardHuman = vi.fn<CardHuman>(() => Promise.resolve('allow'));
    const failure = new Error('rules unreadable');
    const policy = policyFor(layersWith('allow'), {
      loadLayers: () => Promise.reject(failure),
      onRulesError,
      cardHuman,
    });

    expect(await policy(editRequest())).toEqual(selected('no'));
    expect(onRulesError).toHaveBeenCalledWith(failure);
    expect(cardHuman).not.toHaveBeenCalled();
  });

  it('fails closed when the request cannot be read', async () => {
    const hostile = editRequest();
    Object.defineProperty(hostile.toolCall, 'rawInput', {
      get: () => {
        throw new Error('hostile input');
      },
    });

    expect(await policyFor(layersWith('allow'))(hostile)).toEqual(
      selected('no'),
    );
  });

  it('refuses instead of picking allow-always when allow-once is missing', async () => {
    const options = OPTIONS.filter((option) => option.kind !== 'allow_once');

    expect(await policyFor(layersWith('allow'))(editRequest(options))).toEqual(
      selected('no'),
    );
  });

  it('cancels when the agent offers no way to reject', async () => {
    const options = OPTIONS.filter((option) => option.kind === 'allow_always');

    expect(await policyFor(layersWith('deny'))(editRequest(options))).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('never selects an allow-always option, whatever the rules or card say', async () => {
    await fc.assert(
      fc.asyncProperty(
        layersArb,
        fc.uniqueArray(optionArb, {
          selector: (option) => option.optionId,
          maxLength: 6,
        }),
        fc.constantFrom('allow' as const, 'deny'),
        async (layers, options, answer) => {
          const policy = policyFor(layers, {
            cardHuman: () => Promise.resolve(answer),
          });
          const response = await policy(editRequest(options));
          if (response.outcome.outcome === 'cancelled') return;
          const { optionId } = response.outcome;
          const chosen = options.find((option) => option.optionId === optionId);
          expect(chosen?.kind).not.toBe('allow_always');
          expect(chosen).toBeDefined();
        },
      ),
    );
  });
});
