import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionId,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import {
  loadPermissionLayers,
  type Decision,
  type PermissionLayers,
} from '@quarterdeck/rules';
import { CANCELLED_PERMISSION } from '../client/permission-gate.js';
import type { PermissionHandler } from '../client/types.js';
import { decidePermission } from './decide.js';
import { describeToolCall, type ToolRequest } from './tool-request.js';

export type CardAnswer = 'allow' | 'deny';

export interface PermissionCard {
  sessionId: SessionId;
  toolCall: ToolCallUpdate;
  request: ToolRequest;
}

export type CardHuman = (card: PermissionCard) => Promise<CardAnswer>;

export type LoadPermissionLayers = () => Promise<PermissionLayers>;

export interface PermissionPolicyOptions {
  repoDir: string;
  cardHuman: CardHuman;
  loadLayers?: LoadPermissionLayers;
  onRulesError?: (err: unknown) => void;
}

type Answer = 'allow' | 'refuse';

const OPTION_PREFERENCE: Record<Answer, readonly PermissionOptionKind[]> = {
  allow: ['allow_once'],
  refuse: ['reject_once', 'reject_always'],
};

const pickOption = (
  options: readonly PermissionOption[],
  answer: Answer,
): PermissionOption | undefined =>
  OPTION_PREFERENCE[answer]
    .map((kind) => options.find((option) => option.kind === kind))
    .find((option) => option !== undefined);

export const answerPermission = (
  options: readonly PermissionOption[],
  answer: Answer,
): RequestPermissionResponse => {
  const option = pickOption(options, answer);
  if (option) {
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
  if (answer === 'allow') return answerPermission(options, 'refuse');
  return CANCELLED_PERMISSION;
};

const askHuman = async (
  cardHuman: CardHuman,
  card: PermissionCard,
): Promise<Answer> => {
  try {
    if ((await cardHuman(card)) === 'allow') return 'allow';
    return 'refuse';
  } catch {
    return 'refuse';
  }
};

export const createPermissionPolicy = ({
  repoDir,
  cardHuman,
  loadLayers = () => loadPermissionLayers({ repoDir }),
  onRulesError = () => {},
}: PermissionPolicyOptions): PermissionHandler => {
  const lookUp = async (request: ToolRequest): Promise<Decision> => {
    try {
      return decidePermission(await loadLayers(), request, repoDir);
    } catch (err) {
      onRulesError(err);
      return 'deny';
    }
  };

  const settle = async (
    permission: RequestPermissionRequest,
  ): Promise<Answer> => {
    const request = describeToolCall(permission.toolCall, repoDir);
    const decision = await lookUp(request);
    if (decision === 'allow') return 'allow';
    if (decision === 'deny') return 'refuse';
    return askHuman(cardHuman, {
      sessionId: permission.sessionId,
      toolCall: permission.toolCall,
      request,
    });
  };

  return async (permission) => {
    const answer = await settle(permission).catch((): Answer => 'refuse');
    return answerPermission(permission.options, answer);
  };
};
