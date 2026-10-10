import type { AuthMethod } from '@agentclientprotocol/sdk';
import type { Runtime } from '@quarterdeck/rules';

export const CLAUDE_BROWSER_AUTH_METHOD = 'claude-ai-login';
export const KIRO_BROWSER_AUTH_METHOD = 'kiro-login';
export const GEMINI_BROWSER_AUTH_METHOD = 'oauth-personal';

export const BROWSER_AUTH_METHODS: Readonly<Record<Runtime, string>> = {
  claude: CLAUDE_BROWSER_AUTH_METHOD,
  kiro: KIRO_BROWSER_AUTH_METHOD,
  gemini: GEMINI_BROWSER_AUTH_METHOD,
};

export type TerminalAuthMethod = Extract<AuthMethod, { type: 'terminal' }>;

export const isTerminalAuthMethod = (
  method: AuthMethod,
): method is TerminalAuthMethod =>
  'type' in method && method.type === 'terminal';

export const findAuthMethod = (
  authMethods: readonly AuthMethod[] | undefined,
  methodId: string,
): AuthMethod | undefined =>
  authMethods?.find((method) => method.id === methodId);

export const authMethodIds = (
  authMethods: readonly AuthMethod[] | undefined,
): string => {
  const ids = (authMethods ?? []).map((method) => method.id);
  if (ids.length === 0) return 'none';
  return ids.join(', ');
};
