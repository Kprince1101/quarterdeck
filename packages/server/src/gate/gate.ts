import {
  forgeTerms,
  getErrorMessage,
  type MergeGate,
} from '@quarterdeck/rules';
import { isGone, liveReviewer, type ReviewAgent } from '../bus/review.js';
import type {
  Store,
  StoreEvent,
  Subscription,
  TableChange,
  Watcher,
} from '../store/index.js';
import {
  bounce,
  markMerged,
  raiseMergeCard,
  recordReviewRequested,
  recordWaiting,
  type GateStore,
  type Guard,
  type PullRequestAt,
} from './apply.js';
import {
  foreignPullRequest,
  mergeStep,
  reviewStep,
  waitingReasons,
  type Approval,
  type MergeStep,
} from './decide.js';
import {
  GATE_EVENTS,
  MERGE_CARD,
  mergeCardState,
  readFacts,
  type TicketFacts,
} from './facts.js';
import type { ForgeHost, GitRunner, RepositoryRef } from './forge.js';
import { originRepository, projectRepoPath } from './repository.js';
import type { ReviewerHost } from './reviewers.js';

export const GATE_POLL_MS = 60_000;

export type ForgeSource = ForgeHost | (() => Promise<ForgeHost>);

export interface ReviewGateOptions {
  store: Store;
  rules: MergeGate;
  forge: ForgeSource;
  reviewers: ReviewerHost;
  repository?: () => Promise<RepositoryRef>;
  pollMs?: number;
  onError?: (err: unknown) => void;
}

export interface ReviewGate {
  evaluate: (ticketId: string) => Promise<void>;
  sweep: () => Promise<void>;
  close: () => Promise<void>;
}

interface GateContext {
  store: GateStore;
  rules: MergeGate;
  forge: () => Promise<ForgeHost>;
  reviewers: ReviewerHost;
  repository: () => Promise<RepositoryRef>;
}

const TRIGGERS: readonly string[] = [GATE_EVENTS.reported, GATE_EVENTS.verdict];

const reportGateError = (err: unknown): void => {
  console.error('quarterdeck review gate failed', err);
};

export const projectRepository = async (
  store: GateStore,
  run?: GitRunner,
): Promise<RepositoryRef> => {
  const repoPath = await projectRepoPath(store);
  if (!repoPath)
    throw new Error(
      'the project has no repo_path, so the merge gate cannot tell which repository it merges into',
    );
  return originRepository(repoPath, run);
};

const forgeResolver = (source: ForgeSource): (() => Promise<ForgeHost>) => {
  if (typeof source === 'function') return source;
  return () => Promise.resolve(source);
};

const once = <T>(resolve: () => Promise<T>): (() => Promise<T>) => {
  let resolved: Promise<T> | undefined;
  return () => {
    resolved ??= resolve().catch((err: unknown) => {
      resolved = undefined;
      throw err;
    });
    return resolved;
  };
};

const findReviewer = async (
  store: GateStore,
  preferred: string | null,
): Promise<ReviewAgent | undefined> => {
  if (preferred !== null) {
    const { rows } = await store.db.query<ReviewAgent>(
      `select id, name, role, status from agents
       where id = $1 and project_id = $2 and role = 'reviewer'`,
      [preferred, store.projectId],
    );
    const [agent] = rows;
    if (agent && !isGone(agent)) return agent;
  }
  return liveReviewer(store.db, store.projectId);
};

const agentName = async (
  store: GateStore,
  agentId: string | null,
): Promise<{ id: string; name: string } | null> => {
  if (agentId === null) return null;
  const { rows } = await store.db.query<{ id: string; name: string }>(
    'select id, name from agents where id = $1 and project_id = $2',
    [agentId, store.projectId],
  );
  return rows[0] ?? null;
};

const wait = async (
  ctx: GateContext,
  facts: TicketFacts,
  guard: Guard,
  reason: string,
  at: PullRequestAt,
): Promise<void> => {
  if (facts.waitingFor === reason) return;
  await recordWaiting(ctx.store, guard, reason, at);
};

const requestReview = async (
  ctx: GateContext,
  facts: TicketFacts,
  guard: Guard,
): Promise<void> => {
  const { report, ticket } = facts;
  if (report === undefined) return;
  const at = { pr: report.pr, head: report.head };
  const terms = forgeTerms((await ctx.forge()).forge);
  const reviewer = await findReviewer(ctx.store, report.reviewerId);
  if (reviewer === undefined) {
    await wait(ctx, facts, guard, waitingReasons(terms).reviewer, at);
    return;
  }
  await ctx.reviewers.requestReview({
    ticket: { id: ticket.id, title: ticket.title, body: ticket.body },
    reviewer: { id: reviewer.id, name: reviewer.name },
    builder: await agentName(ctx.store, ticket.assigneeId),
    pr: report.pr,
    head: report.head,
    notes: report.notes,
    terms,
  });
  await recordReviewRequested(ctx.store, guard, reviewer.id, at);
};

interface MergeTarget {
  guard: Guard;
  at: PullRequestAt & { head: string };
  host: ForgeHost;
}

const squashMerge = async (
  ctx: GateContext,
  { guard, at, host }: MergeTarget,
): Promise<void> => {
  try {
    await host.squashMerge(at.pr, at.head);
  } catch (err) {
    const terms = forgeTerms(host.forge);
    await raiseMergeCard(ctx.store, guard, at, terms, getErrorMessage(err));
    return;
  }
  await markMerged(ctx.store, guard.ticketId, at, 'gate');
};

