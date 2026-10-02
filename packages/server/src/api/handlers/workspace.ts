import type { WorkspaceIntentName } from '../../intents/index.js';
import type { IntentHandlers } from '../context.js';
import { applyInProject, findRow, unrecorded } from '../record.js';
import { assertDirectory } from '../repo-path.js';
import { RULES_HANDLERS } from './rules.js';

type ProjectIntentName = 'project.create' | 'project.update';

const PROJECT_HANDLERS: IntentHandlers<ProjectIntentName> = {
  'project.create': async (ctx, input, name) => {
    await assertDirectory(input.repoPath);
    await ctx.stores.create(input.project);
    return applyInProject(ctx, name, input, async (tx, projectId) => {
      await tx.query(
        `update projects set name = coalesce($2, name), repo_path = $3
         where id = $1`,
        [projectId, input.name ?? null, input.repoPath ?? null],
      );
      return { projectId };
    });
  },
  'project.update': async (ctx, input, name) => {
    await assertDirectory(input.repoPath);
    return applyInProject(ctx, name, input, async (tx, projectId) => {
      await tx.query(
        `update projects set
           name = coalesce($2, name),
           repo_path = case when $3::boolean then $4 else repo_path end
         where id = $1`,
        [
          projectId,
          input.name ?? null,
          input.repoPath !== undefined,
          input.repoPath ?? null,
        ],
      );
      return { projectId };
    });
  },
};

export const WORKSPACE_HANDLERS: IntentHandlers<WorkspaceIntentName> = {
  ...PROJECT_HANDLERS,
  ...RULES_HANDLERS,
  'layout.save': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      const layout = await findRow<{ id: string }>(
        tx,
        `insert into layouts (project_id, name, spec) values ($1, $2, $3::jsonb)
         on conflict (project_id, name) do update set spec = excluded.spec
         returning id`,
        [projectId, input.name, JSON.stringify(input.spec)],
        `layout ${input.name} was not saved`,
      );
      return { layoutId: layout.id, name: input.name };
    }),
  'layout.delete': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await findRow(
        tx,
        'delete from layouts where project_id = $1 and name = $2 returning id',
        [projectId, input.name],
        `layout ${input.name} not found`,
      );
      return { name: input.name };
    }),
  'wipe.project': async (ctx, input, name) => {
    await ctx.stores.wipe(input.project);
    return unrecorded(name, { wiped: [input.project] });
  },
  'wipe.all': async (ctx, _input, name) =>
    unrecorded(name, { wiped: await ctx.stores.wipeAll() }),
};
