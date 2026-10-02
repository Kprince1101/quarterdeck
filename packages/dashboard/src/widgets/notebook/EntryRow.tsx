import { RequestError } from '../RequestError.js';
import type { EntryView } from './notebook-model.js';
import { ProjectTag } from './ProjectTag.js';
import { useEntryRow } from './use-entry-row.js';

export interface EntryRowProps {
  entry: EntryView;
  showProject: boolean;
}

export const EntryRow = ({ entry, showProject }: EntryRowProps) => {
  const { isPending, error, handleTogglePin } = useEntryRow(entry);
  return (
    <li className="qd-notebook-entry" data-entry-id={entry.id}>
      <div className="qd-notebook-entry-head">
        <ProjectTag project={entry.project} isShown={showProject} />
        <button
          type="button"
          className="qd-notebook-pin"
          aria-pressed={entry.pinned}
          disabled={isPending}
          onClick={handleTogglePin}
        >
          Pinned
        </button>
      </div>
      <p className="qd-notebook-text">{entry.body}</p>
      <RequestError error={error} />
    </li>
  );
};
