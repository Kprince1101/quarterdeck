import type { JSX } from 'react';
import type { SteeringFileView } from '@quarterdeck/server/intents';
import { RequestError } from '../widgets/RequestError.js';
import type { ProfileSummary } from './profile-step.js';
import { stepNumber } from './setup-model.js';
import { SetupStep } from './SetupParts.js';
import type { ProfileStepView } from './use-profile-step.js';

export const PROFILE_HELP =
  'The rules profile is the coding standard your agents are told to follow. default is generic and language-neutral; a profile you added with profile add lives in ~/.quarterdeck/profiles/.';

interface FileListProps {
  label: string;
  files: readonly string[];
}

const FileList = ({ label, files }: FileListProps): JSX.Element => (
  <ul className="qd-setup-files" aria-label={label}>
    {files.map((file) => (
      <li key={file}>
        <code>{file}</code>
      </li>
    ))}
  </ul>
);

interface SteeringListProps {
  files: readonly SteeringFileView[];
}

const SteeringList = ({ files }: SteeringListProps): JSX.Element => (
  <ul className="qd-setup-files" aria-label="Files you may edit">
    {files.map((file) => (
      <li key={file.file}>
        <code>{file.machine}</code> <span>{file.controls}</span>
      </li>
    ))}
  </ul>
);

interface ProfileDetailProps {
  summary: ProfileSummary | null;
  view: ProfileStepView;
}

const ProfileDetail = ({
  summary,
  view,
}: ProfileDetailProps): JSX.Element | null => {
  if (summary === null) return null;
  return <ProfileChoice summary={summary} view={view} />;
};

interface ProfileChoiceProps {
  summary: ProfileSummary;
  view: ProfileStepView;
}

const ProfileChoice = ({ summary, view }: ProfileChoiceProps): JSX.Element => (
  <>
    <label className="qd-setup-row">
      <span className="qd-setup-choice-name">Profile</span>
      <select value={view.picked} onChange={view.handleProfileChange}>
        {summary.choices.map((choice) => (
          <option key={choice.name} value={choice.name}>
            {choice.label}
          </option>
        ))}
      </select>
      <span className="qd-setup-choice-detail">{summary.chosenBy}</span>
    </label>
    <p className="qd-setup-note">{view.note}</p>
    <p className="qd-setup-note">{summary.description}</p>
    <FileList label="Files the profile reads" files={summary.reads} />
    <p className="qd-setup-note">Files you may edit later to steer the crew:</p>
    <SteeringList files={summary.steeringFiles} />
  </>
);

export interface ProfileStepProps {
  view: ProfileStepView;
}

export const ProfileStep = ({ view }: ProfileStepProps): JSX.Element => (
  <SetupStep number={stepNumber('profile')} title="Profile" help={PROFILE_HELP}>
    <RequestError error={view.error} />
    <ProfileDetail summary={view.summary} view={view} />
  </SetupStep>
);
