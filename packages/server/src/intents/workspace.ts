import { z } from 'zod';
import {
  MAX_TEXT_LENGTH,
  absolutePathSchema,
  changesSomething,
  hasUniqueValues,
  inProject,
  projectSlugSchema,
  ruleNameSchema,
  titleSchema,
} from './fields.js';

export const WIPE_ALL_CONFIRMATION = 'wipe everything';

const MAX_GRID_COLUMNS = 48;
const MAX_LAYOUT_ITEMS = 200;
const WIDGET_TYPE = /^[a-z][a-z0-9-]*$/;

const gridCell = z.number().int().min(0);
const gridSpan = z.number().int().positive();

export const layoutItemSchema = z.strictObject({
  id: z.string().min(1).max(100),
  widget: z.string().regex(WIDGET_TYPE),
  x: gridCell,
  y: gridCell,
  w: gridSpan,
  h: gridSpan,
  hidden: z.boolean().default(false),
  config: z.record(z.string(), z.json()).default({}),
});

export const layoutSpecSchema = z.strictObject({
  columns: gridSpan.max(MAX_GRID_COLUMNS),
  items: z
    .array(layoutItemSchema)
    .max(MAX_LAYOUT_ITEMS)
    .refine(
      (items) => hasUniqueValues(items.map((item) => item.id)),
      'layout item ids must be unique',
    ),
});

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
    spec: layoutSpecSchema,
  }),
  'layout.delete': inProject({ name: titleSchema }),
  'wipe.project': inProject({ confirm: projectSlugSchema }).refine(
    (input) => input.confirm === input.project,
    { message: 'confirm must repeat the project slug', path: ['confirm'] },
  ),
  'wipe.all': z.strictObject({ confirm: z.literal(WIPE_ALL_CONFIRMATION) }),
};

export type WorkspaceIntentName = keyof typeof WORKSPACE_INTENTS;
