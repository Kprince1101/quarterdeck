import { z } from 'zod';
import { MAX_TEXT_LENGTH } from './fields.js';

export const ATTACHMENT_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const;

export type AttachmentType = keyof typeof ATTACHMENT_EXTENSIONS;

export const ATTACHMENT_TYPES = Object.keys(
  ATTACHMENT_EXTENSIONS,
) as AttachmentType[];

export const MAX_ATTACHMENTS = 5;

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export const ATTACHMENT_INTENTS: readonly string[] = [
  'planner.message',
  'card.answer',
];

export const ATTACHMENT_TYPE_REFUSAL =
  'Only PNG, JPEG, GIF and WebP images can be attached.';

export const ATTACHMENT_SIZE_REFUSAL = 'Each image must be 5 MB or smaller.';

export const ATTACHMENT_COUNT_REFUSAL = `Attach at most ${MAX_ATTACHMENTS} images to a message.`;

export const EMPTY_MESSAGE_REFUSAL = 'A message needs text or an image.';

export const ATTACHMENT_PATH_PREFIX = '/api/attachments/';

export const isAttachmentType = (type: string): type is AttachmentType =>
  Object.hasOwn(ATTACHMENT_EXTENSIONS, type);

const paddingOf = (data: string): number => {
  if (data.endsWith('==')) return 2;
  if (data.endsWith('=')) return 1;
  return 0;
};

export const base64Bytes = (data: string): number =>
  Math.floor((data.length * 3) / 4) - paddingOf(data);

export const attachmentTypeSchema = z.enum(ATTACHMENT_TYPES, {
  error: ATTACHMENT_TYPE_REFUSAL,
});

export const attachmentUploadSchema = z.strictObject({
  mimeType: attachmentTypeSchema,
  data: z
    .base64()
    .refine((data) => base64Bytes(data) > 0, 'The image is empty.')
    .refine(
      (data) => base64Bytes(data) <= MAX_ATTACHMENT_BYTES,
      ATTACHMENT_SIZE_REFUSAL,
    ),
});

export const attachmentUploadsSchema = z
  .array(attachmentUploadSchema)
  .max(MAX_ATTACHMENTS, ATTACHMENT_COUNT_REFUSAL)
  .default([]);

export const attachmentRefSchema = z.object({
  id: z.uuid(),
  mimeType: attachmentTypeSchema,
  bytes: z.int().positive(),
  path: z.string(),
});

export const attachmentRefsSchema = z.array(attachmentRefSchema);

export const messageTextSchema = z
  .string()
  .trim()
  .max(MAX_TEXT_LENGTH)
  .default('');

export type AttachmentUpload = z.infer<typeof attachmentUploadSchema>;

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export const hasTextOrAttachments = (
  text: string,
  attachments: readonly unknown[],
): boolean => text !== '' || attachments.length > 0;

export const attachmentFileName = (
  ref: Pick<AttachmentRef, 'id' | 'mimeType'>,
): string => `${ref.id}.${ATTACHMENT_EXTENSIONS[ref.mimeType]}`;

export const attachmentUrl = (
  project: string,
  ref: Pick<AttachmentRef, 'id' | 'mimeType'>,
): string =>
  `${ATTACHMENT_PATH_PREFIX}${encodeURIComponent(project)}/${attachmentFileName(ref)}`;

export const attachmentRefsOf = (value: unknown): AttachmentRef[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    const parsed = attachmentRefSchema.safeParse(item);
    if (!parsed.success) return [];
    return [parsed.data];
  });
};
