import { useCallback, useEffect, useState } from 'react';
import { setupReadResultSchema } from '@quarterdeck/server/intents';
import {
  intents as pageIntents,
  readRules as pageRules,
  type IntentClient,
  type RulesReader,
} from '../api/index.js';
import type { SetupSources } from './use-setup-screen.js';

export type AppScreen = 'board' | 'setup';

export interface SetupGate {
  showsSetup: boolean;
  sources: SetupSources;
  handleDone: () => void;
}

export interface SetupGateSources {
  intents?: IntentClient | undefined;
  rules?: RulesReader | undefined;
}

export const useSetupGate = ({
  intents = pageIntents,
  rules = pageRules,
}: SetupGateSources): SetupGate => {
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
  return {
    showsSetup: screen === 'setup',
    sources: { intents, rules },
    handleDone,
  };
};
