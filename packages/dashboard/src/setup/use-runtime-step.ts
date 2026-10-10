import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import {
  setupToolsResultSchema,
  type SetupToolsResult,
} from '@quarterdeck/server/intents';
import type { IntentClient } from '../api/index.js';
import { getErrorMessage } from '../lib/errors.js';
import {
  missingRuntimes,
  runtimeOptions,
  type MissingRuntime,
  type RuntimeOption,
  type SetupRuntime,
} from './setup-model.js';

export interface RuntimeChoice extends RuntimeOption {
  isChecked: boolean;
}

export interface RuntimeStepView {
  tools: SetupToolsResult | null;
  options: RuntimeChoice[];
  missing: MissingRuntime[];
  runtime: SetupRuntime | null;
  hasNone: boolean;
  isLoading: boolean;
  error: string | null;
  handleRuntimeChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleRefresh: () => void;
}

interface Loaded {
  tools: SetupToolsResult | null;
  error: string | null;
  isLoading: boolean;
}

const LOADING: Loaded = { tools: null, error: null, isLoading: true };

const toolsInput = (root: string | null): { root?: string } => {
  if (root === null) return {};
  return { root };
};

const isOffered = (
  options: readonly RuntimeOption[],
  runtime: string | null | undefined,
): runtime is SetupRuntime =>
  options.some((option) => option.runtime === runtime);

const pickedRuntime = (
  options: readonly RuntimeOption[],
  picked: string | null,
  fallback: SetupRuntime | null | undefined,
): SetupRuntime | null => {
  if (isOffered(options, picked)) return picked;
  if (isOffered(options, fallback)) return fallback;
  return null;
};

export const useRuntimeStep = (
  intents: IntentClient,
  root: string | null,
): RuntimeStepView => {
  const [loaded, setLoaded] = useState<Loaded>(LOADING);
  const [picked, setPicked] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    setLoaded((last) => ({ ...last, isLoading: true }));
    intents.setup
      .tools(toolsInput(root))
      .then((reply) => setupToolsResultSchema.parse(reply.result))
      .then(
        (tools) => {
          if (live) setLoaded({ tools, error: null, isLoading: false });
        },
        (err: unknown) => {
          if (live) {
            setLoaded((last) => ({
              ...last,
              error: getErrorMessage(err),
              isLoading: false,
            }));
          }
        },
      );
    return () => {
      live = false;
    };
  }, [intents, root, version]);

  const handleRefresh = useCallback(() => setVersion((last) => last + 1), []);
  const options = runtimeOptions(loaded.tools);
  const runtime = pickedRuntime(options, picked, loaded.tools?.defaultRuntime);
  return {
    tools: loaded.tools,
    options: options.map((option) => ({
      ...option,
      isChecked: option.runtime === runtime,
    })),
    missing: missingRuntimes(loaded.tools),
    runtime,
    hasNone: loaded.tools !== null && options.length === 0,
    isLoading: loaded.isLoading,
    error: loaded.error,
    handleRuntimeChange: (event) => setPicked(event.target.value),
    handleRefresh,
  };
};
