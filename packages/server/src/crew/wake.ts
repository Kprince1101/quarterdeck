import {
  FINISHED_AGENT_STATUSES,
  findAgent,
  type Agent,
} from '../agents/index.js';
import { BudgetHeldError, assertLaunchBudget } from '../budget/index.js';
import {
  continueBuilder,
  markUnblocked,
  markWaiting,
  readDependentTickets,
  readHeldTickets,
  unblockHeld,
  unmetDependencies,
  wakePrompt,
  type BuilderContext,
  type Dependency,
  type DependencyResolver,
  type HeldTicket,
  type TurnRecord,
} from '../driver/index.js';
import { getErrorMessage } from '../lib/errors.js';
import {
  PauseDroppedError,
  pauseLabel,
  type PauseSubject,
} from '../pause/index.js';
import {
  projectNote,
  wakeFailedNote,
  type DriverNote,
  type NoteBuilder,
} from './driver-notes.js';
import type { VoyageLeg } from './voyage-legs.js';
import type { RunLeg } from './voyage-run.js';

export const WAKE_RETRY_MS = 60_000;

const BUSY_STATUSES: readonly string[] = ['starting', 'working'];

export type WakeLeg = Pick<VoyageLeg, 'project' | 'store'>;

export interface WakeOptions<L extends WakeLeg> {
  legs: () => readonly L[];
  dependencies: DependencyResolver;
  builders: (leg: L) => Promise<BuilderContext>;
  note: (note: DriverNote) => void;
  watch: (
    leg: RunLeg,
    builder: NoteBuilder,
    ticketId: string | null,
    turn: Promise<TurnRecord>,
  ) => void;
  report: (err: unknown) => void;
}

export interface Wake {
  poke: () => void;
  idle: () => Promise<void>;
  close: () => void;
}

const holderOf = async (
  leg: WakeLeg,
  ticket: HeldTicket,
): Promise<Agent | undefined> => {
  if (ticket.assigneeId === null) return undefined;
  return findAgent(leg.store, ticket.assigneeId);
};

const isLive = (agent: Agent | undefined): agent is Agent =>
  agent !== undefined && !FINISHED_AGENT_STATUSES.includes(agent.status);

const builderText = (agent: Agent): string =>
  `${agent.name} (builder ${agent.id})`;

export const startWake = <L extends WakeLeg>(options: WakeOptions<L>): Wake => {
  const waking = new Set<string>();
  const tasks = new Set<Promise<void>>();
  let scanning: Promise<void> | undefined;
  let again = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const track = (task: Promise<void>): void => {
    const tracked = task.finally(() => tasks.delete(tracked));
    tasks.add(tracked);
  };

  const retryAt = (releaseAt: Date | null): void => {
    if (closed || timer !== undefined) return;
    const delay = Math.max(
      (releaseAt?.getTime() ?? Date.now() + WAKE_RETRY_MS) - Date.now(),
      0,
    );
    timer = setTimeout(() => {
      timer = undefined;
      poke();
    }, delay);
    timer.unref();
  };

  const failed = (err: unknown): void => {
    if (err instanceof BudgetHeldError) retryAt(err.releaseAt);
    else if (!(err instanceof PauseDroppedError)) options.report(err);
  };

  const sendWake = async (
    leg: L,
    ctx: BuilderContext,
    ticket: HeldTicket,
    dependencies: readonly Dependency[],
    holder: Agent | undefined,
  ): Promise<void> => {
    if (isLive(holder))
      await assertLaunchBudget(ctx.store, ctx.budget, { agentId: holder.id });
    const unblocked = await unblockHeld(ctx.store, ticket.id, dependencies);
    if (unblocked === undefined || closed || holder === undefined) return;
    if (FINISHED_AGENT_STATUSES.includes(holder.status)) {
      options.note(
        projectNote(
          leg.project,
          wakeFailedNote(ticket, builderText(holder), `it is ${holder.status}`),
        ),
      );
      return;
    }
    try {
      const continuation = await continueBuilder(ctx, {
        builderId: holder.id,
        prompt: wakePrompt(ticket, dependencies, ctx.mode),
      });
      options.watch(
        { project: leg.project, builders: ctx },
        continuation.builder,
        continuation.ticketId,
        continuation.turn,
      );
    } catch (err) {
      options.note(
        projectNote(
          leg.project,
          wakeFailedNote(ticket, builderText(holder), getErrorMessage(err)),
        ),
      );
    }
  };

  const wakeHeld = async (
    leg: L,
    ticket: HeldTicket,
    dependencies: readonly Dependency[],
    holder: Agent | undefined,
  ): Promise<void> => {
    const ctx = await options.builders(leg);
    const subject: PauseSubject = {
      operation: 'continue',
      label: pauseLabel('wake', ticket.title),
      ticketId: ticket.id,
    };
    if (isLive(holder)) subject.agentId = holder.id;
    await ctx.pause.hold(subject, () =>
      sendWake(leg, ctx, ticket, dependencies, holder),
    );
  };

  const scanHeld = async (leg: L): Promise<void> => {
    for (const ticket of await readHeldTickets(leg.store)) {
      if (waking.has(ticket.id)) continue;
      const dependencies = await options.dependencies(ticket.dependsOn);
      if (unmetDependencies(dependencies).length > 0) continue;
      const holder = await holderOf(leg, ticket);
      if (holder !== undefined && BUSY_STATUSES.includes(holder.status))
        continue;
      waking.add(ticket.id);
      track(
        wakeHeld(leg, ticket, dependencies, holder)
          .catch(failed)
          .finally(() => waking.delete(ticket.id)),
      );
    }
  };

  const scanDependent = async (leg: L): Promise<void> => {
    for (const ticket of await readDependentTickets(leg.store)) {
      const dependencies = await options.dependencies(ticket.dependsOn);
      const ready = unmetDependencies(dependencies).length === 0;
      if (ready && ticket.waiting)
        await markUnblocked(leg.store, ticket.id, dependencies);
      if (!ready && !ticket.waiting)
        await markWaiting(leg.store, ticket.id, dependencies);
    }
  };

  const sweep = async (): Promise<void> => {
    for (const leg of options.legs()) {
      if (closed) return;
      try {
        await scanHeld(leg);
        await scanDependent(leg);
      } catch (err) {
        options.report(err);
      }
    }
  };

  const loop = async (): Promise<void> => {
    again = false;
    await sweep();
    if (again && !closed) return loop();
    scanning = undefined;
    return undefined;
  };

  const poke = (): void => {
    if (closed) return;
    again = true;
    scanning ??= loop();
  };

  return {
    poke,
    idle: async () => {
      while (scanning !== undefined || tasks.size > 0) {
        await scanning;
        await Promise.allSettled(tasks);
      }
    },
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
};
