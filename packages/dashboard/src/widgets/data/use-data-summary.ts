import { useMemo } from 'react';
import {
  dataSummarySchema,
  type DataSummary,
} from '@quarterdeck/server/intents';
import { useDeck } from '../../deck/deck.js';
import { useIntentQuery, type QueryState } from './use-intent-query.js';

export const useDataSummary = (
  project: string | null,
  version: number | string,
): QueryState<DataSummary> => {
  const { intents } = useDeck();
  const load = useMemo(() => {
    if (project === null) return null;
    return async () => {
      const reply = await intents.data.summary({ project });
      return dataSummarySchema.parse(reply.result);
    };
  }, [intents, project]);
  return useIntentQuery(load, version);
};
