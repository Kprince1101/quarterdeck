import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  STEERING_FILE,
  activeProfile,
  effectiveLevels,
  readProfileManifest,
  renderSteeringBlock,
  writeSteeringBlock,
  type ProfileManifest,
  type RuleLevels,
} from '@quarterdeck/rules';
import { QUARTERDECK_COMMAND } from '@quarterdeck/server';
import { CliError, type CliIo, type CommandRunner } from './io.js';
import { jsonText } from './json-layer.js';
import { confirm } from './prompt.js';

export interface SetupOptions {
  yes: boolean;
}

interface SetupStep {
  says: string;
  run: () => Promise<void>;
}

interface SetupPlan {
  repoPath: string;
  profile: string;
  manifest: ProfileManifest;
  levels: RuleLevels;
  run: CommandRunner;
}

export const spawnCommand: CommandRunner = (command, cwd) =>
  new Promise((resolvePromise, reject) => {
    const [file, ...args] = command;
    if (file === undefined) {
      reject(new CliError('The profile names an empty command'));
      return;
    }
    const child = spawn(file, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new CliError(`${command.join(' ')} exited with ${code}`));
    });
  });

const writeRepoFile = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
};

const commandStep = (
  plan: SetupPlan,
  command: readonly string[],
  what: string,
): SetupStep => ({
  says: `runs \`${command.join(' ')}\` in ${plan.repoPath}${what}`,
  run: () => plan.run(command, plan.repoPath),
});

const installSteps = (plan: SetupPlan): SetupStep[] => {
  const install = plan.manifest.setup?.install;
  if (install === undefined) return [];
  return [commandStep(plan, install, '')];
};

const levelsSteps = (plan: SetupPlan): SetupStep[] => {
  const file = plan.manifest.setup?.levelsFile;
  if (file === undefined) return [];
  const path = resolve(plan.repoPath, file);
  return [
    {
      says: `writes the rule levels to ${path}`,
      run: () => writeRepoFile(path, jsonText({ rules: plan.levels })),
    },
  ];
};

const steeringSteps = (plan: SetupPlan): SetupStep[] => {
  const steer = plan.manifest.setup?.steer;
  const file = plan.manifest.steering?.file ?? STEERING_FILE;
  const path = resolve(plan.repoPath, file);
  if (steer !== undefined)
    return [
      commandStep(
        plan,
        steer,
        `, which writes the steering block into ${path}`,
      ),
    ];
  const block = renderSteeringBlock(plan.profile, plan.levels);
  if (block === '') return [];
  return [
    {
      says: `writes the steering block into ${path}`,
      run: async () => {
        const current = await readFile(path, 'utf8').catch(() => '');
        await writeRepoFile(path, writeSteeringBlock(current, block));
      },
    },
  ];
};

const setupSteps = (plan: SetupPlan): SetupStep[] => {
  if (plan.manifest.setup === undefined) return [];
  return [...installSteps(plan), ...levelsSteps(plan), ...steeringSteps(plan)];
};

const agreed = async (io: CliIo, options: SetupOptions): Promise<boolean> => {
  if (options.yes) return true;
  if (!io.prompter) return false;
  return confirm(io.prompter, 'Set up the repository now? [y/N] ');
};

export const setUpProfile = async (
  io: CliIo,
  repoPath: string,
  options: SetupOptions,
): Promise<number> => {
  const profile = await activeProfile({
    homeDir: io.homeDir,
    repoDir: repoPath,
  });
  const manifest = await readProfileManifest(profile);
  const steps = setupSteps({
    repoPath,
    profile: profile.name,
    manifest,
    levels: effectiveLevels(manifest, profile),
    run: io.run ?? spawnCommand,
  });
  if (steps.length === 0) return 0;
  io.out(`Rules profile ${profile.name} sets up the repository. It:`);
  for (const step of steps) io.out(`- ${step.says}`);
  if (!(await agreed(io, options))) {
    io.out(
      `Skipped. Run it later with ${QUARTERDECK_COMMAND} profile setup ${repoPath}`,
    );
    return 0;
  }
  for (const step of steps) {
    await step.run();
    io.out(`Done: ${step.says}`);
  }
  return steps.length;
};
