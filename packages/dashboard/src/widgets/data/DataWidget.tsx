import type { JSX } from 'react';
import type { WorkspaceMode } from '../../api/index.js';
import { defineWidget } from '../registry.js';
import { Pager, PathList, RowsTable, TableList } from './DataParts.js';
import type { PageView } from './data-view.js';
import { useDataWidget, type DataWidgetView } from './use-data-widget.js';
import { WipeSection } from './WipeSection.js';

interface RowsSectionProps {
  page: PageView | null;
  error: string | null;
  onPrevious: () => void;
  onNext: () => void;
}

const RowsSection = ({ page, error, onPrevious, onNext }: RowsSectionProps) => {
  if (error !== null) return <p className="qd-data-error">{error}</p>;
  if (page === null) {
    return <p className="qd-empty">Pick a table to page through its rows.</p>;
  }
  return (
    <section className="qd-data-section" aria-label="Rows">
      <h3>{page.table}</h3>
      <Pager page={page} onPrevious={onPrevious} onNext={onNext} />
      <RowsTable page={page} />
    </section>
  );
};

const StoredData = ({ view }: { view: DataWidgetView }) => {
  if (view.summaryError !== null) {
    return <p className="qd-data-error">{view.summaryError}</p>;
  }
  return (
    <>
      <TableList tables={view.tables} />
      <RowsSection
        page={view.page}
        error={view.pageError}
        onPrevious={view.handlePrevious}
        onNext={view.handleNext}
      />
      <section className="qd-data-section" aria-label="On disk">
        <h3>On disk</h3>
        <PathList paths={view.paths} />
      </section>
    </>
  );
};

const WAITING: Record<WorkspaceMode, string> = {
  multi: 'Waiting for the project.',
  single: 'Waiting for the repository.',
};

const WorkspaceLine = ({ line }: { line: string | null }) => {
  if (line === null) return null;
  return (
    <p className="qd-data-workspace">
      <span>Workspace</span> {line}
    </p>
  );
};

export const DataWidget = (): JSX.Element => {
  const view = useDataWidget();
  if (view.project === null) {
    return <p className="qd-empty">{WAITING[view.mode]}</p>;
  }
  return (
    <div className="qd-data" aria-busy={view.isLoading}>
      <div className="qd-data-toolbar">
        <button
          type="button"
          className="qd-grid-button"
          onClick={view.handleRefresh}
        >
          Refresh
        </button>
      </div>
      <WorkspaceLine line={view.workspace} />
      <StoredData view={view} />
      <WipeSection
        project={view.project}
        mode={view.mode}
        onWiped={view.handleRefresh}
      />
    </div>
  );
};

export default defineWidget({
  type: 'data',
  title: 'Data',
  component: DataWidget,
  size: { w: 4, h: 12 },
  minSize: { w: 3, h: 4 },
});
