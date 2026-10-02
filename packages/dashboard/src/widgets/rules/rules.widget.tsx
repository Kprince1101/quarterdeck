import type { RuleView } from '../../api/index.js';
import { defineWidget } from '../registry.js';
import { TIGHTEN_ONLY_NOTICE } from './constants.js';
import { MachineLayer } from './machine-layer.js';
import { RepoLayer } from './repo-layer.js';
import { ReviewPanel } from './review-panel.js';
import { RulesPickers } from './rules-pickers.js';
import { DefaultsLayer, RulesAlert, RulesStatus } from './rules-parts.js';
import { useRulesWidget, type RulesWidgetView } from './use-rules-widget.js';
import { ValueSources } from './value-sources.js';
import './rules.css';

interface RulesBodyProps {
  view: RulesWidgetView;
}

const RuleLayers = ({ view, rule }: RulesBodyProps & { rule: RuleView }) => (
  <>
    <p className="qd-rules-note qd-rules-tighten">{TIGHTEN_ONLY_NOTICE}</p>
    <RulesStatus message={view.saved} />
    <MachineLayer view={view} rule={rule} />
    <ReviewPanel view={view} rule={rule} />
    <ValueSources sources={view.sources} />
    <RepoLayer view={view} rule={rule} />
    <DefaultsLayer rule={rule} />
  </>
);

const RulesBody = ({ view }: RulesBodyProps) => {
  if (view.isLoading) return <p className="qd-empty">Loading rules…</p>;
  if (view.rule === null) return null;
  return <RuleLayers view={view} rule={view.rule} />;
};

export const RulesWidget = () => {
  const view = useRulesWidget();
  return (
    <div className="qd-rules">
      <RulesPickers view={view} />
      <RulesAlert message={view.loadError} />
      <RulesBody view={view} />
    </div>
  );
};

export default defineWidget({
  type: 'rules',
  title: 'Rules',
  component: RulesWidget,
  size: { w: 6, h: 12 },
  minSize: { w: 4, h: 6 },
  startHidden: true,
});
