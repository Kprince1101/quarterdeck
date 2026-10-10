import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  LOCAL_RULES_DIR,
  loadRule,
  modelsSchema,
  ruleLayerPaths,
  runtimeSchema,
  type Models,
  type Runtime,
} from '@quarterdeck/rules';
import {
  QUARTERDECK_COMMAND,
  confirmationList,
  createProjectStores,
  createWorkspaces,
  detectWorkspace,
  dispatchIntent,
  ensurePrivateDir,
  quarterdeckHome,
  slugFromFolder,
  type ProjectStores,
  type Workspace,
  type WorkspaceDetection,
  type WorkspaceProject,
  type WorkspaceUpdate,
} from '@quarterdeck/server';
import type { IntentPayload } from '@quarterdeck/server/intents';
import { parseIntent } from './intent.js';
import { CliError, type CliIo, type Command } from './io.js';
import { jsonText, readJsonLayer } from './json-layer.js';
import { setUpProfile } from './profile-setup.js';
import { choose, confirm } from './prompt.js';

export { slugFromFolder };

const RUNTIMES = runtimeSchema.options;
const ROLES = Object.keys(modelsSchema.shape) as Array<keyof Models>;

export const INIT_USAGE = `Usage: ${QUARTERDECK_COMMAND} init [path] [options]

Picks the workspace Quarterdeck works in and creates ~/.quarterdeck.
path (default: the current directory) is either a git repository, which
Quarterdeck then works on its own, or a folder whose git repositories, one
level down, each become a project; you confirm the list first. Running init
again with another repository or folder adds to the workspace. Nothing is
written into a repository unless you agree to a .quarterdeck/ folder there.

  --project <slug>     Slug for a single repository (default: from the folder name)
  --name <name>        Display name for a single repository (default: the folder name)
  --skip <slug>        In a folder, leave this repository out (repeatable)
  --runtime <runtime>  ${RUNTIMES.join(', ')} (asked when interactive)
  --folder             Save a non-default runtime in <repo>/.quarterdeck/, for that repository only
  --no-folder          Save it in ~/.quarterdeck/ instead, for every repository on this machine
  --setup              Run the active rules profile's repo setup without asking
  --no-setup           Skip it (the shipped default profile has none)`;

interface InitOptions {
  project?: string | undefined;
  name?: string | undefined;
  skip?: string[] | undefined;
  runtime?: string | undefined;
  folder?: boolean | undefined;
  'no-folder'?: boolean | undefined;
  setup?: boolean | undefined;
  'no-setup'?: boolean | undefined;
}

interface RuntimeLayer {
  path: string;
  inRepo: boolean;
}

interface RuntimeChoice {
  runtime: Runtime;
  layer: RuntimeLayer | undefined;
}

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const parseRuntime = (value: string): Runtime => {
  const parsed = runtimeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError(`--runtime must be one of ${RUNTIMES.join(', ')}`);
};

const withRuntime = (
  layer: Record<string, unknown>,
  runtime: Runtime,
): Record<string, unknown> => {
  const roles = ROLES.map((role) => {
    const current = layer[role];
    const kept = typeof current === 'object' && current !== null && current;
    return [role, { ...kept, runtime }];
  });
  return { ...layer, ...Object.fromEntries(roles) };
};

const usesRuntime = (models: Models, runtime: Runtime): boolean =>
  ROLES.every((role) => models[role].runtime === runtime);

const pickRuntime = async (
  flag: string | undefined,
  io: CliIo,
  fallback: Runtime,
): Promise<Runtime> => {
  if (flag !== undefined) return parseRuntime(flag);
  if (!io.prompter) return fallback;
  return choose(
    io.prompter,
    `Runtime (${RUNTIMES.join(', ')}) [${fallback}]: `,
    RUNTIMES,
    fallback,
  );
};

const pickFolder = async (
  options: InitOptions,
  io: CliIo,
  repoPath: string,
  runtime: Runtime,
): Promise<boolean> => {
  if (options.folder) return true;
  if (options['no-folder']) return false;
  const folder = join(repoPath, LOCAL_RULES_DIR);
  const machine = quarterdeckHome(io.homeDir);
  if (!io.prompter) {
    throw new CliError(
      `Runtime ${runtime} is not this machine's default. Pass --folder to save it in ${folder}/ for this repository, or --no-folder to save it in ${machine}/ for every repository.`,
    );
  }
  return confirm(
    io.prompter,
    `Save runtime ${runtime} in ${folder}/, for this repository only? If not, it is saved in ${machine}/ for every repository on this machine. [y/N] `,
  );
};

const modelsLayers = (io: CliIo, repoPath: string) => {
  const [machine, repo] = ruleLayerPaths('models', {
    homeDir: io.homeDir,
    repoDir: repoPath,
  }).local;
  if (machine === undefined || repo === undefined) {
    throw new Error('models has no local rule layers');
  }
  return { machine, repo };
};

