import {
  readActiveNotebook,
  type DriverVoyage,
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
import { readVoyageNumber } from './cleanup.js';
import {
  buildWrapUpPrompt,
  wrapUpFormat,
  type CharterProposal,
  type NotebookProposal,
  type WrapUpResult,
} from './wrap-up-format.js';

export const WRAP_UP_EVENTS = {
  proposed: 'voyage.wrapped_up',
  missed: 'voyage.wrap_up_missed',
} as const;

export const NO_DRIVER_SESSION = 'the voyage has no live Driver session';

export interface WrapUpOptions {
  store: Store;
  voyage: Pick<DriverVoyage, 'agent' | 'voyage' | 'turnAs'>;
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
  voyageId: string;
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
       (project_id, voyage_id, agent_id, op, entry_id, body, pinned, rationale)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      source.projectId,
      source.voyageId,
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
    `insert into charter_proposals (project_id, voyage_id, agent_id, body, rationale)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      source.projectId,
      source.voyageId,
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
  const { store, voyage } = options;
  const source: ProposalSource = {
    projectId: store.projectId,
    voyageId: voyage.voyage.id,
    agentId: voyage.agent.id,
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
      agentId: voyage.agent.id,
      payload: {
        voyageId: voyage.voyage.id,
        voyage: voyage.voyage.number,
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
  voyage: { id: string; number: number },
  agentId: string | null,
  reason: string,
): Promise<WrapUp> => {
  const event: PublishInput = {
    kind: WRAP_UP_EVENTS.missed,
    payload: { voyageId: voyage.id, voyage: voyage.number, reason },
  };
  if (agentId !== null) event.agentId = agentId;
  await store.publish(event);
  return { status: 'missed', reason };
};

const recordMiss = (options: WrapUpOptions, reason: string): Promise<WrapUp> =>
  publishMiss(
    options.store,
    options.voyage.voyage,
    options.voyage.agent.id,
    reason,
  );

export const missWrapUp = async (
  store: Store,
  voyageId: string,
  reason: string,
): Promise<WrapUp> => {
  const number = await readVoyageNumber(store.db, store.projectId, voyageId);
  return publishMiss(store, { id: voyageId, number }, null, reason);
};

const runWrapUpTurn = async (
  options: WrapUpOptions,
  notebook: readonly NotebookEntry[],
): Promise<TurnOutcome<WrapUpResult> | string> => {
  const prompt = buildWrapUpPrompt({
    voyage: options.voyage.voyage,
    charter: options.charter,
    notebook,
  });
  try {
    return await options.voyage.turnAs(prompt, wrapUpFormat(notebook));
  } catch (err) {
    return `the wrap-up turn failed: ${getErrorMessage(err)}`;
  }
};

export const wrapUpVoyage = async (options: WrapUpOptions): Promise<WrapUp> => {
  const { store } = options;
  const notebook = await readActiveNotebook(store.db, store.projectId);
  const outcome = await runWrapUpTurn(options, notebook);
  if (typeof outcome === 'string') return recordMiss(options, outcome);
  if (outcome.status !== 'result')
    return recordMiss(options, missReason(outcome));
  return saveProposals(options, outcome.result, notebook);
};
