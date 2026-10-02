import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../src/index.js';

export interface TestIo extends CliIo {
  lines: string[];
  errors: string[];
  questions: string[];
  stop: () => void;
}

export const testIo = (homeDir: string, answers?: string[]): TestIo => {
  const lines: string[] = [];
  const errors: string[] = [];
  const questions: string[] = [];
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const queue = answers && [...answers];
  const prompter = queue && {
    ask: (question: string) => {
      questions.push(question);
      const answer = queue.shift();
      if (answer === undefined) {
        return Promise.reject(new Error(`unexpected question: ${question}`));
      }
      return Promise.resolve(answer);
    },
  };
  return {
    lines,
    errors,
    questions,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    homeDir,
    cwd: homeDir,
    prompter: prompter || undefined,
    untilStopped: () => stopped,
    stop: () => stop(),
  };
};

export interface Sandbox {
  home: string;
  repo: string;
  close: () => Promise<void>;
}

export const sandbox = async (repoName = 'Deck Repo'): Promise<Sandbox> => {
  const root = await mkdtemp(join(tmpdir(), 'qd-cli-'));
  const home = join(root, 'home');
  const repo = join(root, repoName);
  await mkdir(home);
  await mkdir(join(repo, '.git'), { recursive: true });
  return {
    home,
    repo,
    close: () => rm(root, { recursive: true, force: true }),
  };
};

export const entries = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).toSorted();
