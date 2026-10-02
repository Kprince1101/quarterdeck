import { readGridLayout, type GridLayout } from '@quarterdeck/server/layouts';
import type { LayoutRow, ProjectRow } from '@quarterdeck/server/stream-schema';

export const projectOf = (projects: readonly ProjectRow[]): string | null =>
  projects[0]?.slug ?? null;

export const savedLayoutOf = (
  layouts: readonly LayoutRow[],
  name: string,
): GridLayout | null => {
  const row = layouts.find((layout) => layout.name === name);
  if (row === undefined) return null;
  return readGridLayout(row.spec);
};
