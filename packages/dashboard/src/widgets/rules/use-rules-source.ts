import { useCallback, useEffect, useState } from 'react';
import type { RulesView } from '../../api/index.js';
import { useDeck } from '../../deck/DeckProvider.js';
import { getErrorMessage } from '../../lib/errors.js';

export interface RulesSource {
  project: string | null;
  view: RulesView | null;
  loadError: string | null;
  selectProject: (project: string | null) => void;
  reload: () => Promise<void>;
}

export const useRulesSource = (): RulesSource => {
  const { rules: readRules } = useDeck();
  const [project, setProject] = useState<string | null>(null);
  const [view, setView] = useState<RulesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readRules(project).then(
      (next) => {
        if (!live) return;
        setView(next);
        setLoadError(null);
      },
      (err: unknown) => {
        if (live) setLoadError(getErrorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [readRules, project]);

  const reload = useCallback(async () => {
    try {
      setView(await readRules(project));
      setLoadError(null);
    } catch (err) {
      setLoadError(getErrorMessage(err));
    }
  }, [readRules, project]);

  return { project, view, loadError, selectProject: setProject, reload };
};