const assertNoRepoLayer = async (io: CliIo, repoPath: string) => {
  const { repo } = modelsLayers(io, repoPath);
  if (await fileExists(repo)) {
    throw new CliError(
      `${repo} sets this repository's runtime and wins over ~/.quarterdeck. Pass --folder to change it there.`,
    );
  }
};

const decideRuntime = async (
  options: InitOptions,
  io: CliIo,
  repoPath: string,
): Promise<RuntimeChoice> => {
  const current = await loadRule('models', {
    homeDir: io.homeDir,
    repoDir: repoPath,
  });
  const runtime = await pickRuntime(
    options.runtime,
    io,
    current.driver.runtime,
  );
  if (usesRuntime(current, runtime)) return { runtime, layer: undefined };
  const inRepo = await pickFolder(options, io, repoPath, runtime);
  const layers = modelsLayers(io, repoPath);
  if (inRepo) return { runtime, layer: { path: layers.repo, inRepo } };
  await assertNoRepoLayer(io, repoPath);
  return { runtime, layer: { path: layers.machine, inRepo } };
};

const decideFolderRuntime = async (
  options: InitOptions,
  io: CliIo,
  repos: readonly WorkspaceProject[],
): Promise<RuntimeChoice> => {
  const current = await loadRule('models', { homeDir: io.homeDir });
  const runtime = await pickRuntime(
    options.runtime,
    io,
    current.driver.runtime,
  );
  if (usesRuntime(current, runtime)) return { runtime, layer: undefined };
  if (options.folder) {
    throw new CliError(
      '--folder saves a runtime for one repository; for a folder of repositories it is saved in ~/.quarterdeck. Leave --folder out.',
    );
  }
  for (const repo of repos) await assertNoRepoLayer(io, repo.repoPath);
  const { machine } = modelsLayers(io, io.homeDir);
  return { runtime, layer: { path: machine, inRepo: false } };
};

const ruleWrite = (
  project: string,
  layer: RuntimeLayer,
  content: string,
): IntentPayload<'rules.write'> => {
  if (layer.inRepo) {
    return parseIntent('rules.write', {
      scope: 'project',
      project,
      name: 'models',
      content,
    });
  }
  return parseIntent('rules.write', {
    scope: 'machine',
    name: 'models',
    content,
  });
};

const saveRuntime = async (
  stores: ProjectStores,
  io: CliIo,
  project: string,
  runtime: Runtime,
  layer: RuntimeLayer,
) => {
  const models = withRuntime(await readJsonLayer(layer.path), runtime);
  const content = jsonText(models);
  await dispatchIntent(
    { stores, homeDir: io.homeDir },
    'rules.write',
    ruleWrite(project, layer, content),
  );
};

const dataOf = (stores: ProjectStores, project: string): string => {
  if (stores.location === stores.dataHome) {
    return join(stores.dataHome, project);
  }
  return stores.location;
};

const createProjects = async (
  io: CliIo,
  repos: readonly WorkspaceProject[],
  choice: RuntimeChoice,
): Promise<string[]> => {
  const stores = createProjectStores(quarterdeckHome(io.homeDir));
  try {
    const data: string[] = [];
    for (const repo of repos) {
      const input = parseIntent('project.create', {
        project: repo.slug,
        name: repo.name,
        repoPath: repo.repoPath,
      });
      await dispatchIntent(
        { stores, homeDir: io.homeDir },
        'project.create',
        input,
      );
      data.push(dataOf(stores, input.project));
    }
    const [first] = repos;
    if (choice.layer !== undefined && first !== undefined) {
      await saveRuntime(stores, io, first.slug, choice.runtime, choice.layer);
    }
    return data;
  } finally {
    await stores.closeAll();
  }
};

const isNumber = (part: string): boolean => /^\d+$/.test(part);

const parseUnticked = (
  answer: string,
  count: number,
): Set<number> | undefined => {
  const parts = answer.split(/[\s,]+/).filter((part) => part !== '');
  if (!parts.every(isNumber)) return undefined;
  const numbers = parts.map(Number);
  if (numbers.some((n) => n < 1 || n > count)) return undefined;
  return new Set(numbers.map((n) => n - 1));
};

const untick = async (
  io: CliIo,
  repos: readonly WorkspaceProject[],
): Promise<WorkspaceProject[]> => {
  if (!io.prompter || repos.length === 0) return [...repos];
  for (;;) {
    const answer = await io.prompter.ask(
      'Untick any by number, separated by spaces (enter keeps them all): ',
    );
    const unticked = parseUnticked(answer, repos.length);
    if (unticked !== undefined) {
      return repos.filter((_, index) => !unticked.has(index));
    }
  }
};

