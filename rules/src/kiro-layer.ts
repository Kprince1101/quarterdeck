import { z } from 'zod';
import { RulesError } from './errors.js';
import { mergeLayer } from './merge-layer.js';
import { repoKiroSchema } from './schemas.js';

export const mergeRepoKiro = (
  merged: unknown,
  layer: unknown,
  path: string,
): unknown => {
  const result = repoKiroSchema.safeParse(layer);
  if (!result.success)
    throw new RulesError(
      path,
      `the repo layer may only set the builder's base agent\n${z.prettifyError(result.error)}`,
    );
  return mergeLayer(merged, result.data);
};
