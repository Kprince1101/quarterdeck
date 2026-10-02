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

const REPO_WRITE_KINDS: ReadonlySet<ToolKind> = new Set([
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
    values: request.paths.map((path) => pathSubject(repoDir, path)),
  };
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

export const isPinnedToRepo = (
  request: ToolRequest,
  repoDir: string,
): boolean => {
  if (request.kind === 'execute') {
    if (request.command === undefined) return false;
    return isPinnedCommand(repoDir, request.cwd, request.command);
  }
  if (!REPO_WRITE_KINDS.has(request.kind)) return true;
  if (request.paths.length === 0) return false;
  return request.paths.every((path) => isInsideRepo(repoDir, path));
};

export const decidePermission = (
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
  const layered = stricter(machine, repo);
  if (layered === 'allow' && !isPinnedToRepo(request, repoDir)) return 'ask';
  return layered;
};
