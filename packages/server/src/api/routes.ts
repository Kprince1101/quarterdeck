import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import {
  INTENTS,
  INTENT_PATH_PREFIX,
  isIntentName,
  type IntentErrorReply,
  type IntentIssue,
  type IntentReply,
  type IntentStatus,
} from '../intents/index.js';
import type { ApiContext } from './context.js';
import { serveDashboard } from './dashboard.js';
import { dispatchIntent } from './dispatch.js';
import { HttpError, badRequest, notFound } from './http-error.js';
import {
  assertLocalRequest,
  readJsonBody,
  type RequestGuard,
} from './request.js';

const API_PATH = '/api';

const STATUS_CODES: Record<IntentStatus, number> = {
  applied: 200,
  pending: 202,
};

const toIssues = (error: z.ZodError): IntentIssue[] =>
  error.issues.map(({ path, message }) => ({ path, message }));

const intentNameOf = (req: IncomingMessage): string => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  if (!pathname.startsWith(INTENT_PATH_PREFIX)) {
    throw notFound(`No route for ${pathname}`);
  }
  return decodeURIComponent(pathname.slice(INTENT_PATH_PREFIX.length));
};

const isApiPath = (req: IncomingMessage): boolean => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  return pathname === API_PATH || pathname.startsWith(`${API_PATH}/`);
};

const routeIntent = async (
  ctx: ApiContext,
  req: IncomingMessage,
): Promise<IntentReply> => {
  const name = intentNameOf(req);
  if (!isIntentName(name)) throw notFound(`Unknown intent ${name}`);
  if (req.method !== 'POST') {
    throw new HttpError(405, 'Intents are sent with POST', {
      headers: { allow: 'POST' },
    });
  }
  const parsed = INTENTS[name].safeParse(await readJsonBody(req));
  if (!parsed.success) {
    throw badRequest(`Invalid ${name} intent`, toIssues(parsed.error));
  }
  return dispatchIntent(ctx, name, parsed.data);
};

const sendJson = (
  res: ServerResponse,
  status: number,
  body: IntentReply | IntentErrorReply,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const sendError = (res: ServerResponse, err: unknown) => {
  if (err instanceof HttpError) {
    sendJson(res, err.status, err.toJSON(), err.headers);
    return;
  }
  console.error(err);
  sendJson(res, 500, { error: 'Internal error' });
};

export const handleRequest = async (
  ctx: ApiContext,
  guard: RequestGuard,
  req: IncomingMessage,
  res: ServerResponse,
  dashboardDir?: string,
): Promise<void> => {
  try {
    assertLocalRequest(req, guard);
    if (!isApiPath(req)) {
      await serveDashboard(dashboardDir, req, res);
      return;
    }
    const reply = await routeIntent(ctx, req);
    sendJson(res, STATUS_CODES[reply.status], reply);
  } catch (err) {
    sendError(res, err);
  }
};
