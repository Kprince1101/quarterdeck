import {
  trackerSchema,
  type Tracker,
  type TrackerHow,
} from '@quarterdeck/rules/schemas';
import type {
  ServiceSource,
  ServicesReadResult,
} from '@quarterdeck/server/intents';
import { z } from 'zod';

export type HowChoice = '' | TrackerHow;

export interface ServicesForm {
  kind: string;
  how: HowChoice;
  reach: string;
  notes: string;
  publishes: boolean;
}

export interface HowOption {
  value: HowChoice;
  label: string;
}

export interface TrackerDraft {
  tracker: Tracker | null;
  error: string | null;
}

export const EMPTY_SERVICES_FORM: ServicesForm = {
  kind: '',
  how: '',
  reach: '',
  notes: '',
  publishes: false,
};

const HOW_LABELS: Record<HowChoice, string> = {
  '': 'Not reached',
  cli: 'CLI',
  mcp: 'MCP server',
};

export const HOW_OPTIONS: HowOption[] = Object.entries(HOW_LABELS).map(
  ([value, label]) => ({ value: value as HowChoice, label }),
);

export const REACH_LABELS: Record<HowChoice, string> = {
  '': 'Command or server',
  cli: 'Command',
  mcp: 'MCP server name',
};

const REACH_KEYS: Record<TrackerHow, 'command' | 'server'> = {
  cli: 'command',
  mcp: 'server',
};

const SOURCE_NOTES: Record<ServiceSource, string> = {
  project: 'set here',
  rules: 'from the rules',
  default: 'not set',
};

export const isHowChoice = (value: string): value is HowChoice =>
  Object.hasOwn(HOW_LABELS, value);

const reachOf = (tracker: Tracker | null): string =>
  tracker?.command ?? tracker?.server ?? '';

export const formOf = (read: ServicesReadResult): ServicesForm => ({
  kind: read.tracker?.kind ?? '',
  how: read.tracker?.how ?? '',
  reach: reachOf(read.tracker),
  notes: read.tracker?.notes ?? '',
  publishes: read.publishes,
});

const draftOf = (form: ServicesForm, kind: string): Record<string, string> => {
  const draft: Record<string, string> = { kind };
  const reach = form.reach.trim();
  const notes = form.notes.trim();
  if (form.how !== '') draft['how'] = form.how;
  if (form.how !== '' && reach !== '') draft[REACH_KEYS[form.how]] = reach;
  if (notes !== '') draft['notes'] = notes;
  return draft;
};

export const trackerOf = (form: ServicesForm): TrackerDraft => {
  const kind = form.kind.trim();
  if (kind === '') return { tracker: null, error: null };
  const result = trackerSchema.safeParse(draftOf(form, kind));
  if (!result.success)
    return { tracker: null, error: z.prettifyError(result.error) };
  return { tracker: result.data, error: null };
};

export const forgeSummary = (read: ServicesReadResult): string => {
  const { forge } = read;
  if (forge === null) return read.forgeError ?? 'The forge could not be read';
  if (forge.host === null)
    return `${forge.name}, no origin remote read yet (${forge.cli} CLI)`;
  return `${forge.name} at ${forge.host} (${forge.cli} CLI)`;
};

export const sourceNote = (read: ServicesReadResult): string =>
  `Tracker ${SOURCE_NOTES[read.trackerFrom]}, publishes ${SOURCE_NOTES[read.publishesFrom]}. ${read.rulesPath} can set both per project; a value saved here wins.`;
