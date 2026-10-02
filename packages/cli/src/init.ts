import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
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
  createProjectStores,
  dispatchIntent,
  quarterdeckHome,
  type ProjectStores,
} from '@quarterdeck/server';
import type { IntentPayload } from '@quarterdeck/server/intents';
import { parseIntent } from './intent.js';
import { CliError, type CliIo, type Command } from './io.js';
import { choose, confirm } from './prompt.js';

const RUNTIMES = runtimeSchema.options;
const ROLES = Object.keys(modelsSchema.shape) as Array<keyof Models>;
const MAX_SLUG_LENGTH = 63;

export const INIT_USAGE = `Usage: quarterdeck init [repo-path] [options]

Creates ~/.quarterdeck and a project for the git repository at repo-path
(default: the current directory). Nothing is written into the repository
unless you agree to a .quarterdeck/ folder there.

  --project <slug>     Project slug (default: from the folder name)
  --name <name>        Display name (default: the folder name)
  --runtime <runtime>  ${RUNTIMES.join(', ')} (asked when interactive)
  --folder             Save a non-default runtime in <repo>/.quarterdeck/, for this project
  --no-folder          Save it in ~/.quarterdeck/ instead, for every project on this machine`;

interface InitOptions {
  project?: string | undefined;
  name?: string | undefined;
  runtime?: string | undefined;
  folder?: boolean | undefined;
  'no-folder'?: boolean | undefined;
}

interface RuntimeLayer {
  path: string;
  inRepo: boolean;
}

interface RuntimeChoice {
  runtime: Runtime;
  layer: RuntimeLayer | undefined;
}

export const slugFromFolder = (folder: string): string =>
  folder
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, MAX_SLUG_LENGTH);

const isDirectory = async (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

const fileExists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const gitRepo = async (path: string): Promise<string> => {
  if (!(await isDirectory(path))) {
    throw new CliError(`${path} is not a directory`);
  }
  if (!(await fileExists(join(path, '.git')))) {
    throw new CliError(`${path} is not a git repository (no .git)`);
  }
  return path;
};

const parseRuntime = (value: string): Runtime => {
  const parsed = runtimeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError(`--runtime must be one of ${RUNTIMES.join(', ')}`);
};

const readJsonLayer = async (
  path: string,
): Promise<Record<string, unknown>> => {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    throw new CliError(`${path} is not valid JSON`);
  }
  throw new CliError(`${path} is not a JSON object`);
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
      `Runtime ${runtime} is not this machine's default. Pass --folder to save it in ${folder}/ for this project, or --no-folder to save it in ${machine}/ for every project.`,
    );
  }
  return confirm(
    io.prompter,
    `Save runtime ${runtime} in ${folder}/, for this project only? If not, it is saved in ${machine}/ for every project on this machine. [y/N] `,
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
  if (await fileExists(layers.repo)) {
    throw new CliError(
      `${layers.repo} sets this project's runtime and wins over ~/.quarterdeck. Pass --folder to change it there.`,
    );
  }
  return { runtime, layer: { path: layers.machine, inRepo } };
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
  const content = `${JSON.stringify(models, null, 2)}\n`;
  await dispatchIntent(
    { stores, homeDir: io.homeDir },
    'rules.write',
    ruleWrite(project, layer, content),
  );
};

const createProject = async (
  io: CliIo,
  input: IntentPayload<'project.create'>,
  choice: RuntimeChoice,
): Promise<string> => {
  const stores = createProjectStores(quarterdeckHome(io.homeDir));
  try {
    await dispatchIntent(
      { stores, homeDir: io.homeDir },
      'project.create',
      input,
    );
    if (choice.layer !== undefined) {
      await saveRuntime(
        stores,
        io,
        input.project,
        choice.runtime,
        choice.layer,
      );
    }
    if (stores.location === stores.dataHome) {
      return join(stores.dataHome, input.project);
    }
    return stores.location;
  } finally {
    await stores.closeAll();
  }
};

const report = (
  io: CliIo,
  repoPath: string,
  input: IntentPayload<'project.create'>,
  choice: RuntimeChoice,
  data: string,
) => {
  io.out(`Created project ${input.project} (${input.name}) for ${repoPath}`);
  if (choice.layer === undefined) {
    io.out(`Runtime: ${choice.runtime}`);
  } else {
    io.out(`Runtime: ${choice.runtime}, saved in ${choice.layer.path}`);
  }
  io.out(`Data: ${data}`);
  io.out('Next: quarterdeck up');
};

export const runInit: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      name: { type: 'string' },
      runtime: { type: 'string' },
      folder: { type: 'boolean' },
      'no-folder': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.out(INIT_USAGE);
    return 0;
  }
  if (positionals.length > 1) throw new CliError('init takes one repo path');
  if (values.folder && values['no-folder']) {
    throw new CliError('Pass --folder or --no-folder, not both');
  }
  const repoPath = await gitRepo(resolve(io.cwd, positionals[0] ?? '.'));
  const folderName = basename(repoPath);
  const input = parseIntent('project.create', {
    project: values.project ?? slugFromFolder(folderName),
    name: values.name ?? folderName,
    repoPath,
  });
  const choice = await decideRuntime(values, io, repoPath);
  await mkdir(quarterdeckHome(io.homeDir), { recursive: true });
  const data = await createProject(io, input, choice);
  report(io, repoPath, input, choice, data);
  return 0;
};
