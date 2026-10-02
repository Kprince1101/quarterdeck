import type { Runtime } from '@quarterdeck/rules';
import { isAuthRequiredError } from '../acp/client/errors.js';
import {
  awaitCard,
  raiseCard,
  type CardInput,
  type CardOutcome,
  type CardOutcomeStatus,
} from '../bus/cards.js';
import type { BusStore } from '../bus/tool.js';
import { getErrorMessage } from '../lib/errors.js';
import type { PublishInput } from '../store/index.js';
import { signInCommand, type SignInCommand } from './commands.js';

export const SIGN_IN_CARD = 'auth.sign_in';
export const SIGNED_IN = 'Signed in';
export const SIGN_IN_EXPIRY_MS = 24 * 60 * 60 * 1000;

export const SIGN_IN_EVENTS = {
  required: 'agent.auth_required',
  resumed: 'agent.auth_resumed',
} as const;

export type SignInOperation = 'session/new' | 'session/prompt';

export interface SignInGate {
  store: BusStore;
  agentId: string;
  runtime: Runtime;
  expiryMs?: number;
  signal?: AbortSignal;
}

type UnansweredStatus = Exclude<CardOutcomeStatus, 'answered'>;

interface UnansweredOutcome extends CardOutcome {
  status: UnansweredStatus;
}

export class SignInRequiredError extends Error {
  readonly runtime: Runtime;
  readonly command: string;
  readonly cardId: string;
  readonly status: UnansweredStatus;

  constructor(
    signIn: SignInCommand,
    outcome: UnansweredOutcome,
    cause: unknown,
  ) {
    super(
      `${signIn.displayName} is not signed in and sign-in card ${outcome.cardId} was ${outcome.status}; run \`${signIn.command}\` to sign in`,
      { cause },
    );
    this.name = 'SignInRequiredError';
    this.runtime = signIn.runtime;
    this.command = signIn.command;
    this.cardId = outcome.cardId;
    this.status = outcome.status;
  }
}

const signInCard = (
  signIn: SignInCommand,
  operation: SignInOperation,
  err: unknown,
): CardInput => ({
  kind: SIGN_IN_CARD,
  question: `${signIn.displayName} needs you to sign in. ${signIn.steps} Then answer "${SIGNED_IN}" and the session picks up where it stopped.`,
  options: [SIGNED_IN],
  checked: `${operation} failed with auth required: ${getErrorMessage(err)}. Quarterdeck never signs in for you.`,
  recommendation: signIn.command,
});

const isUnanswered = (outcome: CardOutcome): outcome is UnansweredOutcome =>
  outcome.status !== 'answered';

const resumedEvent = (
  gate: SignInGate,
  ticketId: string | null,
  payload: Record<string, unknown>,
): PublishInput => {
  const event: PublishInput = {
    kind: SIGN_IN_EVENTS.resumed,
    agentId: gate.agentId,
    payload,
  };
  if (ticketId !== null) event.ticketId = ticketId;
  return event;
};

const awaitSignIn = async (
  gate: SignInGate,
  operation: SignInOperation,
  err: unknown,
): Promise<void> => {
  const signIn = signInCommand(gate.runtime);
  const expiryMs = gate.expiryMs ?? SIGN_IN_EXPIRY_MS;
  const raised = await raiseCard(
    gate.store,
    gate.agentId,
    signInCard(signIn, operation, err),
    expiryMs,
    [
      {
        kind: SIGN_IN_EVENTS.required,
        payload: {
          runtime: signIn.runtime,
          command: signIn.command,
          operation,
          error: getErrorMessage(err),
        },
      },
    ],
  );
  const outcome = await awaitCard(gate.store, raised.cardId, {
    expiryMs,
    signal: gate.signal ?? new AbortController().signal,
  });
  if (isUnanswered(outcome))
    throw new SignInRequiredError(signIn, outcome, err);
  await gate.store.publish(
    resumedEvent(gate, raised.ticketId, {
      cardId: raised.cardId,
      runtime: signIn.runtime,
      operation,
    }),
  );
};

export const withSignIn = async <T>(
  gate: SignInGate,
  operation: SignInOperation,
  run: () => Promise<T>,
): Promise<T> => {
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;
      await awaitSignIn(gate, operation, err);
    }
  }
};
