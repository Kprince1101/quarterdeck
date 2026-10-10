import type { AuthMethod } from '@agentclientprotocol/sdk';
import type { Runtime } from '@quarterdeck/rules';
import { openInBrowser } from '../acp/auth/open-url.js';
import type {
  SignInDriver,
  SignInOutcome,
  SignInProgress,
} from '../acp/auth/types.js';
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
export const RETRY_SIGN_IN = 'Retry';
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
  signIn?: () => SignInDriver | undefined;
  openUrl?: (url: string) => Promise<void>;
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
  checked: `${operation} failed with auth required: ${getErrorMessage(err)}.`,
  recommendation: signIn.command,
});

const automatedCard = (
  signIn: SignInCommand,
  operation: SignInOperation,
  err: unknown,
): CardInput => ({
  kind: SIGN_IN_CARD,
  question: `Sign in to ${signIn.displayName}`,
  options: [],
  checked: `${operation} failed with auth required: ${getErrorMessage(err)}. Quarterdeck is running ${signIn.displayName}'s own sign-in.`,
  recommendation: signIn.command,
  signIn: { status: 'starting' },
});

const fallbackQuestion = (signIn: SignInCommand): string =>
  `Sign in to ${signIn.displayName}: Quarterdeck could not sign you in. ${signIn.steps}${alternativesText(signIn)} Then answer "${SIGNED_IN}", or "${RETRY_SIGN_IN}" to run the sign-in again.`;

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

interface SignInCardRaised extends RaisedCard {
  joined: boolean;
}

const raiseOrJoin = (
  gate: SignInGate,
  card: CardInput,
  notice: CardNotice,
): Promise<SignInCardRaised> =>
  gate.store.db.transaction(async (tx) => {
    const { projectId } = gate.store;
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
      `${SIGN_IN_CARD}:${projectId}:${gate.runtime}`,
    ]);
    const open = await findOpenSignIn(tx, projectId, gate.runtime);
    const expiryMs = gate.expiryMs ?? SIGN_IN_EXPIRY_MS;
    if (!open) {
      const raised = await insertCard(
        tx,
        projectId,
        gate.agentId,
        card,
        expiryMs,
        [notice],
      );
      return { ...raised, joined: false };
    }
    const ticketId = await activeTicketId(tx, projectId, gate.agentId);
    const links = { agent_id: gate.agentId, ticket_id: ticketId };
    await publishCardNotices(tx, projectId, open.id, links, [notice]);
    return {
      cardId: open.id,
      ticketId,
      expiresAt: open.expires_at,
      joined: true,
    };
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

interface SignInRound {
  gate: SignInGate;
  signIn: SignInCommand;
  operation: SignInOperation;
  err: unknown;
}

const requiredNotice = (round: SignInRound): CardNotice => ({
  kind: SIGN_IN_EVENTS.required,
  payload: {
    runtime: round.signIn.runtime,
    command: round.signIn.command,
    operation: round.operation,
    error: getErrorMessage(round.err),
  },
});

const resume = (
  round: SignInRound,
  raised: RaisedCard,
  extra: Record<string, unknown> = {},
) =>
  round.gate.store.publish(
    resumedEvent(round.gate, raised.ticketId, {
      cardId: raised.cardId,
      runtime: round.signIn.runtime,
      operation: round.operation,
      ...extra,
    }),
  );

const settle = async (
  round: SignInRound,
  raised: RaisedCard,
  outcome: CardOutcome,
): Promise<void> => {
  if (isUnanswered(outcome)) {
    throw new SignInRequiredError(round.signIn, outcome, round.err);
  }
  await resume(round, raised);
};

const waitOnCard = async (
  round: SignInRound,
  raised: RaisedCard,
): Promise<void> => {
  const outcome = await awaitCard(round.gate.store, raised.cardId, {
    expiryMs: remainingMs(raised.expiresAt),
    signal: round.gate.signal ?? new AbortController().signal,
  });
  await settle(round, raised, outcome);
};

const setSignInState = async (
  store: BusStore,
  cardId: string,
  state: SignInProgress,
): Promise<void> => {
  await store.db.query(
    `update cards set sign_in = $3::jsonb
     where id = $1 and project_id = $2 and status = 'open'`,
    [cardId, store.projectId, JSON.stringify(state)],
  );
};

const markSignedIn = async (
  store: BusStore,
  cardId: string,
  state: SignInProgress,
): Promise<void> => {
  await store.db.query(
    `update cards set status = 'answered', answer = $3, answered_at = now(),
       sign_in = $4::jsonb
     where id = $1 and project_id = $2 and status = 'open'`,
    [
      cardId,
      store.projectId,
      SIGNED_IN,
      JSON.stringify({ ...state, status: 'signed_in' }),
    ],
  );
};

