import {
  INTENTS,
  INTENT_PATH_PREFIX,
  RULES_PATH,
  RULES_PROJECT_PARAM,
  isIntentName,
  type IntentName,
  type IntentReply,
  type RulesView,
} from '@quarterdeck/server/intents';
import type { z } from 'zod';
import { getErrorMessage } from '../lib/errors.js';

export const DEMO_ORIGIN = 'http://demo.quarterdeck.invalid';

export class DemoRefusal extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DemoRefusal';
    this.status = status;
  }
}

export interface DemoRoutes {
  intent: (name: IntentName, input: unknown) => IntentReply;
  rules: (project: string | null) => RulesView;
  attachment: (pathname: string) => Response | null;
}

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const SERVER_ERROR = 500;

const refused = (err: unknown): Response => {
  if (err instanceof DemoRefusal) {
    return reply(err.status, { error: err.message });
  }
  return reply(SERVER_ERROR, { error: getErrorMessage(err) });
};

const readBody = async (init: RequestInit | undefined): Promise<unknown> => {
  if (typeof init?.body !== 'string') return undefined;
  return JSON.parse(init.body) as unknown;
};

const routeIntent = async (
  routes: DemoRoutes,
  name: string,
  init: RequestInit | undefined,
): Promise<Response> => {
  if (!isIntentName(name)) return reply(404, { error: `No intent ${name}` });
  const schema: z.ZodType = INTENTS[name];
  const parsed = schema.safeParse(await readBody(init));
  if (!parsed.success) {
    return reply(400, { error: `Invalid ${name} intent` });
  }
  return reply(200, routes.intent(name, parsed.data));
};

export const demoFetch = (routes: DemoRoutes): typeof fetch => {
  const answer = async (
    input: string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    try {
      if (url.pathname.startsWith(INTENT_PATH_PREFIX)) {
        const name = url.pathname.slice(INTENT_PATH_PREFIX.length);
        return await routeIntent(routes, name, init);
      }
      if (url.pathname === RULES_PATH) {
        return reply(
          200,
          routes.rules(url.searchParams.get(RULES_PROJECT_PARAM)),
        );
      }
      const attachment = routes.attachment(url.pathname);
      if (attachment !== null) return attachment;
      return reply(404, { error: `${url.pathname} is not in the demo` });
    } catch (err) {
      return refused(err);
    }
  };
  return answer as typeof fetch;
};
