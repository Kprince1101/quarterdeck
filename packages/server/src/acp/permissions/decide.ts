import { isAbsolute } from 'node:path';
import type {
  Decision,
  PermissionLayers,
  PermissionRule,
  ToolKind,
} from '@quarterdeck/rules';
import { matchesGlob, type GlobMode } from './glob.js';
import { isInsideRepo, pathSubject } from './paths.js';
import { commandSegments, isPinnedCommand } from './shell.js';
import type { ToolRequest } from './tool-request.js';

export interface PolicyLayer {
  default?: Decision | undefined;
  rules?: readonly PermissionRule[] | undefined;
}

interface PatternRule extends PermissionRule {
  pattern: string;
}

interface Subjects {
  mode: GlobMode;
  values: string[];
}

const DECISION_RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

const REPO_PINNED_KINDS: ReadonlySet<ToolKind> = new Set([
  'read',
  'search',
  'edit',
  'delete',
  'move',
]);

const OUTSIDE_BY_PATTERN_KINDS: ReadonlySet<ToolKind> = new Set([
  'read',
  'search',
]);

const CWD_TARGET_KINDS: ReadonlySet<ToolKind> = new Set(['search']);

const SHELL_GUARD_KINDS: ReadonlySet<ToolKind> = new Set([
  'read',
  'edit',
  'delete',
  'move',
]);

export const stricter = (left: Decision, right: Decision): Decision => {
  if (DECISION_RANK[right] > DECISION_RANK[left]) return right;
  return left;
};

export const strictest = (
  decisions: readonly Decision[],
): Decision | undefined => {
  const [first, ...rest] = decisions;
  if (first === undefined) return undefined;
  return rest.reduce(stricter, first);
};

const decisionsOf = (rules: readonly PermissionRule[]): Decision[] =>
  rules.map((rule) => rule.decision);

const hasPattern = (rule: PermissionRule): rule is PatternRule =>
  rule.pattern !== undefined;

export const targetPaths = (request: ToolRequest): string[] => {
  if (request.paths.length > 0) return request.paths;
  if (CWD_TARGET_KINDS.has(request.kind)) return [request.cwd];
  return [];
};

const optionalValues = (value: string | undefined): string[] => {
  if (value === undefined) return [];
  return [value];
};

export const requestSubjects = (
  request: ToolRequest,
  repoDir: string,
): Subjects => {
  if (request.kind === 'execute') {
    return {
      mode: 'command',
      values: commandSegments(request.command ?? ''),
    };
  }
  if (request.kind === 'fetch') {
    return { mode: 'path', values: optionalValues(request.url) };
  }
  return {
    mode: 'path',
    values: targetPaths(request).map((path) => pathSubject(repoDir, path)),
  };
};

const shellGuardDecisions = (
  layer: PolicyLayer,
  subjects: readonly string[],
): Decision[] =>
  decisionsOf(
    (layer.rules ?? [])
      .filter(hasPattern)
      .filter(
        (rule) =>
          SHELL_GUARD_KINDS.has(rule.kind) &&
          rule.decision !== 'allow' &&
          subjects.some((subject) =>
            matchesGlob(rule.pattern, subject, 'path'),
          ),
      ),
  );

export const shellPathGuard = (
  layers: PermissionLayers,
  request: ToolRequest,
  repoDir: string,
): Decision => {
  const subjects = (request.argPaths ?? []).map((path) =>
    pathSubject(repoDir, path),
  );
  return (
    strictest([
      ...shellGuardDecisions(layers.machine, subjects),
      ...shellGuardDecisions(layers.repo ?? {}, subjects),
    ]) ?? 'allow'
  );
};

export const decideLayer = (
  layer: PolicyLayer,
  kind: ToolKind,
  subjects: Subjects,
  fallback: Decision,
): Decision => {
  const kindRules = (layer.rules ?? []).filter((rule) => rule.kind === kind);
  const patterned = kindRules.filter(hasPattern);
  const general =
    strictest(decisionsOf(kindRules.filter((rule) => !hasPattern(rule)))) ??
    layer.default ??
    fallback;
  if (subjects.values.length === 0) {
    const guarded = patterned.some((rule) => rule.decision !== 'allow');
    if (guarded) return stricter(general, 'ask');
    return general;
  }
  const perSubject = subjects.values.map((subject) => {
    const matched = patterned.filter((rule) =>
      matchesGlob(rule.pattern, subject, subjects.mode),
    );
    return strictest(decisionsOf(matched)) ?? general;
  });
  return strictest(perSubject) ?? general;
};

const isNamedOutsideRepo = (
  machine: PolicyLayer,
  kind: ToolKind,
  subject: string,
): boolean => {
  if (!OUTSIDE_BY_PATTERN_KINDS.has(kind)) return false;
  return (machine.rules ?? []).some(
    (rule) =>
      rule.kind === kind &&
      rule.decision === 'allow' &&
      rule.pattern !== undefined &&
      isAbsolute(rule.pattern) &&
      matchesGlob(rule.pattern, subject, 'path'),
  );
};

export const isPinnedToRepo = (
  request: ToolRequest,
  repoDir: string,
  machine: PolicyLayer = {},
): boolean => {
  if (request.kind === 'execute') {
    if (request.command === undefined) return false;
    return isPinnedCommand(repoDir, {
      cwd: request.cwd,
      command: request.command,
      argPaths: request.argPaths,
    });
  }
  if (!REPO_PINNED_KINDS.has(request.kind)) return true;
  const paths = targetPaths(request);
  if (paths.length === 0) return false;
  return paths.every(
    (path) =>
      isInsideRepo(repoDir, path) ||
      isNamedOutsideRepo(machine, request.kind, pathSubject(repoDir, path)),
  );
};

const shellGuardFor = (
  layers: PermissionLayers,
  request: ToolRequest,
  repoDir: string,
): Decision => {
  if (request.kind !== 'execute') return 'allow';
  return shellPathGuard(layers, request, repoDir);
};

const decideAs = (
  layers: PermissionLayers,
  request: ToolRequest,
  repoDir: string,
): Decision => {
  const subjects = requestSubjects(request, repoDir);
  const machine = decideLayer(
    layers.machine,
    request.kind,
    subjects,
    layers.machine.default,
  );
  const repo = decideLayer(layers.repo ?? {}, request.kind, subjects, 'allow');
  const layered = stricter(
    stricter(machine, repo),
    shellGuardFor(layers, request, repoDir),
  );
  if (layered !== 'allow') return layered;
  if (isPinnedToRepo(request, repoDir, layers.machine)) return 'allow';
  return 'ask';
};

export const decidePermission = (
  layers: PermissionLayers,
  request: ToolRequest,
  repoDir: string,
): Decision => {
  const declared = decideAs(layers, request, repoDir);
  if (request.command === undefined || request.kind === 'execute') {
    return declared;
  }
  const asShell = decideAs(layers, { ...request, kind: 'execute' }, repoDir);
  return stricter(declared, asShell);
};
