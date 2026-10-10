import type { RulesView, SteeringFileView } from '@quarterdeck/server/intents';
import {
  CHOSEN_BY_LABELS,
  findProfile,
  profileChoices,
  profileRule,
  type ProfileChoiceOption,
} from '../widgets/rules/profile-panel.js';

export const WORKSPACE_FILE = '~/.quarterdeck/workspace.json';

export interface ProfileSummary {
  active: string;
  chosenBy: string;
  choices: ProfileChoiceOption[];
  description: string;
  reads: string[];
  writesPath: string | null;
  steeringFiles: SteeringFileView[];
  error: string | null;
}

export const profileSummary = (
  view: RulesView,
  picked: string,
): ProfileSummary => {
  const { profiles } = view;
  const summary = findProfile(profiles, picked);
  return {
    active: profiles.active,
    chosenBy: CHOSEN_BY_LABELS[profiles.chosenBy],
    choices: profileChoices(profiles),
    description: summary?.error ?? summary?.description ?? '',
    reads: summary?.files ?? [],
    writesPath: profileRule(view.rules)?.machine.path ?? null,
    steeringFiles: profiles.steeringFiles,
    error: profiles.error,
  };
};

export const pickedProfile = (
  active: string,
  picked: string | null,
): string | undefined => {
  if (picked === null || picked === active) return undefined;
  return picked;
};

export const profileNote = (
  active: string,
  changed: string | undefined,
  writesPath: string | null,
): string => {
  if (changed === undefined) {
    return `Keeps ${active}, the profile this machine has now. Nothing is written for it.`;
  }
  return `Go writes "profile": "${changed}" to ${writesPath ?? 'rules.local.profile.json'}.`;
};

const machineRulePath = (
  view: RulesView | null,
  name: string,
  fallback: string,
): string =>
  view?.rules.find((rule) => rule.name === name)?.machine.path ?? fallback;

export const filesWritten = (
  view: RulesView | null,
  changedProfile: string | undefined,
): string[] => {
  const files = [
    `${WORKSPACE_FILE}, the folder and its repositories`,
    '~/.quarterdeck/<project>/, one folder per project for its data',
    `${machineRulePath(view, 'models', '~/.quarterdeck/rules.local.models.json')}, only if the runtime is not this machine's default`,
  ];
  if (changedProfile === undefined) return files;
  return [
    ...files,
    `${machineRulePath(view, 'profile', '~/.quarterdeck/rules.local.profile.json')}, for the ${changedProfile} profile`,
  ];
};
