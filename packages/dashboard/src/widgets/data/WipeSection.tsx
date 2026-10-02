import type { ReactNode } from 'react';
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
  onWiped: () => void;
}

export const WipeSection = ({ project, onWiped }: WipeSectionProps) => {
  const wipeProject = useWipeProject(project, onWiped);
  const wipeAll = useWipeAll(onWiped);
  return (
    <section className="qd-data-section" aria-label="Wipe">
      <h3>Wipe</h3>
      <WipeControl label="Wipe project" wipe={wipeProject}>
        Stops every agent in <strong>{project}</strong>, then deletes its rows
        and every path marked This project. Rules files stay.
      </WipeControl>
      <WipeControl label="Wipe everything" wipe={wipeAll}>
        Stops every agent and deletes every project Quarterdeck keeps. Rules
        files, plugins and runtime folders stay.
      </WipeControl>
    </section>
  );
};
