import { useEffect, useState } from 'react';
import { authReadResultSchema } from '@quarterdeck/server/intents';
import { useDeck } from '../deck/DeckProvider.js';
import { getErrorMessage } from '../lib/errors.js';
import {
  claudeAuthView,
  unreadableAuthView,
  type ClaudeAuthView,
} from './claude-auth-model.js';

export const useClaudeAuthBadge = (): ClaudeAuthView | null => {
  const { intents } = useDeck();
  const [view, setView] = useState<ClaudeAuthView | null>(null);

  useEffect(() => {
    let live = true;
    intents.auth
      .read({})
      .then((reply) => authReadResultSchema.parse(reply.result))
      .then(
        (read) => {
          if (live) setView(claudeAuthView(read.claude));
        },
        (err: unknown) => {
          if (live) setView(unreadableAuthView(getErrorMessage(err)));
        },
      );
    return () => {
      live = false;
    };
  }, [intents]);

  return view;
};
