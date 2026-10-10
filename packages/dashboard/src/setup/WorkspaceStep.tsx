import type { JSX } from 'react';
import { RequestError } from '../widgets/RequestError.js';
import { stepNumber } from './setup-model.js';
import { SetupNote, SetupStep } from './SetupParts.js';
import type {
  RepositoryChoice,
  WorkspaceStepView,
} from './use-workspace-step.js';

export const WORKSPACE_HELP =
  'The folder Quarterdeck works in: one git repository, or a folder whose git repositories each become a project. Type or paste its full path.';

export const PATH_PLACEHOLDER = '~/code/my-app';

interface RepositoryListProps {
  repositories: readonly RepositoryChoice[];
}

const RepositoryList = ({ repositories }: RepositoryListProps): JSX.Element => (
  <ul className="qd-setup-list">
    {repositories.map((repo) => (
      <li key={repo.slug}>
        <label className="qd-setup-choice">
          <input
            type="checkbox"
            checked={repo.isKept}
            onChange={repo.handleToggle}
          />
          <span className="qd-setup-choice-name">{repo.name}</span>
          <span className="qd-setup-choice-detail">{repo.origin}</span>
        </label>
      </li>
    ))}
  </ul>
);

export interface WorkspaceStepProps {
  view: WorkspaceStepView;
}

export const WorkspaceStep = ({ view }: WorkspaceStepProps): JSX.Element => (
  <SetupStep
    number={stepNumber('workspace')}
    title="Workspace"
    help={WORKSPACE_HELP}
  >
    <form className="qd-setup-row" onSubmit={view.handleDetect}>
      <input
        type="text"
        className="qd-setup-path"
        aria-label="Folder path"
        placeholder={PATH_PLACEHOLDER}
        spellCheck={false}
        autoComplete="off"
        value={view.path}
        onChange={view.handlePathChange}
      />
      <button type="submit" disabled={!view.canDetect}>
        Look
      </button>
    </form>
    <RequestError error={view.error} />
    <SetupNote text={view.summary} className="qd-setup-summary" />
    {view.showsRepositories && (
      <RepositoryList repositories={view.repositories} />
    )}
  </SetupStep>
);
