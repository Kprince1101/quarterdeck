import type { JSX } from 'react';
import type { RuleView } from '../../api/index.js';
import { useWording } from '../../deck/DeckProvider.js';
import { LayerHeading, RulesAlert } from './RulesParts.js';
import type { RulesWidgetView } from './use-rules-widget.js';

interface MachineLayerProps {
  view: RulesWidgetView;
  rule: RuleView;
}

const CheckStatus = ({ error }: { error: string | null }) => {
  if (error !== null) return <RulesAlert message={error} />;
  return (
    <p className="qd-rules-ok" role="status">
      Valid: the loader accepts it.
    </p>
  );
};

interface WarningsProps {
  label: string;
  warnings: string[];
}

const Warnings = ({ label, warnings }: WarningsProps) => {
  if (warnings.length === 0) return null;
  return (
    <ul className="qd-rules-warnings" aria-label={label}>
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
};

const MachineScope = () => (
  <>{useWording()('Applies to every project on this machine.')}</>
);

export const MachineLayer = ({
  view,
  rule,
}: MachineLayerProps): JSX.Element => (
  <section className="qd-rules-layer" aria-label="Machine layer">
    <LayerHeading title="Machine layer" path={rule.machine.path} />
    <p className="qd-rules-note">
      <MachineScope />
      {view.showNoFileNote && ' No file yet; saving creates it.'}
    </p>
    <textarea
      className="qd-rules-editor"
      aria-label={view.editorLabel}
      spellCheck={false}
      value={view.draft}
      onChange={view.handleDraftChange}
    />
    <CheckStatus error={view.checkError} />
    <Warnings label="Shell warnings" warnings={view.shellWarnings} />
    <Warnings label="Deprecated keys" warnings={view.deprecations} />
    <div className="qd-rules-actions">
      <button
        type="button"
        disabled={!view.canWrite}
        onClick={view.handleReviewWrite}
      >
        Review changes
      </button>
      <button
        type="button"
        disabled={!view.canRevert}
        onClick={view.handleRevert}
      >
        Revert
      </button>
      <button
        type="button"
        disabled={!view.canReset}
        onClick={view.handleReviewReset}
      >
        Remove file
      </button>
    </div>
  </section>
);
