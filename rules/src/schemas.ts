import { z } from 'zod';
import { forgeSchema } from './forges.js';

const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const KIRO_AGENT_NAME = /^[a-z0-9][a-z0-9_-]*$/i;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_TRACKER_TEXT = 200;
const MAX_TRACKER_NOTES = 2000;
const HOSTNAME =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

const hasUniqueValues = (values: string[]): boolean =>
  new Set(values).size === values.length;

export const markdownSchema = z.string().trim().min(1);

export const decisionSchema = z.enum(['allow', 'deny', 'ask']);

export const toolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

export const permissionRuleSchema = z.strictObject({
  kind: toolKindSchema,
  pattern: z.string().min(1).optional(),
  decision: decisionSchema,
});

export const permissionsSchema = z.strictObject({
  default: decisionSchema,
  rules: z.array(permissionRuleSchema),
});

export const tighteningDecisionSchema = z.enum(['deny', 'ask']);

export const tighteningRuleSchema = z.strictObject({
  kind: toolKindSchema,
  pattern: z.string().min(1).optional(),
  decision: tighteningDecisionSchema,
});

export const repoPermissionsSchema = z.strictObject({
  default: tighteningDecisionSchema.optional(),
  rules: z.array(tighteningRuleSchema).optional(),
});

export const namingSchema = z.strictObject({
  theme: z.string().min(1),
  names: z
    .array(z.string().regex(AGENT_NAME))
    .min(1)
    .refine(hasUniqueValues, 'names must be unique'),
});

export const settleSecondsSchema = z.number().int().positive();

export const botLoginsSchema = z
  .array(z.string().min(1))
  .refine(hasUniqueValues, 'bot logins must be unique');

export const aiReviewersSchema = z.strictObject({
  github: botLoginsSchema,
  gitlab: botLoginsSchema,
});

export const lifecycleSchema = z.strictObject({
  autoEndSettleSeconds: settleSecondsSchema,
  stuckAfterMinutes: z.number().int().positive(),
  budget: z.strictObject({
    maxTokensPerTicket: z.number().int().positive(),
    warnAtFraction: z.number().gt(0).lt(1),
    window: z.strictObject({
      hours: z.number().int().positive(),
      capTokens: z.number().int().positive().nullable(),
      holdAtFraction: z.number().gt(0).lte(1),
    }),
  }),
  mergeGate: z.strictObject({
    requireReviewerApproval: z.boolean(),
    requireChecksPassing: z.boolean(),
    requireAiReview: z.boolean(),
    aiReviewers: aiReviewersSchema,
    autoMerge: z.boolean(),
    base: z.string().min(1).optional(),
  }),
});

export const repoMergeGateSchema = z.strictObject({
  requireReviewerApproval: z.boolean().optional(),
  requireChecksPassing: z.boolean().optional(),
  requireAiReview: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
});

export const runtimeSchema = z.enum(['kiro', 'claude', 'gemini']);

export const roleModelSchema = z.strictObject({
  runtime: runtimeSchema,
  model: z.string().min(1).optional(),
});

export const modelsSchema = z.strictObject({
  planner: roleModelSchema,
  driver: roleModelSchema,
  builder: roleModelSchema,
  reviewer: roleModelSchema,
});

export const envSchema = z.strictObject({
  pass: z
    .array(z.string().regex(ENV_NAME))
    .refine(hasUniqueValues, 'pass must not repeat a name'),
});

export const kiroAgentNameSchema = z.string().regex(KIRO_AGENT_NAME);

const baseAgentSchema = kiroAgentNameSchema.nullable();

export const kiroBaseRoleSchema = z.enum(['driver', 'reviewer', 'builder']);

export const kiroSchema = z.strictObject({
  baseAgents: z.strictObject({
    driver: baseAgentSchema,
    reviewer: baseAgentSchema,
    builder: baseAgentSchema,
  }),
});

export const repoKiroSchema = z.strictObject({
  baseAgents: z
    .strictObject({ builder: baseAgentSchema.optional() })
    .optional(),
});

export const forgesSchema = z.strictObject({
  forges: z.record(z.string().regex(HOSTNAME), forgeSchema),
});

export const NO_TRACKER = 'none';

export const trackerHowSchema = z.enum(['cli', 'mcp']);

const trackerTextSchema = z.string().trim().min(1).max(MAX_TRACKER_TEXT);

const TRACKER_REACH: Record<
  z.infer<typeof trackerHowSchema>,
  { needs: 'command' | 'server'; refuses: 'command' | 'server' }
> = {
  cli: { needs: 'command', refuses: 'server' },
  mcp: { needs: 'server', refuses: 'command' },
};

