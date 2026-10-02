import { z } from 'zod';
import { tightenRepoBudget } from './budget-layers.js';
import { RulesError } from './errors.js';
import { isJsonObject, mergeLayer, type JsonObject } from './merge-layer.js';
import {
  repoMergeGateSchema,
  settleSecondsSchema,
  type Lifecycle,
  type MergeGate,
  type RepoMergeGate,
} from './schemas.js';

export const tightenMergeGate = (
  machine: MergeGate,
  repo: RepoMergeGate,
): MergeGate => ({
  ...machine,
  requireReviewerApproval:
    machine.requireReviewerApproval || (repo.requireReviewerApproval ?? false),
  requireChecksPassing:
    machine.requireChecksPassing || (repo.requireChecksPassing ?? false),
  requireCopilotReview:
    machine.requireCopilotReview || (repo.requireCopilotReview ?? false),
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
