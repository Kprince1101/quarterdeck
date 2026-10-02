import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  RulesError,
  loadRule,
  ruleLayerPaths,
  type LoadRulesOptions,
  type RuleName,
} from '@quarterdeck/rules';
import { hasErrorCode } from '../lib/errors.js';
import { pathExists } from '../lib/fs.js';
import type { StagedWork } from './context.js';
import { badRequest } from './http-error.js';

export interface RuleLayerTarget {
  name: RuleName;
  homeDir: string;
  repoDir?: string;
}

const layerOptions = (
  target: RuleLayerTarget,
  layerDir: string,
): LoadRulesOptions => {
  if (target.repoDir === undefined) return { homeDir: layerDir };
  return { homeDir: target.homeDir, repoDir: layerDir };
};

const topLayerPath = (name: RuleName, options: LoadRulesOptions): string => {
  const path = ruleLayerPaths(name, options).local.at(-1);
  if (path === undefined) throw new Error(`No local layer for rule ${name}`);
  return path;
};

export const ruleLayerPath = (target: RuleLayerTarget): string =>
  topLayerPath(
    target.name,
    layerOptions(target, target.repoDir ?? target.homeDir),
  );

const writeAtomically = async (path: string, content: string) => {
  await mkdir(dirname(path), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, content);
  await rename(staged, path);
};

const relabel = (err: RulesError, stagedPath: string, realPath: string) => {
  if (err.path !== stagedPath) return err.message;
  return `${realPath}${err.message.slice(stagedPath.length)}`;
};

const validateLayer = async (target: RuleLayerTarget, content: string) => {
  const stagingDir = await mkdtemp(join(tmpdir(), 'quarterdeck-rules-'));
  const options = layerOptions(target, stagingDir);
  const stagedPath = topLayerPath(target.name, options);
  try {
    await writeAtomically(stagedPath, content);
    await loadRule(target.name, options);
  } catch (err) {
    if (err instanceof RulesError) {
      throw badRequest(relabel(err, stagedPath, ruleLayerPath(target)));
    }
    throw err;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
};

const unlinkIfPresent = async (path: string) => {
  try {
    await unlink(path);
  } catch (err) {
    if (!hasErrorCode(err, 'ENOENT')) throw err;
  }
};

export const stageRuleWrite = async (
  target: RuleLayerTarget,
  content: string,
): Promise<StagedWork> => {
  await validateLayer(target, content);
  const path = ruleLayerPath(target);
  return {
    result: { path },
    afterCommit: () => writeAtomically(path, content),
  };
};

export const stageRuleRemoval = async (
  target: RuleLayerTarget,
): Promise<StagedWork> => {
  const path = ruleLayerPath(target);
  return {
    result: { path, removed: await pathExists(path) },
    afterCommit: () => unlinkIfPresent(path),
  };
};
