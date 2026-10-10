import type { ChangeEvent } from 'react';
import type { RulesView } from '../../api/index.js';
import { nameOf, valueOf } from '../../grid/dom.js';
import {
  CHOSEN_BY_LABELS,
  LEVEL_OPTIONS,
  findProfile,
  layerProfile,
  levelRows,
  profileChoices,
  profileRule,
  readLayer,
  withLevel,
  withProfile,
  type LevelOption,
  type LevelRow,
  type ProfileChoiceOption,
} from './profile-panel.js';
import type { RuleDrafts } from './use-rule-drafts.js';

export interface ProfilePanelView {
  showPanel: boolean;
  active: string;
  chosenBy: string;
  description: string;
  files: string[];
  choices: ProfileChoiceOption[];
  pickerValue: string;
  writesPath: string;
  levels: LevelRow[];
  levelOptions: readonly LevelOption[];
  hasLevels: boolean;
  error: string | null;
  handlePickProfile: (event: ChangeEvent<HTMLSelectElement>) => void;
  handleLevelChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}

interface ProfilePanelOptions {
  view: RulesView | null;
  drafts: RuleDrafts;
  onEdit: () => void;
}

const EMPTY: ProfilePanelView = {
  showPanel: false,
  active: '',
  chosenBy: '',
  description: '',
  files: [],
  choices: [],
  pickerValue: '',
  writesPath: '',
  levels: [],
  levelOptions: LEVEL_OPTIONS,
  hasLevels: false,
  error: null,
  handlePickProfile: () => {},
  handleLevelChange: () => {},
};

export const useProfilePanel = ({
  view,
  drafts,
  onEdit,
}: ProfilePanelOptions): ProfilePanelView => {
  const rule = profileRule(view?.rules ?? []);
  if (view === null || rule === undefined) return EMPTY;
  const { profiles } = view;
  const layer = readLayer(drafts.draftOf('profile'));
  const picked = layerProfile(layer) ?? profiles.active;
  const summary = findProfile(profiles, picked);
  const levels = levelRows(summary, layer);

  const editProfileLayer = (draft: string) => {
    drafts.editRule('profile', draft);
    drafts.selectRule('profile');
    onEdit();
  };

  return {
    showPanel: true,
    active: profiles.active,
    chosenBy: CHOSEN_BY_LABELS[profiles.chosenBy],
    description: summary?.error ?? summary?.description ?? '',
    files: summary?.files ?? [],
    choices: profileChoices(profiles),
    pickerValue: picked,
    writesPath: rule.machine.path,
    levels,
    levelOptions: LEVEL_OPTIONS,
    hasLevels: levels.length > 0,
    error: profiles.error,
    handlePickProfile: (event) => {
      editProfileLayer(withProfile(layer, valueOf(event.currentTarget)));
    },
    handleLevelChange: (event) => {
      const rule = nameOf(event.currentTarget);
      const level = Number(valueOf(event.currentTarget));
      editProfileLayer(withLevel(layer, rule, level));
    },
  };
};
