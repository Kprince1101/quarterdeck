import { useDeck } from '../../deck/DeckProvider.js';
import { useIntentRequest } from '../use-intent-request.js';
import type { ProjectPanel } from './project-model.js';

export interface ArchiveProjectView {
  archiveLabel: string;
  isPending: boolean;
  error: string | null;
  handleArchive: () => void;
}

const archiveLabelOf = (isArchived: boolean): string => {
  if (isArchived) return 'Unarchive';
  return 'Archive';
};

export const useArchiveProject = (panel: ProjectPanel): ArchiveProjectView => {
  const { intents } = useDeck();
  const { isPending, error, run } = useIntentRequest();
  return {
    archiveLabel: archiveLabelOf(panel.isArchived),
    isPending,
    error,
    handleArchive: () => {
      void run(() =>
        intents.project.archive({
          project: panel.slug,
          archived: !panel.isArchived,
        }),
      );
    },
  };
};
