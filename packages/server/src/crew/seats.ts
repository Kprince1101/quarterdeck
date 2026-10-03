import { join } from 'node:path';
import type { BudgetWindow, Naming, Runtime } from '@quarterdeck/rules';
import {
  AGENT_COLUMNS,
  insertAgent,
  liveAgentNames,
  markRetired,
  pickAgentName,
  withNameLock,
  type Agent,
  type AgentRole,
  type BirthRequest,
} from '../agents/index.js';
import { assertLaunchBudget } from '../budget/index.js';
import { projectBusName, type BusHost } from '../bus/index.js';
import { getErrorMessage } from '../lib/errors.js';
import { ensurePrivateDir } from '../lib/private-fs.js';
import type { PlannerAdapters, PlannerBus } from '../planner/sessions.js';
import type { Store } from '../store/index.js';
import { createCrewSessions, type CrewSessionHost } from './sessions.js';

export const COORDINATOR_SITE = 'deck';

export const coordinatorDir = (home: string): string => join(home, '_deck');

export type SeatBus = Pick<BusHost, 'launch' | 'revoke'>;

export interface SeatSite {
  project: string;
  store: Store;
  bus: SeatBus;
  voyageId?: string;
}

export interface Seat extends SeatSite {
  agent: Agent;
}

export interface SeatedAgent {
  name: string;
  lead: Seat;
  seats: Seat[];
  sessions: CrewSessionHost;
  sessionId: string;
}

export interface SeatBirth {
  role: AgentRole;
  runtime: Runtime;
  sites: readonly SeatSite[];
  naming: Naming;
  budget: BudgetWindow;
  openStores: () => readonly Store[];
  adapters: PlannerAdapters;
  home: string;
  homeDir: string;
  passEnv: () => Promise<readonly string[]>;
  onExit: () => void;
}

export class NoSeatsError extends Error {
  constructor(role: AgentRole) {
    super(`no open project can seat the ${role}`);
    this.name = 'NoSeatsError';
  }
}

const insertSeats = (birth: SeatBirth): Promise<Seat[]> =>
  withNameLock(async () => {
    const stores = new Set([
      ...birth.sites.map((site) => site.store),
      ...birth.openStores(),
    ]);
    const name = pickAgentName(birth.naming, await liveAgentNames([...stores]));
    const seats: Seat[] = [];
    for (const site of birth.sites) {
      const request: BirthRequest = {
        store: site.store,
        role: birth.role,
        runtime: birth.runtime,
      };
      if (site.voyageId !== undefined) request.voyageId = site.voyageId;
      seats.push({ ...site, agent: await insertAgent(request, name) });
    }
    return seats;
  });

const fanOutBus = (seats: readonly Seat[], lead: Seat): PlannerBus => ({
  launch: (agentId) => lead.bus.launch(agentId),
  revoke: () => {
    for (const seat of seats) seat.bus.revoke(seat.agent.id);
  },
});

const seatServers = (seats: readonly Seat[]) => () =>
  Promise.all(
    seats.map((seat) =>
      seat.bus.launch(seat.agent.id, projectBusName(seat.project)),
    ),
  );

const attachSeat = async (seat: Seat, sessionId: string): Promise<Seat> => {
  const { rows } = await seat.store.db.query<Agent>(
    `update agents
     set session_id = $2,
         status = case when status = 'starting' then 'idle' else status end
     where id = $1
     returning ${AGENT_COLUMNS}`,
    [seat.agent.id, sessionId],
  );
  return { ...seat, agent: rows[0] ?? seat.agent };
};

export const retireSeats = async (
  seats: readonly Seat[],
  kind: string,
  payload: Record<string, unknown> = {},
): Promise<void> => {
  for (const seat of seats) {
    const { rows } = await seat.store.db.query<Agent>(
      `select ${AGENT_COLUMNS} from agents where id = $1 and status <> 'retired'`,
      [seat.agent.id],
    );
    const [agent] = rows;
    if (agent) await markRetired(seat.store, agent, kind, payload);
  }
};

export const birthSeated = async (birth: SeatBirth): Promise<SeatedAgent> => {
  const [site] = birth.sites;
  if (site === undefined) throw new NoSeatsError(birth.role);
  await assertLaunchBudget(site.store, birth.budget, {});
  const seats = await insertSeats(birth);
  const [lead] = seats;
  if (lead === undefined) throw new NoSeatsError(birth.role);
  const cwd = coordinatorDir(birth.home);
  const sessions = createCrewSessions({
    store: lead.store,
    slug: COORDINATOR_SITE,
    bus: fanOutBus(seats, lead),
    adapters: birth.adapters,
    repoPath: async () => {
      await ensurePrivateDir(cwd);
      return cwd;
    },
    homeDir: birth.homeDir,
    passEnv: birth.passEnv,
    servers: seatServers(seats),
    onExit: birth.onExit,
  });
  let sessionId: string;
  try {
    sessionId = await sessions.open(lead.agent);
  } catch (err) {
    await sessions.closeAll();
    await retireSeats(seats, 'agent.birth_failed', {
      error: getErrorMessage(err),
    });
    throw err;
  }
  const attached = await Promise.all(
    seats.map((seat) => attachSeat(seat, sessionId)),
  );
  return {
    name: lead.agent.name,
    lead: attached[0] ?? lead,
    seats: attached,
    sessions,
    sessionId,
  };
};

export const seatIn = (
  seated: Pick<SeatedAgent, 'seats'>,
  store: Pick<Store, 'projectId'>,
): Seat | undefined =>
  seated.seats.find((seat) => seat.agent.projectId === store.projectId);
