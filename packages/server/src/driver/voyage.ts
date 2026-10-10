import type { McpServerStdio } from '@agentclientprotocol/sdk';
import type { BudgetWindow } from '@quarterdeck/rules';
import type { AcpClient } from '../acp/client/index.js';
import {
  AGENT_COLUMNS,
  type Agent,
  type AgentStatus,
} from '../agents/index.js';
import { findAgent, firstRow, recordEvent } from '../agents/rows.js';
import { assertLaunchBudget } from '../budget/index.js';
import { projectBusName, type BusHost } from '../bus/index.js';
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
  readNotebooks,
  type BirthInputParts,
  type NotebookEntry,
  type ProjectBrief,
  type Voyage,
} from './birth-input.js';
import {
  NotADriverError,
  VoyageEndedError,
  VoyageNotFoundError,
} from './errors.js';
import type { WorkspaceMode } from '../stream/schema.js';
import {
  driverTurnFormat,
  type DriverTurnResult,
  type TurnFormat,
} from './result.js';
import {
  markStuckFlagsSurfaced,
  unsurfacedStuckFlags,
  withStuckFlags,
  type StuckFlag,
} from './stuck.js';
import { runTurn, type TurnOutcome, type TurnTarget } from './turns.js';

export const VOYAGE_STARTED_EVENT = 'driver.voyage_started';

const ENDED: ReadonlySet<AgentStatus> = new Set(['ended', 'killed', 'retired']);

export type DriverClient = Pick<
  AcpClient,
  'agent' | 'newSession' | 'prompt' | 'subscribe'
>;

export interface DriverSeat {
  project: string;
  store: Store;
  bus: Pick<BusHost, 'launch'>;
  agentId: string;
  voyageId: string;
}

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
  seats?: readonly DriverSeat[];
  projects?: readonly ProjectBrief[];
  mode?: WorkspaceMode;
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

const otherSeats = (options: DriverVoyageOptions): DriverSeat[] =>
  (options.seats ?? []).filter((seat) => seat.agentId !== options.agentId);

const sessionServers = async (
  options: DriverVoyageOptions,
): Promise<McpServerStdio[]> => {
  const { seats } = options;
  if (seats === undefined) return [await options.bus.launch(options.agentId)];
  return Promise.all(
    seats.map((seat) =>
      seat.bus.launch(seat.agentId, projectBusName(seat.project)),
    ),
  );
};

const readSeatNotebooks = async (
  options: DriverVoyageOptions,
): Promise<NotebookEntry[]> => {
  const { store, seats } = options;
  if (seats === undefined) return readActiveNotebook(store.db, store.projectId);
  return (await readNotebooks(seats)).entries;
};

const attachOtherSeats = async (
  options: DriverVoyageOptions,
  voyage: Voyage,
  sessionId: string,
  notebook: readonly NotebookEntry[],
): Promise<void> => {
  for (const seat of otherSeats(options)) {
    const driver = await findDriver(seat.store, seat.agentId);
    await attachVoyageSession(
      seat.store,
      driver,
      { ...voyage, id: seat.voyageId },
      sessionId,
      notebook,
    );
  }
};

interface SeatFlag extends StuckFlag {
  seat: DriverSeat;
}

const seatFlags = async (options: DriverVoyageOptions): Promise<SeatFlag[]> => {
  const { seats } = options;
  if (seats === undefined) {
    const seat: DriverSeat = { ...options, project: '' };
    const flags = await unsurfacedStuckFlags(options.store);
    return flags.map((flag) => ({ ...flag, seat }));
  }
  const labelled = options.mode !== 'single';
  const found = await Promise.all(
    seats.map(async (seat) =>
      (await unsurfacedStuckFlags(seat.store)).map((flag) => ({
        ...flag,
        ...(labelled && { project: seat.project }),
        seat,
      })),
    ),
  );
  return found.flat();
};

const markSeatFlags = async (flags: readonly SeatFlag[]): Promise<void> => {
  const seats = new Set(flags.map((flag) => flag.seat));
  for (const seat of seats) {
    await markStuckFlagsSurfaced(
      seat.store,
      { id: seat.agentId },
      flags.filter((flag) => flag.seat === seat),
    );
  }
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
      mcpServers: await sessionServers(options),
    }),
  );
  const notebook = await readSeatNotebooks(options);
  const agent = await attachVoyageSession(
    store,
    driver,
    voyage,
    sessionId,
    notebook,
  );
  await attachOtherSeats(options, voyage, sessionId, notebook);
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
  const format = driverTurnFormat(options.mode ?? 'multi');
  const flaggedTurn = (label: string, input: string) =>
    heldTurn(label, async () => {
      const flags = await seatFlags(options);
      const outcome = await runTurn(
        target,
        withStuckFlags(input, flags),
        format,
      );
      if (outcome.status !== 'stopped') await markSeatFlags(flags);
      return outcome;
    });
  const turn = (input: string) => flaggedTurn(pauseLabel('turn', input), input);
  const parts: BirthInputParts = {
    agent,
    voyage,
    charter: options.charter,
    notebook,
    instructions: format.instructions,
  };
  if (options.projects !== undefined) parts.projects = options.projects;
  if (options.mode !== undefined) parts.mode = options.mode;
  const birthInput = buildBirthInput(parts);
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
