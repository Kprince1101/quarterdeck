import { z } from 'zod';

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

export type AssignAction = z.infer<typeof assignActionSchema>;
export type ContinueAction = z.infer<typeof continueActionSchema>;
export type BuilderAction = z.infer<typeof builderActionSchema>;

export const BUILDER_ACTION_KINDS: readonly string[] = ['assign', 'continue'];

export const BUILDER_ACTION_INSTRUCTIONS = `Actions for builders:

- \`{ "kind": "assign", "ticket": "<ticket id>" }\` gives an approved ticket whose dependencies are done to a new builder, in a new worktree. Add \`"builder": "<agent id>"\` to give it to an idle builder that holds no ticket instead.
- \`{ "kind": "continue", "builder": "<agent id>", "prompt": "<text>" }\` sends an idle builder one more prompt in its session, about the ticket it holds.`;
