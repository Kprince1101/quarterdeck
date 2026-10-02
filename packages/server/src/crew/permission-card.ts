import type {
  CardAnswer,
  CardHuman,
  PermissionCard,
} from '../acp/permissions/index.js';
import { ASK_EXPIRY_MS, awaitCard, raiseCard } from '../bus/cards.js';
import type { BusStore } from '../bus/tool.js';

export const PERMISSION_CARD = 'agent.permission';
export const ALLOW_ANSWER = 'allow';
export const DENY_ANSWER = 'deny';

export interface PermissionCardOptions {
  store: BusStore;
  agent: { id: string; name: string };
  signal: AbortSignal;
  expiryMs?: number;
}

const subjectsOf = (card: PermissionCard): string[] => {
  const { request } = card;
  const subjects = [...request.paths];
  if (request.command !== undefined) subjects.unshift(request.command);
  if (request.url !== undefined) subjects.unshift(request.url);
  return subjects;
};

export const permissionQuestion = (
  agentName: string,
  card: PermissionCard,
): string => {
  const title = card.toolCall.title ?? card.request.kind;
  const subjects = subjectsOf(card);
  if (subjects.length === 0) return `${agentName} asks to run ${title}.`;
  return `${agentName} asks to run ${title}: ${subjects.join(', ')}.`;
};

export const cardPermissions =
  (options: PermissionCardOptions): CardHuman =>
  async (card): Promise<CardAnswer> => {
    const expiryMs = options.expiryMs ?? ASK_EXPIRY_MS;
    const raised = await raiseCard(
      options.store,
      options.agent.id,
      {
        kind: PERMISSION_CARD,
        question: permissionQuestion(options.agent.name, card),
        options: [ALLOW_ANSWER, DENY_ANSWER],
        checked: `The permission rules leave a ${card.request.kind} request at ask.`,
        recommendation: `Allow it only if ${options.agent.name} should do this in ${card.request.cwd}.`,
      },
      expiryMs,
    );
    const outcome = await awaitCard(options.store, raised.cardId, {
      expiryMs,
      signal: options.signal,
    });
    if (outcome.status === 'answered' && outcome.answer === ALLOW_ANSWER)
      return 'allow';
    return 'deny';
  };
