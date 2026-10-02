import {
  STREAM_TABLES,
  type StreamTable,
} from '@quarterdeck/server/stream-schema';
import { useDeck } from '../../deck/DeckProvider.js';

export interface TableCount {
  table: StreamTable;
  rows: number;
}

export const useTablesWidget = (): { counts: TableCount[] } => {
  const { tables } = useDeck().stream;
  return {
    counts: STREAM_TABLES.map((table) => ({
      table,
      rows: tables[table].length,
    })),
  };
};
