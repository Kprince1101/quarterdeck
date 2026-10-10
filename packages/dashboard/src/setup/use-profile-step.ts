import { useEffect, useState, type ChangeEvent } from 'react';
import type { RulesView } from '@quarterdeck/server/intents';
import type { RulesReader } from '../api/index.js';
import { getErrorMessage } from '../lib/errors.js';
import {
  pickedProfile,
  profileNote,
  profileSummary,
  type ProfileSummary,
} from './profile-step.js';

export interface ProfileStepView {
  view: RulesView | null;
  summary: ProfileSummary | null;
  picked: string;
  changed: string | undefined;
  note: string;
  isLoaded: boolean;
  error: string | null;
  handleProfileChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}

interface Loaded {
  view: RulesView | null;
  error: string | null;
}

export const useProfileStep = (rules: RulesReader): ProfileStepView => {
  const [loaded, setLoaded] = useState<Loaded>({ view: null, error: null });
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    rules(null).then(
      (view) => {
        if (live) setLoaded({ view, error: null });
      },
      (err: unknown) => {
        if (live) setLoaded({ view: null, error: getErrorMessage(err) });
      },
    );
    return () => {
      live = false;
    };
  }, [rules]);

  const active = loaded.view?.profiles.active ?? '';
  const shown = picked ?? active;
  const summary = loaded.view && profileSummary(loaded.view, shown);
  const changed = pickedProfile(active, picked);
  return {
    view: loaded.view,
    summary,
    picked: shown,
    changed,
    note: profileNote(active, changed, summary?.writesPath ?? null),
    isLoaded: loaded.view !== null,
    error: loaded.error ?? summary?.error ?? null,
    handleProfileChange: (event) => setPicked(event.currentTarget.value),
  };
};
