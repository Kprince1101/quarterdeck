import type {
  ContentBlock,
  InitializeResponse,
} from '@agentclientprotocol/sdk';
import { AcpClientError } from './errors.js';

export const acceptsImages = (agent: InitializeResponse): boolean =>
  agent.agentCapabilities?.promptCapabilities?.image === true;

const agentLabel = (agent: InitializeResponse): string =>
  agent.agentInfo?.title ?? agent.agentInfo?.name ?? 'This agent';

export const imageRefusal = (agent: InitializeResponse): string =>
  `${agentLabel(agent)} does not accept images in a prompt (it does not set promptCapabilities.image), so the prompt was not sent. Send each image's file path as text instead.`;

export const assertPromptContent = (
  agent: InitializeResponse,
  blocks: readonly ContentBlock[],
): void => {
  if (acceptsImages(agent)) return;
  if (!blocks.some((block) => block.type === 'image')) return;
  throw new AcpClientError(imageRefusal(agent), 'image_unsupported');
};
