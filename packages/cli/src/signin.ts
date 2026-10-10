import type { Runtime } from '@quarterdeck/rules';
import {
  GEMINI_COMMAND,
  KIRO_COMMAND,
  openInBrowser,
  runSignIn,
  signInToolName,
  type SignInOutcome,
  type SignInProgress,
  type SignInTool,
} from '@quarterdeck/server';
import type { CliIo } from './io.js';

export type SignInRunner = (
  tool: SignInTool,
  io: CliIo,
) => Promise<SignInOutcome>;

export interface SignInCheck {
  name: string;
  fixes: ReadonlyArray<{ label: string }>;
}

const RUNTIME_CHECKS: Readonly<Record<string, Runtime>> = {
  [KIRO_COMMAND]: 'kiro',
  claude: 'claude',
  [GEMINI_COMMAND]: 'gemini',
};

const GLAB_CHECK = /^glab on (\S+)$/;

const SIGN_IN_LABEL = 'Sign in';

const toolOfName = (name: string): SignInTool | undefined => {
  const runtime = RUNTIME_CHECKS[name];
  if (runtime !== undefined) return { kind: 'runtime', runtime };
  if (name === 'gh') return { kind: 'gh' };
  const host = GLAB_CHECK.exec(name)?.[1];
  if (host !== undefined) return { kind: 'glab', host };
  return undefined;
};

export const signInToolOf = (check: SignInCheck): SignInTool | undefined => {
  const [fix, ...rest] = check.fixes;
  if (fix?.label !== SIGN_IN_LABEL || rest.length > 0) return undefined;
  return toolOfName(check.name);
};

export const terminalProgress = (
  io: CliIo,
  tool: SignInTool,
): ((progress: SignInProgress) => void) => {
  const name = signInToolName(tool);
  const shown = { url: '', code: '' };
  return (progress) => {
    if (progress.status === 'starting') {
      io.out(`Signing in to ${name} with its own browser sign-in...`);
    }
    if (progress.code && progress.code !== shown.code) {
      shown.code = progress.code;
      io.out(`  Code: ${progress.code}`);
    }
    if (progress.url && progress.url !== shown.url) {
      shown.url = progress.url;
      io.out(`  Open: ${progress.url}`);
    }
    if (progress.status === 'signed_in') io.out(`  Signed in to ${name}.`);
    if (progress.status === 'failed') {
      io.out(
        `  Sign-in to ${name} failed: ${progress.message ?? 'unknown error'}`,
      );
    }
  };
};

export const terminalSignIn: SignInRunner = (tool, io) =>
  runSignIn(tool, {
    tty: true,
    env: io.env,
    onProgress: terminalProgress(io, tool),
    openUrl: (url) => openInBrowser(url),
  });

export type SignInAttempts = Map<string, SignInOutcome>;

export const signInWhereNeeded = async (
  checks: readonly SignInCheck[],
  io: CliIo,
  wanted: (tool: SignInTool) => boolean = () => true,
): Promise<SignInAttempts> => {
  const attempts: SignInAttempts = new Map();
  if (io.signIn === undefined) return attempts;
  for (const check of checks) {
    const tool = signInToolOf(check);
    if (tool === undefined || !wanted(tool)) continue;
    attempts.set(check.name, await io.signIn(tool, io));
  }
  return attempts;
};

export const signInFailure = (
  outcome: SignInOutcome | undefined,
): string | undefined => {
  if (outcome === undefined) return undefined;
  if (!outcome.ok) return `automatic sign-in failed: ${outcome.reason}`;
  return `signed in through ${outcome.via}, but the check still fails`;
};

export interface EnsureSignedInOptions {
  checks: () => Promise<readonly SignInCheck[]>;
  wanted: (tool: SignInTool) => boolean;
}

export const ensureSignedIn = async (
  io: CliIo,
  { checks, wanted }: EnsureSignedInOptions,
): Promise<void> => {
  if (io.signIn === undefined) return;
  const attempts = await signInWhereNeeded(await checks(), io, wanted);
  if (attempts.size === 0) return;
  for (const check of await checks()) {
    const why = signInFailure(attempts.get(check.name));
    if (why === undefined || check.fixes.length === 0) continue;
    io.out(
      `${check.name} is still not signed in (${why}). The dashboard asks again when an agent needs it.`,
    );
  }
};
