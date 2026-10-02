import { useCallback, useMemo, useState } from 'react';
import type { DataPage, TableCount } from '@quarterdeck/server/intents';
import { useDeck } from '../../deck/DeckProvider.js';
import {
  pageView,
  pathViews,
  projectSlugOf,
  type PageView,
  type PathView,
} from './data-view.js';
import { useDataPage } from './use-data-page.js';
import { useDataSummary } from './use-data-summary.js';
import { useTableBrowser } from './use-table-browser.js';

export interface TableView {
  table: string;
  rows: number;
  isSelected: boolean;
  onSelect: () => void;
}

export interface DataWidgetView {
  project: string | null;
  isLoading: boolean;
  summaryError: string | null;
  tables: TableView[];
  paths: PathView[];
  page: PageView | null;
  pageError: string | null;
  handlePrevious: () => void;
  handleNext: () => void;
  handleRefresh: () => void;
}

const NO_COUNTS: TableCount[] = [];

const tableViews = (
  counts: readonly TableCount[],
  selected: string | null,
  select: (table: string) => void,
): TableView[] =>
  counts.map(({ table, rows }) => ({
    table,
    rows,
    isSelected: table === selected,
    onSelect: () => select(table),
  }));

const optionalPageView = (page: DataPage | null): PageView | null => {
  if (page === null) return null;
  return pageView(page);
};

export const useDataWidget = (): DataWidgetView => {
  const { stream } = useDeck();
  const project = projectSlugOf(stream.tables.projects);
  const [refreshes, setRefreshes] = useState(0);
  const browser = useTableBrowser();
  const summary = useDataSummary(project, `${stream.cursor}:${refreshes}`);
  const { table, offset, limit } = browser;
  const rows = useDataPage({ project, table, offset, limit }, refreshes);
  const counts = summary.data?.tables ?? NO_COUNTS;
  const tables = useMemo(
    () => tableViews(counts, table, browser.select),
    [counts, table, browser.select],
  );
  const paths = useMemo(
    () => pathViews(summary.data?.paths ?? []),
    [summary.data],
  );
  const page = useMemo(() => optionalPageView(rows.data), [rows.data]);
  const handleRefresh = useCallback(
    () => setRefreshes((count) => count + 1),
    [],
  );
  return {
    project,
    isLoading: summary.isLoading || rows.isLoading,
    summaryError: summary.error,
    tables,
    paths,
    page,
    pageError: rows.error,
    handlePrevious: browser.handlePrevious,
    handleNext: browser.handleNext,
    handleRefresh,
  };
};
