import { attachmentUrl, type AttachmentRef } from '@quarterdeck/server/intents';
import { bytesToBase64, dataUrl } from '../lib/base64.js';
import { authHeaders, type IntentClientOptions } from './intents.js';

export type AttachmentReader = (
  project: string,
  ref: Pick<AttachmentRef, 'id' | 'mimeType'>,
) => Promise<string>;

export class AttachmentReadError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Reading the image failed with HTTP ${status}`);
    this.name = 'AttachmentReadError';
    this.status = status;
  }
}

export const createAttachmentReader = (
  options: IntentClientOptions = {},
): AttachmentReader => {
  const baseUrl = options.baseUrl ?? '';
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  return async (project, ref) => {
    const response = await send(`${baseUrl}${attachmentUrl(project, ref)}`, {
      headers: authHeaders(options.token),
    });
    if (!response.ok) throw new AttachmentReadError(response.status);
    return dataUrl(ref.mimeType, bytesToBase64(await response.arrayBuffer()));
  };
};