const showFallback = async (
  round: SignInRound,
  cardId: string,
  state: SignInProgress,
  reason: string,
): Promise<void> => {
  const { store } = round.gate;
  await store.db.query(
    `update cards set question = $3, checked = $4, options = $5::jsonb,
       sign_in = $6::jsonb
     where id = $1 and project_id = $2 and status = 'open'`,
    [
      cardId,
      store.projectId,
      fallbackQuestion(round.signIn),
      `Automatic sign-in failed: ${reason}`,
      JSON.stringify([RETRY_SIGN_IN, SIGNED_IN]),
      JSON.stringify({ ...state, status: 'failed', message: reason }),
    ],
  );
};

interface DriveResult {
  outcome: SignInOutcome;
  state: SignInProgress;
  settled: CardOutcome | undefined;
}

const driveCard = async (
  round: SignInRound,
  driver: SignInDriver,
  raised: RaisedCard,
): Promise<DriveResult> => {
  const { gate } = round;
  const stop = new AbortController();
  const signals = [stop.signal];
  if (gate.signal) signals.push(gate.signal);
  const signal = AbortSignal.any(signals);
  const watching = awaitCard(gate.store, raised.cardId, {
    expiryMs: remainingMs(raised.expiresAt),
    signal: stop.signal,
  }).then(
    (outcome) => {
      stop.abort();
      return outcome;
    },
    () => undefined,
  );
  let state: SignInProgress = { status: 'starting' };
  let updates = Promise.resolve();
  const onProgress = (progress: SignInProgress) => {
    state = progress;
    updates = updates
      .then(() => setSignInState(gate.store, raised.cardId, progress))
      .catch(() => undefined);
  };
  try {
    const outcome = await driver({
      tty: false,
      signal,
      onProgress,
      openUrl: gate.openUrl ?? ((url) => openInBrowser(url)),
    });
    stop.abort();
    return { outcome, state, settled: await watching };
  } finally {
    stop.abort();
    await updates;
  }
};

export interface SignInAttempt {
  signedIn: boolean;
}

const stillRequired = (signIn: SignInCommand): DriveResult => ({
  outcome: {
    ok: false,
    reason: `${signIn.displayName} signed in but still answered auth required`,
  },
  state: { status: 'starting' },
  settled: undefined,
});

const driveOrStop = (
  round: SignInRound,
  driver: SignInDriver,
  raised: RaisedCard,
  attempt: SignInAttempt,
): Promise<DriveResult> => {
  if (attempt.signedIn) return Promise.resolve(stillRequired(round.signIn));
  return driveCard(round, driver, raised);
};

const signInAutomatically = async (
  round: SignInRound,
  driver: SignInDriver,
  attempt: SignInAttempt,
): Promise<void> => {
  const raised = await raiseOrJoin(
    round.gate,
    automatedCard(round.signIn, round.operation, round.err),
    requiredNotice(round),
  );
  if (raised.joined) {
    await waitOnCard(round, raised);
    return;
  }
  const result = await driveOrStop(round, driver, raised, attempt);
  if (result.settled) {
    await settle(round, raised, result.settled);
    return;
  }
  if (result.outcome.ok) {
    await markSignedIn(round.gate.store, raised.cardId, result.state);
    attempt.signedIn = true;
    await resume(round, raised, { via: result.outcome.via });
    return;
  }
  attempt.signedIn = false;
  await showFallback(round, raised.cardId, result.state, result.outcome.reason);
  await waitOnCard(round, raised);
};

const awaitSignIn = async (
  gate: SignInGate,
  operation: SignInOperation,
  err: unknown,
  attempt: SignInAttempt,
): Promise<void> => {
  const signIn = signInCommand(gate.runtime, gate.authMethods?.());
  const round: SignInRound = { gate, signIn, operation, err };
  const driver = gate.signIn?.();
  if (driver) {
    await signInAutomatically(round, driver, attempt);
    return;
  }
  const raised = await raiseOrJoin(
    gate,
    signInCard(signIn, operation, err),
    requiredNotice(round),
  );
  await waitOnCard(round, raised);
};

export const withSignIn = async <T>(
  gate: SignInGate,
  operation: SignInOperation,
  run: () => Promise<T>,
): Promise<T> => {
  const attempt: SignInAttempt = { signedIn: false };
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (!isAuthRequiredError(err)) throw err;
      await awaitSignIn(gate, operation, err, attempt);
    }
  }
};
