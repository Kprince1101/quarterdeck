import type { JSX } from 'react';
import { useFirstVoyageGuide } from './use-first-voyage-guide.js';
import './setup.css';

export const FIRST_VOYAGE_TITLE = 'What to do first';

export const FirstVoyageGuide = (): JSX.Element | null => {
  const view = useFirstVoyageGuide();
  if (!view.isShown) return null;
  return (
    <aside className="qd-first-voyage" aria-label={FIRST_VOYAGE_TITLE}>
      <h2 className="qd-first-voyage-title">{FIRST_VOYAGE_TITLE}</h2>
      <ol className="qd-first-voyage-steps">
        <li>
          Describe the work you want to the <strong>Planner</strong>. It
          proposes tickets as specs.
        </li>
        <li>
          <strong>Approve</strong> the proposals you want, or edit them first.
        </li>
        <li>
          Press <strong>Start Voyage</strong>. The Driver assigns the work and
          asks you only when it has to.
        </li>
      </ol>
    </aside>
  );
};
