import { EventsPanel } from './starter/events-panel.js';
import { TablesPanel } from './starter/tables-panel.js';

export const WidgetMount = () => (
  <div className="qd-widgets" data-widget-mount="">
    <TablesPanel />
    <EventsPanel />
  </div>
);