const applyMergeStep = async (
  ctx: GateContext,
  facts: TicketFacts,
  step: MergeStep,
  target: MergeTarget,
): Promise<void> => {
  const { guard, at, host } = target;
  if (step.kind === 'merged')
    await markMerged(ctx.store, guard.ticketId, at, host.forge);
  else if (step.kind === 'merge') await squashMerge(ctx, target);
  else if (step.kind === 'ask')
    await raiseMergeCard(ctx.store, guard, at, forgeTerms(host.forge));
  else if (step.kind === 'wait') await wait(ctx, facts, guard, step.reason, at);
  else if (step.kind === 'bounce')
    await bounce(ctx.store, guard, step.reason, at);
};

const runMergeGate = async (
  ctx: GateContext,
  facts: TicketFacts,
  approval: Approval,
): Promise<void> => {
  const guard = { ticketId: facts.ticket.id, reportId: approval.reportId };
  const at = { pr: approval.pr, head: approval.head };
  const host = await ctx.forge();
  const terms = forgeTerms(host.forge);
  const project = await ctx.repository();
  const foreign = foreignPullRequest(
    approval.pr,
    project,
    terms,
    host.pullRequestRef,
  );
  if (foreign !== undefined) {
    await bounce(ctx.store, guard, foreign, at);
    return;
  }
  const card = await mergeCardState(
    ctx.store.db,
    ctx.store.projectId,
    approval.cardId,
  );
  const pr = await host.pullRequest(approval.pr);
  const step = mergeStep(approval, pr, card, ctx.rules, project, terms);
  await applyMergeStep(ctx, facts, step, { guard, at, host });
};

const evaluateTicket = async (
  ctx: GateContext,
  ticketId: string,
): Promise<void> => {
  const facts = await readFacts(ctx.store.db, ctx.store.projectId, ticketId);
  if (facts?.report === undefined) return;
  const guard = { ticketId, reportId: facts.report.eventId };
  const at = { pr: facts.report.pr, head: facts.report.head };
  const step = reviewStep(facts, ctx.rules);
  if (step.kind === 'review') await requestReview(ctx, facts, guard);
  else if (step.kind === 'wait') await wait(ctx, facts, guard, step.reason, at);
  else if (step.kind === 'bounce')
    await bounce(ctx.store, guard, step.reason, at);
  else if (step.kind === 'merge-gate')
    await runMergeGate(ctx, facts, step.approval);
};

const inReviewTickets = async (store: GateStore): Promise<string[]> => {
  const { rows } = await store.db.query<{ id: string }>(
    `select id from tickets where project_id = $1 and status = 'in_review'
     order by created_at, id`,
    [store.projectId],
  );
  return rows.map((row) => row.id);
};

const isAnsweredMergeCard = (change: TableChange): boolean =>
  change.table === 'cards' &&
  change.row?.['kind'] === MERGE_CARD &&
  change.row['status'] !== 'open' &&
  typeof change.row['ticketId'] === 'string';

const isIdleReviewer = (change: TableChange): boolean =>
  change.table === 'agents' &&
  change.row?.['role'] === 'reviewer' &&
  change.row['status'] === 'idle';

export const startReviewGate = async (
  options: ReviewGateOptions,
): Promise<ReviewGate> => {
  const { store } = options;
  const report = options.onError ?? reportGateError;
  const ctx: GateContext = {
    store,
    rules: options.rules,
    reviewers: options.reviewers,
    forge: once(forgeResolver(options.forge)),
    repository: once(options.repository ?? (() => projectRepository(store))),
  };
  const chains = new Map<string, Promise<void>>();
  let closed = false;

  const evaluate = (ticketId: string): Promise<void> => {
    if (closed) return Promise.resolve();
    const previous = chains.get(ticketId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => evaluateTicket(ctx, ticketId))
      .catch((err: unknown) => {
        throw new Error(
          `review gate failed on ticket ${ticketId}: ${getErrorMessage(err)}`,
          { cause: err },
        );
      })
      .finally(() => {
        if (chains.get(ticketId) === next) chains.delete(ticketId);
      });
    chains.set(ticketId, next);
    return next;
  };

  const trigger = (ticketId: string): void => {
    evaluate(ticketId).catch(report);
  };

  const sweepAll = async (): Promise<void> => {
    for (const ticketId of await inReviewTickets(store)) {
      if (closed) return;
      await evaluate(ticketId).catch(report);
    }
  };

  let sweeping: Promise<void> | undefined;
  const sweep = (): Promise<void> => {
    sweeping ??= sweepAll().finally(() => {
      sweeping = undefined;
    });
    return sweeping;
  };
  const scheduleSweep = (): void => {
    if (!closed) sweep().catch(report);
  };

  const onEvent = (event: StoreEvent): void => {
    if (event.ticketId !== null && TRIGGERS.includes(event.kind))
      trigger(event.ticketId);
  };
  const onChange = (change: TableChange): void => {
    if (isAnsweredMergeCard(change)) trigger(String(change.row?.['ticketId']));
    else if (isIdleReviewer(change)) scheduleSweep();
  };

  const subscription: Subscription = await store.subscribe(onEvent, {
    onError: report,
  });
  let watcher: Watcher;
  try {
    watcher = await store.watch(onChange, { onError: report });
  } catch (err) {
    await subscription.close();
    throw err;
  }

  const pollMs = options.pollMs ?? GATE_POLL_MS;
  const timer = setInterval(scheduleSweep, pollMs);
  timer.unref();
  scheduleSweep();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    await Promise.allSettled([subscription.close(), watcher.close()]);
    await Promise.allSettled([sweeping, ...chains.values()]);
  };

  return { evaluate, sweep, close };
};
