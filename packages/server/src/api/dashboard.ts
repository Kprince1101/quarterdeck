import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { hasErrorCode } from '../lib/errors.js';
import { HttpError, notFound } from './http-error.js';

const INDEX_FILE = 'index.html';

const HTML_TYPE = 'text/html; charset=utf-8';

const CONTENT_TYPES: Record<string, string> = {
  '.html': HTML_TYPE,
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const SAFE_HEADERS = {
  'cache-control': 'no-cache',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
};

export const DASHBOARD_PLACEHOLDER = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Quarterdeck</title>
  </head>
  <body>
    <main>
      <h1>Quarterdeck is running</h1>
      <p>The dashboard has not been built yet. The API is up at <code>/api/intents/</code>.</p>
    </main>
  </body>
</html>
`;

const readFileIfPresent = async (path: string): Promise<Buffer | undefined> => {
  try {
    if (!(await stat(path)).isFile()) return undefined;
    return await readFile(path);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT') || hasErrorCode(err, 'ENOTDIR')) {
      return undefined;
    }
    throw err;
  }
};

const decodePath = (pathname: string): string => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    throw notFound(`No file at ${pathname}`);
  }
};

const fileInside = (root: string, pathname: string): string | undefined => {
  const path = decodePath(pathname);
  if (path.includes('\0')) return undefined;
  const target = resolve(join(root, path));
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === '..') return undefined;
  return target;
};

const send = (
  req: IncomingMessage,
  res: ServerResponse,
  type: string,
  body: Buffer | string,
) => {
  res.writeHead(200, {
    ...SAFE_HEADERS,
    'content-type': type,
    'content-length': Buffer.byteLength(body),
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
};

const contentType = (path: string): string =>
  CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';

const serveFromDir = async (
  root: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> => {
  const target = fileInside(root, pathname);
  if (target === undefined) return false;
  const file = await readFileIfPresent(target);
  if (file === undefined) return false;
  send(req, res, contentType(target), file);
  return true;
};

const readIndex = async (root: string | undefined) => {
  if (!root) return undefined;
  return readFileIfPresent(join(root, INDEX_FILE));
};

export const serveDashboard = async (
  dashboardDir: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'The dashboard is read with GET', {
      headers: { allow: 'GET, HEAD' },
    });
  }
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const root = dashboardDir && resolve(dashboardDir);
  if (root && (await serveFromDir(root, pathname, req, res))) return;
  if (extname(pathname) !== '') throw notFound(`No file at ${pathname}`);
  const index = await readIndex(root);
  send(req, res, HTML_TYPE, index ?? DASHBOARD_PLACEHOLDER);
};
