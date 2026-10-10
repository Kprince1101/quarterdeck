import type { JSX } from 'react';
import type { RuleLayer, RuleView } from '../../api/index.js';
import { useWording } from '../../deck/DeckProvider.js';
import { REPO_NOT_MERGED_NOTICE } from './constants.js';
import { LayerHeading, RulesAlert } from './RulesParts.js';
import type { RulesWidgetView } from './use-rules-widget.js';

interface RepoLayerProps {
  view: RulesWidgetView;
  rule: RuleView;
}

const RepoBody = ({ repo }: { repo: RuleLayer }) => {
  if (repo.content === null) {
    return <p className="qd-empty">No repo override for this rule.</p>;
  }
  return <pre className="qd-rules-text">{repo.content}</pre>;
};

export const RepoLayer = ({
  view,
  rule,
}: RepoLayerProps): JSX.Element | null => {
  const word = useWording();
  if (!view.showRepoLayer) return null;
  if (rule.repo === null) {
    return (
      <section className="qd-rules-layer" aria-label="Repo layer">
        <p className="qd-empty">
          {view.project} has no repo path, so it has no repo layer.
        </p>
      </section>
    );
  }
  return (
    <section className="qd-rules-layer" aria-label="Repo layer">
      <LayerHeading title="Repo layer" path={rule.repo.path} readOnly />
      <p className="qd-rules-note">
        {word('Committed with the project. Edit it in the repo, not here.')}
        {view.repoNotMerged && ` ${REPO_NOT_MERGED_NOTICE}`}
      </p>
      <RepoBody repo={rule.repo} />
      <RulesAlert message={view.repoError} />
    </section>
  );
};
