import { z } from 'zod';

const AGENT_NAME = /^[a-z][a-z0-9-]*$/;

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

export const lifecycleSchema = z.strictObject({
  autoEndSettleSeconds: z.number().int().positive(),
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
  }),
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

export const RULE_SCHEMAS = {
  charter: markdownSchema,
  reviewer: markdownSchema,
  permissions: permissionsSchema,
  naming: namingSchema,
  lifecycle: lifecycleSchema,
  models: modelsSchema,
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
export type Runtime = z.infer<typeof runtimeSchema>;
export type RoleModel = z.infer<typeof roleModelSchema>;
export type Models = z.infer<typeof modelsSchema>;
