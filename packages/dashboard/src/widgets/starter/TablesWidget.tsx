import type { JSX } from 'react';
import { useWording } from '../../deck/DeckProvider.js';
import { defineWidget } from '../registry.js';
import { useTablesWidget } from './use-tables-widget.js';

export const TablesWidget = (): JSX.Element => {
  const { counts } = useTablesWidget();
  const word = useWording();
  return (
    <dl className="qd-table-counts">
      {counts.map(({ table, rows }) => (
        <div key={table}>
          <dt>{word(table)}</dt>
          <dd>{rows}</dd>
        </div>
      ))}
    </dl>
  );
};

export default defineWidget({
  type: 'tables',
  title: 'Tables',
  component: TablesWidget,
  size: { w: 4, h: 12 },
  minSize: { w: 2, h: 3 },
});
