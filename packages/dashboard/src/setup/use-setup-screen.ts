import type { IntentClient, RulesReader } from '../api/index.js';
import { filesWritten } from './profile-step.js';
import { progressLine, stepMarks, type StepMark } from './setup-model.js';
import { useProfileStep, type ProfileStepView } from './use-profile-step.js';
import { useRuntimeStep, type RuntimeStepView } from './use-runtime-step.js';
import { useSetupSave, type SetupSaveView } from './use-setup-save.js';
import { useSignInStep, type SignInStepView } from './use-sign-in-step.js';
import {
  useWorkspaceStep,
  type WorkspaceStepView,
} from './use-workspace-step.js';

export interface SetupSources {
  intents: IntentClient;
  rules: RulesReader;
}

export interface SetupScreenView {
  progress: string;
  steps: StepMark[];
  workspace: WorkspaceStepView;
  runtime: RuntimeStepView;
  profile: ProfileStepView;
  signIn: SignInStepView;
  go: SetupSaveView;
  writes: string[];
  showsSignedOutNote: boolean;
}

export const useSetupScreen = (
  { intents, rules }: SetupSources,
  onDone: () => void,
): SetupScreenView => {
  const workspace = useWorkspaceStep(intents);
  const runtime = useRuntimeStep(intents, workspace.root);
  const profile = useProfileStep(rules);
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
      profile: profile.changed,
      skip: workspace.skip,
      isReady: workspace.isDone,
    },
    onDone,
  );
  const done = {
    workspace: workspace.isDone,
    runtime: runtime.runtime !== null,
    profile: profile.isLoaded,
    'sign-in': signIn.isDone,
    go: false,
  };
  return {
    progress: progressLine(done),
    steps: stepMarks(done),
    workspace,
    runtime,
    profile,
    signIn,
    go,
    writes: filesWritten(profile.view, profile.changed),
    showsSignedOutNote: go.canGo && !signIn.isDone,
  };
};
