import { forgeSchema } from '@quarterdeck/rules/forges';
import { z } from 'zod';
import { idSchema, inProject } from './fields.js';

const turnIdSchema = z.int().positive();

const positiveSchema = z.int().positive();

export const READ_INTENTS = {
  'turn.read': inProject({ turnId: turnIdSchema }),
  'usage.read': inProject({}),
  'forge.read': inProject({}),
};

export type ReadIntentName = keyof typeof READ_INTENTS;

export const turnReadResultSchema = z.object({
  turnId: turnIdSchema,
  agentId: idSchema,
  seq: positiveSchema,
  input: z.string(),
  output: z.string().nullable(),
  result: z.json().nullable(),
  voyage: positiveSchema.nullable(),
  n: positiveSchema.nullable(),
  latestSession: z.boolean(),
});

export type TurnReadResult = z.infer<typeof turnReadResultSchema>;

export const usageReadResultSchema = z.object({
  windowHours: positiveSchema,
  usedTokens: z.int().nonnegative(),
  capTokens: positiveSchema.nullable(),
  percent: z.number().nonnegative().nullable(),
});

export type UsageReadResult = z.infer<typeof usageReadResultSchema>;

export const forgeReadResultSchema = z.object({
  forge: forgeSchema,
  terms: z.object({
    short: z.enum(['PR', 'MR']),
    long: z.enum(['pull request', 'merge request']),
    cli: z.enum(['gh', 'glab']),
    name: z.enum(['GitHub', 'GitLab']),
  }),
});

export type ForgeReadResult = z.infer<typeof forgeReadResultSchema>;
