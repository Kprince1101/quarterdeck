import {
  readNotebooks,
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

export interface WrapUpLeg {
  project: string;
  store: Store;
  voyageId: string;
  agentId: string | null;
}

export interface WrapUpOptions {
  store: Store;
  voyage: Pick<DriverVoyage, 'agent' | 'voyage' | 'turnAs'>;
  charter: string;
  legs?: readonly WrapUpLeg[];
}

export type WrapUp =
  | {
      status: 'proposed';
      summary: string;
      notebookProposalIds: string[];
      charterProposalId: string | null;
    }
  | { status: 'missed'; reason: string };

interface ProposalColumns {
  entryId: string | null;
  body: string | null;
  pinned: boolean;
}

interface PlacedProposal {
  leg: WrapUpLeg;
  proposal: NotebookProposal;
  global: boolean;
}

interface LegNotebook {
  entries: NotebookEntry[];
  owners: Map<string, WrapUpLeg>;
}

const SINGLE_LEGS = new WeakMap<WrapUpOptions, readonly WrapUpLeg[]>();

const singleLeg = (options: WrapUpOptions): readonly WrapUpLeg[] => {
  const cached = SINGLE_LEGS.get(options);
  if (cached !== undefined) return cached;
  const legs = [
    {
      project: '',
      store: options.store,
      voyageId: options.voyage.voyage.id,
      agentId: options.voyage.agent.id,
    },
  ];
  SINGLE_LEGS.set(options, legs);
  return legs;
};

const legsOf = (options: WrapUpOptions): readonly WrapUpLeg[] =>
  options.legs ?? singleLeg(options);

const leadOf = (legs: readonly WrapUpLeg[]): WrapUpLeg => {
  const [lead] = legs;
  if (lead === undefined) throw new Error('a voyage has at least one project');
  return lead;
};

const proposalColumns = (proposal: NotebookProposal): ProposalColumns => {
  if (proposal.op === 'add')
    return { entryId: null, body: proposal.body, pinned: proposal.pinned };
  if (proposal.op === 'update')
    return { entryId: proposal.entry, body: proposal.body, pinned: false };
  return { entryId: proposal.entry, body: null, pinned: false };
};

const insertNotebookProposal = async (
  tx: Queryable,
  placed: PlacedProposal,
): Promise<string> => {
  const { leg, proposal } = placed;
  const { entryId, body, pinned } = proposalColumns(proposal);
  const { rows } = await tx.query<{ id: string }>(
    `insert into notebook_proposals
       (project_id, voyage_id, agent_id, op, entry_id, body, pinned, rationale,
        global)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id`,
    [
      leg.store.projectId,
      leg.voyageId,
      leg.agentId,
      proposal.op,
      entryId,
      body,
      pinned,
      proposal.rationale,
      placed.global,
    ],
  );
  const [row] = rows;
  if (!row) throw new Error(`notebook proposal ${proposal.op} was not saved`);
  return row.id;
};

const insertCharterProposal = async (
  tx: Queryable,
  leg: WrapUpLeg,
  proposal: CharterProposal,
): Promise<string> => {
  const { rows } = await tx.query<{ id: string }>(
    `insert into charter_proposals (project_id, voyage_id, agent_id, body, rationale)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      leg.store.projectId,
      leg.voyageId,
      leg.agentId,
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

const placeProposal = (
  options: WrapUpOptions,
  notebook: LegNotebook,
  proposal: NotebookProposal,
): PlacedProposal => {
  const legs = legsOf(options);
  const lead = leadOf(legs);
  if (proposal.op !== 'add')
    return {
      leg: notebook.owners.get(proposal.entry) ?? lead,
      proposal,
      global: false,
    };
  const named = legs.find((leg) => leg.project === proposal.project);
  if (named !== undefined) return { leg: named, proposal, global: false };
  return { leg: lead, proposal, global: options.legs !== undefined };
};

interface LegProposals {
  notebook: string[];
  charter: string | null;
}

const saveLeg = (
  options: WrapUpOptions,
  leg: WrapUpLeg,
  placed: readonly PlacedProposal[],
  result: WrapUpResult,
  charter: CharterProposal | undefined,
): Promise<LegProposals> =>
  leg.store.db.transaction(async (tx) => {
    const notebook: string[] = [];
    for (const proposal of placed.filter((each) => each.leg === leg))
      notebook.push(await insertNotebookProposal(tx, proposal));
    let charterId: string | null = null;
    if (charter !== undefined)
      charterId = await insertCharterProposal(tx, leg, charter);
    const event: PublishInput = {
      kind: WRAP_UP_EVENTS.proposed,
      payload: {
        voyageId: leg.voyageId,
        voyage: options.voyage.voyage.number,
        summary: result.summary,
        notebookProposals: notebook,
        charterProposal: charterId,
      },
    };
    if (leg.agentId !== null) event.agentId = leg.agentId;
    await publishEvent(tx, leg.store.projectId, event);
    return { notebook, charter: charterId };
  });

const saveProposals = async (
  options: WrapUpOptions,
  result: WrapUpResult,
  notebook: LegNotebook,
): Promise<WrapUp> => {
  const legs = legsOf(options);
  const lead = leadOf(legs);
  const placed = result.notebook
    .filter((proposal) => changesSomething(proposal, notebook.entries))
    .map((proposal) => placeProposal(options, notebook, proposal));
  const charter = changedCharter(result, options.charter);
  const notebookProposalIds: string[] = [];
  let charterProposalId: string | null = null;
  for (const leg of legs) {
    const saved = await saveLeg(
      options,
      leg,
      placed,
      result,
      (leg === lead && charter) || undefined,
    );
    notebookProposalIds.push(...saved.notebook);
    charterProposalId ??= saved.charter;
  }
  return {
    status: 'proposed',
    summary: result.summary,
    notebookProposalIds,
    charterProposalId,
  };
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

const recordMiss = async (
  options: WrapUpOptions,
  reason: string,
): Promise<WrapUp> => {
  const { number } = options.voyage.voyage;
  for (const leg of legsOf(options))
    await publishMiss(
      leg.store,
      { id: leg.voyageId, number },
      leg.agentId,
      reason,
    );
  return { status: 'missed', reason };
};

export const missWrapUp = async (
  store: Store,
  voyageId: string,
  reason: string,
): Promise<WrapUp> => {
  const number = await readVoyageNumber(store.db, store.projectId, voyageId);
  return publishMiss(store, { id: voyageId, number }, null, reason);
};

const voyageProjects = (
  options: WrapUpOptions,
): ReadonlySet<string> | undefined => {
  if (options.legs === undefined) return undefined;
  return new Set(options.legs.map((leg) => leg.project));
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
    return await options.voyage.turnAs(
      prompt,
      wrapUpFormat(notebook, voyageProjects(options)),
    );
  } catch (err) {
    return `the wrap-up turn failed: ${getErrorMessage(err)}`;
  }
};

export const wrapUpVoyage = async (options: WrapUpOptions): Promise<WrapUp> => {
  const notebook: LegNotebook = await readNotebooks(legsOf(options));
  const outcome = await runWrapUpTurn(options, notebook.entries);
  if (typeof outcome === 'string') return recordMiss(options, outcome);
  if (outcome.status !== 'result')
    return recordMiss(options, missReason(outcome));
  return saveProposals(options, outcome.result, notebook);
};
