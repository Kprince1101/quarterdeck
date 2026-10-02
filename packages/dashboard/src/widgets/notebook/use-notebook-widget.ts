import { useMemo } from 'react';
import { useDeck } from '../../deck/deck.js';
import { buildNotebook, type NotebookModel } from './notebook-model.js';

export interface NotebookWidgetView extends NotebookModel {
  noProposals: boolean;
  noEntries: boolean;
}

export const useNotebookWidget = (): NotebookWidgetView => {
  const { tables } = useDeck().stream;
  const model = useMemo(() => buildNotebook(tables), [tables]);
  return {
    ...model,
    noProposals: model.proposals.length === 0,
    noEntries: model.entries.length === 0,
  };
};
