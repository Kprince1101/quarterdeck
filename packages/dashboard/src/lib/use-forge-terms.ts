import { useEffect, useState } from 'react';
import {
  DEFAULT_FORGE,
  forgeTerms,
  type ForgeTerms,
} from '@quarterdeck/rules/forges';
import { forgeReadResultSchema } from '@quarterdeck/server/intents';
import { useDeck } from '../deck/DeckProvider.js';
import { getErrorMessage } from './errors.js';

export interface ForgeTermsRead {
  terms: ForgeTerms;
  isRead: boolean;
  error: string | null;
}

interface Loaded extends ForgeTermsRead {
  project: string;
}

const UNREAD: ForgeTermsRead = {
  terms: forgeTerms(DEFAULT_FORGE),
  isRead: false,
  error: null,
};

export const useForgeTerms = (
  project: string,
  enabled = true,
): ForgeTermsRead => {
  const { intents } = useDeck();
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    intents.forge
      .read({ project })
      .then((reply) => forgeReadResultSchema.parse(reply.result))
      .then(
        (read) => {
          if (live)
            setLoaded({
              project,
              terms: forgeTerms(read.forge),
              isRead: true,
              error: null,
            });
        },
        (err: unknown) => {
          if (live)
            setLoaded({ project, ...UNREAD, error: getErrorMessage(err) });
        },
      );
    return () => {
      live = false;
    };
  }, [intents, project, enabled]);

  if (!enabled || loaded?.project !== project) return UNREAD;
  return { terms: loaded.terms, isRead: loaded.isRead, error: loaded.error };
};
