import {
  DISCARD_APPROVED,
  DISCARD_WORKTREE_CARD,
  WorktreeDirtyError,
  findAgent,
  requestWorktreeDiscard,
  type AgentLifecycle,
  type RetireOptions,
} from '../agents/index.js';
import { ARCHIVE_KIND } from '../pause/index.js';
import type { Store, StoreEvent } from '../store/index.js';

export const ARCHIVE_RETIRED_EVENT = 'archive.retired';

const ARCHIVE_CONTROL_KINDS: readonly string[] = [
  ARCHIVE_KIND,
  'card.answer',
  'card.decline',
];

export interface ArchiveControlOptions {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'retire'>;
  onError?: (err: unknown) => void;
}

export interface ArchiveRetirement {
  retired: string[];
  discardCards: string[];
}

export interface ArchiveControl {
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

interface ArchivedAgent {
  id: string;
  cardId: string | null;
  cardStatus: string | null;
  cardAnswer: string | null;
}

const reportArchiveControlError = (err: unknown): void => {
  console.error('quarterdeck archive control failed', err);
};

const unretiredAgents = async (store: Store): Promise<ArchivedAgent[]> => {
  const { rows } = await store.db.query<ArchivedAgent>(
    `select a.id, c.id as "cardId", c.status as "cardStatus",
            c.answer as "cardAnswer"
     from agents a
     join projects p on p.id = a.project_id
     left join lateral (
       select id, status, answer from cards
       where agent_id = a.id and kind = $2 and created_at >= p.archived_at
       order by created_at desc, id desc
       limit 1
     ) c on true
     where a.project_id = $1 and p.archived_at is not null
       and a.status <> 'retired'
     order by a.created_at, a.id`,
    [store.projectId, DISCARD_WORKTREE_CARD],
  );
  return rows;
};

const approved = (agent: ArchivedAgent): boolean =>
  agent.cardStatus === 'answered' && agent.cardAnswer === DISCARD_APPROVED;

export const retireArchivedAgents = async (
  options: ArchiveControlOptions,
): Promise<ArchiveRetirement> => {
  const { store, lifecycle } = options;
  const onError = options.onError ?? reportArchiveControlError;
  const retired: string[] = [];
  const discardCards: string[] = [];
  for (const agent of await unretiredAgents(store)) {
    if (agent.cardId !== null && !approved(agent)) continue;
    const retireOptions: RetireOptions = {};
    if (agent.cardId !== null) retireOptions.discardCardId = agent.cardId;
    try {
      await lifecycle.retire(store, agent.id, retireOptions);
      retired.push(agent.id);
    } catch (err) {
      if (!(err instanceof WorktreeDirtyError) || agent.cardId !== null) {
        onError(err);
        continue;
      }
      const dirty = await findAgent(store, agent.id);
      discardCards.push(await requestWorktreeDiscard(store, dirty, err));
    }
  }
  if (retired.length > 0 || discardCards.length > 0) {
    await store.publish({
      kind: ARCHIVE_RETIRED_EVENT,
      payload: { retired, discardCards },
    });
  }
  return { retired, discardCards };
};

export const startArchiveControl = async (
  options: ArchiveControlOptions,
): Promise<ArchiveControl> => {
  const { store } = options;
  const onError = options.onError ?? reportArchiveControlError;
  let running: Promise<void> | undefined;
  let again = false;
  let closing = false;

  const loop = async (): Promise<void> => {
    again = false;
    try {
      if (!closing) await retireArchivedAgents({ ...options, onError });
    } catch (err) {
      running = undefined;
      throw err;
    }
    if (again) return loop();
    running = undefined;
  };

  const drain = (): Promise<void> => {
    again = true;
    running ??= loop();
    return running;
  };

  const onEvent = (event: StoreEvent): void => {
    if (ARCHIVE_CONTROL_KINDS.includes(event.kind)) drain().catch(onError);
  };

  const subscription = await store.subscribe(onEvent, { onError });
  drain().catch(onError);

  const shutdown = async (): Promise<void> => {
    closing = true;
    await subscription.close();
    await running?.catch(() => undefined);
  };
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= shutdown();
    return closed;
  };

  return { drain, close };
};
