import type { AuthReadResult } from '@quarterdeck/server/intents';

type ClaudeAuth = AuthReadResult['claude'];

export type ClaudeAuthState = 'ready' | 'incomplete' | 'unreadable';

export interface ClaudeAuthView {
  label: string;
  title: string;
  state: ClaudeAuthState;
}

export const AUTH_MODE_LABELS: Record<ClaudeAuth['mode'], string> = {
  subscription: 'subscription',
  api_key: 'API key',
  vertex: 'Vertex',
};

export const AUTH_SOURCE_TEXT: Record<ClaudeAuth['source'], string> = {
  env: 'set by QUARTERDECK_CLAUDE_AUTH',
  file: 'set in ~/.quarterdeck/claude.json',
  default: 'the default',
};

export const KEY_SOURCE_TEXT: Record<
  NonNullable<ClaudeAuth['keySource']>,
  string
> = {
  env: 'ANTHROPIC_API_KEY from the environment',
  keychain: 'ANTHROPIC_API_KEY from the Keychain',
};

export const AUTH_UNREADABLE_LABEL = 'Claude: auth unreadable';

const detailsOf = (auth: ClaudeAuth): string[] => {
  const details = [
    `Claude auth mode ${auth.mode}, ${AUTH_SOURCE_TEXT[auth.source]}`,
  ];
  if (auth.keySource !== null) details.push(KEY_SOURCE_TEXT[auth.keySource]);
  if (auth.missing.length > 0) {
    details.push(`missing ${auth.missing.join(' and ')}`);
  }
  if (auth.gateway) details.push('through ANTHROPIC_BASE_URL');
  return details;
};

const stateOf = (auth: ClaudeAuth): ClaudeAuthState => {
  if (auth.missing.length > 0) return 'incomplete';
  return 'ready';
};

export const claudeAuthView = (auth: ClaudeAuth): ClaudeAuthView => ({
  label: `Claude: ${AUTH_MODE_LABELS[auth.mode]}`,
  title: detailsOf(auth).join('; '),
  state: stateOf(auth),
});

export const unreadableAuthView = (error: string): ClaudeAuthView => ({
  label: AUTH_UNREADABLE_LABEL,
  title: error,
  state: 'unreadable',
});
