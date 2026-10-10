import { z } from 'zod';
import { attachmentRefsSchema } from '../intents/attachments.js';

export const STREAM_PATH = '/ws';

export const STREAM_AFTER_PARAM = 'after';

export const STREAM_PROJECT_PARAM = 'project';

export const STREAM_PROTOCOL = 'quarterdeck';

export const STREAM_TOKEN_PREFIX = 'quarterdeck.token.';

export const streamProtocols = (token: string): string[] => [
  STREAM_PROTOCOL,
  `${STREAM_TOKEN_PREFIX}${token}`,
];

const idSchema = z.guid();

const timestampSchema = z.iso.datetime();

const decimalSchema = z.string().regex(/^-?\d+(\.\d+)?$/);

const countSchema = z.int().nonnegative();

export const runtimeSchema = z.enum(['kiro', 'claude', 'gemini']);

export const projectRowSchema = z.object({
  id: idSchema,
  slug: z.string(),
  name: z.string(),
  repoPath: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
  pausedAt: timestampSchema.nullable(),
  tracker: z.json().nullable(),
  publishes: z.boolean().nullable(),
});

export const voyageRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  number: z.int().positive(),
  status: z.enum(['planning', 'active', 'ended']),
  goal: z.string(),
  projects: z.array(z.string()),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});

export const agentRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  voyageId: idSchema.nullable(),
  name: z.string(),
  role: z.enum(['planner', 'driver', 'builder', 'reviewer']),
  runtime: runtimeSchema,
  status: z.enum([
    'starting',
    'idle',
    'working',
    'paused',
    'stuck',
    'ended',
    'killed',
    'retired',
  ]),
  sessionId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});

export const ticketRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  voyageId: idSchema.nullable(),
  assigneeId: idSchema.nullable(),
  title: z.string(),
  body: z.string(),
  status: z.enum([
    'proposed',
    'open',
    'assigned',
    'in_progress',
    'in_review',
    'bounced',
    'blocked',
    'done',
    'cancelled',
    'rejected',
  ]),
  dependsOn: z.array(idSchema),
  source: z.string(),
  externalId: z.string().nullable(),
  externalRef: z.string().nullable(),
  prUrl: z.string().nullable(),
  headSha: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const signInStateSchema = z.object({
  status: z.enum(['starting', 'waiting', 'signed_in', 'failed']),
  url: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export const cardRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  agentId: idSchema.nullable(),
  ticketId: idSchema.nullable(),
  kind: z.string(),
  question: z.string(),
  options: z.json(),
  checked: z.string().nullable(),
  recommendation: z.string().nullable(),
  signIn: signInStateSchema.nullable().optional(),
  status: z.enum(['open', 'answered', 'declined', 'expired']),
  answer: z.string().nullable(),
  attachments: attachmentRefsSchema,
  createdAt: timestampSchema,
  answeredAt: timestampSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
});

export const turnRowSchema = z.object({
  id: z.int().positive(),
  agentId: idSchema,
  ticketId: idSchema.nullable(),
  seq: z.int().positive(),
  stopReason: z.string().nullable(),
  inputTokens: countSchema,
  outputTokens: countSchema,
  transcriptPath: z.string().nullable(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});

export const notebookRowSchema = z.object({
  id: idSchema,
  projectId: idSchema.nullable(),
  voyageId: idSchema.nullable(),
  authorId: idSchema.nullable(),
  body: z.string(),
  pinned: z.boolean(),
  createdAt: timestampSchema,
  retiredAt: timestampSchema.nullable(),
  externalId: z.string().nullable().optional(),
});

const proposalStatusSchema = z.enum(['open', 'accepted', 'rejected']);

export const notebookProposalRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  voyageId: idSchema.nullable(),
  agentId: idSchema.nullable(),
  op: z.enum(['add', 'update', 'retire']),
  entryId: idSchema.nullable(),
  body: z.string().nullable(),
  pinned: z.boolean(),
  global: z.boolean(),
  rationale: z.string(),
  status: proposalStatusSchema,
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
});

export const charterProposalRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  voyageId: idSchema.nullable(),
  agentId: idSchema.nullable(),
  body: z.string(),
  rationale: z.string(),
  status: proposalStatusSchema,
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
});

export const budgetRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  voyageId: idSchema.nullable(),
  agentId: idSchema.nullable(),
  limitTokens: countSchema.nullable(),
  limitUsd: decimalSchema.nullable(),
  spentTokens: countSchema,
  spentUsd: decimalSchema,
  updatedAt: timestampSchema,
});

