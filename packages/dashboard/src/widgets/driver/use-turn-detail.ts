import { useEffect, useState } from 'react';
import {
  turnReadResultSchema,
  type TurnReadResult,
} from '@quarterdeck/server/intents';
import type { TurnRow } from '@quarterdeck/server/stream-schema';
import type { IntentClient } from '../../api/index.js';
import { getErrorMessage } from '../../lib/errors.js';

export type TurnDetail =
  | { status: 'loading' }
  | { status: 'ready'; read: TurnReadResult }
  | { status: 'failed'; error: string };

interface Loaded {
  key: string;
  detail: TurnDetail;
}

const LOADING: TurnDetail = { status: 'loading' };

const readKey = (turn: TurnRow | null): string | null => {
  if (turn === null) return null;
  return `${turn.id}:${turn.endedAt ?? 'running'}`;
};

export const useTurnDetail = (
  intents: IntentClient,
  project: string | null,
  turn: TurnRow | null,
): TurnDetail | null => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = readKey(turn);
  const turnId = turn?.id;

  useEffect(() => {
    if (project === null || key === null || turnId === undefined) return;
    let current = true;
    const settle = (detail: TurnDetail) => {
      if (current) setLoaded({ key, detail });
    };
    intents.turn
      .read({ project, turnId })
      .then((reply) => {
        settle({
          status: 'ready',
          read: turnReadResultSchema.parse(reply.result),
        });
      })
      .catch((err: unknown) => {
        settle({ status: 'failed', error: getErrorMessage(err) });
      });
    return () => {
      current = false;
    };
  }, [intents, project, key, turnId]);

  if (key === null || project === null) return null;
  if (loaded?.key !== key) return LOADING;
  return loaded.detail;
};
