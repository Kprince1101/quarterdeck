import { findAgent, type Agent } from '../agents/index.js';
import { continueBuilder } from '../driver/index.js';
import { LIFECYCLE_EVENTS } from '../lifecycle/index.js';
import { getErrorMessage } from '../lib/errors.js';
import { settleIntent, type SettledStatus } from '../planner/rows.js';
import { publishEvent, type Store, type StoreEvent } from '../store/index.js';
import type { CrewFailureReporter } from './failures.js';
import { openVoyage, type OpenedVoyage } from './voyage-rows.js';
import type { VoyageRun } from './voyage-run.js';
import { NO_VOYAGE_REPO } from './rules.js';

export const VOYAGE_START = 'voyage.start';
export const AGENT_MESSAGE = 'agent.message';

export const CREW_INTENT_KINDS: readonly string[] = [
  VOYAGE_START,
  AGENT_MESSAGE,
];

export const NO_MESSAGES =
  'only the Driver and builders of a live voyage take messages';

export interface CrewIntent {
  id: string;
  kind: string;
  goal: string | null;
  agentId: string | null;
  text: string | null;
  repoPath: string | null;
}

export interface CrewIntentsOptions {
  store: Store;
  runs: () => VoyageRun[];
  report: CrewFailureReporter;
  start: (voyage: OpenedVoyage) => void;
  launched: (voyageId: string) => Promise<void>;
  track: (task: Promise<void>) => void;
}

export interface CrewIntents {
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

const pendingCrewIntents = async (store: Store): Promise<CrewIntent[]> => {
  const { rows } = await store.db.query<CrewIntent>(
    `select i.id, i.kind, i.input ->> 'goal' as goal,
       i.input ->> 'agentId' as "agentId", i.input ->> 'text' as text,
       p.repo_path as "repoPath"
     from intents i join projects p on p.id = i.project_id
     where i.project_id = $1 and i.status = 'pending'
       and i.kind = any($2::text[])
     order by i.created_at, i.id`,
    [store.projectId, CREW_INTENT_KINDS],
  );
  return rows;
};

const runOf = (runs: VoyageRun[], agent: Agent): VoyageRun | undefined => {
  if (agent.role === 'driver')
    return runs.find((run) => run.driver.voyage.agent.id === agent.id);
  if (agent.role === 'builder')
    return runs.find((run) => run.voyageId === agent.voyageId);
  return undefined;
};

export const startCrewIntents = async (
  options: CrewIntentsOptions,
): Promise<CrewIntents> => {
  const { store } = options;
  const handled = new Set<string>();
  let running: Promise<void> | undefined;
  let again = false;
  let closing = false;

  const settle = (
    intent: CrewIntent,
    status: SettledStatus,
    result: Record<string, unknown>,
  ): Promise<void> =>
    store.db.transaction(async (tx) => {
      if (!(await settleIntent(tx, intent.id, status, result))) return;
      if (status === 'applied' || intent.agentId === null) return;
      await publishEvent(tx, store.projectId, {
        kind: LIFECYCLE_EVENTS.failed,
        agentId: intent.agentId,
        payload: { intentId: intent.id, intent: intent.kind, ...result },
      });
    });

  const startVoyage = async (intent: CrewIntent): Promise<void> => {
    if (intent.repoPath === null) {
      await settle(intent, 'rejected', { error: NO_VOYAGE_REPO });
      return;
    }
    const opening = await openVoyage(store, intent.id, intent.goal ?? '');
    if (!opening.opened) {
      await settle(intent, 'rejected', { error: opening.error });
      return;
    }
    options.start(opening.voyage);
  };

  const deliver = async (intent: CrewIntent, agent: Agent): Promise<void> => {
    const text = intent.text ?? '';
    if (agent.voyageId !== null) await options.launched(agent.voyageId);
    const run = runOf(options.runs(), agent);
    if (run === undefined) {
      await settle(intent, 'rejected', { error: NO_MESSAGES });
      return;
    }
    if (agent.role === 'driver') {
      run.message(text);
      await settle(intent, 'applied', { agentId: agent.id });
      return;
    }
    const continuation = await continueBuilder(run.builders, {
      builderId: agent.id,
      prompt: text,
    });
    run.watchBuilder(agent, continuation.ticketId, continuation.turn);
    await settle(intent, 'applied', { agentId: agent.id });
  };

  const message = async (intent: CrewIntent): Promise<void> => {
    try {
      await deliver(intent, await findAgent(store, intent.agentId ?? ''));
    } catch (err) {
      await settle(intent, 'rejected', { error: getErrorMessage(err) });
    }
  };

  const handle = async (intent: CrewIntent): Promise<void> => {
    handled.add(intent.id);
    if (intent.kind === VOYAGE_START) {
      await startVoyage(intent).catch(async (err: unknown) => {
        options.report('voyages')(err);
        await settle(intent, 'rejected', { error: getErrorMessage(err) });
      });
      return;
    }
    options.track(message(intent));
  };

  const drainPending = async (): Promise<void> => {
    for (const intent of await pendingCrewIntents(store)) {
      if (closing) return;
      if (!handled.has(intent.id)) await handle(intent);
    }
  };

  const loop = async (): Promise<void> => {
    again = false;
    try {
      await drainPending();
    } finally {
      running = undefined;
    }
    if (again) return drain();
    return undefined;
  };

  const drain = (): Promise<void> => {
    again = true;
    running ??= loop();
    return running;
  };

  const onEvent = (event: StoreEvent): void => {
    if (CREW_INTENT_KINDS.includes(event.kind))
      drain().catch(options.report('voyages'));
  };

  const subscription = await store.subscribe(onEvent, {
    onError: options.report('voyages'),
  });
  drain().catch(options.report('voyages'));

  return {
    drain,
    close: async () => {
      closing = true;
      await subscription.close();
      await running?.catch(() => undefined);
    },
  };
};
