import { openInBrowser } from '../acp/auth/open-url.js';
import {
  runSignIn,
  signInToolName,
  type SignInTool,
} from '../acp/auth/tools.js';
import type {
  SignInOutcome,
  SignInProgress,
  SignInRunOptions,
} from '../acp/auth/types.js';
import type { SetupSignIn } from '../intents/index.js';
import { getErrorMessage } from '../lib/errors.js';

export type SetupSignInRunner = (
  tool: SignInTool,
  options: SignInRunOptions,
) => Promise<SignInOutcome>;

export interface SetupSignInsOptions {
  run?: SetupSignInRunner | undefined;
  openUrl?: ((url: string) => Promise<void>) | undefined;
}

export interface SetupSignIns {
  start: (tool: SignInTool) => SetupSignIn;
  read: () => SetupSignIn[];
  settled: (tool: SignInTool) => Promise<void>;
  close: () => void;
}

interface Running {
  view: SetupSignIn;
  stop: AbortController;
  done: Promise<void>;
}

export const signInKey = (tool: SignInTool): string => {
  if (tool.kind === 'runtime') return `runtime:${tool.runtime}`;
  if (tool.kind === 'glab') return `glab:${tool.host}`;
  return tool.kind;
};

export const isSignInRunning = (
  progress: Pick<SignInProgress, 'status'>,
): boolean => progress.status === 'starting' || progress.status === 'waiting';

const settledProgress = (
  last: SignInProgress,
  outcome: SignInOutcome,
): SignInProgress => {
  if (outcome.ok) return { status: 'signed_in' };
  return { ...last, status: 'failed', message: outcome.reason };
};

export const createSetupSignIns = ({
  run = runSignIn,
  openUrl = openInBrowser,
}: SetupSignInsOptions = {}): SetupSignIns => {
  const entries = new Map<string, Running>();

  const begin = (tool: SignInTool, key: string): Running => {
    const stop = new AbortController();
    let last: SignInProgress = { status: 'starting' };
    const view: SetupSignIn = {
      key,
      tool,
      name: signInToolName(tool),
      progress: last,
    };
    const progress = (next: SignInProgress) => {
      last = next;
      view.progress = next;
    };
    const done = run(tool, {
      tty: false,
      signal: stop.signal,
      onProgress: progress,
      openUrl,
    }).then(
      (outcome) => progress(settledProgress(last, outcome)),
      (err: unknown) =>
        progress({ status: 'failed', message: getErrorMessage(err) }),
    );
    return { view, stop, done };
  };

  const start = (tool: SignInTool): SetupSignIn => {
    const key = signInKey(tool);
    const current = entries.get(key);
    if (current !== undefined && isSignInRunning(current.view.progress)) {
      return { ...current.view };
    }
    const running = begin(tool, key);
    entries.set(key, running);
    return { ...running.view };
  };

  return {
    start,
    read: () => [...entries.values()].map(({ view }) => ({ ...view })),
    settled: async (tool) => {
      await entries.get(signInKey(tool))?.done;
    },
    close: () => {
      for (const { stop } of entries.values()) stop.abort();
    },
  };
};