export const trackerSchema = z
  .strictObject({
    kind: trackerTextSchema,
    how: trackerHowSchema.optional(),
    command: trackerTextSchema.optional(),
    server: trackerTextSchema.optional(),
    notes: z.string().trim().max(MAX_TRACKER_NOTES).optional(),
  })
  .superRefine((tracker, ctx) => {
    if (tracker.how === undefined) {
      if (tracker.kind !== NO_TRACKER)
        ctx.addIssue({
          code: 'custom',
          path: ['how'],
          message: `a ${tracker.kind} tracker needs how: 'cli' or 'mcp'`,
        });
      if (tracker.command !== undefined || tracker.server !== undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['how'],
          message: "a command or server needs how: 'cli' or 'mcp'",
        });
      return;
    }
    const { needs, refuses } = TRACKER_REACH[tracker.how];
    if (tracker[needs] === undefined)
      ctx.addIssue({
        code: 'custom',
        path: [needs],
        message: `how: '${tracker.how}' needs a ${needs}`,
      });
    if (tracker[refuses] !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: [refuses],
        message: `how: '${tracker.how}' takes a ${needs}, not a ${refuses}`,
      });
  });

export const projectServicesSchema = z.strictObject({
  tracker: trackerSchema.optional(),
  publishes: z.boolean().optional(),
});

export const servicesSchema = z.strictObject({
  projects: z.record(z.string().regex(PROJECT_SLUG), projectServicesSchema),
});

export const profileNameSchema = z.string().regex(PROFILE_NAME);

export const ruleLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

export const ruleLevelsSchema = z.record(
  z.string().trim().min(1),
  ruleLevelSchema,
);

export const profileRuleSchema = z.strictObject({
  profile: profileNameSchema,
  levels: ruleLevelsSchema,
});

const commandSchema = z.array(z.string().min(1)).min(1);

export const steeringSourceSchema = z.strictObject({
  file: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
});

export const profileSetupSchema = z.strictObject({
  install: commandSchema.optional(),
  levelsFile: z.string().min(1).optional(),
  steer: commandSchema.optional(),
});

export const profileManifestSchema = z.strictObject({
  description: z.string().trim().min(1),
  standards: z.array(z.string().min(1)).default([]),
  levels: ruleLevelsSchema.default({}),
  steering: steeringSourceSchema.optional(),
  setup: profileSetupSchema.optional(),
});

export const RULE_SCHEMAS = {
  charter: markdownSchema,
  reviewer: markdownSchema,
  permissions: permissionsSchema,
  naming: namingSchema,
  lifecycle: lifecycleSchema,
  models: modelsSchema,
  env: envSchema,
  kiro: kiroSchema,
  forges: forgesSchema,
  services: servicesSchema,
  profile: profileRuleSchema,
};

export type RuleName = keyof typeof RULE_SCHEMAS;

export type Rules = { [K in RuleName]: z.infer<(typeof RULE_SCHEMAS)[K]> };

export type Decision = z.infer<typeof decisionSchema>;
export type ToolKind = z.infer<typeof toolKindSchema>;
export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type Permissions = z.infer<typeof permissionsSchema>;
export type TighteningDecision = z.infer<typeof tighteningDecisionSchema>;
export type TighteningRule = z.infer<typeof tighteningRuleSchema>;
export type RepoPermissions = z.infer<typeof repoPermissionsSchema>;
export type Naming = z.infer<typeof namingSchema>;
export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type BudgetWindow = Lifecycle['budget']['window'];
export type MergeGate = Lifecycle['mergeGate'];
export type AiReviewers = MergeGate['aiReviewers'];
export type RepoMergeGate = z.infer<typeof repoMergeGateSchema>;
export type Runtime = z.infer<typeof runtimeSchema>;
export type RoleModel = z.infer<typeof roleModelSchema>;
export type Models = z.infer<typeof modelsSchema>;
export type EnvRule = z.infer<typeof envSchema>;
export type KiroRule = z.infer<typeof kiroSchema>;
export type RepoKiroRule = z.infer<typeof repoKiroSchema>;
export type KiroBaseRole = z.infer<typeof kiroBaseRoleSchema>;
export type ForgesRule = z.infer<typeof forgesSchema>;
export type TrackerHow = z.infer<typeof trackerHowSchema>;
export type Tracker = z.infer<typeof trackerSchema>;
export type ProjectServicesRule = z.infer<typeof projectServicesSchema>;
export type ServicesRule = z.infer<typeof servicesSchema>;
export type RuleLevel = z.infer<typeof ruleLevelSchema>;
export type RuleLevels = z.infer<typeof ruleLevelsSchema>;
export type ProfileRule = z.infer<typeof profileRuleSchema>;
export type SteeringSource = z.infer<typeof steeringSourceSchema>;
export type ProfileSetup = z.infer<typeof profileSetupSchema>;
export type ProfileManifest = z.infer<typeof profileManifestSchema>;
