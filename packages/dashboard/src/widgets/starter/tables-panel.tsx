import { Panel } from '../../shell/shell.js';
import { useTablesPanel } from './use-tables-panel.js';

export const TablesPanel = () => {
  const { counts } = useTablesPanel();
  return (
    <Panel title="Tables">
      <dl className="qd-table-counts">
        {counts.map(({ table, rows }) => (
          <div key={table}>
            <dt>{table}</dt>
            <dd>{rows}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
};
