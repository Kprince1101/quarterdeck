import {
  loadRule,
  type LoadRulesOptions,
  type Runtime,
} from '@quarterdeck/rules';
import type { ApiContext } from '../api/context.js';
import { badRequest, conflict } from '../api/http-error.js';
import type {
  IntentPayload,
  SetupDetectResult,
  SetupSaveResult,
} from '../intents/index.js';
import type { WorkspaceProject } from '../stream/schema.js';
import {
  detectWorkspace,
  type WorkspaceDetection,
} from '../workspace/index.js';
import { applySetup, assertProjectSlugs } from './apply.js';
import { needsSetup, resolveSetupPath, setupWorkspaces } from './paths.js';
import {
  modelsLayers,
  repoRuntimeLayer,
  usesRuntime,
  type RuntimeChoice,
} from './runtime-layer.js';

export const detectSetupFolder = async (
  ctx: ApiContext,
  path: string,
): Promise<SetupDetectResult> =>
  detectWorkspace(resolveSetupPath(path, ctx.homeDir));

const modelsRules = (
  homeDir: string,
  detection: WorkspaceDetection,
  repos: readonly WorkspaceProject[],
): LoadRulesOptions => {
  const [only] = repos;
  if (detection.mode !== 'single' || only === undefined) return { homeDir };
  return { homeDir, repoDir: only.repoPath };
};

const assertNoRepoLayers = async (
  homeDir: string,
  repos: readonly WorkspaceProject[],
): Promise<void> => {
  for (const repo of repos) {
    const layer = await repoRuntimeLayer(homeDir, repo.repoPath);
    if (layer === undefined) continue;
    throw conflict(
      `${layer} sets the runtime for ${repo.name} and wins over ~/.quarterdeck. Pick the runtime it names, or change it there.`,
    );
  }
};

export const machineRuntimeChoice = async (
  homeDir: string,
  detection: WorkspaceDetection,
  repos: readonly WorkspaceProject[],
  runtime: Runtime,
): Promise<RuntimeChoice> => {
  const current = await loadRule(
    'models',
    modelsRules(homeDir, detection, repos),
  );
  if (usesRuntime(current, runtime)) return { runtime, layer: undefined };
  await assertNoRepoLayers(homeDir, repos);
  const { machine } = modelsLayers(homeDir, homeDir);
  return { runtime, layer: { path: machine, inRepo: false } };
};

export const saveSetup = async (
  ctx: ApiContext,
  input: IntentPayload<'setup.save'>,
): Promise<SetupSaveResult> => {
  if (!(await needsSetup(ctx))) {
    throw conflict(
      'Quarterdeck already has a workspace. Add repositories to it with init in a terminal.',
    );
  }
  const detection = await detectSetupFolder(ctx, input.root);
  const skipped = new Set(input.skip);
  const repos = detection.repositories.filter(
    (repo) => !skipped.has(repo.slug),
  );
  if (repos.length === 0) throw badRequest('No repositories to add.');
  assertProjectSlugs(repos);
  const choice = await machineRuntimeChoice(
    ctx.homeDir,
    detection,
    repos,
    input.runtime,
  );
  const { update } = await applySetup(
    {
      stores: ctx.stores,
      homeDir: ctx.homeDir,
      workspaces: setupWorkspaces(ctx),
    },
    { root: detection.root, mode: detection.mode, repos, choice },
  );
  return {
    mode: update.workspace.mode,
    projects: repos.map((repo) => repo.slug),
    runtime: input.runtime,
    notice: update.notice,
  };
};
