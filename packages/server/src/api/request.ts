import type { IncomingMessage } from 'node:http';
import {
  ATTACHMENT_INTENTS,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from '../intents/attachments.js';
import { HttpError, badRequest } from './http-error.js';
import { bearerToken, verifyApiToken } from './token.js';

export const MAX_BODY_BYTES = 1024 * 1024;

export const MAX_ATTACHMENT_BODY_BYTES =
  MAX_BODY_BYTES + MAX_ATTACHMENTS * Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;

const JSON_TYPE = 'application/json';

export interface RequestGuard {
  hosts: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  token: string;
}

export const localGuard = (
  port: number,
  token: string,
  extraOrigins: readonly string[] = [],
): RequestGuard => {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([
    ...[...hosts].map((host) => `http://${host}`),
    ...extraOrigins,
  ]);
  return { hosts, origins, token };
};

export const assertLocalRequest = (
  req: IncomingMessage,
  guard: RequestGuard,
): void => {
  if (!guard.hosts.has(req.headers.host ?? '')) {
    throw new HttpError(403, 'Host not allowed');
  }
  const { origin } = req.headers;
  if (origin !== undefined && !guard.origins.has(origin)) {
    throw new HttpError(403, 'Origin not allowed');
  }
};

export const isAuthorized = (
  req: IncomingMessage,
  guard: RequestGuard,
): boolean => verifyApiToken(guard.token, bearerToken(req.headers));

export const maxBodyBytes = (intent: string): number => {
  if (ATTACHMENT_INTENTS.includes(intent)) return MAX_ATTACHMENT_BODY_BYTES;
  return MAX_BODY_BYTES;
};

const assertJsonType = (req: IncomingMessage) => {
  const [mediaType = ''] = (req.headers['content-type'] ?? '').split(';');
  if (mediaType.trim().toLowerCase() !== JSON_TYPE) {
    throw new HttpError(415, `Content-Type must be ${JSON_TYPE}`);
  }
};

const tooLarge = (limit: number) =>
  new HttpError(413, `Body is larger than ${limit} bytes`, {
    headers: { connection: 'close' },
  });

const readBody = async (
  req: IncomingMessage,
  limit: number,
): Promise<string> => {
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    throw tooLarge(limit);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) throw tooLarge(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const readJsonBody = async (
  req: IncomingMessage,
  limit: number = MAX_BODY_BYTES,
): Promise<unknown> => {
  assertJsonType(req);
  const text = await readBody(req, limit);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest('Body is not valid JSON');
  }
};
