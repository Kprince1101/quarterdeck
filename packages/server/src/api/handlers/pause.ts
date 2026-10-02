import { getErrorMessage } from '../../lib/errors.js';
import { setGlobalPause } from '../../pause/index.js';
import type { Queryable } from '../../store/index.js';
import type { IntentHandler, IntentHandlers } from '../context.js';
import { conflict } from '../http-error.js';
import { applyInProject, findRow, unrecorded } from '../record.js';

type PauseIntentName =
  'pause.set' | 'pause.all' | 'agent.pause' | 'agent.resume';

const UNPAUSABLE_AGENT_STATUSES = new Set([
  'paused',
  'ended',
  'killed',
  'retired',
]);

const agentStatus = async (
  tx: Queryable,
  projectId: string,
  agentId: string,
): Promise<string> => {
  const agent = await findRow<{ status: string }>(
    tx,
    'select status from agents where id = $1 and project_id = $2 for update',
    [agentId, projectId],
    `agent ${agentId} not found`,
  );
  return agent.status;
};

const setProjectPause: IntentHandler<'pause.set'> = (ctx, input, name) =>
  applyInProject(ctx, name, input, async (tx, projectId) => {
    const { pausedAt } = await findRow<{ pausedAt: Date | null }>(
      tx,
      `update projects
       set paused_at = case when $2::boolean then coalesce(paused_at, now()) end
       where id = $1
       returning paused_at as "pausedAt"`,
      [projectId, input.paused],
      `project ${input.project} not found`,
    );
    return { paused: input.paused, pausedAt };
  });

const setPauseEverywhere: IntentHandler<'pause.all'> = async (
  ctx,
  input,
  name,
) => {
  await setGlobalPause(ctx.stores.dataHome, input.paused);
  const projects: string[] = [];
  const failed: { project: string; error: string }[] = [];
  for (const project of await ctx.stores.list()) {
    const recorded = { project, paused: input.paused };
    try {
      await applyInProject(ctx, name, recorded, () =>
        Promise.resolve({ paused: input.paused }),
      );
      projects.push(project);
    } catch (err) {
      failed.push({ project, error: getErrorMessage(err) });
    }
  }
  return unrecorded(name, { paused: input.paused, projects, failed });
};

const pauseAgent: IntentHandler<'agent.pause'> = (ctx, input, name) =>
  applyInProject(ctx, name, input, async (tx, projectId) => {
    const status = await agentStatus(tx, projectId, input.agentId);
    if (UNPAUSABLE_AGENT_STATUSES.has(status)) {
      throw conflict(`agent ${input.agentId} is already ${status}`);
    }
    await tx.query(`update agents set status = 'paused' where id = $1`, [
      input.agentId,
    ]);
    return { agentId: input.agentId, status: 'paused' };
  });

const resumeAgent: IntentHandler<'agent.resume'> = (ctx, input, name) =>
  applyInProject(ctx, name, input, async (tx, projectId) => {
    const status = await agentStatus(tx, projectId, input.agentId);
    if (status !== 'paused') {
      throw conflict(`agent ${input.agentId} is not paused, it is ${status}`);
    }
    const resumed = await findRow<{ status: string }>(
      tx,
      `update agents
       set status = case
         when exists (
           select 1 from turns where agent_id = $1 and ended_at is null
         ) then 'working'
         else 'idle'
       end
       where id = $1
       returning status`,
      [input.agentId],
      `agent ${input.agentId} not found`,
    );
    return { agentId: input.agentId, status: resumed.status };
  });

export const PAUSE_HANDLERS: IntentHandlers<PauseIntentName> = {
  'pause.set': setProjectPause,
  'pause.all': setPauseEverywhere,
  'agent.pause': pauseAgent,
  'agent.resume': resumeAgent,
};
