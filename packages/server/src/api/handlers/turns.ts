import { turnDir, turnFile } from '../../driver/files.js';
import {
  findTurnSession,
  type VoyageAgents,
} from '../../driver/replay-voyage.js';
import { VOYAGE_STARTED_EVENT } from '../../driver/voyage.js';
import type { TurnReadResult } from '../../intents/index.js';
import { readTextIfExists } from '../../lib/fs.js';
import { projectTurnsDir, type Store } from '../../store/index.js';
import type { IntentHandler } from '../context.js';
import { findRow, unrecorded } from '../record.js';

interface TurnPrompt {
  agentId: string;
  seq: number;
  prompt: string;
}

const parseResult = (text: string): TurnReadResult['result'] => {
  try {
    return JSON.parse(text) as TurnReadResult['result'];
  } catch {
    return null;
  }
};

const readResult = async (path: string): Promise<TurnReadResult['result']> => {
  const text = await readTextIfExists(path);
  if (text === null) return null;
  return parseResult(text);
};

const voyageAgents =
  (store: Store): VoyageAgents =>
  async (voyage) => {
    const { rows } = await store.db.query<{ agentId: string }>(
      `select distinct agent_id as "agentId" from events
       where project_id = $1 and kind = $2 and agent_id is not null
         and payload ->> 'voyage' = $3`,
      [store.projectId, VOYAGE_STARTED_EVENT, String(voyage)],
    );
    return rows.map((row) => row.agentId);
  };

export const readTurn: IntentHandler<'turn.read'> = async (
  ctx,
  input,
  name,
) => {
  const store = await ctx.stores.get(input.project);
  const turn = await findRow<TurnPrompt>(
    store.db,
    `select t.agent_id as "agentId", t.seq, t.prompt
     from turns t join agents a on a.id = t.agent_id
     where t.id = $1 and a.project_id = $2`,
    [input.turnId, store.projectId],
    `turn ${input.turnId} not found`,
  );
  const turnsDir = projectTurnsDir(input.project, ctx.stores.dataHome);
  const dir = turnDir(turnsDir, turn.agentId, turn.seq);
  const [output, result, session] = await Promise.all([
    readTextIfExists(turnFile(dir, 'output')),
    readResult(turnFile(dir, 'result')),
    findTurnSession(turnsDir, turn.agentId, turn.seq, voyageAgents(store)),
  ]);
  const read: TurnReadResult = {
    turnId: input.turnId,
    agentId: turn.agentId,
    seq: turn.seq,
    input: turn.prompt,
    output,
    result,
    voyage: session?.session.voyage ?? null,
    n: session?.n ?? null,
    latestSession: session?.latest ?? false,
  };
  return unrecorded(name, read);
};
