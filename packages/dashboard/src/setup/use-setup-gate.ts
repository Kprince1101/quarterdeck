import { useCallback, useEffect, useState } from 'react';
import { setupReadResultSchema } from '@quarterdeck/server/intents';
import { intents as pageIntents, type IntentClient } from '../api/index.js';

export type AppScreen = 'board' | 'setup';

export interface SetupGate {
  showsSetup: boolean;
  intents: IntentClient;
  handleDone: () => void;
}

export const useSetupGate = (
  intents: IntentClient = pageIntents,
): SetupGate => {
  const [screen, setScreen] = useState<AppScreen>('board');

  useEffect(() => {
    let live = true;
    intents.setup
      .read({})
      .then((reply) => setupReadResultSchema.parse(reply.result))
      .then(
        ({ needsSetup }) => {
          if (live && needsSetup) setScreen('setup');
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [intents]);

  const handleDone = useCallback(() => setScreen('board'), []);
  return { showsSetup: screen === 'setup', intents, handleDone };
};
