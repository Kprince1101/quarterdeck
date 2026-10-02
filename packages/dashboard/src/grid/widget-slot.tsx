import type { PaneView } from './panes.js';

export interface WidgetSlotProps {
  panes: PaneView[];
  stacked: boolean;
}

interface PanesProps {
  panes: PaneView[];
}

const PaneStack = ({ panes }: PanesProps) => (
  <div className="qd-widget-stack">
    {panes.map(({ type, title, instanceId, Widget }) => (
      <section
        key={type}
        className="qd-widget-pane"
        aria-label={title}
        data-pane={type}
      >
        <h3 className="qd-widget-pane-title">{title}</h3>
        <Widget instanceId={instanceId} />
      </section>
    ))}
  </div>
);

const SinglePane = ({ panes }: PanesProps) =>
  panes.map(({ type, instanceId, Widget }) => (
    <Widget key={type} instanceId={instanceId} />
  ));

export const WidgetSlot = ({ panes, stacked }: WidgetSlotProps) => {
  if (stacked) return <PaneStack panes={panes} />;
  return <SinglePane panes={panes} />;
};
