import type { BudgetWindow, ForgeTerms, Runtime } from '@quarterdeck/rules';
import {
  AGENT_COLUMNS,
  findAgent,
  type Agent,
  type AgentLifecycle,
  type SessionHost,
  type WorktreeHost,
} from '../agents/index.js';
import type { PauseGuard } from '../pause/index.js';
import type { PromptServices } from '../services/index.js';
import type { Store } from '../store/index.js';
import { BuilderNotAvailableError, BuilderSessionLostError } from './errors.js';
import { heldTickets } from './tickets.js';
import {
  runPrompt,
  type TurnClient,
  type TurnRecord,
  type TurnTarget,
} from './turns.js';

export interface BuilderSessionHost extends SessionHost {
  client: (sessionId: string) => TurnClient | undefined;
}

export interface BuilderContext {
  store: Store;
  lifecycle: Pick<AgentLifecycle, 'birth'>;
  sessions: BuilderSessionHost;
  worktrees: WorktreeHost;
  runtime: Runtime;
  repoPath: string;
  base: string;
  terms: ForgeTerms;
  services: PromptServices;
  worktreesDir: string;
  turnsDir: string;
  budget: BudgetWindow;
  pause: PauseGuard;
  voyageId?: string;
}

export interface ClaimedBuilder {
  builder: Agent;
  ticketId: string | null;
}

export interface ClaimRules {
  free: boolean;
  session: boolean;
}

const refusal = (
  agent: Agent,
  ticketId: string | null,
  rules: ClaimRules,
): string | undefined => {
  if (agent.role !== 'builder') return `its role is ${agent.role}`;
  if (agent.status !== 'idle') return `it is ${agent.status}`;
  if (rules.free && ticketId !== null) return `it holds ticket ${ticketId}`;
  if (rules.session && agent.sessionId === null) return 'it has no session';
  return undefined;
};

export const claimBuilder = async (
  store: Store,
  agentId: string,
  rules: ClaimRules,
): Promise<ClaimedBuilder> => {
  const agent = await findAgent(store, agentId);
  const [held] = await heldTickets(store, agentId);
  const ticketId = held?.id ?? null;
  const reason = refusal(agent, ticketId, rules);
  if (reason !== undefined) throw new BuilderNotAvailableError(agentId, reason);
  const { rows } = await store.db.query<Agent>(
    `update agents set status = 'working'
     where id = $1 and status = 'idle'
     returning ${AGENT_COLUMNS}`,
    [agentId],
  );
  const [builder] = rows;
  if (!builder) throw new BuilderNotAvailableError(agentId, 'it is busy');
  return { builder, ticketId };
};

export const releaseBuilder = async (
  store: Store,
  agentId: string,
): Promise<void> => {
  await store.db.query(
    `update agents set status = 'idle'
     where id = $1 and status = 'working'`,
    [agentId],
  );
};

export const withClaim = async <T>(
  store: Store,
  agentId: string,
  task: () => Promise<T>,
): Promise<T> => {
  try {
    return await task();
  } catch (err) {
    await releaseBuilder(store, agentId);
    throw err;
  }
};

export const builderTarget = (
  ctx: Pick<BuilderContext, 'store' | 'sessions' | 'turnsDir'>,
  builder: Agent,
  ticketId: string | null,
): TurnTarget => {
  const { sessionId } = builder;
  if (sessionId === null)
    throw new BuilderNotAvailableError(builder.id, 'it has no session');
  const client = ctx.sessions.client(sessionId);
  if (!client) throw new BuilderSessionLostError(builder.id, sessionId);
  const target: TurnTarget = {
    store: ctx.store,
    client,
    agent: builder,
    sessionId,
    turnsDir: ctx.turnsDir,
  };
  if (ticketId !== null) target.ticketId = ticketId;
  return target;
};

export const promptBuilder = (
  target: TurnTarget,
  input: string,
): Promise<TurnRecord> => {
  const turn = runPrompt(target, input);
  turn.catch(() => undefined);
  return turn;
};
