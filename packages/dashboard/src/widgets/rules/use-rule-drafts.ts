import type { RuleName } from '@quarterdeck/rules/schemas';
import { useCallback, useMemo, useState } from 'react';
import type { RuleView, RulesView } from '../../api/index.js';
import {
  checkDraft,
  initialDraft,
  valueSources,
  type DraftCheck,
  type ValueSource,
} from './rule-layers.js';

export interface RuleEditor {
  rule: RuleView;
  draft: string;
  dirty: boolean;
  check: DraftCheck;
  sources: ValueSource[];
}

export interface RuleDrafts {
  names: RuleName[];
  name: RuleName | null;
  editor: RuleEditor | null;
  selectRule: (name: RuleName) => void;
  edit: (draft: string) => void;
  editRule: (name: RuleName, draft: string) => void;
  draftOf: (name: RuleName) => string | null;
  discard: (name: RuleName) => void;
}

type Drafts = Partial<Record<RuleName, string>>;

const withoutDraft = (drafts: Drafts, name: RuleName): Drafts =>
  Object.fromEntries(
    Object.entries(drafts).filter(([key]) => key !== name),
  ) as Drafts;

const editorFor = (rule: RuleView, drafts: Drafts): RuleEditor => {
  const draft = drafts[rule.name] ?? initialDraft(rule);
  const check = checkDraft(rule, draft);
  return {
    rule,
    draft,
    dirty: draft !== initialDraft(rule),
    check,
    sources: valueSources(rule, check, draft),
  };
};

export const useRuleDrafts = (view: RulesView | null): RuleDrafts => {
  const [chosen, setChosen] = useState<RuleName | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const names = useMemo(
    () => view?.rules.map((rule) => rule.name) ?? [],
    [view],
  );
  const name = chosen ?? names[0] ?? null;

  const editor = useMemo(() => {
    const rule = view?.rules.find((candidate) => candidate.name === name);
    if (rule === undefined) return null;
    return editorFor(rule, drafts);
  }, [view, name, drafts]);

  const editRule = useCallback((target: RuleName, draft: string) => {
    setDrafts((current) => ({ ...current, [target]: draft }));
  }, []);

  const edit = useCallback(
    (draft: string) => {
      if (name !== null) editRule(name, draft);
    },
    [name, editRule],
  );

  const draftOf = useCallback(
    (target: RuleName): string | null => {
      const rule = view?.rules.find((candidate) => candidate.name === target);
      if (rule === undefined) return null;
      return drafts[target] ?? initialDraft(rule);
    },
    [view, drafts],
  );

  const discard = useCallback((target: RuleName) => {
    setDrafts((current) => withoutDraft(current, target));
  }, []);

  return {
    names,
    name,
    editor,
    selectRule: setChosen,
    edit,
    editRule,
    draftOf,
    discard,
  };
};
