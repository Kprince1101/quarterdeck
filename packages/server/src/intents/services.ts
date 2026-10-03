import { forgeSchema } from '@quarterdeck/rules/forges';
import { trackerSchema } from '@quarterdeck/rules/schemas';
import { z } from 'zod';
import { changesSomething, inProject } from './fields.js';

const SERVICES_FIELDS = ['tracker', 'publishes'] as const;

export const SERVICES_INTENTS = {
  'services.read': inProject({}),
  'services.set': inProject({
    tracker: trackerSchema.nullable().optional(),
    publishes: z.boolean().nullable().optional(),
  }).refine(
    (input) => changesSomething(input, SERVICES_FIELDS),
    'services.set needs tracker or publishes',
  ),
};

export type ServicesIntentName = keyof typeof SERVICES_INTENTS;

export const serviceSourceSchema = z.enum(['project', 'rules', 'default']);

export type ServiceSource = z.infer<typeof serviceSourceSchema>;

export const forgeServiceSchema = z.object({
  forge: forgeSchema,
  host: z.string().nullable(),
  cli: z.enum(['gh', 'glab']),
  name: z.enum(['GitHub', 'GitLab']),
});

export type ForgeService = z.infer<typeof forgeServiceSchema>;

export const servicesReadResultSchema = z.object({
  forge: forgeServiceSchema.nullable(),
  forgeError: z.string().nullable(),
  tracker: trackerSchema.nullable(),
  trackerFrom: serviceSourceSchema,
  publishes: z.boolean(),
  publishesFrom: serviceSourceSchema,
  rulesPath: z.string(),
});

export type ServicesReadResult = z.infer<typeof servicesReadResultSchema>;
