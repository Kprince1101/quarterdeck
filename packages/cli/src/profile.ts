import { copyFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  PROFILE_MANIFEST,
  describeProfiles,
  listProfiles,
  locateProfile,
  machineProfilesDir,
  profileManifestSchema,
  profileNameSchema,
  ruleLayerPaths,
  ruleLevelsSchema,
  type ProfileChoice,
  type ProfileSummary,
  type RuleLevels,
} from '@quarterdeck/rules';
import {
  QUARTERDECK_COMMAND,
  createProjectStores,
  dispatchIntent,
  ensurePrivateDir,
  quarterdeckHome,
  writePrivateFile,
  type ProjectStores,
} from '@quarterdeck/server';
import { projectSlugSchema } from '@quarterdeck/server/intents';
import { parseIntent } from './intent.js';
import { CliError, type CliIo, type Command } from './io.js';
import { jsonText, readJsonLayer } from './json-layer.js';
import { setUpProfile } from './profile-setup.js';

export const PROFILE_USAGE = `Usage: ${QUARTERDECK_COMMAND} profile <command> [options]

Commands:
  list                      List the rules profiles and the files each reads
  add <name>                Create a machine profile in ~/.quarterdeck/profiles/<name>/
  use <name>                Make <name> the active profile for this machine
  setup [repo-path]         Run the active profile's repo setup (install, levels, steering)

add options:
  --standards <path>        A standards doc agents read at kickoff (repeatable)
  --philosophy <path>       A second doc read after the standards
  --description <text>      One line saying what the profile is for
  --levels <file>           A JSON map of rule name to level 0-3
  --reviewer <file>         Reviewer rules added to the shipped reviewer.md
  --lifecycle <file>        A lifecycle layer, such as merge gate settings
  --force                   Replace a profile that already exists

use options:
  --project <slug>          Choose it for one project only, in <repo>/.quarterdeck/

setup options:
  --yes                     Do not ask first`;

