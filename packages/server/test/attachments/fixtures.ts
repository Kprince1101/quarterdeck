import type { AttachmentUpload } from '../../src/intents/index.js';

export const PNG_DATA =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const PNG_BYTES = Buffer.from(PNG_DATA, 'base64').length;

export const JPEG_DATA = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
]).toString('base64');

export const GIF_DATA = Buffer.from(
  'GIF89a\x01\x00\x01\x00',
  'latin1',
).toString('base64');

export const WEBP_DATA = Buffer.from(
  'RIFF\x0c\x00\x00\x00WEBPVP8 ',
  'latin1',
).toString('base64');

export const png = (): AttachmentUpload => ({
  mimeType: 'image/png',
  data: PNG_DATA,
});

export const oversized = (): AttachmentUpload => ({
  mimeType: 'image/png',
  data: Buffer.concat([
    Buffer.from(PNG_DATA, 'base64'),
    Buffer.alloc(5 * 1024 * 1024),
  ]).toString('base64'),
});
