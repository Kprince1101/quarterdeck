import { z } from 'zod';
import { idSchema, inProject } from './fields.js';

const turnIdSchema = z.int().positive();

const positiveSchema = z.int().positive();

export const READ_INTENTS = {
  'turn.read': inProject({ turnId: turnIdSchema }),
  'usage.read': inProject({}),
};

export type ReadIntentName = keyof typeof READ_INTENTS;

export const turnReadResultSchema = z.object({
  turnId: turnIdSchema,
  agentId: idSchema,
  seq: positiveSchema,
  input: z.string(),
  output: z.string().nullable(),
  result: z.json().nullable(),
  round: positiveSchema.nullable(),
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
