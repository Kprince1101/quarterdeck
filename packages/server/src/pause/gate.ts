import {
  AGENT_KILLED_EVENT,
  AGENT_RETIRED_EVENT,
  FINISHED_AGENT_STATUSES,
  type AgentStatus,
} from '../agents/index.js';
import {
  quarterdeckHome,
  type PublishInput,
  type Store,
  type StoreEvent,
} from '../store/index.js';
import { PauseDroppedError, type DropReason } from './errors.js';
import { pausedScopes } from './state.js';

export const PAUSE_EVENTS = {
  held: 'pause.held',
  replayed: 'pause.replayed',
  dropped: 'pause.dropped',
} as const;

export const UNPAUSE_KINDS: readonly string[] = [
  'pause.set',
  'pause.all',
  'agent.resume',
];

export const FINISH_KINDS: readonly string[] = [
  AGENT_KILLED_EVENT,
  AGENT_RETIRED_EVENT,
];

export const MAX_LABEL_LENGTH = 80;

export type PauseOperation =
  'launch' | 'continue' | 'resume' | 'driver.turn' | 'planner.turn';

export interface PauseSubject {
  operation: PauseOperation;
  label: string;
  agentId?: string;
  ticketId?: string;
}

export interface HoldOptions {
  signal?: AbortSignal;
}

export interface PauseGuard {
  hold: <T>(
    subject: PauseSubject,
    run: () => Promise<T>,
    options?: HoldOptions,
  ) => Promise<T>;
}

export interface PauseGate extends PauseGuard {
  held: () => PauseSubject[];
  replay: () => Promise<void>;
  close: () => Promise<void>;
}

export interface PauseGateOptions {
  store: Pick<Store, 'db' | 'projectId' | 'publish' | 'subscribe'>;
  home?: string;
  onError?: (err: unknown) => void;
}

interface Held {
  subject: PauseSubject;
  heldEventId: number | null;
  start: () => void;
  drop: (reason: DropReason) => void;
  detach: () => void;
}

const reportError = (err: unknown): void => {
  console.error(err);
};

export const pauseLabel = (prefix: string, text: string): string => {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  if (line === '') return prefix;
  const label = `${prefix}: ${line}`;
  if (label.length <= MAX_LABEL_LENGTH) return label;
  return `${label.slice(0, MAX_LABEL_LENGTH - 1)}…`;
};

const subjectEvent = (
  kind: string,
  subject: PauseSubject,
  extra: Record<string, unknown>,
): PublishInput => {
  const event: PublishInput = {
    kind,
    payload: { operation: subject.operation, label: subject.label, ...extra },
  };
  if (subject.agentId !== undefined) event.agentId = subject.agentId;
  if (subject.ticketId !== undefined) event.ticketId = subject.ticketId;
  return event;
};

export const startPauseGate = async (
  options: PauseGateOptions,
): Promise<PauseGate> => {
  const { store } = options;
  const home = options.home ?? quarterdeckHome();
  const report = options.onError ?? reportError;
  const queue: Held[] = [];
  let closed = false;
  let running: Promise<void> | undefined;
  let again = false;

  const scopesOf = (subject: PauseSubject) =>
    pausedScopes(store.db, store.projectId, home, subject.agentId);

  const isFinished = async ({ agentId }: PauseSubject): Promise<boolean> => {
    if (agentId === undefined) return false;
    const { rows } = await store.db.query<{ status: AgentStatus }>(
      'select status from agents where id = $1 and project_id = $2',
      [agentId, store.projectId],
    );
    return rows.some(({ status }) => FINISHED_AGENT_STATUSES.includes(status));
  };

  const take = (entry: Held): boolean => {
    const index = queue.indexOf(entry);
    if (index === -1) return false;
    queue.splice(index, 1);
    entry.detach();
    return true;
  };

  const publishAbout = (
    entry: Held,
    kind: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const { heldEventId } = entry;
    if (heldEventId === null) return Promise.resolve();
    const event = subjectEvent(kind, entry.subject, { heldEventId, ...extra });
    return store.publish(event).then(() => undefined, report);
  };

  const dropped = (entry: Held, reason: DropReason): Promise<void> => {
    entry.drop(reason);
    return publishAbout(entry, PAUSE_EVENTS.dropped, { reason });
  };

  const sweep = async (): Promise<void> => {
    for (const entry of queue.slice()) {
      if (!queue.includes(entry)) continue;
      if (await isFinished(entry.subject)) {
        if (take(entry)) await dropped(entry, 'finished');
        continue;
      }
      const scopes = await scopesOf(entry.subject);
      if (scopes.length > 0 || !take(entry)) continue;
      await publishAbout(entry, PAUSE_EVENTS.replayed);
      entry.start();
    }
  };

  const replaying = (): boolean => queue.length > 0 || running !== undefined;

  const loop = async (): Promise<void> => {
    again = false;
    try {
      await sweep();
    } catch (err) {
      running = undefined;
      throw err;
    }
    if (again) return loop();
    running = undefined;
  };

  const replay = (): Promise<void> => {
    again = true;
    running ??= loop();
    return running;
  };

  const hold = async <T>(
    subject: PauseSubject,
    run: () => Promise<T>,
    holdOptions: HoldOptions = {},
  ): Promise<T> => {
    const { signal } = holdOptions;
    const scopes = await scopesOf(subject);
    if (scopes.length === 0 && (closed || !replaying())) return run();
    if (closed) throw new PauseDroppedError(subject, 'closed');
    if (signal?.aborted) throw new PauseDroppedError(subject, 'aborted');
    let heldEventId: number | null = null;
    if (scopes.length > 0) {
      const event = await store.publish(
        subjectEvent(PAUSE_EVENTS.held, subject, { scopes }),
      );
      heldEventId = event.id;
    }
    const waiting = new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (take(entry)) void dropped(entry, 'aborted');
      };
      const entry: Held = {
        subject,
        heldEventId,
        start: () => {
          Promise.resolve().then(run).then(resolve, reject);
        },
        drop: (reason) => {
          reject(new PauseDroppedError(subject, reason));
        },
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      queue.push(entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (closed && take(entry)) void dropped(entry, 'closed');
      else if (signal?.aborted) onAbort();
    });
    replay().catch(report);
    return waiting;
  };

  const onEvent = (event: StoreEvent): void => {
    const recheck =
      UNPAUSE_KINDS.includes(event.kind) || FINISH_KINDS.includes(event.kind);
    if (recheck) replay().catch(report);
  };
  const subscription = await store.subscribe(onEvent, { onError: report });

  const shutdown = async (): Promise<void> => {
    closed = true;
    await subscription.close();
    await running?.catch(() => undefined);
    for (const entry of queue.splice(0)) {
      entry.detach();
      await dropped(entry, 'closed');
    }
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= shutdown();
    return closing;
  };

  return {
    hold,
    held: () => queue.map((entry) => entry.subject),
    replay,
    close,
  };
};
