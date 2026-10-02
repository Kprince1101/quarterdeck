import { useDeck } from '../../deck/deck.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { EntryView } from './notebook-model.js';

export interface EntryRowView {
  isPending: boolean;
  error: string | null;
  handleTogglePin: () => void;
}

export const useEntryRow = (entry: EntryView): EntryRowView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  const handleTogglePin = () => {
    void run(() =>
      intents.notebook.pin({
        project: entry.project,
        entryId: entry.id,
        pinned: !entry.pinned,
      }),
    );
  };
  return { isPending, error, handleTogglePin };
};
