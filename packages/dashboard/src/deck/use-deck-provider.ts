import { useMemo } from 'react';
import {
  intents as pageIntents,
  readAttachment as pageAttachments,
  readRules as pageRules,
  useStream,
  type AttachmentReader,
  type IntentClient,
  type RulesReader,
  type StreamOptions,
  type StreamState,
} from '../api/index.js';

export interface Deck {
  stream: StreamState;
  intents: IntentClient;
  rules: RulesReader;
  attachments: AttachmentReader;
}

export interface DeckSources {
  stream?: StreamOptions | undefined;
  intents?: IntentClient | undefined;
  rules?: RulesReader | undefined;
  attachments?: AttachmentReader | undefined;
}

export const useDeckProvider = ({
  stream: streamOptions,
  intents = pageIntents,
  rules = pageRules,
  attachments = pageAttachments,
}: DeckSources): Deck => {
  const stream = useStream(streamOptions);
  return useMemo(
    () => ({ stream, intents, rules, attachments }),
    [stream, intents, rules, attachments],
  );
};
