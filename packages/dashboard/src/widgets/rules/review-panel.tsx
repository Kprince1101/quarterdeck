import type { RuleView } from '../../api/index.js';
import type { DiffLine } from '../line-diff.js';
import { DIFF_MARKS } from './constants.js';
import { LayerHeading, RulesAlert } from './rules-parts.js';
import type { RulesWidgetView } from './use-rules-widget.js';

interface ReviewPanelProps {
  view: RulesWidgetView;
  rule: RuleView;
}

const DiffRow = ({ line }: { line: DiffLine }) => (
  <span className="qd-diff-line" data-op={line.kind}>
    {DIFF_MARKS[line.kind]} {line.text}
    {'\n'}
  </span>
);

export const ReviewPanel = ({ view, rule }: ReviewPanelProps) => {
  if (view.review === null) return null;
  return (
    <section className="qd-rules-layer" aria-label="Review changes">
      <LayerHeading title={view.reviewTitle} path={rule.machine.path} />
      <pre className="qd-diff">
        {view.diff.map((line) => (
          <DiffRow key={line.id} line={line} />
        ))}
      </pre>
      <RulesAlert message={view.saveError} />
      <div className="qd-rules-actions">
        <button
          type="button"
          disabled={view.saving}
          onClick={view.handleConfirm}
        >
          {view.confirmLabel}
        </button>
        <button type="button" onClick={view.handleCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
};
