import type { MergeGate } from '@quarterdeck/rules';
import type { MergeCardState, TicketFacts } from './facts.js';
import type { PullRequest } from './github.js';

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

export const WAITING = {
  reviewer: 'waiting for a live reviewer',
  human: 'waiting for a human to answer the merge card',
  held: 'held: the merge card was not answered merge',
  draft: 'waiting: the pull request is a draft',
  checks: 'waiting for checks to finish',
  mergeable: 'waiting for GitHub to work out whether it merges cleanly',
  copilot: 'waiting for a Copilot review',
} as const;

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

const checksStep = (pr: PullRequest): MergeStep | undefined => {
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
    return { kind: 'wait', reason: WAITING.checks };
  return undefined;
};

const copilotStep = (pr: PullRequest): MergeStep | undefined => {
  if (pr.copilot.openThreads > 0)
    return {
      kind: 'bounce',
      reason: `${pr.copilot.openThreads} Copilot review thread(s) are unresolved; answer and resolve each, then report again`,
    };
  if (!pr.copilot.reviewed) return { kind: 'wait', reason: WAITING.copilot };
  return undefined;
};

const readinessStep = (
  pr: PullRequest,
  rules: MergeGate,
): MergeStep | undefined => {
  if (pr.draft) return { kind: 'wait', reason: WAITING.draft };
  if (rules.requireChecksPassing) {
    const step = checksStep(pr);
    if (step) return step;
  }
  if (pr.mergeable === 'conflicting')
    return {
      kind: 'bounce',
      reason:
        'the pull request conflicts with its base; rebase, push and report again',
    };
  if (pr.mergeable === 'unknown')
    return { kind: 'wait', reason: WAITING.mergeable };
  if (rules.requireCopilotReview) return copilotStep(pr);
  return undefined;
};

export const mergeStep = (
  approval: Approval,
  pr: PullRequest,
  card: MergeCardState,
  rules: MergeGate,
): MergeStep => {
  if (pr.state === 'merged') return { kind: 'merged' };
  if (pr.state === 'closed')
    return {
      kind: 'bounce',
      reason:
        'the pull request was closed without merging; reopen it or open a new one and report again',
    };
  if (pr.head !== approval.head)
    return {
      kind: 'bounce',
      reason: `the pull request head is ${pr.head}, not the approved ${approval.head}; report the new head for review`,
    };
  if (card === 'held') return { kind: 'wait', reason: WAITING.held };
  const notReady = readinessStep(pr, rules);
  if (notReady) return notReady;
  if (card === 'merge') return { kind: 'merge' };
  if (card === 'open') return { kind: 'wait', reason: WAITING.human };
  if (rules.autoMerge) return { kind: 'merge' };
  return { kind: 'ask' };
};
