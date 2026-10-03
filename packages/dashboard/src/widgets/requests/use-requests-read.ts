import { useEffect, useState } from 'react';
import {
  forgeRequestsResultSchema,
  type ProjectRequests,
} from '@quarterdeck/server/intents';
import { useDeck } from '../../deck/DeckProvider.js';
import { getErrorMessage } from '../../lib/errors.js';
import { useNow } from '../../lib/use-now.js';
import { lastTicketEvent } from './requests-model.js';

export interface RequestsRead {
  projects: ProjectRequests[] | null;
  error: string | null;
  now: number;
}

interface Loaded {
  projects: ProjectRequests[] | null;
  error: string | null;
}

const NOTHING_READ: Loaded = { projects: null, error: null };

export const useRequestsRead = (): RequestsRead => {
  const { intents, stream } = useDeck();
  const hasProject = stream.tables.projects.length > 0;
  const ticketEvent = lastTicketEvent(stream.events);
  const now = useNow();
  const [loaded, setLoaded] = useState<Loaded>(NOTHING_READ);

  useEffect(() => {
    if (!hasProject) return;
    let live = true;
    intents.forge
      .requests({})
      .then((reply) => forgeRequestsResultSchema.parse(reply.result))
      .then(
        (read) => {
          if (live) setLoaded({ projects: read.projects, error: null });
        },
        (err: unknown) => {
          if (!live) return;
          setLoaded((last) => ({
            projects: last.projects,
            error: getErrorMessage(err),
          }));
        },
      );
    return () => {
      live = false;
    };
  }, [intents, hasProject, ticketEvent, now]);

  return { ...loaded, now };
};
