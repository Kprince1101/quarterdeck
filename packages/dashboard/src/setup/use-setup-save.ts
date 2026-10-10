import type { IntentClient } from '../api/index.js';
import { useIntentRequest } from '../widgets/use-intent-request.js';
import type { SetupRuntime } from './setup-model.js';

export interface SetupPlanInput {
  root: string | null;
  runtime: SetupRuntime | null;
  profile: string | undefined;
  skip: readonly string[];
  isReady: boolean;
}

const profileInput = (profile: string | undefined): { profile?: string } => {
  if (profile === undefined) return {};
  return { profile };
};

export interface SetupSaveView {
  canGo: boolean;
  isPending: boolean;
  error: string | null;
  handleGo: () => void;
}

export const useSetupSave = (
  intents: IntentClient,
  plan: SetupPlanInput,
  onDone: () => void,
): SetupSaveView => {
  const { isPending, error, run } = useIntentRequest();
  const { root, runtime, profile, skip } = plan;

  const save = async () => {
    if (root === null || runtime === null) return;
    await intents.setup.save({
      root,
      runtime,
      ...profileInput(profile),
      skip: [...skip],
    });
    onDone();
  };

  return {
    canGo: plan.isReady && root !== null && runtime !== null && !isPending,
    isPending,
    error,
    handleGo: () => {
      void run(save);
    },
  };
};
