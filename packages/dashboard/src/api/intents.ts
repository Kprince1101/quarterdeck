import type { z } from 'zod';
import {
  INTENTS,
  INTENT_NAMES,
  intentPath,
  type IntentErrorReply,
  type IntentInput,
  type IntentIssue,
  type IntentName,
  type IntentReply,
} from '@quarterdeck/server/intents';

export type IntentGroup = IntentName extends `${infer Group}.${string}`
  ? Group
  : never;

export type IntentReplyOf<N extends IntentName> = IntentReply & { intent: N };

export interface IntentSendOptions {
  keepalive?: boolean | undefined;
}

export type IntentSender<N extends IntentName> = (
  input: IntentInput<N>,
  options?: IntentSendOptions,
) => Promise<IntentReplyOf<N>>;

export type IntentClient = {
  [Group in IntentGroup]: {
    [
      N in IntentName as N extends `${Group}.${infer Action}` ? Action : never
    ]: IntentSender<N>;
  };
};

export interface IntentClientOptions {
  baseUrl?: string | undefined;
  token?: string | undefined;
  fetch?: typeof fetch;
}

export const authHeaders = (
  token: string | undefined,
): Record<string, string> => {
  if (token === undefined) return {};
  return { authorization: `Bearer ${token}` };
};

export class IntentError extends Error {
  readonly intent: IntentName;
  readonly status: number;
  readonly issues: IntentIssue[] | undefined;
  readonly sent: boolean;

  constructor(
    intent: IntentName,
    status: number,
    reply: IntentErrorReply,
    sent: boolean,
  ) {
    super(reply.error);
    this.name = 'IntentError';
    this.intent = intent;
    this.status = status;
    this.issues = reply.issues;
    this.sent = sent;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export const KEEPALIVE_BODY_LIMIT = 64 * 1024;

const PAYLOAD_TOO_LARGE = 413;

const keepaliveInit = (
  name: IntentName,
  body: string,
  options: IntentSendOptions | undefined,
): { keepalive?: true } => {
  if (options?.keepalive !== true) return {};
  const bytes = new TextEncoder().encode(body).length;
  if (bytes > KEEPALIVE_BODY_LIMIT) {
    throw new IntentError(
      name,
      PAYLOAD_TOO_LARGE,
      {
        error: `${name} is ${bytes} bytes; a request sent as the page closes may carry at most ${KEEPALIVE_BODY_LIMIT}`,
      },
      false,
    );
  }
  return { keepalive: true };
};

const toIssues = (error: z.ZodError): IntentIssue[] =>
  error.issues.map(({ path, message }) => ({ path, message }));

const isErrorReply = (body: unknown): body is IntentErrorReply =>
  typeof body === 'object' &&
  body !== null &&
  typeof (body as { error?: unknown }).error === 'string';

const errorReply = (
  name: IntentName,
  status: number,
  body: unknown,
): IntentErrorReply => {
  if (isErrorReply(body)) return body;
  return { error: `${name} failed with HTTP ${status}` };
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
};

export type SendIntent = <N extends IntentName>(
  name: N,
  input: IntentInput<N>,
  options?: IntentSendOptions,
) => Promise<IntentReplyOf<N>>;

export const createIntentSender = (
  options: IntentClientOptions = {},
): SendIntent => {
  const baseUrl = options.baseUrl ?? '';
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  const headers = { ...JSON_HEADERS, ...authHeaders(options.token) };

  return async <N extends IntentName>(
    name: N,
    input: IntentInput<N>,
    sendOptions?: IntentSendOptions,
  ): Promise<IntentReplyOf<N>> => {
    const schema: z.ZodType = INTENTS[name];
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new IntentError(
        name,
        400,
        { error: `Invalid ${name} intent`, issues: toIssues(parsed.error) },
        false,
      );
    }
    const body = JSON.stringify(input);
    const keepalive = keepaliveInit(name, body, sendOptions);
    const response = await send(`${baseUrl}${intentPath(name)}`, {
      method: 'POST',
      headers,
      body,
      ...keepalive,
    });
    const reply = await readJson(response);
    if (!response.ok) {
      const refusal = errorReply(name, response.status, reply);
      throw new IntentError(name, response.status, refusal, true);
    }
    return reply as IntentReplyOf<N>;
  };
};

export const createIntentClient = (
  options: IntentClientOptions = {},
): IntentClient => {
  const sendIntent = createIntentSender(options);
  const client: Record<string, Record<string, unknown>> = {};
  INTENT_NAMES.forEach((name) => {
    const [group = name, action = name] = name.split('.');
    const actions = (client[group] ??= {});
    actions[action] = (
      input: IntentInput<typeof name>,
      options?: IntentSendOptions,
    ) => sendIntent(name, input, options);
  });
  return client as IntentClient;
};
