import type { JSX } from 'react';
import type { RuleView } from '../../api/index.js';
import { useWording } from '../../deck/DeckProvider.js';
import { defineWidget } from '../registry.js';
import { TIGHTEN_ONLY_NOTICE } from './constants.js';
import { MachineLayer } from './MachineLayer.js';
import { RepoLayer } from './RepoLayer.js';
import { ReviewPanel } from './ReviewPanel.js';
import { RulesPickers } from './RulesPickers.js';
import { DefaultsLayer, RulesAlert, RulesStatus } from './RulesParts.js';
import { useRulesWidget, type RulesWidgetView } from './use-rules-widget.js';
import { ValueSources } from './ValueSources.js';
import './rules.css';

interface RulesBodyProps {
  view: RulesWidgetView;
}

const RuleLayers = ({ view, rule }: RulesBodyProps & { rule: RuleView }) => (
  <>
    <p className="qd-rules-note qd-rules-tighten">
      {useWording()(TIGHTEN_ONLY_NOTICE)}
    </p>
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

export const RulesWidget = (): JSX.Element => {
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
