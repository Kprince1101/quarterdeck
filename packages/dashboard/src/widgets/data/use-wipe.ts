import { useState, type ChangeEvent, type FormEvent } from 'react';
import {
  WIPE_ALL_CONFIRMATION,
  wipeResultSchema,
  type IntentReply,
} from '@quarterdeck/server/intents';
import { useDeck } from '../../deck/DeckProvider.js';
import { useIntentRequest } from '../use-intent-request.js';
import { wipeSummary } from './data-view.js';

export interface WipeView {
  phrase: string;
  typed: string;
  isWipeDisabled: boolean;
  error: string | null;
  done: string | null;
  handleChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleSubmit: (event: FormEvent) => void;
}

const useWipe = (
  phrase: string,
  send: () => Promise<IntentReply>,
  onWiped: () => void,
): WipeView => {
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { isPending, error, run } = useIntentRequest();
  const isWipeDisabled = typed !== phrase || isPending;

  const wipe = () =>
    run(async () => {
      const reply = await send();
      setDone(wipeSummary(wipeResultSchema.parse(reply.result)));
      setTyped('');
      onWiped();
    });

  return {
    phrase,
    typed,
    isWipeDisabled,
    error,
    done,
    handleChange: ({ currentTarget }) => {
      setTyped(currentTarget.value);
      setDone(null);
    },
    handleSubmit: (event) => {
      event.preventDefault();
      if (!isWipeDisabled) void wipe();
    },
  };
};

export const useWipeProject = (
  project: string,
  onWiped: () => void,
): WipeView => {
  const { intents } = useDeck();
  return useWipe(
    project,
    () => intents.wipe.project({ project, confirm: project }),
    onWiped,
  );
};

export const useWipeAll = (onWiped: () => void): WipeView => {
  const { intents } = useDeck();
  return useWipe(
    WIPE_ALL_CONFIRMATION,
    () => intents.wipe.all({ confirm: WIPE_ALL_CONFIRMATION }),
    onWiped,
  );
};
