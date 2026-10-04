import { z } from 'zod';
import {
  applyTurnAction,
  turnActionSchema,
  type BuilderContext,
  type DriverAction,
  type DriverVoyage,
  type DriverTurnOutcome,
  type TurnAction,
  type TurnActionOutcome,
  type TurnRecord,
} from '../driver/index.js';
import { getErrorMessage } from '../lib/errors.js';
import {
  actionDoneNote,
  actionFailedNote,
  builderFailedNote,
  builderTurnNote,
  composeTurnInput,
  humanNote,
  projectNote,
  readNoteTicket,
  ticketLabel,
  type DriverNote,
  type NoteBuilder,
} from './driver-notes.js';
import type { CrewFailureReporter } from './failures.js';

export const MAX_RETRY_TURNS = 3;

export interface RunLeg {
  project: string;
  builders: BuilderContext;
}

export interface VoyageRunDriver {
  voyage: DriverVoyage;
  charter: string;
}

export interface VoyageRunOptions {
  voyage: DriverVoyage;
  charter: string;
  resolve: (action: TurnAction) => Promise<RunLeg>;
  report: CrewFailureReporter;
  onBuilderTurn?: () => void;
}

export interface VoyageRun {
  voyageId: string;
  driver: VoyageRunDriver;
  note: (note: DriverNote) => void;
  message: (text: string) => void;
  watchBuilder: (
    leg: RunLeg,
    builder: NoteBuilder,
    ticketId: string | null,
    turn: Promise<TurnRecord>,
  ) => void;
  idle: () => Promise<void>;
  close: () => void;
}

const outcomeText = (outcome: TurnActionOutcome): string | undefined => {
  if (outcome.kind === 'assign') {
    const { assignment } = outcome;
    return `Assigned ${ticketLabel(assignment.ticket)} to ${assignment.builder.name} (builder ${assignment.builder.id}).`;
  }
  if (outcome.kind === 'block')
    return `Blocked ${ticketLabel(outcome.block.ticket)} on ${outcome.block.dependencies.map(({ id }) => id).join(', ')}.`;
  if (outcome.kind === 'published')
    return `Recorded ${ticketLabel(outcome.ticket)} as published: ${outcome.package} ${outcome.version}.`;
  return undefined;
};

const outcomeNote = (
  leg: RunLeg,
  outcome: TurnActionOutcome,
): DriverNote | undefined => {
  const text = outcomeText(outcome);
  if (text === undefined) return undefined;
  return projectNote(leg.project, actionDoneNote(text));
};

export const startVoyageRun = (options: VoyageRunOptions): VoyageRun => {
  const { voyage } = options;
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

  const ticketOf = async (leg: RunLeg, ticketId: string | null) => {
    if (ticketId === null) return undefined;
    return readNoteTicket(leg.builders.store, ticketId);
  };

  const watchBuilder = (
    leg: RunLeg,
    builder: NoteBuilder,
    ticketId: string | null,
    turn: Promise<TurnRecord>,
  ): void => {
    turn
      .then(
        async (record) => {
          const ticket = await ticketOf(leg, ticketId);
          note(
            projectNote(
              leg.project,
              builderTurnNote(builder, record.stopReason, ticket),
            ),
          );
        },
        (err: unknown) =>
          note(projectNote(leg.project, builderFailedNote(builder, err))),
      )
      .finally(() => options.onBuilderTurn?.())
      .catch(options.report('builder', { ...links, agentId: builder.id }));
  };

  const watchOutcome = (leg: RunLeg, outcome: TurnActionOutcome): void => {
    if (outcome.kind === 'assign') {
      const { assignment } = outcome;
      watchBuilder(
        leg,
        assignment.builder,
        assignment.ticket.id,
        assignment.turn,
      );
      return;
    }
    if (outcome.kind !== 'continue') return;
    const { continuation } = outcome;
    watchBuilder(
      leg,
      continuation.builder,
      continuation.ticketId,
      continuation.turn,
    );
  };

  const applyAction = async (action: DriverAction): Promise<void> => {
    const parsed = turnActionSchema.safeParse(action);
    if (!parsed.success) {
      note(actionFailedNote(action, z.prettifyError(parsed.error)));
      return;
    }
    let leg: RunLeg;
    let outcome: TurnActionOutcome;
    try {
      leg = await options.resolve(parsed.data);
      outcome = await applyTurnAction(leg.builders, parsed.data);
    } catch (err) {
      note(actionFailedNote(action, getErrorMessage(err)));
      return;
    }
    const done = outcomeNote(leg, outcome);
    if (done) pending.push(done);
    watchOutcome(leg, outcome);
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
