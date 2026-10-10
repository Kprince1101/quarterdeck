import type { JSX } from 'react';
import type { LevelRow } from './profile-panel.js';
import { RulesAlert } from './RulesParts.js';
import type { ProfilePanelView } from './use-profile-panel.js';

interface ProfilePanelProps {
  profile: ProfilePanelView;
}

interface LevelProps {
  profile: ProfilePanelView;
  row: LevelRow;
}

const Level = ({ profile, row }: LevelProps) => (
  <li>
    <label>
      <code>{row.rule}</code>
      <select
        name={row.rule}
        value={row.level}
        onChange={profile.handleLevelChange}
      >
        {profile.levelOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {row.local && <span className="qd-rules-tag">local</span>}
    </label>
  </li>
);

const Levels = ({ profile }: ProfilePanelProps) => {
  if (!profile.hasLevels) {
    return <p className="qd-empty">This profile sets no rule levels.</p>;
  }
  return (
    <ul className="qd-rules-levels" aria-label="Rule levels">
      {profile.levels.map((row) => (
        <Level key={row.rule} profile={profile} row={row} />
      ))}
    </ul>
  );
};

const FileList = ({ label, files }: { label: string; files: string[] }) => (
  <ul className="qd-rules-files" aria-label={label}>
    {files.map((file) => (
      <li key={file}>
        <code>{file}</code>
      </li>
    ))}
  </ul>
);

export const ProfilePanel = ({
  profile,
}: ProfilePanelProps): JSX.Element | null => {
  if (!profile.showPanel) return null;
  return (
    <section className="qd-rules-layer" aria-label="Rules profile">
      <header className="qd-rules-layer-head">
        <h3>Profile: {profile.active}</h3>
        <span>{profile.chosenBy}</span>
      </header>
      <RulesAlert message={profile.error} />
      <label>
        Pick a profile
        <select
          value={profile.pickerValue}
          onChange={profile.handlePickProfile}
        >
          {profile.choices.map((choice) => (
            <option key={choice.name} value={choice.name}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <p className="qd-rules-note">
        Picking a profile or a level writes <code>{profile.writesPath}</code>{' '}
        once you review and save it below.
      </p>
      <p className="qd-rules-note">{profile.description}</p>
      <FileList label="Files the profile reads" files={profile.files} />
      <Levels profile={profile} />
    </section>
  );
};
