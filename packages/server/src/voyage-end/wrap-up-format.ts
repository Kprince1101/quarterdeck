import { z } from 'zod';
import type { NotebookEntry, Voyage, TurnFormat } from '../driver/index.js';

export const MAX_NOTEBOOK_PROPOSALS = 50;

const bodySchema = z.string().trim().min(1);
const rationaleSchema = z.string().trim().default('');

const entryIdSchema = (active: ReadonlySet<string>) =>
  z
    .string()
    .refine(
      (id) => active.has(id),
      'entry must be the id of an active notebook entry',
    );

const notebookProposalSchema = (active: ReadonlySet<string>) =>
  z.discriminatedUnion('op', [
    z.object({
      op: z.literal('add'),
      body: bodySchema,
      pinned: z.boolean().default(false),
      rationale: rationaleSchema,
    }),
    z.object({
      op: z.literal('update'),
      entry: entryIdSchema(active),
      body: bodySchema,
      rationale: rationaleSchema,
    }),
    z.object({
      op: z.literal('retire'),
      entry: entryIdSchema(active),
      rationale: rationaleSchema,
    }),
  ]);

type NotebookProposalInput = z.infer<ReturnType<typeof notebookProposalSchema>>;

const entryOf = (proposal: NotebookProposalInput): string | undefined => {
  if (proposal.op === 'add') return undefined;
  return proposal.entry;
};

const touchesEachEntryOnce = (
  proposals: readonly NotebookProposalInput[],
): boolean => {
  const entries = proposals.flatMap((proposal) => entryOf(proposal) ?? []);
  return new Set(entries).size === entries.length;
};

export const wrapUpResultSchema = (
  active: ReadonlySet<string>,
): z.ZodObject<{
  summary: z.ZodString;
  notebook: z.ZodArray<ReturnType<typeof notebookProposalSchema>>;
  charter: z.ZodDefault<
    z.ZodNullable<
      z.ZodObject<{
        body: typeof bodySchema;
        rationale: typeof rationaleSchema;
      }>
    >
  >;
}> =>
  z.object({
    summary: z.string().trim().min(1),
    notebook: z
      .array(notebookProposalSchema(active))
      .max(MAX_NOTEBOOK_PROPOSALS)
      .refine(touchesEachEntryOnce, 'propose at most one change per entry'),
    charter: z
      .object({ body: bodySchema, rationale: rationaleSchema })
      .nullable()
      .default(null),
  });

export type WrapUpResult = z.infer<ReturnType<typeof wrapUpResultSchema>>;
export type NotebookProposal = WrapUpResult['notebook'][number];
export type CharterProposal = NonNullable<WrapUpResult['charter']>;

export const WRAP_UP_INSTRUCTIONS = `End your reply with your wrap-up result: one JSON object in a \`\`\`json fenced block, with nothing after it.

\`\`\`json
{
  "summary": "Shipped QD12 and QD13; QD14 waits on a product decision.",
  "notebook": [
    { "op": "add", "body": "Run the store tests on both backends.", "pinned": false, "rationale": "QD13 broke Postgres only." },
    { "op": "update", "entry": "<entry id>", "body": "The new text of the entry.", "rationale": "Why it changed." },
    { "op": "retire", "entry": "<entry id>", "rationale": "Why it is no longer true." }
  ],
  "charter": null
}
\`\`\`

- \`summary\`: one or two sentences on what this voyage did.
- \`notebook\`: changes to the notebook, or \`[]\`. \`add\` writes a new entry (\`pinned\` keeps it first); \`update\` replaces an entry's text; \`retire\` takes an entry out of the notebook. \`entry\` is an id from the notebook above. At most one change per entry, and at most ${MAX_NOTEBOOK_PROPOSALS} changes.
- \`charter\`: \`null\`, or \`{ "body": "...", "rationale": "..." }\` where \`body\` is the whole charter as you would have it, not a diff.

Every change is a proposal. Nothing changes until the human approves it, and the next Driver is born with what they approve.`;

const entryTitle = (entry: NotebookEntry): string => {
  if (entry.pinned) return `### ${entry.id} (pinned)`;
  return `### ${entry.id}`;
};

const entrySection = (entry: NotebookEntry): string =>
  `${entryTitle(entry)}\n\n${entry.body.trim()}`;

const notebookSection = (notebook: readonly NotebookEntry[]): string => {
  if (notebook.length === 0) return 'The notebook is empty.';
  return notebook.map(entrySection).join('\n\n');
};

export interface WrapUpPromptParts {
  voyage: Pick<Voyage, 'number'>;
  charter: string;
  notebook: readonly NotebookEntry[];
}

export const buildWrapUpPrompt = (parts: WrapUpPromptParts): string =>
  [
    `Voyage ${parts.voyage.number} has settled: no open tickets, no running agents and no open cards. This is your wrap-up turn; the voyage ends after it.`,
    'Look back over the voyage and propose what the next Driver should be born with: notebook entries to add, update or retire, and any change to the charter.',
    '# Notebook',
    'The active notebook, each entry under its id.',
    notebookSection(parts.notebook),
    '# Charter',
    parts.charter.trim(),
    '# Wrap-up result',
    WRAP_UP_INSTRUCTIONS,
  ].join('\n\n');

export const wrapUpFormat = (
  notebook: readonly NotebookEntry[],
): TurnFormat<WrapUpResult> => ({
  schema: wrapUpResultSchema(new Set(notebook.map((entry) => entry.id))),
  instructions: WRAP_UP_INSTRUCTIONS,
});
