import { runtimeSchema } from '@quarterdeck/rules/schemas';
import { z } from 'zod';
import {
  signInStateSchema,
  workspaceModeSchema,
  workspaceProjectSchema,
} from '../stream/schema.js';
import { projectSlugSchema } from './fields.js';

export const MAX_SETUP_PATH_LENGTH = 4096;

const MAX_HOST_LENGTH = 253;

export const setupPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SETUP_PATH_LENGTH);

export const signInToolSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('runtime'), runtime: runtimeSchema }),
  z.strictObject({ kind: z.literal('gh') }),
  z.strictObject({
    kind: z.literal('glab'),
    host: z.string().min(1).max(MAX_HOST_LENGTH),
  }),
]);

export const SETUP_INTENTS = {
  'setup.read': z.strictObject({}),
  'setup.detect': z.strictObject({ path: setupPathSchema }),
  'setup.tools': z.strictObject({ root: setupPathSchema.optional() }),
  'setup.sign_in': z.strictObject({ tool: signInToolSchema }),
  'setup.save': z.strictObject({
    root: setupPathSchema,
    runtime: runtimeSchema,
    skip: z.array(projectSlugSchema).default([]),
  }),
};

export type SetupIntentName = keyof typeof SETUP_INTENTS;

export const setupToolSchema = z.object({
  tool: signInToolSchema,
  name: z.string(),
  state: z.string(),
  installed: z.boolean(),
  signedIn: z.boolean(),
  hint: z.string().nullable(),
});

export const setupToolsResultSchema = z.object({
  runtimes: z.array(setupToolSchema),
  forges: z.array(setupToolSchema),
  defaultRuntime: runtimeSchema.nullable(),
});

export const setupSignInSchema = z.object({
  key: z.string(),
  tool: signInToolSchema,
  name: z.string(),
  progress: signInStateSchema,
});

export const setupReadResultSchema = z.object({
  needsSetup: z.boolean(),
  signIns: z.array(setupSignInSchema),
});

export const setupDetectResultSchema = z.object({
  root: z.string(),
  mode: workspaceModeSchema,
  repositories: z.array(workspaceProjectSchema),
});

export const setupSaveResultSchema = z.object({
  mode: workspaceModeSchema,
  projects: z.array(z.string()),
  runtime: runtimeSchema,
  notice: z.string().nullable(),
});

export type SetupSignInTool = z.infer<typeof signInToolSchema>;
export type SetupTool = z.infer<typeof setupToolSchema>;
export type SetupToolsResult = z.infer<typeof setupToolsResultSchema>;
export type SetupSignIn = z.infer<typeof setupSignInSchema>;
export type SetupReadResult = z.infer<typeof setupReadResultSchema>;
export type SetupDetectResult = z.infer<typeof setupDetectResultSchema>;
export type SetupSaveResult = z.infer<typeof setupSaveResultSchema>;
