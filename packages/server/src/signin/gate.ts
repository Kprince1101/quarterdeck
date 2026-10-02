import type { AuthMethod } from '@agentclientprotocol/sdk';
import type { Runtime } from '@quarterdeck/rules';
import { isAuthRequiredError } from '../acp/client/errors.js';
import {
  ASK_EXPIRY_MAX_MS,
  activeTicketId,
  awaitCard,
  insertCard,
  publishCardNotices,
  type CardInput,
  type CardNotice,
  type CardOutcome,
  type CardOutcomeStatus,
  type RaisedCard,
} from '../bus/cards.js';
import type { BusStore } from '../bus/tool.js';
import { getErrorMessage } from '../lib/errors.js';
import type { PublishInput, Queryable } from '../store/index.js';
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
  authMethods?: () => readonly AuthMethod[] | undefined;
  expiryMs?: number;
  signal?: AbortSignal | undefined;
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

const alternativesText = (signIn: SignInCommand): string => {
  if (signIn.alternatives.length === 0) return '';
  const commands = signIn.alternatives.map((command) => `\`${command}\``);
  return ` Or sign in another way: ${commands.join(', ')}.`;
};

const signInCard = (
  signIn: SignInCommand,
  operation: SignInOperation,
  err: unknown,
): CardInput => ({
  kind: SIGN_IN_CARD,
  question: `${signIn.displayName} needs you to sign in. ${signIn.steps}${alternativesText(signIn)} Then answer "${SIGNED_IN}" and the session picks up where it stopped.`,
  options: [SIGNED_IN],
  checked: `${operation} failed with auth required: ${getErrorMessage(err)}. Quarterdeck never signs in for you.`,
  recommendation: signIn.command,
});

const isUnanswered = (outcome: CardOutcome): outcome is UnansweredOutcome =>
  outcome.status !== 'answered';

const findOpenSignIn = async (
  tx: Queryable,
  projectId: string,
  runtime: Runtime,
): Promise<{ id: string; expires_at: Date } | undefined> => {
  const { rows } = await tx.query<{ id: string; expires_at: Date }>(
    `select c.id, c.expires_at from cards c
     where c.project_id = $1 and c.kind = $2 and c.status = 'open'
       and c.expires_at > now()
       and exists (
         select 1 from events e
         where e.project_id = $1 and e.kind = $3
           and e.payload->>'cardId' = c.id::text
           and e.payload->>'runtime' = $4)
     order by c.created_at limit 1`,
    [projectId, SIGN_IN_CARD, SIGN_IN_EVENTS.required, runtime],
  );
  return rows[0];
};

const raiseOrJoin = (
  gate: SignInGate,
  card: CardInput,
  notice: CardNotice,
): Promise<RaisedCard> =>
  gate.store.db.transaction(async (tx) => {
    const { projectId } = gate.store;
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
      `${SIGN_IN_CARD}:${projectId}:${gate.runtime}`,
    ]);
    const open = await findOpenSignIn(tx, projectId, gate.runtime);
    const expiryMs = gate.expiryMs ?? SIGN_IN_EXPIRY_MS;
    if (!open)
      return insertCard(tx, projectId, gate.agentId, card, expiryMs, [notice]);
    const ticketId = await activeTicketId(tx, projectId, gate.agentId);
    const links = { agent_id: gate.agentId, ticket_id: ticketId };
    await publishCardNotices(tx, projectId, open.id, links, [notice]);
    return { cardId: open.id, ticketId, expiresAt: open.expires_at };
  });

const remainingMs = (expiresAt: Date): number =>
  Math.min(Math.max(expiresAt.getTime() - Date.now(), 1), ASK_EXPIRY_MAX_MS);

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
  const signIn = signInCommand(gate.runtime, gate.authMethods?.());
  const raised = await raiseOrJoin(gate, signInCard(signIn, operation, err), {
    kind: SIGN_IN_EVENTS.required,
    payload: {
      runtime: signIn.runtime,
      command: signIn.command,
      operation,
      error: getErrorMessage(err),
    },
  });
  const outcome = await awaitCard(gate.store, raised.cardId, {
    expiryMs: remainingMs(raised.expiresAt),
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
