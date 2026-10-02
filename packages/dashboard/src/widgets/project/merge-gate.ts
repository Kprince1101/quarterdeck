import { isJsonObject } from '@quarterdeck/rules/merge';
import type { MergeGate } from '@quarterdeck/rules/schemas';
import type { RuleView, RulesView } from '../../api/index.js';
import { getErrorMessage } from '../../lib/errors.js';
import { EMPTY_JSON_LAYER } from '../rules/constants.js';
import { checkDraft } from '../rules/rule-layers.js';

export type GateKey = 'requireCopilotReview' | 'autoMerge';

export interface GateToggle {
  key: GateKey;
  label: string;
  checked: boolean;
  pinnedByRepo: boolean;
  title: string;
}

export interface GateToggles {
  toggles: GateToggle[];
  error: string | null;
}

const GATE_LABELS: Record<GateKey, string> = {
  requireCopilotReview: 'Copilot review (all projects)',
  autoMerge: 'Auto-merge (all projects)',
};

const GATE_KEYS = Object.keys(GATE_LABELS) as GateKey[];

const CONFIRMED_WHEN_ON: ReadonlySet<GateKey> = new Set(['autoMerge']);

export const AUTO_MERGE_WARNING =
  'Turn on auto-merge for every project on this machine? Approved pull requests will squash-merge to GitHub with no merge card.';

export const needsConfirm = (key: GateKey, value: boolean): boolean =>
  value && CONFIRMED_WHEN_ON.has(key);

interface GateValues {
  machine: MergeGate;
  effective: MergeGate;
}

const gateOf = (lifecycle: unknown): MergeGate => {
  if (!isJsonObject(lifecycle) || !isJsonObject(lifecycle['mergeGate'])) {
    throw new Error('The lifecycle rule has no mergeGate');
  }
  return lifecycle['mergeGate'] as unknown as MergeGate;
};

const gateValues = (rule: RuleView): GateValues => {
  const check = checkDraft(rule, rule.machine.content ?? EMPTY_JSON_LAYER);
  if (check.error !== null) throw new Error(check.error);
  return { machine: gateOf(check.merged), effective: gateOf(check.effective) };
};

const repoPinNote = (rule: RuleView): string =>
  ` This project's repo layer (${rule.repo?.path ?? ''}) pins it, so it cannot change here.`;

const gateTitle = (rule: RuleView, key: GateKey, pinned: boolean): string => {
  const base = `Machine-wide: sets mergeGate.${key} in ${rule.machine.path}, which applies to every project.`;
  if (!pinned) return base;
  return `${base}${repoPinNote(rule)}`;
};

export const lifecycleRule = (view: RulesView): RuleView => {
  const rule = view.rules.find(({ name }) => name === 'lifecycle');
  if (rule === undefined) throw new Error('The lifecycle rule is missing');
  return rule;
};

export const gateToggles = (rule: RuleView): GateToggles => {
  try {
    const { machine, effective } = gateValues(rule);
    const toggles = GATE_KEYS.map((key) => {
      const pinnedByRepo = machine[key] !== effective[key];
      return {
        key,
        label: GATE_LABELS[key],
        checked: effective[key],
        pinnedByRepo,
        title: gateTitle(rule, key, pinnedByRepo),
      };
    });
    return { toggles, error: null };
  } catch (err) {
    return { toggles: [], error: getErrorMessage(err) };
  }
};

const machineLayer = (rule: RuleView): Record<string, unknown> => {
  const layer = JSON.parse(rule.machine.content ?? EMPTY_JSON_LAYER) as unknown;
  if (!isJsonObject(layer)) {
    throw new Error(`${rule.machine.path} is not a JSON object`);
  }
  return layer;
};

const layerGate = (layer: Record<string, unknown>): Record<string, unknown> => {
  const gate = layer['mergeGate'];
  if (isJsonObject(gate)) return gate;
  return {};
};

export const gateLayer = (
  rule: RuleView,
  key: GateKey,
  value: boolean,
): string => {
  const { machine, effective } = gateValues(rule);
  if (machine[key] !== effective[key]) {
    throw new Error(`mergeGate.${key} is pinned by this project's repo layer`);
  }
  const layer = machineLayer(rule);
  const mergeGate = { ...layerGate(layer), [key]: value };
  return `${JSON.stringify({ ...layer, mergeGate }, null, 2)}\n`;
};
