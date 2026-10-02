import type { RuleName } from '@quarterdeck/rules/schemas';
import type { DiffOp } from './line-diff.js';

export type ReviewKind = 'write' | 'reset';

export const EMPTY_JSON_LAYER = '{}\n';

export const MACHINE_ONLY = '';

export const REPO_TIGHTEN_ONLY_KEYS: Readonly<
  Partial<Record<RuleName, readonly string[]>>
> = {
  lifecycle: ['mergeGate', 'autoEndSettleSeconds', 'budget.window'],
};

export const TIGHTEN_ONLY_NOTICE =
  'A project’s repo layer can only tighten permissions, mergeGate, autoEndSettleSeconds and budget.window: its permissions may only deny or ask, its mergeGate flags can only turn a gate on, it can only lengthen the settle time, and its budget window takes the smaller cap, the lower hold fraction and the longer window. Everything else in the repo layer overrides the machine layer.';

export const REPO_NOT_MERGED_NOTICE =
  'It is not merged: it is decided on its own and the stricter answer wins.';

export const DIFF_MARKS: Record<DiffOp, string> = {
  same: ' ',
  add: '+',
  remove: '-',
};

export const SAVED_VERBS: Record<ReviewKind, string> = {
  write: 'Saved',
  reset: 'Removed',
};

export const REVIEW_TITLES: Record<ReviewKind, string> = {
  write: 'Changes to save',
  reset: 'Remove this file?',
};

export const CONFIRM_LABELS: Record<ReviewKind, string> = {
  write: 'Save',
  reset: 'Remove',
};