const CHOSEN_BY: Record<ProfileChoice, string> = {
  shipped: 'the shipped default',
  machine: 'this machine',
  project: 'this project',
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const summaryLines = (summary: ProfileSummary, active: string): string[] => {
  const mark = (summary.name === active && '*') || ' ';
  const about = summary.error ?? summary.description;
  return [
    `${mark} ${summary.name} (${summary.source}): ${about}`,
    ...summary.files.map((file) => `    ${file}`),
  ];
};

const listCommand = async (io: CliIo): Promise<number> => {
  const view = await describeProfiles({ homeDir: io.homeDir });
  for (const summary of view.profiles)
    for (const line of summaryLines(summary, view.active)) io.out(line);
  if (view.error !== null) {
    io.err(view.error);
    return 1;
  }
  const [layer = ''] = ruleLayerPaths('profile', { homeDir: io.homeDir }).local;
  io.out(`Active: ${view.active}, chosen by ${CHOSEN_BY[view.chosenBy]}.`);
  io.out(`${QUARTERDECK_COMMAND} profile use <name> writes ${layer}.`);
  return 0;
};

interface AddValues {
  standards?: string[] | undefined;
  philosophy?: string | undefined;
  description?: string | undefined;
  levels?: string | undefined;
  reviewer?: string | undefined;
  lifecycle?: string | undefined;
  force?: boolean | undefined;
}

const existingFile = async (io: CliIo, path: string): Promise<string> => {
  const absolute = resolve(io.cwd, path);
  if (!(await exists(absolute)))
    throw new CliError(`${absolute} does not exist`);
  return absolute;
};

const readLevels = async (
  io: CliIo,
  path: string | undefined,
): Promise<RuleLevels> => {
  if (path === undefined) return {};
  const file = await existingFile(io, path);
  const layer = await readJsonLayer(file);
  const levels = layer['levels'] ?? layer['rules'] ?? layer;
  const parsed = ruleLevelsSchema.safeParse(levels);
  if (!parsed.success)
    throw new CliError(`${file}: every level must be 0, 1, 2 or 3`);
  return parsed.data;
};

const profileName = (name: string | undefined): string => {
  if (name === undefined)
    throw new CliError(`profile add needs a name\n\n${PROFILE_USAGE}`);
  if (!profileNameSchema.safeParse(name).success)
    throw new CliError(
      `${JSON.stringify(name)} is not a profile name: use lowercase letters, digits, - and _`,
    );
  return name;
};

const refuseShipped = async (io: CliIo, name: string): Promise<void> => {
  const shipped = (await listProfiles({ homeDir: io.homeDir })).find(
    (profile) => profile.name === name && profile.source === 'shipped',
  );
  if (shipped !== undefined)
    throw new CliError(`${name} is a shipped profile; pick another name`);
};

const copyLayer = async (
  io: CliIo,
  from: string | undefined,
  to: string,
): Promise<string[]> => {
  if (from === undefined) return [];
  await copyFile(await existingFile(io, from), to);
  return [to];
};

const addCommand = async (
  io: CliIo,
  name: string | undefined,
  values: AddValues,
): Promise<number> => {
  const profile = profileName(name);
  await refuseShipped(io, profile);
  const dir = resolve(machineProfilesDir(io.homeDir), profile);
  const manifestPath = resolve(dir, PROFILE_MANIFEST);
  if (!values.force && (await exists(manifestPath)))
    throw new CliError(`${manifestPath} exists; pass --force to replace it`);
  const docs = [...(values.standards ?? []), values.philosophy].filter(
    (path): path is string => path !== undefined,
  );
  const standards = await Promise.all(docs.map((doc) => existingFile(io, doc)));
  const manifest = profileManifestSchema.parse({
    description:
      values.description ?? `Machine profile ${profile}, added from the CLI.`,
    standards,
    levels: await readLevels(io, values.levels),
  });
  await ensurePrivateDir(dir);
  await writePrivateFile(manifestPath, jsonText(manifest));
  const written = [
    manifestPath,
    ...(await copyLayer(io, values.reviewer, resolve(dir, 'reviewer.md'))),
    ...(await copyLayer(io, values.lifecycle, resolve(dir, 'lifecycle.json'))),
  ];
  for (const path of written) io.out(`Wrote ${path}`);
  io.out(`Make it active with ${QUARTERDECK_COMMAND} profile use ${profile}`);
  return 0;
};

const projectRepoPath = async (
  stores: ProjectStores,
  project: string,
): Promise<string> => {
  if (!projectSlugSchema.safeParse(project).success)
    throw new CliError(`${JSON.stringify(project)} is not a project slug`);
  if (!(await stores.list()).includes(project))
    throw new CliError(
      `project ${project} does not exist in ${stores.location}`,
    );
  const store = await stores.get(project);
  const { rows } = await store.db.query<{ repo_path: string | null }>(
    'select repo_path from projects where id = $1',
    [store.projectId],
  );
  const repoPath = rows[0]?.repo_path ?? null;
  if (repoPath === null)
    throw new CliError(`project ${project} has no repository path`);
  return repoPath;
};

const writeChoice = async (
  io: CliIo,
  stores: ProjectStores,
  name: string,
  project: string | undefined,
): Promise<string> => {
  if (project === undefined) {
    const [path = ''] = ruleLayerPaths('profile', {
      homeDir: io.homeDir,
    }).local;
    const content = jsonText({ ...(await readJsonLayer(path)), profile: name });
    await dispatchIntent(
      { stores, homeDir: io.homeDir },
      'rules.write',
      parseIntent('rules.write', {
        scope: 'machine',
        name: 'profile',
        content,
      }),
    );
    return path;
  }
  const repoDir = await projectRepoPath(stores, project);
  const path =
    ruleLayerPaths('profile', { homeDir: io.homeDir, repoDir }).local.at(-1) ??
    '';
  const content = jsonText({ ...(await readJsonLayer(path)), profile: name });
  await dispatchIntent(
    { stores, homeDir: io.homeDir },
    'rules.write',
    parseIntent('rules.write', {
      scope: 'project',
      project,
      name: 'profile',
      content,
    }),
  );
  return path;
};

const useCommand = async (
  io: CliIo,
  name: string | undefined,
  project: string | undefined,
): Promise<number> => {
  if (name === undefined)
    throw new CliError(`profile use needs a name\n\n${PROFILE_USAGE}`);
  await locateProfile(name, { homeDir: io.homeDir });
  const stores = createProjectStores(quarterdeckHome(io.homeDir));
  try {
    const path = await writeChoice(io, stores, name, project);
    io.out(`Wrote ${path}`);
    io.out(`Profile ${name} is active for ${project ?? 'this machine'}.`);
    return 0;
  } finally {
    await stores.closeAll();
  }
};

const setupCommand = async (
  io: CliIo,
  repo: string | undefined,
  yes: boolean,
): Promise<number> => {
  const repoPath = resolve(io.cwd, repo ?? '.');
  const done = await setUpProfile(io, repoPath, { yes });
  if (done === 0) io.out('Nothing to set up for the active profile.');
  return 0;
};

export const runProfile: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      standards: { type: 'string', multiple: true },
      philosophy: { type: 'string' },
      description: { type: 'string' },
      levels: { type: 'string' },
      reviewer: { type: 'string' },
      lifecycle: { type: 'string' },
      force: { type: 'boolean' },
      project: { type: 'string' },
      yes: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, target, ...extra] = positionals;
  if (values.help || command === undefined) {
    io.out(PROFILE_USAGE);
    return 0;
  }
  if (extra.length > 0)
    throw new CliError(`profile ${command} takes one argument`);
  if (command === 'list') return listCommand(io);
  if (command === 'add') return addCommand(io, target, values);
  if (command === 'use') return useCommand(io, target, values.project);
  if (command === 'setup') return setupCommand(io, target, values.yes ?? false);
  throw new CliError(`Unknown profile command ${command}\n\n${PROFILE_USAGE}`);
};
