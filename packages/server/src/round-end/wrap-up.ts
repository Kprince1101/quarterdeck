import {
  readActiveNotebook,
  type DriverRound,
  type NotebookEntry,
  type TurnOutcome,
} from '../driver/index.js';
import { getErrorMessage } from '../lib/errors.js';
import {
  publishEvent,
  type PublishInput,
  type Queryable,
  type Store,
} from '../store/index.js';
import { readRoundNumber } from './cleanup.js';
import {
  buildWrapUpPrompt,
  wrapUpFormat,
  type CharterProposal,
  type NotebookProposal,
  type WrapUpResult,
} from './wrap-up-format.js';

export const WRAP_UP_EVENTS = {
  proposed: 'round.wrapped_up',
  missed: 'round.wrap_up_missed',
} as const;

export const NO_DRIVER_SESSION = 'the round has no live Driver session';

export interface WrapUpOptions {
  store: Store;
  round: Pick<DriverRound, 'agent' | 'round' | 'turnAs'>;
  charter: string;
}

export type WrapUp =
  | {
      status: 'proposed';
      summary: string;
      notebookProposalIds: string[];
      charterProposalId: string | null;
    }
  | { status: 'missed'; reason: string };

interface ProposalSource {
  projectId: string;
  roundId: string;
  agentId: string;
}

interface ProposalColumns {
  entryId: string | null;
  body: string | null;
  pinned: boolean;
}

const proposalColumns = (proposal: NotebookProposal): ProposalColumns => {
  if (proposal.op === 'add')
    return { entryId: null, body: proposal.body, pinned: proposal.pinned };
  if (proposal.op === 'update')
    return { entryId: proposal.entry, body: proposal.body, pinned: false };
  return { entryId: proposal.entry, body: null, pinned: false };
};

const insertNotebookProposal = async (
  tx: Queryable,
  source: ProposalSource,
  proposal: NotebookProposal,
): Promise<string> => {
  const { entryId, body, pinned } = proposalColumns(proposal);
  const { rows } = await tx.query<{ id: string }>(
    `insert into notebook_proposals
       (project_id, round_id, agent_id, op, entry_id, body, pinned, rationale)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      source.projectId,
      source.roundId,
      source.agentId,
      proposal.op,
      entryId,
      body,
      pinned,
      proposal.rationale,
    ],
  );
  const [row] = rows;
  if (!row) throw new Error(`notebook proposal ${proposal.op} was not saved`);
  return row.id;
};

const insertCharterProposal = async (
  tx: Queryable,
  source: ProposalSource,
  proposal: CharterProposal,
): Promise<string> => {
  const { rows } = await tx.query<{ id: string }>(
    `insert into charter_proposals (project_id, round_id, agent_id, body, rationale)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      source.projectId,
      source.roundId,
      source.agentId,
      proposal.body,
      proposal.rationale,
    ],
  );
  const [row] = rows;
  if (!row) throw new Error('charter proposal was not saved');
  return row.id;
};

const changesSomething = (
  proposal: NotebookProposal,
  notebook: readonly NotebookEntry[],
): boolean => {
  if (proposal.op !== 'update') return true;
  const entry = notebook.find(({ id }) => id === proposal.entry);
  return entry?.body.trim() !== proposal.body;
};

const changedCharter = (
  result: WrapUpResult,
  charter: string,
): CharterProposal | undefined => {
  if (result.charter === null) return undefined;
  if (result.charter.body === charter.trim()) return undefined;
  return result.charter;
};

const saveProposals = (
  options: WrapUpOptions,
  result: WrapUpResult,
  notebook: readonly NotebookEntry[],
): Promise<WrapUp> => {
  const { store, round } = options;
  const source: ProposalSource = {
    projectId: store.projectId,
    roundId: round.round.id,
    agentId: round.agent.id,
  };
  const changes = result.notebook.filter((proposal) =>
    changesSomething(proposal, notebook),
  );
  const charter = changedCharter(result, options.charter);
  return store.db.transaction(async (tx) => {
    const notebookProposalIds: string[] = [];
    for (const proposal of changes) {
      notebookProposalIds.push(
        await insertNotebookProposal(tx, source, proposal),
      );
    }
    let charterProposalId: string | null = null;
    if (charter !== undefined)
      charterProposalId = await insertCharterProposal(tx, source, charter);
    await publishEvent(tx, store.projectId, {
      kind: WRAP_UP_EVENTS.proposed,
      agentId: round.agent.id,
      payload: {
        roundId: round.round.id,
        round: round.round.number,
        summary: result.summary,
        notebookProposals: notebookProposalIds,
        charterProposal: charterProposalId,
      },
    });
    return {
      status: 'proposed',
      summary: result.summary,
      notebookProposalIds,
      charterProposalId,
    };
  });
};

type MissedOutcome = Exclude<TurnOutcome<WrapUpResult>, { status: 'result' }>;

const missReason = (outcome: MissedOutcome): string => {
  if (outcome.status === 'missed') return outcome.error;
  return `the wrap-up turn stopped: ${outcome.stopReason}`;
};

const publishMiss = async (
  store: Store,
  round: { id: string; number: number },
  agentId: string | null,
  reason: string,
): Promise<WrapUp> => {
  const event: PublishInput = {
    kind: WRAP_UP_EVENTS.missed,
    payload: { roundId: round.id, round: round.number, reason },
  };
  if (agentId !== null) event.agentId = agentId;
  await store.publish(event);
  return { status: 'missed', reason };
};

const recordMiss = (options: WrapUpOptions, reason: string): Promise<WrapUp> =>
  publishMiss(
    options.store,
    options.round.round,
    options.round.agent.id,
    reason,
  );

export const missWrapUp = async (
  store: Store,
  roundId: string,
  reason: string,
): Promise<WrapUp> => {
  const number = await readRoundNumber(store.db, store.projectId, roundId);
  return publishMiss(store, { id: roundId, number }, null, reason);
};

const runWrapUpTurn = async (
  options: WrapUpOptions,
  notebook: readonly NotebookEntry[],
): Promise<TurnOutcome<WrapUpResult> | string> => {
  const prompt = buildWrapUpPrompt({
    round: options.round.round,
    charter: options.charter,
    notebook,
  });
  try {
    return await options.round.turnAs(prompt, wrapUpFormat(notebook));
  } catch (err) {
    return `the wrap-up turn failed: ${getErrorMessage(err)}`;
  }
};

export const wrapUpRound = async (options: WrapUpOptions): Promise<WrapUp> => {
  const { store } = options;
  const notebook = await readActiveNotebook(store.db, store.projectId);
  const outcome = await runWrapUpTurn(options, notebook);
  if (typeof outcome === 'string') return recordMiss(options, outcome);
  if (outcome.status !== 'result')
    return recordMiss(options, missReason(outcome));
  return saveProposals(options, outcome.result, notebook);
};
