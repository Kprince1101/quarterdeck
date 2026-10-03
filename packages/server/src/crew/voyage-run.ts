import { z } from 'zod';
import {
  applyBuilderAction,
  builderActionSchema,
  type BuilderActionOutcome,
  type BuilderContext,
  type DriverAction,
  type DriverVoyage,
  type DriverTurnOutcome,
  type TurnRecord,
} from '../driver/index.js';
import { getErrorMessage } from '../lib/errors.js';
import type { VoyageDriver } from '../voyage-end/index.js';
import type { Store } from '../store/index.js';
import {
  actionDoneNote,
  actionFailedNote,
  builderFailedNote,
  builderTurnNote,
  composeTurnInput,
  humanNote,
  readNoteTicket,
  ticketLabel,
  type DriverNote,
  type NoteBuilder,
} from './driver-notes.js';
import type { CrewFailureReporter } from './failures.js';

export const MAX_RETRY_TURNS = 3;

export interface VoyageRunOptions {
  store: Store;
  voyage: DriverVoyage;
  charter: string;
  builders: BuilderContext;
  report: CrewFailureReporter;
}

export interface VoyageRun {
  voyageId: string;
  driver: VoyageDriver;
  builders: BuilderContext;
  note: (note: DriverNote) => void;
  message: (text: string) => void;
  watchBuilder: (
    builder: NoteBuilder,
    ticketId: string | null,
    turn: Promise<TurnRecord>,
  ) => void;
  idle: () => Promise<void>;
  close: () => void;
}

const outcomeNote = (outcome: BuilderActionOutcome): DriverNote | undefined => {
  if (outcome.kind !== 'assign') return undefined;
  const { assignment } = outcome;
  return actionDoneNote(
    `Assigned ${ticketLabel(assignment.ticket)} to ${assignment.builder.name} (builder ${assignment.builder.id}).`,
  );
};

export const startVoyageRun = (options: VoyageRunOptions): VoyageRun => {
  const { store, voyage } = options;
  const links = { voyageId: voyage.voyage.id, agentId: voyage.agent.id };
  const pending: DriverNote[] = [];
  let turning: Promise<void> | undefined;
  let retries = 0;
  let broken = false;
  let closed = false;

  const wantsTurn = (): boolean => {
    if (pending.some((note) => note.wake === 'event')) return true;
    return (
      pending.some((note) => note.wake === 'retry') && retries < MAX_RETRY_TURNS
    );
  };

  const note = (next: DriverNote): void => {
    if (closed) return;
    pending.push(next);
    pump();
  };

  const ticketOf = async (ticketId: string | null) => {
    if (ticketId === null) return undefined;
    return readNoteTicket(store, ticketId);
  };

  const watchBuilder = (
    builder: NoteBuilder,
    ticketId: string | null,
    turn: Promise<TurnRecord>,
  ): void => {
    turn
      .then(
        async (record) => {
          const ticket = await ticketOf(ticketId);
          note(builderTurnNote(builder, record.stopReason, ticket));
        },
        (err: unknown) => note(builderFailedNote(builder, err)),
      )
      .catch(options.report('builder', { ...links, agentId: builder.id }));
  };

  const applyAction = async (action: DriverAction): Promise<void> => {
    const parsed = builderActionSchema.safeParse(action);
    if (!parsed.success) {
      note(actionFailedNote(action, z.prettifyError(parsed.error)));
      return;
    }
    let outcome: BuilderActionOutcome;
    try {
      outcome = await applyBuilderAction(options.builders, parsed.data);
    } catch (err) {
      note(actionFailedNote(action, getErrorMessage(err)));
      return;
    }
    const done = outcomeNote(outcome);
    if (done) pending.push(done);
    if (outcome.kind === 'assign')
      watchBuilder(
        outcome.assignment.builder,
        outcome.assignment.ticket.id,
        outcome.assignment.turn,
      );
    else
      watchBuilder(
        outcome.continuation.builder,
        outcome.continuation.ticketId,
        outcome.continuation.turn,
      );
  };

  const applyOutcome = async (outcome: DriverTurnOutcome): Promise<void> => {
    if (outcome.status !== 'result') return;
    for (const action of outcome.result.actions) {
      if (closed) return;
      await applyAction(action);
    }
  };

  const fail = (err: unknown): void => {
    broken = true;
    options.report('driver', links)(err);
  };

  const settle = (work: Promise<void>): void => {
    turning = work.catch(fail).finally(() => {
      turning = undefined;
      pump();
    });
  };

  const pump = (): void => {
    if (closed || broken || turning !== undefined || !wantsTurn()) return;
    const notes = pending.splice(0);
    if (notes.some((next) => next.wake === 'event')) retries = 0;
    else retries += 1;
    settle(voyage.turn(composeTurnInput(notes)).then(applyOutcome));
  };

  settle(voyage.birth.then(applyOutcome));

  return {
    voyageId: voyage.voyage.id,
    driver: { voyage, charter: options.charter },
    builders: options.builders,
    note,
    message: (text) => note(humanNote(text)),
    watchBuilder,
    idle: async () => {
      while (turning !== undefined) await turning;
    },
    close: () => {
      closed = true;
    },
  };
};
