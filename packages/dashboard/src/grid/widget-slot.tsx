import { TabBar, TabPanel } from '../primitives/index.js';
import type { PaneView } from './panes.js';
import { usePaneTabs } from './use-pane-tabs.js';

export interface WidgetSlotProps {
  label: string;
  panes: PaneView[];
  stacked: boolean;
}

interface PanesProps {
  panes: PaneView[];
}

const Panes = ({ panes }: PanesProps) =>
  panes.map(({ type, instanceId, Widget }) => (
    <Widget key={type} instanceId={instanceId} />
  ));

const PaneTabs = ({ label, panes }: Omit<WidgetSlotProps, 'stacked'>) => {
  const { tabs, panel, activePanes, handleKeyDown } = usePaneTabs(panes);
  return (
    <div className="qd-widget-tabs">
      <TabBar label={label} tabs={tabs} onKeyDown={handleKeyDown} />
      <TabPanel panel={panel}>
        <Panes panes={activePanes} />
      </TabPanel>
    </div>
  );
};

export const WidgetSlot = ({ label, panes, stacked }: WidgetSlotProps) => {
  if (stacked) return <PaneTabs label={label} panes={panes} />;
  return <Panes panes={panes} />;
};
