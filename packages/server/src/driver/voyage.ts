import type { BudgetWindow } from '@quarterdeck/rules';
import type { AcpClient } from '../acp/client/index.js';
import {
  AGENT_COLUMNS,
  type Agent,
  type AgentStatus,
} from '../agents/index.js';
import { findAgent, firstRow, recordEvent } from '../agents/rows.js';
import { assertLaunchBudget } from '../budget/index.js';
import type { BusHost } from '../bus/index.js';
import {
  pauseLabel,
  type PauseGuard,
  type PauseSubject,
} from '../pause/index.js';
import { withSignIn } from '../signin/index.js';
import type { Store } from '../store/index.js';
import {
  buildBirthInput,
  readActiveNotebook,
  type NotebookEntry,
  type Voyage,
} from './birth-input.js';
import {
  NotADriverError,
  VoyageEndedError,
  VoyageNotFoundError,
} from './errors.js';
import {
  DRIVER_TURN_FORMAT,
  type DriverTurnResult,
  type TurnFormat,
} from './result.js';
import {
  markStuckFlagsSurfaced,
  unsurfacedStuckFlags,
  withStuckFlags,
} from './stuck.js';
import { runTurn, type TurnOutcome, type TurnTarget } from './turns.js';

export const VOYAGE_STARTED_EVENT = 'driver.voyage_started';

const ENDED: ReadonlySet<AgentStatus> = new Set(['ended', 'killed', 'retired']);

export type DriverClient = Pick<
  AcpClient,
  'agent' | 'newSession' | 'prompt' | 'subscribe'
>;

export interface DriverVoyageOptions {
  store: Store;
  client: DriverClient;
  bus: Pick<BusHost, 'launch'>;
  agentId: string;
  voyageId: string;
  cwd: string;
  charter: string;
  turnsDir: string;
  budget: BudgetWindow;
  pause: PauseGuard;
}

export type DriverTurnOutcome = TurnOutcome<DriverTurnResult>;

export interface DriverVoyage {
  agent: Agent;
  voyage: Voyage;
  sessionId: string;
  notebook: readonly NotebookEntry[];
  birth: Promise<DriverTurnOutcome>;
  turn: (input: string) => Promise<DriverTurnOutcome>;
  turnAs: <T>(input: string, format: TurnFormat<T>) => Promise<TurnOutcome<T>>;
}

const findVoyage = async (store: Store, voyageId: string): Promise<Voyage> => {
  const { rows } = await store.db.query<Voyage>(
    `select id, number, status, goal from voyages
     where id = $1 and project_id = $2`,
    [voyageId, store.projectId],
  );
  const [voyage] = rows;
  if (!voyage) throw new VoyageNotFoundError(voyageId);
  if (voyage.status === 'ended')
    throw new VoyageEndedError(voyage.id, voyage.number);
  return voyage;
};

const findDriver = async (store: Store, agentId: string): Promise<Agent> => {
  const agent = await findAgent(store, agentId);
  if (agent.role !== 'driver') {
    throw new NotADriverError(agentId, `its role is ${agent.role}`);
  }
  if (ENDED.has(agent.status)) {
    throw new NotADriverError(agentId, `it is ${agent.status}`);
  }
  return agent;
};

const attachVoyageSession = (
  store: Store,
  agent: Agent,
  voyage: Voyage,
  sessionId: string,
  notebook: readonly NotebookEntry[],
): Promise<Agent> =>
  store.db.transaction(async (tx) => {
    const { rows } = await tx.query<Agent>(
      `update agents
       set session_id = $2, voyage_id = $3,
           status = case when status = 'starting' then 'idle' else status end
       where id = $1
       returning ${AGENT_COLUMNS}`,
      [agent.id, sessionId, voyage.id],
    );
    const attached = firstRow(rows, agent.id);
    await recordEvent(tx, attached, VOYAGE_STARTED_EVENT, {
      voyageId: voyage.id,
      voyage: voyage.number,
      sessionId,
      notebook: notebook.map((entry) => entry.id),
    });
    return attached;
  });

const serialize = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
};

const launchVoyage = async (
  options: DriverVoyageOptions,
): Promise<DriverVoyage> => {
  const { store, client } = options;
  const voyage = await findVoyage(store, options.voyageId);
  const driver = await findDriver(store, options.agentId);
  await assertLaunchBudget(store, options.budget, { agentId: driver.id });
  const gate = {
    store,
    agentId: driver.id,
    runtime: driver.runtime,
    authMethods: () => client.agent.authMethods,
  };
  const { sessionId } = await withSignIn(gate, 'session/new', async () =>
    client.newSession({
      cwd: options.cwd,
      mcpServers: [await options.bus.launch(driver.id)],
    }),
  );
  const notebook = await readActiveNotebook(store.db, store.projectId);
  const agent = await attachVoyageSession(
    store,
    driver,
    voyage,
    sessionId,
    notebook,
  );
  const target: TurnTarget = {
    store,
    client,
    agent,
    sessionId,
    turnsDir: options.turnsDir,
  };
  const enqueue = serialize();
  const heldTurn = <T>(label: string, run: () => Promise<T>) =>
    enqueue(() =>
      options.pause.hold(
        { operation: 'driver.turn', label, agentId: agent.id },
        run,
      ),
    );
  const turnAs = <T>(input: string, format: TurnFormat<T>) =>
    heldTurn(pauseLabel('turn', input), () => runTurn(target, input, format));
  const flaggedTurn = (label: string, input: string) =>
    heldTurn(label, async () => {
      const flags = await unsurfacedStuckFlags(store);
      const outcome = await runTurn(
        target,
        withStuckFlags(input, flags),
        DRIVER_TURN_FORMAT,
      );
      if (outcome.status !== 'stopped')
        await markStuckFlagsSurfaced(store, agent, flags);
      return outcome;
    });
  const turn = (input: string) => flaggedTurn(pauseLabel('turn', input), input);
  const birthInput = buildBirthInput({
    agent,
    voyage,
    charter: options.charter,
    notebook,
    instructions: DRIVER_TURN_FORMAT.instructions,
  });
  const birth = flaggedTurn(`birth turn, voyage ${voyage.number}`, birthInput);
  birth.catch(() => undefined);
  return { agent, voyage, sessionId, notebook, birth, turn, turnAs };
};

export const openDriverVoyage = async (
  options: DriverVoyageOptions,
): Promise<DriverVoyage> => {
  const voyage = await findVoyage(options.store, options.voyageId);
  const driver = await findDriver(options.store, options.agentId);
  const subject: PauseSubject = {
    operation: 'launch',
    label: `${driver.name}, voyage ${voyage.number}`,
    agentId: driver.id,
  };
  return options.pause.hold(subject, () => launchVoyage(options));
};
