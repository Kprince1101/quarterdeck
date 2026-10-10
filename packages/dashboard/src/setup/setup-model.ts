import type {
  SetupDetectResult,
  SetupSignIn,
  SetupSignInTool,
  SetupTool,
  SetupToolsResult,
} from '@quarterdeck/server/intents';

export type SetupRuntime = NonNullable<SetupToolsResult['defaultRuntime']>;

export type SetupStepId = 'workspace' | 'runtime' | 'sign-in' | 'go';

export interface SetupStep {
  id: SetupStepId;
  label: string;
}

export const SETUP_STEPS: readonly SetupStep[] = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'sign-in', label: 'Sign in' },
  { id: 'go', label: 'Go' },
];

export type SetupDone = Readonly<Record<SetupStepId, boolean>>;

export const progressLine = (done: SetupDone): string => {
  const index = SETUP_STEPS.findIndex(({ id }) => !done[id]);
  const at = SETUP_STEPS[index];
  if (at === undefined) return 'All set';
  return `Step ${index + 1} of ${SETUP_STEPS.length}: ${at.label}`;
};

export interface StepMark {
  id: SetupStepId;
  label: string;
  isDone: boolean;
}

export const stepMarks = (done: SetupDone): StepMark[] =>
  SETUP_STEPS.map(({ id, label }) => ({ id, label, isDone: done[id] }));

export interface RepositoryRow {
  slug: string;
  name: string;
  repoPath: string;
  origin: string;
  isKept: boolean;
}

export const repositoryRows = (
  detection: SetupDetectResult | null,
  skipped: ReadonlySet<string>,
): RepositoryRow[] =>
  (detection?.repositories ?? []).map((repo) => ({
    slug: repo.slug,
    name: repo.name,
    repoPath: repo.repoPath,
    origin: repo.repository ?? 'no origin',
    isKept: !skipped.has(repo.slug),
  }));

const repositoryCount = (count: number): string => {
  if (count === 1) return '1 repository';
  return `${count} repositories`;
};

export const detectionSummary = (
  detection: SetupDetectResult | null,
): string | null => {
  if (detection === null) return null;
  const [only] = detection.repositories;
  if (detection.mode === 'single' && only !== undefined) {
    return `One repository: ${only.name}. Quarterdeck works on it alone.`;
  }
  return `${repositoryCount(detection.repositories.length)} in ${detection.root}, each one a project. Untick any to leave out.`;
};

export const keptCount = (rows: readonly RepositoryRow[]): number =>
  rows.filter(({ isKept }) => isKept).length;

export interface RuntimeOption {
  runtime: SetupRuntime;
  name: string;
  state: string;
}

export interface MissingRuntime {
  name: string;
  hint: string | null;
}

const runtimeOf = (tool: SetupSignInTool): SetupRuntime | null => {
  if (tool.kind !== 'runtime') return null;
  return tool.runtime;
};

export const runtimeOptions = (
  tools: SetupToolsResult | null,
): RuntimeOption[] =>
  (tools?.runtimes ?? []).flatMap(({ tool, name, state, installed }) => {
    const runtime = runtimeOf(tool);
    if (!installed || runtime === null) return [];
    return [{ runtime, name, state }];
  });

export const missingRuntimes = (
  tools: SetupToolsResult | null,
): MissingRuntime[] =>
  (tools?.runtimes ?? [])
    .filter(({ installed }) => !installed)
    .map(({ name, hint }) => ({ name, hint }));

export const signInKey = (tool: SetupSignInTool): string => {
  if (tool.kind === 'runtime') return `runtime:${tool.runtime}`;
  if (tool.kind === 'glab') return `glab:${tool.host}`;
  return tool.kind;
};

export const chosenTools = (
  tools: SetupToolsResult | null,
  runtime: SetupRuntime | null,
): SetupTool[] => {
  if (tools === null || runtime === null) return [];
  const chosen = tools.runtimes.filter(
    ({ tool }) => runtimeOf(tool) === runtime,
  );
  return [...chosen, ...tools.forges];
};

export const isSignInRunning = (signIn: SetupSignIn | undefined): boolean =>
  signIn?.progress.status === 'starting' ||
  signIn?.progress.status === 'waiting';

export const signInsByKey = (
  signIns: readonly SetupSignIn[],
): ReadonlyMap<string, SetupSignIn> =>
  new Map(signIns.map((signIn) => [signIn.key, signIn]));

export const settledKeys = (
  before: readonly SetupSignIn[],
  after: readonly SetupSignIn[],
): string[] => {
  const was = signInsByKey(before);
  return after
    .filter((signIn) => isSignInRunning(was.get(signIn.key)))
    .filter((signIn) => !isSignInRunning(signIn))
    .map(({ key }) => key);
};
