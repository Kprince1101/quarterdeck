import type { Runtime } from '@quarterdeck/rules';
import { findAgent, type AgentLifecycle } from '../agents/index.js';
import { liveReviewer } from '../bus/review.js';
import { runPrompt, type TurnTarget } from '../driver/index.js';
import {
  reviewPrompt,
  type ReviewerHost,
  type ReviewRequest,
} from '../gate/index.js';
import type { Store } from '../store/index.js';
import type { CrewFailureReporter } from './failures.js';
import { AgentNotLiveError, type CrewSessionHost } from './sessions.js';

export interface ReviewerDeskOptions {
  store: Store;
  sessions: Pick<CrewSessionHost, 'client'>;
  lifecycle: Pick<AgentLifecycle, 'birth'>;
  turnsDir: string;
  brief: () => Promise<string>;
  runtime: () => Promise<Runtime>;
  report: CrewFailureReporter;
}

export interface ReviewerDesk extends ReviewerHost {
  ensure: () => Promise<void>;
  close: () => Promise<void>;
}

export const reviewerInput = (brief: string, request: ReviewRequest): string =>
  `${brief.trim()}\n\n# Review\n\n${reviewPrompt(request)}`;

export const createReviewerDesk = (
  options: ReviewerDeskOptions,
): ReviewerDesk => {
  const { store } = options;
  const queues = new Map<string, Promise<unknown>>();
  let ensuring: Promise<void> | undefined;

  const birthIfMissing = async (): Promise<void> => {
    if (await liveReviewer(store.db, store.projectId)) return;
    await options.lifecycle.birth({
      store,
      role: 'reviewer',
      runtime: await options.runtime(),
    });
  };

  const ensure = (): Promise<void> => {
    ensuring ??= birthIfMissing().finally(() => {
      ensuring = undefined;
    });
    return ensuring;
  };

  const reviewTarget = async (request: ReviewRequest): Promise<TurnTarget> => {
    const reviewer = await findAgent(store, request.reviewer.id);
    const { sessionId } = reviewer;
    if (sessionId === null) throw new AgentNotLiveError(reviewer.id);
    const client = options.sessions.client(sessionId);
    if (client === undefined) throw new AgentNotLiveError(reviewer.id);
    return {
      store,
      client,
      agent: reviewer,
      sessionId,
      turnsDir: options.turnsDir,
      ticketId: request.ticket.id,
    };
  };

  const requestReview = async (request: ReviewRequest): Promise<void> => {
    const target = await reviewTarget(request);
    const input = reviewerInput(await options.brief(), request);
    const previous = queues.get(target.agent.id) ?? Promise.resolve();
    const turn = previous
      .catch(() => undefined)
      .then(() => runPrompt(target, input));
    queues.set(target.agent.id, turn);
    turn.catch(
      options.report('reviewer', {
        agentId: target.agent.id,
        ticketId: request.ticket.id,
      }),
    );
  };

  const close = async (): Promise<void> => {
    await ensuring?.catch(() => undefined);
  };

  return { requestReview, ensure, close };
};
