import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Agent } from '../agents/index.js';
import type { PublishInput, Store } from '../store/index.js';

export const BUILDER_CONTINUED_EVENT = 'builder.continued';

export const BUILDER_STUCK_EVENT = 'builder.stuck';
export const STUCK_SURFACED_EVENT = 'driver.stuck_surfaced';

export const STUCK_AFTER_CONTINUES = 3;

const HEADS_COMPARED = STUCK_AFTER_CONTINUES + 1;

export interface StuckFlag {
  eventId: number;
  builderId: string;
  name: string;
  ticketId: string | null;
  ticketTitle: string | null;
  head: string;
}

const run = promisify(execFile);

export const worktreeHead = async (
  worktreePath: string | null,
): Promise<string | null> => {
  if (worktreePath === null) return null;
  try {
    const { stdout } = await run('git', [
      '-C',
      worktreePath,
      'rev-parse',
      'HEAD',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const recentHeads = async (
  store: Store,
  builderId: string,
  ticketId: string | null,
): Promise<(string | null)[]> => {
  const { rows } = await store.db.query<{ head: string | null }>(
    `select payload->>'head' as head from events
     where project_id = $1 and agent_id = $2
       and ticket_id is not distinct from $3::uuid and kind = $4
     order by id desc
     limit $5`,
    [
      store.projectId,
      builderId,
      ticketId,
      BUILDER_CONTINUED_EVENT,
      HEADS_COMPARED,
    ],
  );
  return rows.map((row) => row.head);
};

const alreadyFlagged = async (
  store: Store,
  builderId: string,
  ticketId: string | null,
  head: string,
): Promise<boolean> => {
  const { rows } = await store.db.query(
    `select 1 from events
     where project_id = $1 and agent_id = $2
       and ticket_id is not distinct from $3::uuid and kind = $4
       and payload->>'head' = $5
     limit 1`,
    [store.projectId, builderId, ticketId, BUILDER_STUCK_EVENT, head],
  );
  return rows.length > 0;
};

export const flagIfStuck = async (
  store: Store,
  builder: Pick<Agent, 'id' | 'name'>,
  ticketId: string | null,
  head: string | null,
): Promise<boolean> => {
  if (head === null) return false;
  const heads = await recentHeads(store, builder.id, ticketId);
  if (heads.length < HEADS_COMPARED) return false;
  if (heads.some((seen) => seen !== head)) return false;
  if (await alreadyFlagged(store, builder.id, ticketId, head)) return false;
  const event: PublishInput = {
    kind: BUILDER_STUCK_EVENT,
    agentId: builder.id,
    payload: { name: builder.name, head, continues: STUCK_AFTER_CONTINUES },
  };
  if (ticketId !== null) event.ticketId = ticketId;
  await store.publish(event);
  return true;
};

export const unsurfacedStuckFlags = async (
  store: Store,
): Promise<StuckFlag[]> => {
  const { rows } = await store.db.query<StuckFlag>(
    `select e.id::int8 as "eventId", e.agent_id as "builderId",
            e.payload->>'name' as name, e.ticket_id as "ticketId",
            t.title as "ticketTitle", e.payload->>'head' as head
     from events e
     left join tickets t on t.id = e.ticket_id
     where e.project_id = $1 and e.kind = $2
       and not exists (
         select 1 from events s
         where s.project_id = $1 and s.kind = $3
           and s.payload->'flags' @> to_jsonb(e.id)
       )
     order by e.id`,
    [store.projectId, BUILDER_STUCK_EVENT, STUCK_SURFACED_EVENT],
  );
  return rows.map((row) => ({ ...row, eventId: Number(row.eventId) }));
};

export const markStuckFlagsSurfaced = async (
  store: Store,
  driver: Pick<Agent, 'id'>,
  flags: readonly StuckFlag[],
): Promise<void> => {
  if (flags.length === 0) return;
  await store.publish({
    kind: STUCK_SURFACED_EVENT,
    agentId: driver.id,
    payload: { flags: flags.map((flag) => flag.eventId) },
  });
};

const flagLine = (flag: StuckFlag): string => {
  const builder = `${flag.name} (${flag.builderId})`;
  if (flag.ticketId === null)
    return `- ${builder}, holding no ticket, at ${flag.head}.`;
  const ticket = `ticket ${flag.ticketId} "${flag.ticketTitle ?? ''}"`;
  return `- ${builder} on ${ticket}, at ${flag.head}.`;
};

export const stuckSection = (flags: readonly StuckFlag[]): string =>
  [
    '# Stuck builders',
    `Each of these builders ran ${STUCK_AFTER_CONTINUES} continues in a row without making a commit. Another continue like the last ones is unlikely to help: give it a concrete next step, re-assign its ticket, or raise a card.`,
    flags.map(flagLine).join('\n'),
  ].join('\n\n');

export const withStuckFlags = (
  input: string,
  flags: readonly StuckFlag[],
): string => {
  if (flags.length === 0) return input;
  return `${input}\n\n${stuckSection(flags)}`;
};
