import { isJsonObject, type JsonObject } from '@quarterdeck/rules/merge';
import type {
  ProfileSummaryView,
  ProfilesView,
  RuleView,
} from '../../api/index.js';

export interface ProfileChoiceOption {
  name: string;
  label: string;
}

export interface LevelRow {
  rule: string;
  level: string;
  local: boolean;
}

export interface LevelOption {
  value: string;
  label: string;
}

export const LEVEL_OPTIONS: readonly LevelOption[] = [
  { value: '3', label: '3 enforced' },
  { value: '2', label: '2 disable comment allowed' },
  { value: '1', label: '1 warn' },
  { value: '0', label: '0 off' },
];

export const CHOSEN_BY_LABELS: Record<ProfilesView['chosenBy'], string> = {
  shipped: 'Chosen by the shipped default.',
  machine: 'Chosen by this machine.',
  project: "Chosen by this project's repo layer, which wins over this machine.",
};

const SOURCE_LABELS: Record<ProfileSummaryView['source'], string> = {
  shipped: 'shipped',
  machine: 'this machine',
};

export const readLayer = (text: string | null): JsonObject => {
  if (text === null) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (isJsonObject(value)) return value;
  } catch {
    return {};
  }
  return {};
};

const layerLevels = (layer: JsonObject): Record<string, number> => {
  const levels = layer['levels'];
  if (!isJsonObject(levels)) return {};
  return Object.fromEntries(
    Object.entries(levels).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
};

export const layerProfile = (layer: JsonObject): string | null => {
  const profile = layer['profile'];
  if (typeof profile !== 'string') return null;
  return profile;
};

const layerText = (layer: JsonObject): string =>
  `${JSON.stringify(layer, null, 2)}\n`;

export const withProfile = (layer: JsonObject, profile: string): string =>
  layerText({ ...layer, profile });

export const withLevel = (
  layer: JsonObject,
  rule: string,
  level: number,
): string =>
  layerText({ ...layer, levels: { ...layerLevels(layer), [rule]: level } });

export const profileChoices = (view: ProfilesView): ProfileChoiceOption[] =>
  view.profiles.map((profile) => ({
    name: profile.name,
    label: `${profile.name} (${SOURCE_LABELS[profile.source]})`,
  }));

export const findProfile = (
  view: ProfilesView,
  name: string,
): ProfileSummaryView | undefined =>
  view.profiles.find((profile) => profile.name === name);

export const levelRows = (
  summary: ProfileSummaryView | undefined,
  layer: JsonObject,
): LevelRow[] => {
  const local = layerLevels(layer);
  const merged: Record<string, number> = { ...summary?.levels, ...local };
  return Object.keys(merged)
    .toSorted()
    .map((rule) => ({
      rule,
      level: String(merged[rule]),
      local: Object.hasOwn(local, rule),
    }));
};

export const profileRule = (rules: readonly RuleView[]): RuleView | undefined =>
  rules.find((rule) => rule.name === 'profile');
