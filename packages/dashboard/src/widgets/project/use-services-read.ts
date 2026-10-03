import { useCallback, useEffect, useState } from 'react';
import {
  servicesReadResultSchema,
  type ServicesReadResult,
} from '@quarterdeck/server/intents';
import { useDeck } from '../../deck/DeckProvider.js';
import { getErrorMessage } from '../../lib/errors.js';

export interface ServicesReadSource {
  read: ServicesReadResult | null;
  loadError: string | null;
  reload: () => Promise<void>;
}

export const useServicesRead = (project: string): ServicesReadSource => {
  const { intents } = useDeck();
  const [read, setRead] = useState<ServicesReadResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchRead = useCallback(
    async () =>
      servicesReadResultSchema.parse(
        (await intents.services.read({ project })).result,
      ),
    [intents, project],
  );

  useEffect(() => {
    let live = true;
    fetchRead().then(
      (next) => {
        if (!live) return;
        setRead(next);
        setLoadError(null);
      },
      (err: unknown) => {
        if (live) setLoadError(getErrorMessage(err));
      },
    );
    return () => {
      live = false;
    };
  }, [fetchRead]);

  const reload = useCallback(async () => {
    setRead(await fetchRead());
  }, [fetchRead]);

  return { read, loadError, reload };
};
