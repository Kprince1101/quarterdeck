import type { IncomingMessage } from 'node:http';
import { HttpError, badRequest } from './http-error.js';
import { bearerToken, verifyApiToken } from './token.js';

export const MAX_BODY_BYTES = 1024 * 1024;

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
) => {
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

const assertJsonType = (req: IncomingMessage) => {
  const [mediaType = ''] = (req.headers['content-type'] ?? '').split(';');
  if (mediaType.trim().toLowerCase() !== JSON_TYPE) {
    throw new HttpError(415, `Content-Type must be ${JSON_TYPE}`);
  }
};

const tooLarge = () =>
  new HttpError(413, `Body is larger than ${MAX_BODY_BYTES} bytes`, {
    headers: { connection: 'close' },
  });

const readBody = async (req: IncomingMessage): Promise<string> => {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
    throw tooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  assertJsonType(req);
  const text = await readBody(req);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw badRequest('Body is not valid JSON');
  }
};
