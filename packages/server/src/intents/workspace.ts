import { z } from 'zod';
import { gridLayoutSchema, presetNameSchema } from '../layouts/index.js';
import {
  MAX_TEXT_LENGTH,
  absolutePathSchema,
  changesSomething,
  inProject,
  projectSlugSchema,
  ruleNameSchema,
  titleSchema,
} from './fields.js';

export const WIPE_ALL_CONFIRMATION = 'wipe everything';

const ruleContentSchema = z.string().max(MAX_TEXT_LENGTH);

const machineRule = { scope: z.literal('machine'), name: ruleNameSchema };
const projectRule = { scope: z.literal('project'), name: ruleNameSchema };

const PROJECT_FIELDS = ['name', 'repoPath'] as const;

export const WORKSPACE_INTENTS = {
  'project.create': inProject({
    name: titleSchema.optional(),
    repoPath: absolutePathSchema.optional(),
  }),
  'project.update': inProject({
    name: titleSchema.optional(),
    repoPath: absolutePathSchema.nullable().optional(),
  }).refine(
    (input) => changesSomething(input, PROJECT_FIELDS),
    'project.update needs name or repoPath',
  ),
  'rules.write': z.discriminatedUnion('scope', [
    z.strictObject({ ...machineRule, content: ruleContentSchema }),
    inProject({ ...projectRule, content: ruleContentSchema }),
  ]),
  'rules.reset': z.discriminatedUnion('scope', [
    z.strictObject(machineRule),
    inProject(projectRule),
  ]),
  'layout.save': inProject({
    name: titleSchema,
    spec: gridLayoutSchema,
  }),
  'layout.reset': inProject({
    name: titleSchema,
    preset: presetNameSchema,
  }),
  'layout.delete': inProject({ name: titleSchema }),
  'wipe.project': inProject({ confirm: projectSlugSchema }).refine(
    (input) => input.confirm === input.project,
    { message: 'confirm must repeat the project slug', path: ['confirm'] },
  ),
  'wipe.all': z.strictObject({ confirm: z.literal(WIPE_ALL_CONFIRMATION) }),
};

export type WorkspaceIntentName = keyof typeof WORKSPACE_INTENTS;
