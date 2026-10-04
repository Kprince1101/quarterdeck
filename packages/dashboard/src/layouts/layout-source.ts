import { readGridLayout, type GridLayout } from '@quarterdeck/server/layouts';
import type { SavedLayout } from '@quarterdeck/server/stream-schema';
import type { StreamState } from '../api/index.js';

export const hasSnapshot = (stream: StreamState): boolean =>
  stream.cursor !== null;

export const savedLayoutOf = (
  layout: SavedLayout | null,
): GridLayout | null => {
  if (layout === null) return null;
  return readGridLayout(layout.spec);
};
