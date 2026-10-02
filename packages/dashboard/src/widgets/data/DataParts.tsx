import type { PageView, PathView } from './data-view.js';
import type { TableView } from './use-data-widget.js';

interface TableListProps {
  tables: TableView[];
}

export const TableList = ({ tables }: TableListProps) => (
  <ul className="qd-data-tables" aria-label="Tables">
    {tables.map(({ table, rows, isSelected, onSelect }) => (
      <li key={table}>
        <button type="button" aria-pressed={isSelected} onClick={onSelect}>
          <span>{table}</span>
          <span className="qd-data-count">{rows}</span>
        </button>
      </li>
    ))}
  </ul>
);

interface PathListProps {
  paths: PathView[];
}

export const PathList = ({ paths }: PathListProps) => (
  <ul className="qd-data-paths" aria-label="On disk">
    {paths.map(({ key, label, path, scope, presence, exists }) => (
      <li key={key} data-exists={exists}>
        <span className="qd-data-path-label">{label}</span>
        <span className="qd-data-path-scope">{scope}</span>
        <code title={path}>{path}</code>
        <span className="qd-data-path-presence">{presence}</span>
      </li>
    ))}
  </ul>
);

interface RowsTableProps {
  page: PageView;
}

export const RowsTable = ({ page }: RowsTableProps) => (
  <div className="qd-data-scroll">
    <table className="qd-data-rows" aria-label={page.label}>
      <thead>
        <tr>
          {page.columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {page.rows.map(({ key, cells }) => (
          <tr key={key}>
            {cells.map((cell, column) => (
              <td key={page.columns[column]} title={cell}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

interface PagerProps {
  page: PageView;
  onPrevious: () => void;
  onNext: () => void;
}

export const Pager = ({ page, onPrevious, onNext }: PagerProps) => (
  <div className="qd-data-pager">
    <span className="qd-data-range">{page.range}</span>
    <button
      type="button"
      className="qd-grid-button"
      disabled={!page.canPrevious}
      onClick={onPrevious}
    >
      Previous
    </button>
    <button
      type="button"
      className="qd-grid-button"
      disabled={!page.canNext}
      onClick={onNext}
    >
      Next
    </button>
  </div>
);
