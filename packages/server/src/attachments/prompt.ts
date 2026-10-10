import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PromptInput } from '../acp/client/types.js';
import type { AttachmentRef } from '../intents/attachments.js';
import { readAttachment } from './files.js';

export const ATTACHED_PATHS_INTRO =
  'The person attached these images. Open each file to see it:';

export interface PromptPlan {
  record: string;
  input: PromptInput;
}

export const attachmentNote = (ref: AttachmentRef): string =>
  `[image ${ref.id}: ${ref.mimeType}, ${ref.bytes} bytes]`;

export const attachmentPathLine = (ref: AttachmentRef): string =>
  `- ${ref.path} (${ref.mimeType}, ${ref.bytes} bytes)`;

const joinParts = (parts: readonly string[]): string =>
  parts.filter((part) => part !== '').join('\n\n');

const textBlocks = (text: string): ContentBlock[] => {
  if (text === '') return [];
  return [{ type: 'text', text }];
};

const imageBlock = async (ref: AttachmentRef): Promise<ContentBlock> => ({
  type: 'image',
  mimeType: ref.mimeType,
  data: (await readAttachment(ref)).toString('base64'),
});

export const pathsPrompt = (
  text: string,
  refs: readonly AttachmentRef[],
): string =>
  joinParts([
    text,
    [ATTACHED_PATHS_INTRO, ...refs.map(attachmentPathLine)].join('\n'),
  ]);

export const planPrompt = async (
  text: string,
  refs: readonly AttachmentRef[],
  images: boolean,
): Promise<PromptPlan> => {
  if (refs.length === 0) return { record: text, input: text };
  if (!images) {
    const withPaths = pathsPrompt(text, refs);
    return { record: withPaths, input: withPaths };
  }
  const blocks = await Promise.all(refs.map(imageBlock));
  return {
    record: joinParts([text, refs.map(attachmentNote).join('\n')]),
    input: [...textBlocks(text), ...blocks],
  };
};
