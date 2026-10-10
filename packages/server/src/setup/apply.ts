import { join } from 'node:path';
import { dispatchIntent } from '../api/dispatch.js';
import { badRequest } from '../api/http-error.js';
import type { ProjectStores } from '../api/project-stores.js';
import { INTENTS, projectSlugSchema } from '../intents/index.js';
import type { WorkspaceMode, WorkspaceProject } from '../stream/schema.js';
import type { WorkspaceUpdate, Workspaces } from '../workspace/index.js';
import { saveRuntime, type RuntimeChoice } from './runtime-layer.js';

export interface SetupContext {
  stores: ProjectStores;
  homeDir: string;
  workspaces: Workspaces;
}

export interface SetupPlan {
  root: string;
  mode: WorkspaceMode;
  repos: readonly WorkspaceProject[];
  choice: RuntimeChoice;
}

export interface SetupApplied {
  data: string[];
  update: WorkspaceUpdate;
}

const dataOf = (stores: ProjectStores, project: string): string => {
  if (stores.location === stores.dataHome) {
    return join(stores.dataHome, project);
  }
  return stores.location;
};

export const assertProjectSlugs = (
  repos: readonly WorkspaceProject[],
): void => {
  for (const repo of repos) {
    if (projectSlugSchema.safeParse(repo.slug).success) continue;
    throw badRequest(
      `${repo.repoPath} gives the project slug "${repo.slug}", which is not a valid slug; rename the folder or use init --project`,
    );
  }
};

export const applySetup = async (
  ctx: SetupContext,
  { root, mode, repos, choice }: SetupPlan,
): Promise<SetupApplied> => {
  const projects = { stores: ctx.stores, homeDir: ctx.homeDir };
  const [first] = repos;
  const { layer } = choice;
  if (layer !== undefined && !layer.inRepo && first !== undefined) {
    await saveRuntime(projects, first.slug, choice.runtime, layer);
  }
  const data: string[] = [];
  for (const repo of repos) {
    const input = INTENTS['project.create'].parse({
      project: repo.slug,
      name: repo.name,
      repoPath: repo.repoPath,
    });
    await dispatchIntent(projects, 'project.create', input);
    data.push(dataOf(ctx.stores, input.project));
  }
  if (layer?.inRepo && first !== undefined) {
    await saveRuntime(projects, first.slug, choice.runtime, layer);
  }
  const update = await ctx.workspaces.add({
    root,
    mode,
    projects: [...repos],
  });
  return { data, update };
};
