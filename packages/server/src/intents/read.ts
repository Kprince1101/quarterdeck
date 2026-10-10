import { forgeSchema } from '@quarterdeck/rules/forges';
import { z } from 'zod';
import { claudeAuthStatusSchema } from '../acp/runtimes/claude/auth-mode.js';
import { idSchema, inProject } from './fields.js';

const turnIdSchema = z.int().positive();

const positiveSchema = z.int().positive();

export const READ_INTENTS = {
  'turn.read': inProject({ turnId: turnIdSchema }),
  'usage.read': inProject({}),
  'forge.read': inProject({}),
  'forge.requests': z.strictObject({}),
  'auth.read': z.strictObject({}),
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

export const openRequestSchema = z.object({
  url: z.string(),
  number: positiveSchema,
  title: z.string(),
  author: z.string().nullable(),
  branch: z.string(),
  base: z.string(),
  draft: z.boolean(),
  checks: z.enum(['passing', 'pending', 'failing', 'none']),
  review: z.enum(['approved', 'changes', 'none']),
  createdAt: z.string(),
  ticket: z
    .object({ id: idSchema, title: z.string(), status: z.string() })
    .nullable(),
  agent: z.object({ id: idSchema, name: z.string() }).nullable(),
});

export type OpenRequest = z.infer<typeof openRequestSchema>;

export const projectRequestsSchema = z.object({
  project: z.string(),
  name: z.string(),
  forge: forgeSchema,
  requests: z.array(openRequestSchema),
  error: z.string().nullable(),
  fetchedAt: z.string(),
});

export type ProjectRequests = z.infer<typeof projectRequestsSchema>;

export const forgeRequestsResultSchema = z.object({
  projects: z.array(projectRequestsSchema),
});

export type ForgeRequestsResult = z.infer<typeof forgeRequestsResultSchema>;

export const authReadResultSchema = z.object({
  claude: claudeAuthStatusSchema,
});

export type AuthReadResult = z.infer<typeof authReadResultSchema>;
