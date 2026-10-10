import type { ReactNode, JSX } from 'react';
import type { WorkspaceMode } from '../../api/index.js';
import { RequestError } from '../RequestError.js';
import { useWipeAll, useWipeProject, type WipeView } from './use-wipe.js';

interface WipeControlProps {
  label: string;
  wipe: WipeView;
  children: ReactNode;
}

const WipeDone = ({ done }: { done: string | null }) => {
  if (done === null) return null;
  return (
    <p className="qd-data-wiped" role="status">
      {done}
    </p>
  );
};

const WipeControl = ({ label, wipe, children }: WipeControlProps) => (
  <form
    className="qd-data-wipe"
    aria-label={label}
    onSubmit={wipe.handleSubmit}
  >
    <p>{children}</p>
    <label>
      <span>
        Type <code>{wipe.phrase}</code> to confirm
      </span>
      <input
        type="text"
        value={wipe.typed}
        autoComplete="off"
        spellCheck={false}
        onChange={wipe.handleChange}
      />
    </label>
    <button
      type="submit"
      className="qd-grid-button"
      disabled={wipe.isWipeDisabled}
    >
      {label}
    </button>
    <RequestError error={wipe.error} />
    <WipeDone done={wipe.done} />
  </form>
);

interface WipeSectionProps {
  project: string;
  mode: WorkspaceMode;
  onWiped: () => void;
}

const MultiWipe = ({ project, wipe }: { project: string; wipe: WipeView }) => (
  <WipeControl label="Wipe project" wipe={wipe}>
    Stops every agent in <strong>{project}</strong>, then deletes its rows and
    every path marked This project. Rules files stay.
  </WipeControl>
);

const SingleWipe = ({ project, wipe }: { project: string; wipe: WipeView }) => (
  <WipeControl label="Wipe repository data" wipe={wipe}>
    Stops every agent working on <strong>{project}</strong>, then deletes its
    rows and every path marked Quarterdeck data. Rules files stay.
  </WipeControl>
);

const ONE_WIPE: Record<WorkspaceMode, typeof MultiWipe> = {
  multi: MultiWipe,
  single: SingleWipe,
};

const WIPE_ALL_TEXT: Record<WorkspaceMode, string> = {
  multi:
    'Stops every agent and deletes every project Quarterdeck keeps. Rules files, plugins and runtime folders stay.',
  single:
    'Stops every agent and deletes everything Quarterdeck keeps. Rules files, plugins and runtime folders stay.',
};

export const WipeSection = ({
  project,
  mode,
  onWiped,
}: WipeSectionProps): JSX.Element => {
  const wipeProject = useWipeProject(project, onWiped);
  const wipeAll = useWipeAll(onWiped);
  const OneWipe = ONE_WIPE[mode];
  return (
    <section className="qd-data-section" aria-label="Wipe">
      <h3>Wipe</h3>
      <OneWipe project={project} wipe={wipeProject} />
      <WipeControl label="Wipe everything" wipe={wipeAll}>
        {WIPE_ALL_TEXT[mode]}
      </WipeControl>
    </section>
  );
};
