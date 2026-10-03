import { z } from 'zod';
import { tightenRepoBudget } from './budget-layers.js';
import { RulesError } from './errors.js';
import { isJsonObject, mergeLayer, type JsonObject } from './merge-layer.js';
import { FORGE_TERMS, type Forge } from './forges.js';
import {
  repoMergeGateSchema,
  settleSecondsSchema,
  type Lifecycle,
  type MergeGate,
  type RepoMergeGate,
} from './schemas.js';

export const MACHINE_LIFECYCLE_PATH =
  '~/.quarterdeck/rules.local.lifecycle.json';

export const DEPRECATED_AI_REVIEW_KEY = 'requireCopilotReview';

export const deprecatedAiReviewWarning = (path: string): string =>
  `${path}: mergeGate.${DEPRECATED_AI_REVIEW_KEY} is deprecated and reads as mergeGate.requireAiReview; rename it`;

export interface UpgradedLayer {
  layer: unknown;
  warnings: string[];
}

const aliasedFlag = (current: unknown, deprecated: unknown): unknown => {
  if (current === undefined) return deprecated;
  if (typeof current !== 'boolean') return current;
  if (typeof deprecated !== 'boolean') return deprecated;
  return current || deprecated;
};

export const upgradeLifecycleLayer = (
  layer: unknown,
  path: string,
): UpgradedLayer => {
  if (!isJsonObject(layer) || !isJsonObject(layer['mergeGate']))
    return { layer, warnings: [] };
  const gate = layer['mergeGate'];
  if (!Object.hasOwn(gate, DEPRECATED_AI_REVIEW_KEY))
    return { layer, warnings: [] };
  const { [DEPRECATED_AI_REVIEW_KEY]: deprecated, ...rest } = gate;
  const mergeGate = {
    ...rest,
    requireAiReview: aliasedFlag(rest['requireAiReview'], deprecated),
  };
  return {
    layer: { ...layer, mergeGate },
    warnings: [deprecatedAiReviewWarning(path)],
  };
};

export class AiReviewConfigError extends RulesError {
  readonly forge: Forge;

  constructor(forge: Forge) {
    super(
      MACHINE_LIFECYCLE_PATH,
      `mergeGate.requireAiReview is on, but mergeGate.aiReviewers.${forge} lists no ${FORGE_TERMS[forge].name} bot logins; list the AI reviewer's exact bot logins there, or turn requireAiReview off`,
    );
    this.name = 'AiReviewConfigError';
    this.forge = forge;
  }
}

export const aiReviewersOf = (
  gate: MergeGate,
  forge: Forge,
): readonly string[] => {
  const logins = gate.aiReviewers[forge];
  if (gate.requireAiReview && logins.length === 0)
    throw new AiReviewConfigError(forge);
  return logins;
};

export const tightenMergeGate = (
  machine: MergeGate,
  repo: RepoMergeGate,
): MergeGate => ({
  ...machine,
  requireReviewerApproval:
    machine.requireReviewerApproval || (repo.requireReviewerApproval ?? false),
  requireChecksPassing:
    machine.requireChecksPassing || (repo.requireChecksPassing ?? false),
  requireAiReview: machine.requireAiReview || (repo.requireAiReview ?? false),
  autoMerge: machine.autoMerge && (repo.autoMerge ?? true),
});

export const tightenSettleSeconds = (machine: number, repo: number): number =>
  Math.max(machine, repo);

const parseRepoKey = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  path: string,
  what: string,
): T => {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new RulesError(
      path,
      `the repo layer may only tighten ${what}\n${z.prettifyError(result.error)}`,
    );
  return result.data;
};

const repoMergeGate = (
  next: Lifecycle,
  layer: JsonObject,
  path: string,
): MergeGate => {
  if (!Object.hasOwn(layer, 'mergeGate')) return next.mergeGate;
  const repo = parseRepoKey(
    repoMergeGateSchema,
    layer['mergeGate'],
    path,
    'the merge gate',
  );
  return tightenMergeGate(next.mergeGate, repo);
};

const repoSettleSeconds = (
  next: Lifecycle,
  layer: JsonObject,
  path: string,
): number => {
  if (!Object.hasOwn(layer, 'autoEndSettleSeconds'))
    return next.autoEndSettleSeconds;
  const repo = parseRepoKey(
    settleSecondsSchema,
    layer['autoEndSettleSeconds'],
    path,
    'the auto-end settle time',
  );
  return tightenSettleSeconds(next.autoEndSettleSeconds, repo);
};

export const mergeRepoLifecycle = (
  merged: unknown,
  layer: unknown,
  path: string,
): unknown => {
  if (!isJsonObject(layer)) return mergeLayer(merged, layer);
  const {
    mergeGate: _mergeGate,
    autoEndSettleSeconds: _settle,
    ...rest
  } = layer;
  const next = mergeLayer(merged, rest) as Lifecycle;
  return tightenRepoBudget(merged, {
    ...next,
    autoEndSettleSeconds: repoSettleSeconds(next, layer, path),
    mergeGate: repoMergeGate(next, layer, path),
  });
};
