import type { RuleName } from '@quarterdeck/rules/schemas';
import { useMemo, type ChangeEvent } from 'react';
import type { ProjectRow, RuleView } from '../../api/index.js';
import { useDeck } from '../../deck/deck.js';
import { valueOf } from '../../grid/dom.js';
import type { DiffLine } from '../line-diff.js';
import {
  CONFIRM_LABELS,
  MACHINE_ONLY,
  REVIEW_TITLES,
  type ReviewKind,
} from './constants.js';
import type { ValueSource } from './rule-layers.js';
import { useRuleDrafts } from './use-rule-drafts.js';
import { useRuleReview } from './use-rule-review.js';
import { useRulesSource } from './use-rules-source.js';

export interface ProjectChoice {
  slug: string;
  label: string;
}

export interface RulesWidgetView {
  names: RuleName[];
  ruleValue: string;
  projects: ProjectChoice[];
  projectValue: string;
  project: string | null;
  loadError: string | null;
  isLoading: boolean;
  rule: RuleView | null;
  draft: string;
  editorLabel: string;
  checkError: string | null;
  sources: ValueSource[];
  showNoFileNote: boolean;
  canWrite: boolean;
  canRevert: boolean;
  canReset: boolean;
  review: ReviewKind | null;
  reviewTitle: string;
  confirmLabel: string;
  diff: DiffLine[];
  saving: boolean;
  saveError: string | null;
  saved: string | null;
  showRepoLayer: boolean;
  repoError: string | null;
  repoNotMerged: boolean;
  handleRuleChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  handleProjectChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  handleDraftChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleReviewWrite: () => void;
  handleReviewReset: () => void;
  handleRevert: () => void;
  handleConfirm: () => void;
  handleCancel: () => void;
}

const projectLabel = ({ slug, name }: ProjectRow): string => {
  if (name === slug) return slug;
  return `${name} (${slug})`;
};

const useProjectChoices = (): ProjectChoice[] => {
  const { projects } = useDeck().stream.tables;
  return useMemo(
    () =>
      projects
        .filter((row) => row.archivedAt === null)
        .map((row) => ({ slug: row.slug, label: projectLabel(row) })),
    [projects],
  );
};

const projectFromValue = (value: string): string | null => {
  if (value === MACHINE_ONLY) return null;
  return value;
};

export const useRulesWidget = (): RulesWidgetView => {
  const projects = useProjectChoices();
  const source = useRulesSource();
  const drafts = useRuleDrafts(source.view);
  const { editor } = drafts;
  const review = useRuleReview({
    editor,
    reload: source.reload,
    discard: drafts.discard,
  });
  const rule = editor?.rule ?? null;
  const fileName = rule?.file ?? '';

  return {
    names: drafts.names,
    ruleValue: drafts.name ?? '',
    projects,
    projectValue: source.project ?? MACHINE_ONLY,
    project: source.project,
    loadError: source.loadError,
    isLoading: editor === null && source.loadError === null,
    rule,
    draft: editor?.draft ?? '',
    editorLabel: `Edit rules.local.${fileName}`,
    checkError: editor?.check.error ?? null,
    sources: editor?.sources ?? [],
    showNoFileNote: rule?.machine.content === null,
    canWrite: review.canWrite,
    canRevert: editor?.dirty ?? false,
    canReset: review.canReset,
    review: review.review,
    reviewTitle: REVIEW_TITLES[review.review ?? 'write'],
    confirmLabel: CONFIRM_LABELS[review.review ?? 'write'],
    diff: review.diff,
    saving: review.saving,
    saveError: review.saveError,
    saved: review.saved,
    showRepoLayer: source.project !== null,
    repoError: editor?.check.repoError ?? null,
    repoNotMerged: rule?.name === 'permissions',
    handleRuleChange: (event) => {
      drafts.selectRule(valueOf(event.currentTarget) as RuleName);
      review.leave();
      review.clearSaved();
    },
    handleProjectChange: (event) => {
      source.selectProject(projectFromValue(valueOf(event.currentTarget)));
      review.leave();
    },
    handleDraftChange: (event) => {
      drafts.edit(valueOf(event.currentTarget));
      review.leave();
      review.clearSaved();
    },
    handleReviewWrite: () => {
      review.start('write');
    },
    handleReviewReset: () => {
      review.start('reset');
    },
    handleRevert: () => {
      if (rule !== null) drafts.discard(rule.name);
      review.leave();
    },
    handleConfirm: () => {
      void review.confirm();
    },
    handleCancel: review.leave,
  };
};
