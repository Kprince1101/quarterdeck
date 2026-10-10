import {
  ATTACHMENT_COUNT_REFUSAL,
  ATTACHMENT_SIZE_REFUSAL,
  ATTACHMENT_TYPES,
  ATTACHMENT_TYPE_REFUSAL,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  isAttachmentType,
  type AttachmentType,
  type AttachmentUpload,
} from '@quarterdeck/server/intents';
import { bytesToBase64, dataUrl } from '../lib/base64.js';

export const ATTACH_ACCEPT = ATTACHMENT_TYPES.join(',');

export const ATTACH_LABEL = 'Attach images';

export interface AttachableFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface DraftImage extends AttachmentUpload {
  key: string;
  src: string;
}

export interface FileCheck {
  accepted: AttachableFile[];
  refusal: string | null;
}

interface FileItem {
  readonly kind: string;
  getAsFile: () => AttachableFile | null;
}

export interface FileSource {
  readonly files?: ArrayLike<AttachableFile> | null | undefined;
  readonly items?: ArrayLike<FileItem> | null | undefined;
}

const fileRefusal = (file: AttachableFile): string | null => {
  if (!isAttachmentType(file.type))
    return `${file.name}: ${ATTACHMENT_TYPE_REFUSAL}`;
  if (file.size > MAX_ATTACHMENT_BYTES)
    return `${file.name}: ${ATTACHMENT_SIZE_REFUSAL}`;
  return null;
};

const joinRefusals = (refusals: readonly string[]): string | null => {
  if (refusals.length === 0) return null;
  return refusals.join(' ');
};

export const checkFiles = (
  files: readonly AttachableFile[],
  attached: number,
): FileCheck => {
  const fitting = files.filter((file) => fileRefusal(file) === null);
  const room = Math.max(MAX_ATTACHMENTS - attached, 0);
  const refusals = files.flatMap((file) => fileRefusal(file) ?? []);
  if (fitting.length > room) refusals.push(ATTACHMENT_COUNT_REFUSAL);
  return { accepted: fitting.slice(0, room), refusal: joinRefusals(refusals) };
};

const itemFiles = (items: ArrayLike<FileItem>): AttachableFile[] =>
  Array.from(items).flatMap((item) => {
    if (item.kind !== 'file') return [];
    return item.getAsFile() ?? [];
  });

export const filesOf = (source: FileSource | null): AttachableFile[] => {
  if (source === null) return [];
  const files = Array.from(source.files ?? []);
  if (files.length > 0) return files;
  return itemFiles(source.items ?? []);
};

export const hasFiles = (types: readonly string[] | undefined): boolean =>
  types?.includes('Files') ?? false;

export const readDraftImage = async (
  file: AttachableFile,
  key: string,
): Promise<DraftImage> => {
  const mimeType = file.type as AttachmentType;
  const data = bytesToBase64(await file.arrayBuffer());
  return { key, mimeType, data, src: dataUrl(mimeType, data) };
};

export const uploadsOf = (images: readonly DraftImage[]): AttachmentUpload[] =>
  images.map(({ mimeType, data }) => ({ mimeType, data }));

export const withAttachments = <Input extends object>(
  input: Input,
  attachments: readonly AttachmentUpload[],
): Input & { attachments?: AttachmentUpload[] } => {
  if (attachments.length === 0) return input;
  return { ...input, attachments: [...attachments] };
};
