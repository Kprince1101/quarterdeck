import type { Queryable } from '../store/index.js';
import type {
  IntentName,
  IntentReply,
  IntentResult,
  IntentStatus,
} from '../intents/index.js';
import { publishEvent } from '../store/index.js';
import type {
  ApiContext,
  ProjectCheck,
  ProjectWork,
  StagedProjectWork,
} from './context.js';
import { notFound } from './http-error.js';

interface ProjectInput {
  project: string;
}

const INSERT_INTENT = `insert into intents
  (project_id, kind, input, status, result, settled_at)
  values (
    $1, $2, $3::jsonb, $4::text, $5::jsonb,
    case when $4::text = 'pending' then null else now() end
  )
  returning id`;

const toJson = (value: unknown): string | null => {
  if (value === null) return null;
  return JSON.stringify(value);
};

const recordIntent = async (
  tx: Queryable,
  projectId: string,
  name: IntentName,
  input: ProjectInput,
  status: IntentStatus,
  result: IntentResult | null,
): Promise<string> => {
  const { id } = await findRow<{ id: string }>(
    tx,
    INSERT_INTENT,
    [projectId, name, toJson(input), status, toJson(result)],
    `Could not record intent ${name}`,
  );
  await publishEvent(tx, projectId, {
    kind: name,
    payload: { intentId: id, status },
  });
  return id;
};

export const nothingAfterCommit = (): Promise<void> => Promise.resolve();

const runInProject = async (
  ctx: ApiContext,
  name: IntentName,
  input: ProjectInput,
  status: IntentStatus,
  work: StagedProjectWork,
): Promise<IntentReply> => {
  const store = await ctx.stores.get(input.project);
  const { reply, afterCommit } = await store.db.transaction(async (tx) => {
    const staged = await work(tx, store.projectId);
    const id = await recordIntent(
      tx,
      store.projectId,
      name,
      input,
      status,
      staged.result,
    );
    const committed: IntentReply = {
      intent: name,
      status,
      id,
      result: staged.result,
    };
    return { reply: committed, afterCommit: staged.afterCommit };
  });
  await afterCommit();
  return reply;
};

export const applyStagedInProject = (
  ctx: ApiContext,
  name: IntentName,
  input: ProjectInput,
  work: StagedProjectWork,
): Promise<IntentReply> => runInProject(ctx, name, input, 'applied', work);

export const applyInProject = (
  ctx: ApiContext,
  name: IntentName,
  input: ProjectInput,
  work: ProjectWork,
): Promise<IntentReply> =>
  applyStagedInProject(ctx, name, input, async (tx, projectId) => ({
    result: await work(tx, projectId),
    afterCommit: nothingAfterCommit,
  }));

export const queueInProject = (
  ctx: ApiContext,
  name: IntentName,
  input: ProjectInput,
  check?: ProjectCheck,
): Promise<IntentReply> =>
  runInProject(ctx, name, input, 'pending', async (tx, projectId) => {
    await check?.(tx, projectId);
    return { result: null, afterCommit: nothingAfterCommit };
  });

export const unrecorded = (
  name: IntentName,
  result: IntentResult | null,
): IntentReply => ({ intent: name, status: 'applied', id: null, result });

export const findRow = async <Row>(
  tx: Queryable,
  sql: string,
  params: unknown[],
  missing: string,
): Promise<Row> => {
  const {
    rows: [row],
  } = await tx.query<Row>(sql, params);
  if (row === undefined) throw notFound(missing);
  return row;
};
