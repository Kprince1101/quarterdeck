import type { SignInProgress, SignInRunOptions } from './types.js';

const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;
const LABELLED_CODE = /\bcode\b[^A-Za-z0-9]*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)/i;
const BARE_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

export interface SignInPrompt {
  url?: string;
  code?: string;
}

export const readSignInPrompt = (line: string): SignInPrompt => {
  const prompt: SignInPrompt = {};
  const url = URL_PATTERN.exec(line)?.[0].replace(TRAILING_PUNCTUATION, '');
  if (url) prompt.url = url;
  const withoutUrl = line.replace(url ?? '', ' ');
  const code =
    LABELLED_CODE.exec(withoutUrl)?.[1] ?? BARE_CODE.exec(withoutUrl)?.[1];
  if (code) prompt.code = code;
  return prompt;
};

export interface PromptTracker {
  line: (line: string) => void;
  report: (progress: SignInProgress) => void;
  current: () => SignInProgress;
}

const sameProgress = (a: SignInProgress, b: SignInProgress): boolean =>
  a.status === b.status &&
  a.url === b.url &&
  a.code === b.code &&
  a.message === b.message;

export const trackSignInPrompt = (
  options: Pick<SignInRunOptions, 'onProgress' | 'openUrl'>,
): PromptTracker => {
  let state: SignInProgress = { status: 'starting' };
  options.onProgress?.(state);
  const report = (next: SignInProgress) => {
    if (sameProgress(state, next)) return;
    state = next;
    options.onProgress?.(state);
  };
  const line = (text: string) => {
    const prompt = readSignInPrompt(text);
    if (!prompt.url && !prompt.code) return;
    const url = state.url ?? prompt.url;
    if (url && !state.url) {
      options.openUrl?.(url).catch(() => undefined);
    }
    const next: SignInProgress = { ...state, status: 'waiting' };
    if (url) next.url = url;
    const code = state.code ?? prompt.code;
    if (code) next.code = code;
    report(next);
  };
  return { line, report, current: () => state };
};