const singleRepository = (
  detection: WorkspaceDetection,
  options: InitOptions,
): WorkspaceProject[] =>
  detection.repositories.map((repo) => ({
    ...repo,
    slug: options.project ?? repo.slug,
    name: options.name ?? repo.name,
  }));

const known = (workspace: Workspace | null, repo: WorkspaceProject) =>
  workspace?.projects.some(
    (project) =>
      project.repoPath === repo.repoPath || project.slug === repo.slug,
  ) ?? false;

const chooseRepositories = async (
  io: CliIo,
  detection: WorkspaceDetection,
  options: InitOptions,
  workspace: Workspace | null,
): Promise<WorkspaceProject[]> => {
  if (detection.mode === 'single') return singleRepository(detection, options);
  if (options.project !== undefined || options.name !== undefined) {
    throw new CliError(
      `--project and --name name one repository; ${detection.root} holds several. Use --skip to leave some out.`,
    );
  }
  const skipped = new Set(options.skip);
  const listed = detection.repositories.filter(
    (repo) => !skipped.has(repo.slug),
  );
  const fresh = listed.filter((repo) => !known(workspace, repo));
  const already = listed.filter((repo) => known(workspace, repo));
  io.out(`Repositories in ${detection.root}, each one a project:`);
  for (const line of confirmationList({ ...detection, repositories: fresh })) {
    io.out(line);
  }
  for (const repo of already) {
    io.out(`  already a project: ${repo.slug}  ${repo.repoPath}`);
  }
  return untick(io, fresh);
};

const projectCount = (count: number): string => {
  if (count === 1) return '1 project';
  return `${count} projects`;
};

const workspaceLine = (workspace: Workspace): string => {
  if (workspace.mode === 'single') {
    return `Workspace: one repository, ${workspace.root}`;
  }
  return `Workspace: ${projectCount(workspace.projects.length)} in ${workspace.root}`;
};

const createdLine = (repo: WorkspaceProject, workspace: Workspace): string => {
  if (workspace.mode === 'single') {
    return `Added ${repo.name} at ${repo.repoPath}`;
  }
  return `Created project ${repo.slug} (${repo.name}) for ${repo.repoPath}`;
};

const report = (
  io: CliIo,
  repos: readonly WorkspaceProject[],
  choice: RuntimeChoice,
  data: readonly string[],
  update: WorkspaceUpdate,
) => {
  if (update.notice !== null) io.out(update.notice);
  for (const repo of repos) io.out(createdLine(repo, update.workspace));
  if (choice.layer === undefined) {
    io.out(`Runtime: ${choice.runtime}`);
  } else {
    io.out(`Runtime: ${choice.runtime}, saved in ${choice.layer.path}`);
  }
  io.out(workspaceLine(update.workspace));
  for (const path of data) io.out(`Data: ${path}`);
};

const decide = (
  options: InitOptions,
  io: CliIo,
  detection: WorkspaceDetection,
  repos: readonly WorkspaceProject[],
): Promise<RuntimeChoice> => {
  const [only] = repos;
  if (detection.mode === 'single' && only !== undefined) {
    return decideRuntime(options, io, only.repoPath);
  }
  return decideFolderRuntime(options, io, repos);
};

export const runInit: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      name: { type: 'string' },
      skip: { type: 'string', multiple: true },
      runtime: { type: 'string' },
      folder: { type: 'boolean' },
      'no-folder': { type: 'boolean' },
      setup: { type: 'boolean' },
      'no-setup': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.out(INIT_USAGE);
    return 0;
  }
  if (positionals.length > 1) throw new CliError('init takes one path');
  if (values.folder && values['no-folder']) {
    throw new CliError('Pass --folder or --no-folder, not both');
  }
  if (values.setup && values['no-setup']) {
    throw new CliError('Pass --setup or --no-setup, not both');
  }
  const detection = await detectWorkspace(
    resolve(io.cwd, positionals[0] ?? '.'),
  );
  const home = quarterdeckHome(io.homeDir);
  const workspaces = createWorkspaces(home);
  const repos = await chooseRepositories(
    io,
    detection,
    values,
    await workspaces.read(),
  );
  if (repos.length === 0) throw new CliError('No repositories to add.');
  for (const repo of repos) {
    parseIntent('project.create', { project: repo.slug });
  }
  const choice = await decide(values, io, detection, repos);
  await ensurePrivateDir(home);
  const data = await createProjects(io, repos, choice);
  const update = await workspaces.add({
    root: detection.root,
    mode: detection.mode,
    projects: repos,
  });
  report(io, repos, choice, data, update);
  if (!values['no-setup']) {
    for (const repo of repos)
      await setUpProfile(io, repo.repoPath, { yes: values.setup ?? false });
  }
  io.out(`Next: ${QUARTERDECK_COMMAND} up`);
  return 0;
};
