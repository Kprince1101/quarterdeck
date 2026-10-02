import { z } from 'zod';
import { RulesError } from './errors.js';
import { isJsonObject, mergeLayer } from './merge-layer.js';
import {
  repoMergeGateSchema,
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

export const mergeRepoLifecycle = (
  merged: unknown,
  layer: unknown,
  path: string,
): unknown => {
  if (!isJsonObject(layer) || !Object.hasOwn(layer, 'mergeGate'))
    return mergeLayer(merged, layer);
  const { mergeGate, ...rest } = layer;
  const result = repoMergeGateSchema.safeParse(mergeGate);
  if (!result.success)
    throw new RulesError(
      path,
      `the repo layer may only tighten the merge gate\n${z.prettifyError(result.error)}`,
    );
  const next = mergeLayer(merged, rest) as Lifecycle;
  return {
    ...next,
    mergeGate: tightenMergeGate(next.mergeGate, result.data),
  };
};
