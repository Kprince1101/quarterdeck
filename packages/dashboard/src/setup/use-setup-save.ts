import type { IntentClient } from '../api/index.js';
import { useIntentRequest } from '../widgets/use-intent-request.js';
import type { SetupRuntime } from './setup-model.js';

export interface SetupPlanInput {
  root: string | null;
  runtime: SetupRuntime | null;
  skip: readonly string[];
  isReady: boolean;
}

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
  const { root, runtime, skip } = plan;

  const save = async () => {
    if (root === null || runtime === null) return;
    await intents.setup.save({ root, runtime, skip: [...skip] });
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
