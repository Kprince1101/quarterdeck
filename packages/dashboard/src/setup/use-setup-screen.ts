import type { IntentClient } from '../api/index.js';
import { progressLine, stepMarks, type StepMark } from './setup-model.js';
import { useRuntimeStep, type RuntimeStepView } from './use-runtime-step.js';
import { useSetupSave, type SetupSaveView } from './use-setup-save.js';
import { useSignInStep, type SignInStepView } from './use-sign-in-step.js';
import {
  useWorkspaceStep,
  type WorkspaceStepView,
} from './use-workspace-step.js';

export interface SetupScreenView {
  progress: string;
  steps: StepMark[];
  workspace: WorkspaceStepView;
  runtime: RuntimeStepView;
  signIn: SignInStepView;
  go: SetupSaveView;
  showsSignedOutNote: boolean;
}

export const useSetupScreen = (
  intents: IntentClient,
  onDone: () => void,
): SetupScreenView => {
  const workspace = useWorkspaceStep(intents);
  const runtime = useRuntimeStep(intents, workspace.root);
  const signIn = useSignInStep(
    intents,
    runtime.tools,
    runtime.runtime,
    runtime.handleRefresh,
  );
  const go = useSetupSave(
    intents,
    {
      root: workspace.root,
      runtime: runtime.runtime,
      skip: workspace.skip,
      isReady: workspace.isDone,
    },
    onDone,
  );
  const done = {
    workspace: workspace.isDone,
    runtime: runtime.runtime !== null,
    'sign-in': signIn.isDone,
    go: false,
  };
  return {
    progress: progressLine(done),
    steps: stepMarks(done),
    workspace,
    runtime,
    signIn,
    go,
    showsSignedOutNote: go.canGo && !signIn.isDone,
  };
};
