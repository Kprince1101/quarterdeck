import { useEffect, useRef, useState } from 'react';
import {
  setupReadResultSchema,
  setupSignInSchema,
  type SetupSignIn,
  type SetupTool,
  type SetupToolsResult,
} from '@quarterdeck/server/intents';
import type { IntentClient } from '../api/index.js';
import { toSignInView, type SignInView } from '../widgets/cards/card-deck.js';
import { useIntentRequest } from '../widgets/use-intent-request.js';
import {
  chosenTools,
  isSignInRunning,
  settledKeys,
  signInKey,
  signInsByKey,
  type SetupRuntime,
} from './setup-model.js';

export const SIGN_IN_POLL_MS = 1000;

export interface SignInRow {
  key: string;
  name: string;
  state: string;
  hint: string | null;
  isSignedIn: boolean;
  canSignIn: boolean;
  progress: SignInView | null;
  handleSignIn: () => void;
}

export interface SignInStepView {
  rows: SignInRow[];
  hasRows: boolean;
  isDone: boolean;
  error: string | null;
}

const merged = (
  signIns: readonly SetupSignIn[],
  next: SetupSignIn,
): SetupSignIn[] => [...signIns.filter(({ key }) => key !== next.key), next];

const useSignInPoll = (
  intents: IntentClient,
  signIns: readonly SetupSignIn[],
  onRead: (next: SetupSignIn[]) => void,
): void => {
  const isRunning = signIns.some(isSignInRunning);
  const read = useRef(onRead);
  read.current = onRead;
  useEffect(() => {
    if (!isRunning) return undefined;
    const timer = setInterval(() => {
      intents.setup
        .read({})
        .then((reply) => setupReadResultSchema.parse(reply.result))
        .then(
          (result) => read.current(result.signIns),
          () => undefined,
        );
    }, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [intents, isRunning]);
};

export const useSignInStep = (
  intents: IntentClient,
  tools: SetupToolsResult | null,
  runtime: SetupRuntime | null,
  onSettled: () => void,
): SignInStepView => {
  const [signIns, setSignIns] = useState<SetupSignIn[]>([]);
  const { error, run } = useIntentRequest();

  useSignInPoll(intents, signIns, (next) => {
    const settled = settledKeys(signIns, next);
    setSignIns(next);
    if (settled.length > 0) onSettled();
  });

  const start = async (tool: SetupTool['tool']) => {
    const reply = await intents.setup.sign_in({ tool });
    const signIn = setupSignInSchema.parse(reply.result?.['signIn']);
    setSignIns((last) => merged(last, signIn));
  };

  const byKey = signInsByKey(signIns);
  const rows = chosenTools(tools, runtime).map((tool): SignInRow => {
    const key = signInKey(tool.tool);
    const signIn = byKey.get(key);
    return {
      key,
      name: tool.name,
      state: tool.state,
      hint: tool.hint,
      isSignedIn: tool.signedIn,
      canSignIn: tool.installed && !tool.signedIn && !isSignInRunning(signIn),
      progress: toSignInView(signIn?.progress),
      handleSignIn: () => {
        void run(() => start(tool.tool));
      },
    };
  });

  return {
    rows,
    hasRows: rows.length > 0,
    isDone: rows.length > 0 && rows.every(({ isSignedIn }) => isSignedIn),
    error,
  };
};
