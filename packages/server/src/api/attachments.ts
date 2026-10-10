import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import {
  AttachmentError,
  removeAttachments,
  saveAttachments,
} from '../attachments/index.js';
import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_PATH_PREFIX,
  type AttachmentRef,
  type AttachmentType,
  type AttachmentUpload,
} from '../intents/index.js';
import { hasErrorCode } from '../lib/errors.js';
import { PROJECT_SLUG } from '../lib/slug.js';
import { projectAttachmentsDir } from '../store/index.js';
import type { ApiContext } from './context.js';
import { HttpError, badRequest, notFound } from './http-error.js';

const ATTACHMENT_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.([a-z]+)$/;

const TYPE_OF_EXTENSION: ReadonlyMap<string, AttachmentType> = new Map(
  Object.entries(ATTACHMENT_EXTENSIONS).map(([type, extension]) => [
    extension,
    type as AttachmentType,
  ]),
);

export const isAttachmentPath = (pathname: string): boolean =>
  pathname.startsWith(ATTACHMENT_PATH_PREFIX);

export const withSavedAttachments = async <Reply>(
  ctx: ApiContext,
  project: string,
  uploads: readonly AttachmentUpload[],
  record: (attachments: AttachmentRef[]) => Promise<Reply>,
): Promise<Reply> => {
  if (uploads.length > 0) await ctx.stores.get(project);
  const dir = projectAttachmentsDir(project, ctx.stores.dataHome);
  const attachments = await saveAttachments(dir, uploads).catch(
    (err: unknown) => {
      if (err instanceof AttachmentError) throw badRequest(err.message);
      throw err;
    },
  );
  try {
    return await record(attachments);
  } catch (err) {
    await removeAttachments(attachments);
    throw err;
  }
};

interface AttachmentFile {
  path: string;
  type: AttachmentType;
}

const attachmentFile = (ctx: ApiContext, pathname: string): AttachmentFile => {
  const missing = notFound(`No attachment at ${pathname}`);
  const [project = '', file = '', ...rest] = pathname
    .slice(ATTACHMENT_PATH_PREFIX.length)
    .split('/');
  if (rest.length > 0 || !PROJECT_SLUG.test(project)) throw missing;
  const type = TYPE_OF_EXTENSION.get(ATTACHMENT_FILE.exec(file)?.[1] ?? '');
  if (type === undefined) throw missing;
  const dir = projectAttachmentsDir(project, ctx.stores.dataHome);
  return { path: join(dir, file), type };
};

const readAttachmentFile = async (path: string): Promise<Buffer> => {
  try {
    return await readFile(path);
  } catch (err) {
    if (hasErrorCode(err, 'ENOENT')) throw notFound('The image is gone');
    throw err;
  }
};

export const serveAttachment = async (
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> => {
  if (req.method !== 'GET') {
    throw new HttpError(405, 'Attachments are read with GET', {
      headers: { allow: 'GET' },
    });
  }
  const file = attachmentFile(ctx, pathname);
  const bytes = await readAttachmentFile(file.path);
  res.writeHead(200, {
    'content-type': file.type,
    'content-length': String(bytes.length),
    'cache-control': 'private, max-age=86400, immutable',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
};
