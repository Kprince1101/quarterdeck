import { z } from 'zod';
import { projectSlugSchema, ruleNameSchema } from './fields.js';

export const RULES_PATH = '/api/rules';

export const RULES_PROJECT_PARAM = 'project';

const ruleLayerSchema = z.object({
  path: z.string(),
  content: z.string().nullable(),
});

export const ruleViewSchema = z.object({
  name: ruleNameSchema,
  file: z.string(),
  defaults: z.object({ path: z.string(), content: z.string() }),
  machine: ruleLayerSchema,
  repo: ruleLayerSchema.nullable(),
});

export const rulesViewSchema = z.object({
  project: projectSlugSchema.nullable(),
  repoPath: z.string().nullable(),
  rules: z.array(ruleViewSchema),
});

export const rulesUrl = (project: string | null): string => {
  if (project === null) return RULES_PATH;
  return `${RULES_PATH}?${new URLSearchParams({ [RULES_PROJECT_PARAM]: project }).toString()}`;
};

export type RuleLayer = z.infer<typeof ruleLayerSchema>;
export type RuleView = z.infer<typeof ruleViewSchema>;
export type RulesView = z.infer<typeof rulesViewSchema>;
