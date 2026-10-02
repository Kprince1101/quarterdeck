import {
  rulesUrl,
  rulesViewSchema,
  type RulesView,
} from '@quarterdeck/server/intents';
import { authHeaders, type IntentClientOptions } from './intents.js';

export type RulesReader = (project: string | null) => Promise<RulesView>;

export class RulesReadError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RulesReadError';
    this.status = status;
  }
}

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

const errorOf = (status: number, body: unknown): string => {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body;
    if (typeof error === 'string') return error;
  }
  return `Reading the rules failed with HTTP ${status}`;
};

export const createRulesReader = (
  options: IntentClientOptions = {},
): RulesReader => {
  const baseUrl = options.baseUrl ?? '';
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  return async (project) => {
    const response = await send(`${baseUrl}${rulesUrl(project)}`, {
      headers: { accept: 'application/json', ...authHeaders(options.token) },
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new RulesReadError(response.status, errorOf(response.status, body));
    }
    const parsed = rulesViewSchema.safeParse(body);
    if (!parsed.success) {
      throw new RulesReadError(response.status, 'The rules reply is malformed');
    }
    return parsed.data;
  };
};