export const layoutRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  name: z.string(),
  spec: z.json(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const tableRowSchemas = {
  projects: projectRowSchema,
  voyages: voyageRowSchema,
  agents: agentRowSchema,
  tickets: ticketRowSchema,
  cards: cardRowSchema,
  turns: turnRowSchema,
  notebook: notebookRowSchema,
  notebook_proposals: notebookProposalRowSchema,
  charter_proposals: charterProposalRowSchema,
  budget: budgetRowSchema,
  layouts: layoutRowSchema,
} as const;

export type StreamTable = keyof typeof tableRowSchemas;

export const STREAM_TABLES = Object.keys(tableRowSchemas) as StreamTable[];

export const streamEventSchema = z.object({
  id: z.int().positive(),
  projectId: idSchema,
  agentId: idSchema.nullable(),
  ticketId: idSchema.nullable(),
  kind: z.string(),
  payload: z.json(),
  createdAt: timestampSchema,
});

export const snapshotTablesSchema = z.object({
  projects: z.array(projectRowSchema),
  voyages: z.array(voyageRowSchema),
  agents: z.array(agentRowSchema),
  tickets: z.array(ticketRowSchema),
  cards: z.array(cardRowSchema),
  turns: z.array(turnRowSchema),
  notebook: z.array(notebookRowSchema),
  notebook_proposals: z.array(notebookProposalRowSchema),
  charter_proposals: z.array(charterProposalRowSchema),
  budget: z.array(budgetRowSchema),
  layouts: z.array(layoutRowSchema),
});

export const machineStateSchema = z.object({
  pausedAt: timestampSchema.nullable(),
});

export const savedLayoutSchema = z.object({
  spec: z.json(),
  updatedAt: timestampSchema,
});

export const workspaceModeSchema = z.enum(['single', 'multi']);

export const workspaceProjectSchema = z.object({
  slug: z.string(),
  name: z.string(),
  repoPath: z.string(),
  repository: z.string().nullable(),
});

export const workspaceSchema = z.object({
  root: z.string(),
  mode: workspaceModeSchema,
  projects: z.array(workspaceProjectSchema),
  updatedAt: timestampSchema,
});

export const keepAwakeModeSchema = z.enum(['duration', 'untilVoyageEnds']);

export const keepAwakeStateSchema = z.object({
  on: z.boolean(),
  mode: keepAwakeModeSchema.nullable(),
  expiresAt: timestampSchema.nullable(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
});

export const snapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  cursor: z.int().nonnegative(),
  tables: snapshotTablesSchema,
  machine: machineStateSchema,
  layout: savedLayoutSchema.nullable(),
  workspace: workspaceSchema.nullish(),
  keepAwake: keepAwakeStateSchema.nullish(),
});

export const machineMessageSchema = z.object({
  type: z.literal('machine'),
  machine: machineStateSchema,
});

export const layoutMessageSchema = z.object({
  type: z.literal('layout'),
  layout: savedLayoutSchema,
});

export const workspaceMessageSchema = z.object({
  type: z.literal('workspace'),
  workspace: workspaceSchema,
});

export const keepAwakeMessageSchema = z.object({
  type: z.literal('keepAwake'),
  keepAwake: keepAwakeStateSchema,
});

export const eventMessageSchema = z.object({
  type: z.literal('event'),
  event: streamEventSchema,
});

const changeOpSchema = z.enum(['insert', 'update', 'delete']);

const changeOf = <
  Table extends StreamTable,
  Row extends (typeof tableRowSchemas)[Table],
>(
  table: Table,
  row: Row,
) =>
  z.object({
    type: z.literal('change'),
    table: z.literal(table),
    op: changeOpSchema,
    id: row.shape.id,
    row: row.nullable(),
  });

export const changeMessageSchema = z.discriminatedUnion('table', [
  changeOf('projects', projectRowSchema),
  changeOf('voyages', voyageRowSchema),
  changeOf('agents', agentRowSchema),
  changeOf('tickets', ticketRowSchema),
  changeOf('cards', cardRowSchema),
  changeOf('turns', turnRowSchema),
  changeOf('notebook', notebookRowSchema),
  changeOf('notebook_proposals', notebookProposalRowSchema),
  changeOf('charter_proposals', charterProposalRowSchema),
  changeOf('budget', budgetRowSchema),
  changeOf('layouts', layoutRowSchema),
]);

export const streamMessageSchema = z.discriminatedUnion('type', [
  snapshotMessageSchema,
  eventMessageSchema,
  changeMessageSchema,
  machineMessageSchema,
  layoutMessageSchema,
  workspaceMessageSchema,
  keepAwakeMessageSchema,
]);

export type ProjectRow = z.infer<typeof projectRowSchema>;
export type VoyageRow = z.infer<typeof voyageRowSchema>;
export type AgentRow = z.infer<typeof agentRowSchema>;
export type TicketRow = z.infer<typeof ticketRowSchema>;
export type CardRow = z.infer<typeof cardRowSchema>;
export type SignInState = z.infer<typeof signInStateSchema>;
export type TurnRow = z.infer<typeof turnRowSchema>;
export type NotebookRow = z.infer<typeof notebookRowSchema>;
export type NotebookProposalRow = z.infer<typeof notebookProposalRowSchema>;
export type CharterProposalRow = z.infer<typeof charterProposalRowSchema>;
export type BudgetRow = z.infer<typeof budgetRowSchema>;
export type LayoutRow = z.infer<typeof layoutRowSchema>;
export type StreamEvent = z.infer<typeof streamEventSchema>;
export type SnapshotTables = z.infer<typeof snapshotTablesSchema>;
export type MachineState = z.infer<typeof machineStateSchema>;
export type MachineMessage = z.infer<typeof machineMessageSchema>;
export type SavedLayout = z.infer<typeof savedLayoutSchema>;
export type LayoutMessage = z.infer<typeof layoutMessageSchema>;
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>;
export type WorkspaceProject = z.infer<typeof workspaceProjectSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceMessage = z.infer<typeof workspaceMessageSchema>;
export type KeepAwakeMode = z.infer<typeof keepAwakeModeSchema>;
export type KeepAwakeState = z.infer<typeof keepAwakeStateSchema>;
export type KeepAwakeMessage = z.infer<typeof keepAwakeMessageSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type EventMessage = z.infer<typeof eventMessageSchema>;
export type ChangeMessage = z.infer<typeof changeMessageSchema>;
export type StreamMessage = z.infer<typeof streamMessageSchema>;
