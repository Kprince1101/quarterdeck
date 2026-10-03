import type { Tracker } from '@quarterdeck/rules/schemas';
import { useDeck } from '../../deck/DeckProvider.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { ProjectPanel } from './project-model.js';
import {
  HOW_OPTIONS,
  REACH_LABELS,
  forgeSummary,
  sourceNote,
  trackerOf,
  type HowOption,
} from './services-form.js';
import {
  useServicesForm,
  type ServicesFormState,
} from './use-services-form.js';
import { useServicesRead } from './use-services-read.js';

export interface ProjectServicesView extends ServicesFormState {
  isLoaded: boolean;
  forgeSummary: string;
  sourceNote: string;
  howOptions: HowOption[];
  reachLabel: string;
  isReachDisabled: boolean;
  isPending: boolean;
  canSave: boolean;
  error: string | null;
  handleSave: () => void;
  handleUseRules: () => void;
}

interface ServicesValues {
  tracker: Tracker | null;
  publishes: boolean | null;
}

export const useProjectServices = (
  panel: ProjectPanel,
): ProjectServicesView => {
  const { intents } = useDeck();
  const { read, loadError, reload } = useServicesRead(panel.slug);
  const fields = useServicesForm(read);
  const { isPending, error, run } = useIntentRequest();
  const draft = trackerOf(fields.form);
  const send = (values: ServicesValues) => {
    void run(async () => {
      await intents.services.set({ project: panel.slug, ...values });
      await reload();
    });
  };
  return {
    ...fields,
    isLoaded: read !== null,
    forgeSummary: (read && forgeSummary(read)) ?? '',
    sourceNote: (read && sourceNote(read)) ?? '',
    howOptions: HOW_OPTIONS,
    reachLabel: REACH_LABELS[fields.form.how],
    isReachDisabled: fields.form.how === '',
    isPending,
    canSave: read !== null && draft.error === null && !isPending,
    error: error ?? loadError ?? draft.error,
    handleSave: () => {
      send({ tracker: draft.tracker, publishes: fields.form.publishes });
    },
    handleUseRules: () => {
      send({ tracker: null, publishes: null });
    },
  };
};
