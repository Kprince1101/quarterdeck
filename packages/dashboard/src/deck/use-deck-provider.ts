import { useMemo } from 'react';
import {
  intents as pageIntents,
  readRules as pageRules,
  useStream,
  type IntentClient,
  type RulesReader,
  type StreamOptions,
  type StreamState,
} from '../api/index.js';

export interface Deck {
  stream: StreamState;
  intents: IntentClient;
  rules: RulesReader;
}

export interface DeckSources {
  stream?: StreamOptions | undefined;
  intents?: IntentClient | undefined;
  rules?: RulesReader | undefined;
}

export const useDeckProvider = ({
  stream: streamOptions,
  intents = pageIntents,
  rules = pageRules,
}: DeckSources): Deck => {
  const stream = useStream(streamOptions);
  return useMemo(() => ({ stream, intents, rules }), [stream, intents, rules]);
};
