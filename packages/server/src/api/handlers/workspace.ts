import { createGlobalLayouts } from '../../global-layout/index.js';
import type {
  IntentPayload,
  IntentReply,
  IntentResult,
  WorkspaceIntentName,
} from '../../intents/index.js';
import { createWorkspaces, describeRepository } from '../../workspace/index.js';
import { presetLayout, type GridLayout } from '../../layouts/index.js';
import type { Queryable } from '../../store/index.js';
import type { ApiContext, IntentHandlers } from '../context.js';
import { applyInProject, findRow, unrecorded } from '../record.js';
import { assertDirectory } from '../repo-path.js';
import { RULES_HANDLERS } from './rules.js';

type ProjectIntentName =
  'project.create' | 'project.update' | 'project.archive';

const joinWorkspace = async (
  ctx: ApiContext,
  input: IntentPayload<'project.create'>,
): Promise<IntentResult> => {
  if (ctx.workspaces === undefined || input.repoPath === undefined) return {};
  const repo = await describeRepository(input.repoPath);
  const project = {
    ...repo,
    slug: input.project,
    name: input.name ?? repo.name,
  };
  const { workspace, notice } = await ctx.workspaces.add({
    root: input.repoPath,
    mode: 'single',
    projects: [project],
  });
  return { workspace: { mode: workspace.mode, notice } };
};

const PROJECT_HANDLERS: IntentHandlers<ProjectIntentName> = {
  'project.create': async (ctx, input, name) => {
    await assertDirectory(input.repoPath);
    await ctx.stores.create(input.project);
    const reply = await applyInProject(
      ctx,
      name,
      input,
      async (tx, projectId) => {
        await tx.query(
          `update projects set name = coalesce($2, name), repo_path = $3
         where id = $1`,
          [projectId, input.name ?? null, input.repoPath ?? null],
        );
        return { projectId };
      },
    );
    const joined = await joinWorkspace(ctx, input);
    return { ...reply, result: { ...reply.result, ...joined } };
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
  'project.archive': (ctx, input, name) =>
    applyInProject(ctx, name, input, async (tx, projectId) => {
      await findRow(
        tx,
        `update projects set archived_at =
           case when $2::boolean then coalesce(archived_at, now()) end
         where id = $1
         returning id`,
        [projectId, input.archived],
        `project ${input.project} not found`,
      );
      return { projectId, archived: input.archived };
    }),
};

interface LayoutInput {
  project?: string | undefined;
  name: string;
}

const saveLayout = async (
  tx: Queryable,
  projectId: string,
  name: string,
  spec: GridLayout,
) => {
  const layout = await findRow<{ id: string }>(
    tx,
    `insert into layouts (project_id, name, spec) values ($1, $2, $3::jsonb)
     on conflict (project_id, name) do update set spec = excluded.spec
     returning id`,
    [projectId, name, JSON.stringify(spec)],
    `layout ${name} was not saved`,
  );
  return { layoutId: layout.id, name };
};

const writeLayout = async (
  ctx: ApiContext,
  intent: 'layout.save' | 'layout.reset',
  input: LayoutInput,
  spec: GridLayout,
  extra: IntentResult = {},
): Promise<IntentReply> => {
  const { project } = input;
  if (project === undefined) {
    const layouts = ctx.layouts ?? createGlobalLayouts(ctx.stores.dataHome);
    const { updatedAt } = await layouts.save(spec);
    return unrecorded(intent, { name: input.name, updatedAt, ...extra });
  }
  return applyInProject(
    ctx,
    intent,
    { ...input, project },
    async (tx, projectId) => ({
      ...(await saveLayout(tx, projectId, input.name, spec)),
      ...extra,
    }),
  );
};

export const WORKSPACE_HANDLERS: IntentHandlers<WorkspaceIntentName> = {
  ...PROJECT_HANDLERS,
  ...RULES_HANDLERS,
  'layout.save': (ctx, input, name) =>
    writeLayout(ctx, name, input, input.spec),
  'layout.reset': (ctx, input, name) =>
    writeLayout(ctx, name, input, presetLayout(input.preset), {
      preset: input.preset,
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
    const wiped = await ctx.stores.wipe(input.project);
    await ctx.workspaces?.remove(wiped.wiped);
    return unrecorded(name, wiped);
  },
  'wipe.all': async (ctx, _input, name) => {
    const wiped = await ctx.stores.wipeAll();
    await ctx.workspaces?.remove(wiped.wiped);
    return unrecorded(name, wiped);
  },
  'workspace.read': async (ctx, _input, name) => {
    const workspaces = ctx.workspaces ?? createWorkspaces(ctx.stores.dataHome);
    return unrecorded(name, { workspace: await workspaces.read() });
  },
};
