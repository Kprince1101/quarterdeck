import type { JSX } from 'react';
import { RequestError } from '../RequestError.js';
import type { ProjectPanel } from './project-model.js';
import {
  useProjectServices,
  type ProjectServicesView,
} from './use-project-services.js';

interface ServicesViewProps {
  services: ProjectServicesView;
}

const TrackerFields = ({ services }: ServicesViewProps) => (
  <div className="qd-project-fields">
    <label className="qd-project-field">
      <span>Tracker</span>
      <input
        className="qd-project-input"
        placeholder="jira, github-issues, none"
        value={services.form.kind}
        onChange={services.handleKindChange}
      />
    </label>
    <label className="qd-project-field">
      <span>Reached by</span>
      <select
        className="qd-project-input"
        value={services.form.how}
        onChange={services.handleHowChange}
      >
        {services.howOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
    <label className="qd-project-field">
      <span>{services.reachLabel}</span>
      <input
        className="qd-project-input"
        disabled={services.isReachDisabled}
        value={services.form.reach}
        onChange={services.handleReachChange}
      />
    </label>
    <label className="qd-project-field">
      <span>Notes</span>
      <textarea
        className="qd-project-input"
        rows={2}
        value={services.form.notes}
        onChange={services.handleNotesChange}
      />
    </label>
  </div>
);

const ServicesActions = ({ services }: ServicesViewProps) => (
  <div className="qd-project-actions">
    {services.showsPublishes && (
      <label className="qd-project-toggle">
        <input
          type="checkbox"
          checked={services.form.publishes}
          disabled={services.isPending}
          onChange={services.handlePublishesChange}
        />
        <span>Publishes (dependents wait for a release)</span>
      </label>
    )}
    <button
      type="button"
      disabled={!services.canSave}
      onClick={services.handleSave}
    >
      Save services
    </button>
    <button
      type="button"
      disabled={services.isPending}
      onClick={services.handleUseRules}
    >
      Use the rules
    </button>
  </div>
);

const ServicesForm = ({ services }: ServicesViewProps) => (
  <>
    <p className="qd-project-forge">
      <span>Forge</span>
      <span className="qd-project-forge-value">{services.forgeSummary}</span>
    </p>
    <TrackerFields services={services} />
    <ServicesActions services={services} />
    <p className="qd-project-note">{services.sourceNote}</p>
  </>
);

export interface ServicesSectionProps {
  panel: ProjectPanel;
}

export const ServicesSection = ({
  panel,
}: ServicesSectionProps): JSX.Element => {
  const services = useProjectServices(panel);
  return (
    <section className="qd-project-section" aria-label="Services">
      <h3 className="qd-project-heading">Services</h3>
      {services.isLoaded && <ServicesForm services={services} />}
      <RequestError error={services.error} />
    </section>
  );
};
