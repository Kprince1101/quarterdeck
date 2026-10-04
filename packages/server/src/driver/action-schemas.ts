import { z } from 'zod';
import { hasUniqueValues } from '../intents/fields.js';

const MAX_BLOCKERS = 50;
const MAX_PUBLISHED_LENGTH = 200;

export const assignActionSchema = z.object({
  kind: z.literal('assign'),
  ticket: z.uuid(),
  builder: z.uuid().optional(),
});

export const continueActionSchema = z.object({
  kind: z.literal('continue'),
  builder: z.uuid(),
  prompt: z.string().trim().min(1),
});

export const builderActionSchema = z.discriminatedUnion('kind', [
  assignActionSchema,
  continueActionSchema,
]);

export const blockActionSchema = z.object({
  kind: z.literal('block'),
  ticket: z.uuid(),
  on: z
    .array(z.uuid())
    .min(1)
    .max(MAX_BLOCKERS)
    .refine(hasUniqueValues, 'on must not repeat a ticket'),
  note: z.string().trim().min(1).optional(),
});

export const publishedActionSchema = z.object({
  kind: z.literal('published'),
  ticket: z.uuid(),
  package: z.string().trim().min(1).max(MAX_PUBLISHED_LENGTH),
  version: z.string().trim().min(1).max(MAX_PUBLISHED_LENGTH),
});

export const ticketActionSchema = z.discriminatedUnion('kind', [
  blockActionSchema,
  publishedActionSchema,
]);

export const turnActionSchema = z.discriminatedUnion('kind', [
  assignActionSchema,
  continueActionSchema,
  blockActionSchema,
  publishedActionSchema,
]);

export type AssignAction = z.infer<typeof assignActionSchema>;
export type ContinueAction = z.infer<typeof continueActionSchema>;
export type BuilderAction = z.infer<typeof builderActionSchema>;
export type BlockAction = z.infer<typeof blockActionSchema>;
export type PublishedAction = z.infer<typeof publishedActionSchema>;
export type TicketAction = z.infer<typeof ticketActionSchema>;
export type TurnAction = z.infer<typeof turnActionSchema>;

export const BUILDER_ACTION_KINDS: readonly string[] = ['assign', 'continue'];
export const TICKET_ACTION_KINDS: readonly string[] = ['block', 'published'];

export const BUILDER_ACTION_INSTRUCTIONS = `Actions for builders:

- \`{ "kind": "assign", "ticket": "<ticket id>" }\` gives an approved ticket whose dependencies are satisfied to a new builder, in a new worktree. Add \`"builder": "<agent id>"\` to give it to an idle builder that holds no ticket instead.
- \`{ "kind": "continue", "builder": "<agent id>", "prompt": "<text>" }\` sends an idle builder one more prompt in its session, about the ticket it holds.`;

export const TICKET_ACTION_INSTRUCTIONS = `Actions for tickets:

- \`{ "kind": "block", "ticket": "<ticket id>", "on": ["<ticket id>", …] }\` holds a ticket a builder already has until every ticket in \`on\` is satisfied; they may be in any project. Add \`"note": "<text>"\` to say why. The builder keeps its worktree and session. Once everything in \`on\` is satisfied, Quarterdeck puts the ticket back and continues its builder with the versions to bump to; you do not continue it yourself.
- \`{ "kind": "published", "ticket": "<ticket id>", "package": "<name>", "version": "<version>" }\` records that you published a merged ticket of a project that publishes, as that package and version (a snapshot or a release). Publish it first with your shell and the project's CLI; Quarterdeck does not publish.

A dependency is satisfied once it is done and, when its project publishes, recorded as \`published\`. A dependency in a project that is not open or is archived stays unsatisfied.`;
