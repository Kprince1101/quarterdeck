import type { ReactNode } from 'react';
import {
  createIntentClient,
  createRulesReader,
  takePageToken,
  type StreamOptions,
  type TokenPage,
} from './api/index.js';
import { App } from './App.js';
import type { DeckSources } from './deck/DeckProvider.js';
import { TokenMissing } from './shell/TokenMissing.js';

export interface LiveOptions {
  baseUrl?: string | undefined;
  stream?: Omit<StreamOptions, 'token'> | undefined;
  page?: TokenPage | undefined;
}

export const liveSources = (
  token: string,
  { baseUrl, stream }: LiveOptions = {},
): DeckSources => ({
  intents: createIntentClient({ baseUrl, token }),
  rules: createRulesReader({ baseUrl, token }),
  stream: { ...stream, token },
});

export const livePage = (options: LiveOptions = {}): ReactNode => {
  const token = takePageToken(options.page);
  if (token === null) return <TokenMissing />;
  return <App {...liveSources(token, options)} />;
};
