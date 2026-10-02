import { useCallback, useEffect, useState } from 'react';
import type { RuleView } from '../../api/index.js';
import { useDeck } from '../../deck/DeckProvider.js';
import { getErrorMessage } from '../../lib/errors.js';
import { lifecycleRule } from './merge-gate.js';

export interface LifecycleRuleSource {
  rule: RuleView | null;
  loadError: string | null;
  read: () => Promise<RuleView>;
  show: (rule: RuleView) => void;
}

export const useLifecycleRule = (project: string): LifecycleRuleSource => {
  const { rules } = useDeck();
  const [rule, setRule] = useState<RuleView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const read = useCallback(
    async () => lifecycleRule(await rules(project)),
    [rules, project],
  );

  useEffect(() => {
    let live = true;
    read().then(
      (next) => {
        if (!live) return;
        setRule(next);
        setLoadError(null);
      },
      (err: unknown) => {
        if (live) setLoadError(getErrorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [read]);

  return { rule, loadError, read, show: setRule };
};
