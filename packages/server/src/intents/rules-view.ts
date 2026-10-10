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

const ruleLevelsSchema = z.record(
  z.string(),
  z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
);

export const profileSummarySchema = z.object({
  name: z.string(),
  source: z.enum(['shipped', 'machine']),
  dir: z.string(),
  description: z.string(),
  files: z.array(z.string()),
  levels: ruleLevelsSchema,
  setup: z.boolean(),
  error: z.string().nullable(),
});

export const steeringFileSchema = z.object({
  file: z.string(),
  controls: z.string(),
  machine: z.string(),
  repo: z.string().nullable(),
});

export const profilesViewSchema = z.object({
  active: z.string(),
  chosenBy: z.enum(['shipped', 'machine', 'project']),
  levels: ruleLevelsSchema,
  profiles: z.array(profileSummarySchema),
  steeringFiles: z.array(steeringFileSchema),
  error: z.string().nullable(),
});

export const rulesViewSchema = z.object({
  project: projectSlugSchema.nullable(),
  repoPath: z.string().nullable(),
  rules: z.array(ruleViewSchema),
  profiles: profilesViewSchema,
});

export const rulesUrl = (project: string | null): string => {
  if (project === null) return RULES_PATH;
  return `${RULES_PATH}?${new URLSearchParams({ [RULES_PROJECT_PARAM]: project }).toString()}`;
};

export type RuleLayer = z.infer<typeof ruleLayerSchema>;
export type RuleView = z.infer<typeof ruleViewSchema>;
export type RulesView = z.infer<typeof rulesViewSchema>;
export type ProfileSummaryView = z.infer<typeof profileSummarySchema>;
export type SteeringFileView = z.infer<typeof steeringFileSchema>;
export type ProfilesView = z.infer<typeof profilesViewSchema>;
