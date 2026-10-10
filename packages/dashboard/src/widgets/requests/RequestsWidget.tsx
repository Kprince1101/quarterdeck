import type { JSX } from 'react';
import { useShowsProjects } from '../../deck/DeckProvider.js';
import { defineWidget } from '../registry.js';
import {
  NEUTRAL_TITLE,
  requestsEmptyText,
  requestsSectionLabel,
  requestsTableLabel,
  type ProjectRequestsView,
  type RequestRowView,
  type RequestsView,
} from './requests-model.js';
import { useRequestsWidget } from './use-requests-widget.js';
import './requests.css';

const NO_TICKET = '—';

interface TicketCellProps {
  row: RequestRowView;
}

const TicketCell = ({ row }: TicketCellProps) => {
  if (row.ticket === null)
    return <td className="qd-requests-none">{NO_TICKET}</td>;
  return (
    <td>
      <span
        className="qd-requests-ticket"
        data-ticket-id={row.ticket.id}
        title={`Ticket ${row.ticket.status}`}
      >
        {row.ticket.title}
      </span>
      {row.agent !== null && (
        <span className="qd-requests-agent">{row.agent}</span>
      )}
    </td>
  );
};

interface RequestRowProps {
  row: RequestRowView;
}

const NumberCell = ({ row }: RequestRowProps) => {
  if (row.url === null) return <td>{row.numberLabel}</td>;
  return (
    <td>
      <a
        href={row.url}
        target="_blank"
        rel="noreferrer"
        aria-label={row.openLabel}
        title={row.openLabel}
      >
        {row.numberLabel}
      </a>
    </td>
  );
};

const RequestRow = ({ row }: RequestRowProps) => (
  <tr>
    <NumberCell row={row} />
    <td className="qd-requests-name">
      {row.title}
      {row.draft && <span className="qd-requests-draft">Draft</span>}
    </td>
    <td>{row.author}</td>
    <td>
      <code>{row.branchLabel}</code>
    </td>
    <td className="qd-requests-checks" data-checks={row.checks}>
      {row.checksLabel}
    </td>
    <td className="qd-requests-review" data-review={row.review}>
      {row.reviewLabel}
    </td>
    <TicketCell row={row} />
    <td className="qd-requests-age">{row.age}</td>
  </tr>
);

interface ProjectSectionProps {
  project: ProjectRequestsView;
  isLabelled: boolean;
}

const RequestTable = ({ project, isLabelled }: ProjectSectionProps) => {
  if (project.rows.length === 0) return null;
  return (
    <table
      className="qd-requests-table"
      aria-label={requestsTableLabel(project, isLabelled)}
    >
      <thead>
        <tr>
          {project.columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {project.rows.map((row) => (
          <RequestRow key={row.key} row={row} />
        ))}
      </tbody>
    </table>
  );
};

const ProjectSection = ({ project, isLabelled }: ProjectSectionProps) => (
  <section
    className="qd-requests-project"
    aria-label={requestsSectionLabel(project, isLabelled)}
    data-forge={project.forge}
  >
    {isLabelled && (
      <h4>
        {project.name}
        <span className="qd-requests-forge">{project.terms.name}</span>
      </h4>
    )}
    {project.error !== null && (
      <p className="qd-requests-project-error" role="alert">
        {project.error}
      </p>
    )}
    {project.empty !== null && <p className="qd-empty">{project.empty}</p>}
    <RequestTable project={project} isLabelled={isLabelled} />
  </section>
);

interface RequestsListProps {
  view: RequestsView | null;
}

const RequestsList = ({ view }: RequestsListProps) => {
  const showsProjects = useShowsProjects();
  if (view === null) return <p className="qd-empty">Reading open requests…</p>;
  if (view.empty !== null)
    return (
      <p className="qd-empty">{requestsEmptyText(view.empty, showsProjects)}</p>
    );
  return (
    <>
      {view.projects.map((project) => (
        <ProjectSection
          key={project.project}
          project={project}
          isLabelled={showsProjects}
        />
      ))}
    </>
  );
};

interface RequestsErrorProps {
  error: string | null;
}

const RequestsError = ({ error }: RequestsErrorProps) => {
  if (error === null) return null;
  return (
    <p className="qd-requests-error" role="alert">
      {error}
    </p>
  );
};

export const RequestsWidget = (): JSX.Element => {
  const { view, error } = useRequestsWidget();
  return (
    <div className="qd-requests">
      <h3 className="qd-requests-title">{view?.title ?? NEUTRAL_TITLE}</h3>
      <RequestsError error={error} />
      <RequestsList view={view} />
    </div>
  );
};

export default defineWidget({
  type: 'requests',
  title: NEUTRAL_TITLE,
  component: RequestsWidget,
  size: { w: 6, h: 4 },
  minSize: { w: 3, h: 2 },
});
