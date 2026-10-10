import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ATTACHMENT_SIZE_REFUSAL,
  MAX_ATTACHMENT_BYTES,
  attachmentFileName,
  type AttachmentRef,
  type AttachmentType,
  type AttachmentUpload,
} from '../intents/attachments.js';
import { PRIVATE_FILE_MODE, ensurePrivateDir } from '../lib/private-fs.js';

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const GIF_SIGNATURES = ['GIF87a', 'GIF89a'];

const ascii = (bytes: Buffer, start: number, end: number): string =>
  bytes.toString('latin1', start, end);

const SIGNATURES: Record<AttachmentType, (bytes: Buffer) => boolean> = {
  'image/png': (bytes) =>
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE),
  'image/jpeg': (bytes) =>
    bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE),
  'image/gif': (bytes) => GIF_SIGNATURES.includes(ascii(bytes, 0, 6)),
  'image/webp': (bytes) =>
    ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP',
};

interface DecodedAttachment {
  ref: AttachmentRef;
  bytes: Buffer;
}

const decode = (
  dir: string,
  upload: AttachmentUpload,
  index: number,
): DecodedAttachment => {
  const label = `Image ${index + 1}`;
  const bytes = Buffer.from(upload.data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES)
    throw new AttachmentError(`${label}: ${ATTACHMENT_SIZE_REFUSAL}`);
  if (!SIGNATURES[upload.mimeType](bytes))
    throw new AttachmentError(
      `${label} is not a valid ${upload.mimeType} file.`,
    );
  const id = randomUUID();
  const path = join(dir, attachmentFileName({ id, mimeType: upload.mimeType }));
  return {
    ref: { id, mimeType: upload.mimeType, bytes: bytes.length, path },
    bytes,
  };
};

export const removeAttachments = async (
  refs: readonly Pick<AttachmentRef, 'path'>[],
): Promise<void> => {
  await Promise.all(refs.map(({ path }) => rm(path, { force: true })));
};

const writeAttachment = ({ ref, bytes }: DecodedAttachment): Promise<void> =>
  writeFile(ref.path, bytes, { mode: PRIVATE_FILE_MODE, flag: 'wx' });

export const saveAttachments = async (
  dir: string,
  uploads: readonly AttachmentUpload[],
): Promise<AttachmentRef[]> => {
  const decoded = uploads.map((upload, index) => decode(dir, upload, index));
  if (decoded.length === 0) return [];
  const refs = decoded.map(({ ref }) => ref);
  await ensurePrivateDir(dir);
  try {
    await Promise.all(decoded.map(writeAttachment));
  } catch (err) {
    await removeAttachments(refs);
    throw err;
  }
  return refs;
};

export const readAttachment = (
  ref: Pick<AttachmentRef, 'path'>,
): Promise<Buffer> => readFile(ref.path);
