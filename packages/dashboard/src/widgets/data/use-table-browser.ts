import { useCallback, useState } from 'react';
import { DATA_PAGE_SIZE } from '@quarterdeck/server/intents';
import { previousOffset } from './data-view.js';

export interface TableBrowser {
  table: string | null;
  offset: number;
  limit: number;
  select: (table: string) => void;
  handlePrevious: () => void;
  handleNext: () => void;
}

interface Position {
  table: string | null;
  offset: number;
}

const START: Position = { table: null, offset: 0 };

export const useTableBrowser = (
  limit: number = DATA_PAGE_SIZE,
): TableBrowser => {
  const [position, setPosition] = useState<Position>(START);
  const select = useCallback(
    (table: string) => setPosition({ table, offset: 0 }),
    [],
  );
  const handlePrevious = useCallback(
    () =>
      setPosition((at) => ({
        ...at,
        offset: previousOffset(at.offset, limit),
      })),
    [limit],
  );
  const handleNext = useCallback(
    () => setPosition((at) => ({ ...at, offset: at.offset + limit })),
    [limit],
  );
  return { ...position, limit, select, handlePrevious, handleNext };
};
