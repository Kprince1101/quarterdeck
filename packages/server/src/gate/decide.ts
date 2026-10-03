import {
  aiReviewersOf,
  forgeTerms,
  type Forge,
  type ForgeTerms,
  type MergeGate,
} from '@quarterdeck/rules';
import type { MergeCardState, TicketFacts } from './facts.js';
import type { PullRequest, PullRequestRef, RepositoryRef } from './forge.js';
import { repositoryName, sameRepository } from './repository.js';

export interface Approval {
  eventId: number;
  reportId: number;
  pr: string;
  head: string;
  cardId: string | undefined;
}

export type ReviewStep =
  | { kind: 'idle' }
  | { kind: 'review' }
  | { kind: 'wait'; reason: string }
  | { kind: 'bounce'; reason: string }
  | { kind: 'merge-gate'; approval: Approval };

export type MergeStep =
  | { kind: 'idle' }
  | { kind: 'wait'; reason: string }
  | { kind: 'bounce'; reason: string }
  | { kind: 'merged' }
  | { kind: 'merge' }
  | { kind: 'ask' };

export interface WaitingReasons {
  reviewer: string;
  human: string;
  held: string;
  draft: string;
  checks: string;
  mergeable: string;
}

export const waitingReasons = (terms: ForgeTerms): WaitingReasons => ({
  reviewer: 'waiting for a live reviewer',
  human: 'waiting for a human to answer the merge card',
  held: 'held: the merge card was not answered merge',
  draft: `waiting: the ${terms.long} is a draft`,
  checks: 'waiting for checks to finish',
  mergeable: `waiting for ${terms.name} to work out whether it merges cleanly`,
});

const orList = (names: readonly string[]): string => {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1) ?? ''}`;
};

export const aiReviewWaiting = (bots: readonly string[]): string =>
  `waiting for an AI review from ${orList(bots)}`;

const approvalOf = (
  facts: TicketFacts,
  rules: MergeGate,
): Pick<Approval, 'eventId' | 'pr' | 'head'> | ReviewStep => {
  const { report, verdict } = facts;
  if (report === undefined) return { kind: 'idle' };
  if (!rules.requireReviewerApproval)
    return { eventId: report.eventId, pr: report.pr, head: report.head ?? '' };
  if (verdict === undefined) {
    if (facts.reviewRequested) return { kind: 'idle' };
    return { kind: 'review' };
  }
  if (verdict.decision !== 'approve') return { kind: 'idle' };
  return {
    eventId: verdict.eventId,
    pr: verdict.pr ?? report.pr,
    head: verdict.head ?? '',
  };
};

export const reviewStep = (
  facts: TicketFacts,
  rules: MergeGate,
): ReviewStep => {
  if (facts.ticket.status !== 'in_review' || facts.report === undefined)
    return { kind: 'idle' };
  const approval = approvalOf(facts, rules);
  if ('kind' in approval) return approval;
  if (approval.head === '')
    return {
      kind: 'bounce',
      reason:
        'the report gave no head commit, so the gate cannot tell what was approved; report again with head',
    };
  const card = facts.mergeCards.findLast(
    ({ eventId }) => eventId > approval.eventId,
  );
  return {
    kind: 'merge-gate',
    approval: {
      ...approval,
      reportId: facts.report.eventId,
      cardId: card?.cardId,
    },
  };
};

interface MergeContext {
  rules: MergeGate;
  project: RepositoryRef;
  forge: Forge;
  terms: ForgeTerms;
  waiting: WaitingReasons;
}

const checksStep = (
  pr: PullRequest,
  ctx: MergeContext,
): MergeStep | undefined => {
  if (pr.checks.state === 'failing') {
    let names = '';
    if (pr.checks.failing.length > 0)
      names = `: ${pr.checks.failing.join(', ')}`;
    return {
      kind: 'bounce',
      reason: `checks are failing${names}; fix them, push and report again`,
    };
  }
  if (pr.checks.state === 'pending')
    return { kind: 'wait', reason: ctx.waiting.checks };
  return undefined;
};

const aiReviewStep = (
  pr: PullRequest,
  ctx: MergeContext,
): MergeStep | undefined => {
  const bots = aiReviewersOf(ctx.rules, ctx.forge);
  const isAiReviewer = (login: string): boolean => bots.includes(login);
  const open = pr.botReview.openThreads.filter(isAiReviewer);
  if (open.length > 0)
    return {
      kind: 'bounce',
      reason: `${open.length} AI review thread(s) from ${orList([...new Set(open)])} are unresolved on the ${ctx.terms.long}; answer and resolve each, then report again`,
    };
  if (!pr.botReview.reviewers.some(isAiReviewer))
    return { kind: 'wait', reason: aiReviewWaiting(bots) };
  return undefined;
};

const readinessStep = (
  pr: PullRequest,
  ctx: MergeContext,
): MergeStep | undefined => {
  if (pr.draft) return { kind: 'wait', reason: ctx.waiting.draft };
  if (ctx.rules.requireChecksPassing) {
    const step = checksStep(pr, ctx);
    if (step) return step;
  }
  if (pr.mergeable === 'conflicting')
    return {
      kind: 'bounce',
      reason: `the ${ctx.terms.long} conflicts with its base; rebase, push and report again`,
    };
  if (pr.mergeable === 'unknown')
    return { kind: 'wait', reason: ctx.waiting.mergeable };
  if (ctx.rules.requireAiReview) return aiReviewStep(pr, ctx);
  return undefined;
};

const notInRepository = (
  url: string,
  project: RepositoryRef,
  terms: ForgeTerms,
): string =>
  `the ${terms.long} ${url} is not in this project's repository ${repositoryName(project)}; open it there and report again`;

