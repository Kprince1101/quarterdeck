import { useEffect, useState } from 'react';
import {
  usageReadResultSchema,
  type UsageReadResult,
} from '@quarterdeck/server/intents';
import { useDeck } from '../../deck/deck.js';
import { getErrorMessage } from '../../lib/errors.js';
import { useNow } from '../../lib/use-now.js';
import { lastTurnEnd } from './usage-model.js';

export interface UsageRead {
  read: UsageReadResult | null;
  error: string | null;
}

interface Loaded extends UsageRead {
  project: string;
}

const NOTHING_READ: UsageRead = { read: null, error: null };

const lastReadOf = (
  last: Loaded | null,
  project: string,
): UsageReadResult | null => {
  if (last?.project !== project) return null;
  return last.read;
};

export const useUsageRead = (): UsageRead => {
  const { intents, stream } = useDeck();
  const project = stream.tables.projects[0]?.slug ?? null;
  const turnEnd = lastTurnEnd(stream.tables.turns);
  const now = useNow();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (project === null) return;
    let live = true;
    intents.usage
      .read({ project })
      .then((reply) => usageReadResultSchema.parse(reply.result))
      .then(
        (read) => {
          if (live) setLoaded({ project, read, error: null });
        },
        (err: unknown) => {
          if (!live) return;
          setLoaded((last) => ({
            project,
            read: lastReadOf(last, project),
            error: getErrorMessage(err),
          }));
        },
      );
    return () => {
      live = false;
    };
  }, [intents, project, turnEnd, now]);

  if (loaded === null || loaded.project !== project) return NOTHING_READ;
  return { read: loaded.read, error: loaded.error };
};
