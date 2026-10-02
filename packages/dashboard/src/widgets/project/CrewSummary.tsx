import { RequestError } from '../RequestError.js';
import type { ProjectPanel } from './project-model.js';
import { useRefreshAgents } from './use-refresh-agents.js';

export interface CrewSummaryProps {
  panel: ProjectPanel;
}

export const CrewSummary = ({ panel }: CrewSummaryProps) => {
  const { refreshLabel, canRefresh, error, handleRefresh } =
    useRefreshAgents(panel);
  return (
    <section className="qd-project-section" aria-label="Agents">
      <h3 className="qd-project-heading">Agents</h3>
      <dl className="qd-table-counts">
        <div>
          <dt>Reviewer</dt>
          <dd data-field="reviewer">{panel.reviewer}</dd>
        </div>
        <div>
          <dt>Retired</dt>
          <dd data-field="retired">{panel.retiredCount}</dd>
        </div>
      </dl>
      <div className="qd-project-actions">
        <button type="button" disabled={!canRefresh} onClick={handleRefresh}>
          {refreshLabel}
        </button>
      </div>
      <RequestError error={error} />
    </section>
  );
};