export const foreignPullRequest = (
  url: string,
  project: RepositoryRef,
  terms: ForgeTerms,
  parse: (url: string) => PullRequestRef,
): string | undefined => {
  let ref: PullRequestRef;
  try {
    ref = parse(url);
  } catch {
    return `${url} is not a ${terms.name} ${terms.long} URL; report the ${terms.long}'s URL`;
  }
  if (!sameRepository(ref, project))
    return notInRepository(url, project, terms);
  return undefined;
};

const targetStep = (
  approval: Approval,
  pr: PullRequest,
  ctx: MergeContext,
): MergeStep | undefined => {
  const { project, terms } = ctx;
  if (!sameRepository(pr.repository, project))
    return {
      kind: 'bounce',
      reason: notInRepository(approval.pr, project, terms),
    };
  const base = ctx.rules.base ?? pr.defaultBranch;
  if (base === null)
    return {
      kind: 'bounce',
      reason: `${repositoryName(project)} has no default branch to merge into; set mergeGate.base`,
    };
  if (pr.base !== base)
    return {
      kind: 'bounce',
      reason: `the ${terms.long} merges into ${pr.base}, not ${base}; retarget it to ${base} and report again`,
    };
  return undefined;
};

const settledStep = (
  approval: Approval,
  pr: PullRequest,
  ctx: MergeContext,
): MergeStep | undefined => {
  const offTarget = targetStep(approval, pr, ctx);
  if (offTarget) return offTarget;
  if (pr.state === 'merged') return { kind: 'merged' };
  if (pr.state === 'closed')
    return {
      kind: 'bounce',
      reason: `the ${ctx.terms.long} was closed without merging; reopen it or open a new one and report again`,
    };
  if (pr.head !== approval.head)
    return {
      kind: 'bounce',
      reason: `the ${ctx.terms.long} head is ${pr.head}, not the approved ${approval.head}; report the new head for review`,
    };
  return undefined;
};

export const mergeStep = (
  approval: Approval,
  pr: PullRequest,
  card: MergeCardState,
  rules: MergeGate,
  project: RepositoryRef,
  forge: Forge,
): MergeStep => {
  const terms = forgeTerms(forge);
  const waiting = waitingReasons(terms);
  const ctx = { rules, project, forge, terms, waiting };
  const settled = settledStep(approval, pr, ctx);
  if (settled) return settled;
  if (card === 'held') return { kind: 'wait', reason: ctx.waiting.held };
  const notReady = readinessStep(pr, ctx);
  if (notReady) return notReady;
  if (card === 'merge') return { kind: 'merge' };
  if (card === 'open') return { kind: 'wait', reason: ctx.waiting.human };
  if (rules.autoMerge) return { kind: 'merge' };
  return { kind: 'ask' };
};
