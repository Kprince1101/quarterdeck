import { useMemo } from 'react';
import {
  intents as pageIntents,
  useStream,
  type IntentClient,
  type StreamOptions,
  type StreamState,
} from '../api/index.js';

export interface Deck {
  stream: StreamState;
  intents: IntentClient;
}

export interface DeckSources {
  stream?: StreamOptions | undefined;
  intents?: IntentClient | undefined;
}

export const useDeckProvider = ({
  stream: streamOptions,
  intents = pageIntents,
}: DeckSources): Deck => {
  const stream = useStream(streamOptions);
  return useMemo(() => ({ stream, intents }), [stream, intents]);
};
