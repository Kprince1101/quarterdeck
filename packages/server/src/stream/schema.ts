import { z } from 'zod';

export const STREAM_PATH = '/ws';

export const STREAM_AFTER_PARAM = 'after';

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
});

export const roundRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  number: z.int().positive(),
  status: z.enum(['planning', 'active', 'ended']),
  goal: z.string(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
});

export const agentRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  roundId: idSchema.nullable(),
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
  roundId: idSchema.nullable(),
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
    'done',
    'cancelled',
    'rejected',
  ]),
  dependsOn: z.array(idSchema),
  source: z.string(),
  externalId: z.string().nullable(),
  prUrl: z.string().nullable(),
  headSha: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
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
  status: z.enum(['open', 'answered', 'declined', 'expired']),
  answer: z.string().nullable(),
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
  projectId: idSchema,
  roundId: idSchema.nullable(),
  authorId: idSchema.nullable(),
  body: z.string(),
  pinned: z.boolean(),
  createdAt: timestampSchema,
});

export const charterProposalRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  agentId: idSchema.nullable(),
  body: z.string(),
  rationale: z.string(),
  status: z.enum(['open', 'accepted', 'rejected']),
  createdAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
});

export const budgetRowSchema = z.object({
  id: idSchema,
  projectId: idSchema,
  roundId: idSchema.nullable(),
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
  rounds: roundRowSchema,
  agents: agentRowSchema,
  tickets: ticketRowSchema,
  cards: cardRowSchema,
  turns: turnRowSchema,
  notebook: notebookRowSchema,
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
  rounds: z.array(roundRowSchema),
  agents: z.array(agentRowSchema),
  tickets: z.array(ticketRowSchema),
  cards: z.array(cardRowSchema),
  turns: z.array(turnRowSchema),
  notebook: z.array(notebookRowSchema),
  charter_proposals: z.array(charterProposalRowSchema),
  budget: z.array(budgetRowSchema),
  layouts: z.array(layoutRowSchema),
});

export const machineStateSchema = z.object({
  pausedAt: timestampSchema.nullable(),
});

export const snapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  cursor: z.int().nonnegative(),
  tables: snapshotTablesSchema,
  machine: machineStateSchema,
});

export const machineMessageSchema = z.object({
  type: z.literal('machine'),
  machine: machineStateSchema,
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
  changeOf('rounds', roundRowSchema),
  changeOf('agents', agentRowSchema),
  changeOf('tickets', ticketRowSchema),
  changeOf('cards', cardRowSchema),
  changeOf('turns', turnRowSchema),
  changeOf('notebook', notebookRowSchema),
  changeOf('charter_proposals', charterProposalRowSchema),
  changeOf('budget', budgetRowSchema),
  changeOf('layouts', layoutRowSchema),
]);

export const streamMessageSchema = z.discriminatedUnion('type', [
  snapshotMessageSchema,
  eventMessageSchema,
  changeMessageSchema,
  machineMessageSchema,
]);

export type ProjectRow = z.infer<typeof projectRowSchema>;
export type RoundRow = z.infer<typeof roundRowSchema>;
export type AgentRow = z.infer<typeof agentRowSchema>;
export type TicketRow = z.infer<typeof ticketRowSchema>;
export type CardRow = z.infer<typeof cardRowSchema>;
export type TurnRow = z.infer<typeof turnRowSchema>;
export type NotebookRow = z.infer<typeof notebookRowSchema>;
export type CharterProposalRow = z.infer<typeof charterProposalRowSchema>;
export type BudgetRow = z.infer<typeof budgetRowSchema>;
export type LayoutRow = z.infer<typeof layoutRowSchema>;
export type StreamEvent = z.infer<typeof streamEventSchema>;
export type SnapshotTables = z.infer<typeof snapshotTablesSchema>;
export type MachineState = z.infer<typeof machineStateSchema>;
export type MachineMessage = z.infer<typeof machineMessageSchema>;
export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type EventMessage = z.infer<typeof eventMessageSchema>;
export type ChangeMessage = z.infer<typeof changeMessageSchema>;
export type StreamMessage = z.infer<typeof streamMessageSchema>;
