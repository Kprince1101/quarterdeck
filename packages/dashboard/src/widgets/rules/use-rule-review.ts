import type { RuleName } from '@quarterdeck/rules/schemas';
import { useMemo, useState } from 'react';
import { useDeck } from '../../deck/DeckProvider.js';
import { getErrorMessage } from '../../lib/errors.js';
import { lineDiff, type DiffLine } from '../line-diff.js';
import { SAVED_VERBS, type ReviewKind } from './constants.js';
import type { RuleEditor } from './use-rule-drafts.js';

export interface RuleReview {
  review: ReviewKind | null;
  diff: DiffLine[];
  saving: boolean;
  saveError: string | null;
  saved: string | null;
  canWrite: boolean;
  canReset: boolean;
  start: (kind: ReviewKind) => void;
  leave: () => void;
  clearSaved: () => void;
  confirm: () => Promise<void>;
}

export interface RuleReviewDeps {
  editor: RuleEditor | null;
  reload: () => Promise<void>;
  discard: (name: RuleName) => void;
}

const AFTER_REVIEW: Record<ReviewKind, (editor: RuleEditor) => string> = {
  write: (editor) => editor.draft,
  reset: () => '',
};

const reviewDiff = (
  editor: RuleEditor | null,
  review: ReviewKind | null,
): DiffLine[] => {
  if (editor === null || review === null) return [];
  return lineDiff(
    editor.rule.machine.content ?? '',
    AFTER_REVIEW[review](editor),
  );
};

export const useRuleReview = ({
  editor,
  reload,
  discard,
}: RuleReviewDeps): RuleReview => {
  const { intents } = useDeck();
  const [review, setReview] = useState<ReviewKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const diff = useMemo(() => reviewDiff(editor, review), [editor, review]);

  const canWrite =
    editor !== null && editor.dirty && editor.check.error === null;
  const canReset = editor !== null && editor.rule.machine.content !== null;
  const allowed: Record<ReviewKind, boolean> = {
    write: canWrite,
    reset: canReset,
  };

  const send = (target: RuleEditor, kind: ReviewKind) => {
    const rule = { scope: 'machine', name: target.rule.name } as const;
    if (kind === 'reset') return intents.rules.reset(rule);
    return intents.rules.write({ ...rule, content: target.draft });
  };

  const apply = async (target: RuleEditor, kind: ReviewKind) => {
    try {
      await send(target, kind);
    } catch (err) {
      setSaveError(getErrorMessage(err));
      return;
    }
    await reload();
    discard(target.rule.name);
    setReview(null);
    setSaved(`${SAVED_VERBS[kind]} ${target.rule.machine.path}`);
  };

  return {
    review,
    diff,
    saving,
    saveError,
    saved,
    canWrite,
    canReset,
    start: (kind) => {
      if (!allowed[kind]) return;
      setReview(kind);
      setSaveError(null);
      setSaved(null);
    },
    leave: () => {
      setReview(null);
      setSaveError(null);
    },
    clearSaved: () => {
      setSaved(null);
    },
    confirm: async () => {
      if (editor === null || review === null || saving) return;
      setSaving(true);
      setSaveError(null);
      try {
        await apply(editor, review);
      } finally {
        setSaving(false);
      }
    },
  };
};
