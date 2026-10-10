import { z } from 'zod';
import {
  entryTags,
  type NotebookEntry,
  type Voyage,
  type TurnFormat,
} from '../driver/index.js';
import type { WorkspaceMode } from '../stream/schema.js';
import {
  multiOnly,
  singleOnly,
  workspaceWording,
} from '../workspace/wording.js';

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

const projectSchema = (projects: ReadonlySet<string> | undefined) =>
  z
    .string()
    .refine(
      (project) => projects === undefined || projects.has(project),
      'project must be one of the voyage’s projects',
    )
    .optional();

const notebookProposalSchema = (
  active: ReadonlySet<string>,
  projects?: ReadonlySet<string>,
) =>
  z.discriminatedUnion('op', [
    z.object({
      op: z.literal('add'),
      body: bodySchema,
      pinned: z.boolean().default(false),
      project: projectSchema(projects),
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
  projects?: ReadonlySet<string>,
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
      .array(notebookProposalSchema(active, projects))
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

const WRAP_UP_TEMPLATE = `End your reply with your wrap-up result: one JSON object in a \`\`\`json fenced block, with nothing after it.

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
${multiOnly(`- \`notebook\`: changes to the notebook, or \`[]\`. \`add\` writes a new entry (\`pinned\` keeps it first; on a voyage across several projects, \`"project": "<slug>"\` files it under one project, and leaving it out makes it an entry for every project); \`update\` replaces an entry's text; \`retire\` takes an entry out of the notebook. \`entry\` is an id from the notebook above. At most one change per entry, and at most ${MAX_NOTEBOOK_PROPOSALS} changes.`)}
${singleOnly(`- \`notebook\`: changes to the notebook, or \`[]\`. \`add\` writes a new entry (\`pinned\` keeps it first); \`update\` replaces an entry's text; \`retire\` takes an entry out of the notebook. \`entry\` is an id from the notebook above. At most one change per entry, and at most ${MAX_NOTEBOOK_PROPOSALS} changes.`)}
- \`charter\`: \`null\`, or \`{ "body": "...", "rationale": "..." }\` where \`body\` is the whole charter as you would have it, not a diff.

Every change is a proposal. Nothing changes until the human approves it, and the next Driver is born with what they approve.`;

export const wrapUpInstructions = (mode: WorkspaceMode): string =>
  workspaceWording(WRAP_UP_TEMPLATE, mode);

export const WRAP_UP_INSTRUCTIONS = wrapUpInstructions('multi');

const entryTitle = (entry: NotebookEntry, mode: WorkspaceMode): string => {
  const tags = entryTags(entry, mode);
  if (tags.length === 0) return `### ${entry.id}`;
  return `### ${entry.id} (${tags.join(', ')})`;
};

const entrySection = (entry: NotebookEntry, mode: WorkspaceMode): string =>
  `${entryTitle(entry, mode)}\n\n${entry.body.trim()}`;

const notebookSection = (
  notebook: readonly NotebookEntry[],
  mode: WorkspaceMode,
): string => {
  if (notebook.length === 0) return 'The notebook is empty.';
  return notebook.map((entry) => entrySection(entry, mode)).join('\n\n');
};

export interface WrapUpPromptParts {
  voyage: Pick<Voyage, 'number'>;
  charter: string;
  notebook: readonly NotebookEntry[];
  mode?: WorkspaceMode | undefined;
}

export const buildWrapUpPrompt = (parts: WrapUpPromptParts): string => {
  const mode = parts.mode ?? 'multi';
  return [
    `Voyage ${parts.voyage.number} has settled: no open tickets, no running agents and no open cards. This is your wrap-up turn; the voyage ends after it.`,
    'Look back over the voyage and propose what the next Driver should be born with: notebook entries to add, update or retire, and any change to the charter.',
    '# Notebook',
    'The active notebook, each entry under its id.',
    notebookSection(parts.notebook, mode),
    '# Charter',
    parts.charter.trim(),
    '# Wrap-up result',
    wrapUpInstructions(mode),
  ].join('\n\n');
};

export const wrapUpFormat = (
  notebook: readonly NotebookEntry[],
  projects?: ReadonlySet<string>,
  mode: WorkspaceMode = 'multi',
): TurnFormat<WrapUpResult> => ({
  schema: wrapUpResultSchema(
    new Set(notebook.map((entry) => entry.id)),
    projects,
  ),
  instructions: wrapUpInstructions(mode),
});
