import { useMemo } from 'react';
import { dataPageSchema, type DataPage } from '@quarterdeck/server/intents';
import { useDeck } from '../../deck/deck.js';
import { useIntentQuery, type QueryState } from './use-intent-query.js';

export interface PageRequest {
  project: string | null;
  table: string | null;
  offset: number;
  limit: number;
}

export const useDataPage = (
  { project, table, offset, limit }: PageRequest,
  version: number,
): QueryState<DataPage> => {
  const { intents } = useDeck();
  const load = useMemo(() => {
    if (project === null || table === null) return null;
    return async () => {
      const reply = await intents.data.rows({ project, table, offset, limit });
      return dataPageSchema.parse(reply.result);
    };
  }, [intents, project, table, offset, limit]);
  return useIntentQuery(load, version);
};
