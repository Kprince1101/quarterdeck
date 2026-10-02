import { RequestError } from '../RequestError.js';
import type { ProjectPanel } from './project-model.js';
import { useArchiveProject } from './use-archive-project.js';

export interface ArchiveControlProps {
  panel: ProjectPanel;
}

export const ArchiveControl = ({ panel }: ArchiveControlProps) => {
  const { archiveLabel, isPending, error, handleArchive } =
    useArchiveProject(panel);
  return (
    <section className="qd-project-section" aria-label="Archive">
      <div className="qd-project-actions">
        <button type="button" disabled={isPending} onClick={handleArchive}>
          {archiveLabel}
        </button>
      </div>
      <RequestError error={error} />
    </section>
  );
};
