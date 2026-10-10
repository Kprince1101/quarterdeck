import type { ForgeTerms } from '@quarterdeck/rules';
import {
  AGENT_RETIRED_EVENT,
  FINISHED_AGENT_STATUSES,
  type AgentStatus,
} from '../agents/index.js';
import { projectBusName } from '../bus/index.js';
import { runPrompt, type TurnTarget } from '../driver/index.js';
import {
  reviewPrompt,
  type ReviewerHost,
  type ReviewRequest,
} from '../gate/index.js';
import { AgentExitedError, type FailureTarget } from './failures.js';
import {
  retireSeats,
  type Seat,
  type SeatSite,
  type SeatedAgent,
} from './seats.js';
import type { WorkspaceMode } from '../stream/schema.js';
import { DEFAULT_WORKSPACE_MODE } from '../workspace/feed.js';
import { AgentNotLiveError } from './sessions.js';

export interface ReviewerDeskOptions {
  sites: () => Promise<readonly SeatSite[]>;
  birth: (sites: readonly SeatSite[]) => Promise<SeatedAgent>;
  turnsDir: (project: string) => string;
  brief: (project: string) => Promise<string>;
  services: (project: string, ticketId: string) => Promise<string>;
  report: (targets: readonly FailureTarget[]) => (err: unknown) => void;
  mode?: (() => Promise<WorkspaceMode>) | undefined;
}

export interface ReviewerDesk extends ReviewerHost {
  ensure: () => Promise<void>;
  exited: () => void;
  close: () => Promise<void>;
}

export const reviewerInput = (
  brief: string,
  request: ReviewRequest,
  services: string,
): string =>
  `${brief.trim()}\n\n# Review\n\n${reviewPrompt(request)}\n\n${services}`;

export const reviewBusLine = (
  project: string,
  terms: ForgeTerms,
  mode: WorkspaceMode,
): string => {
  const bus = `use the tools of the bus \`${projectBusName(project)}\` for it.`;
  if (mode === 'single') return `For this ${terms.long}, ${bus}`;
  return `This ${terms.long} belongs to project ${project}: ${bus}`;
};

const isLiveSeat = async (seat: Seat | undefined): Promise<boolean> => {
  if (seat === undefined) return false;
  const { rows } = await seat.store.db.query<{ status: AgentStatus }>(
    'select status from agents where id = $1',
    [seat.agent.id],
  );
  const status = rows[0]?.status;
  return status !== undefined && !FINISHED_AGENT_STATUSES.includes(status);
};

const seatsCover = async (
  reviewer: SeatedAgent,
  sites: readonly SeatSite[],
): Promise<boolean> => {
  const live = await Promise.all(
    sites.map((site) =>
      isLiveSeat(
        reviewer.seats.find(
          (seat) => seat.agent.projectId === site.store.projectId,
        ),
      ),
    ),
  );
  return live.every(Boolean);
};

export const createReviewerDesk = (
  options: ReviewerDeskOptions,
): ReviewerDesk => {
  let current: SeatedAgent | undefined;
  let ensuring: Promise<void> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;

  const retire = async (reviewer: SeatedAgent): Promise<void> => {
    if (current === reviewer) current = undefined;
    await reviewer.sessions.closeAll();
    await retireSeats(reviewer.seats, AGENT_RETIRED_EVENT);
  };

  const retireAfterReviews = async (reviewer: SeatedAgent): Promise<void> => {
    current = undefined;
    await queue.catch(() => undefined);
    await retire(reviewer);
  };

  const birthIfMissing = async (): Promise<void> => {
    const sites = await options.sites();
    if (closed || sites.length === 0) return;
    if (current !== undefined && (await seatsCover(current, sites))) return;
    if (current !== undefined) await retireAfterReviews(current);
    const born = await options.birth(sites);
    if (closed) {
      await retire(born);
      return;
    }
    current = born;
  };

  const ensure = (): Promise<void> => {
    ensuring ??= birthIfMissing().finally(() => {
      ensuring = undefined;
    });
    return ensuring;
  };

  const reviewTarget = (
    request: ReviewRequest,
  ): TurnTarget & { seat: Seat } => {
    const seat = current?.seats.find(
      (each) => each.agent.id === request.reviewer.id,
    );
    if (current === undefined || seat === undefined)
      throw new AgentNotLiveError(request.reviewer.id);
    const client = current.sessions.client(current.sessionId);
    if (client === undefined) throw new AgentNotLiveError(request.reviewer.id);
    return {
      seat,
      store: seat.store,
      client,
      agent: seat.agent,
      sessionId: current.sessionId,
      turnsDir: options.turnsDir(seat.project),
      ticketId: request.ticket.id,
    };
  };

  const requestReview = async (request: ReviewRequest): Promise<void> => {
    const target = reviewTarget(request);
    const { project } = target.seat;
    const [brief, services, mode] = await Promise.all([
      options.brief(project),
      options.services(project, request.ticket.id),
      options.mode?.() ?? DEFAULT_WORKSPACE_MODE,
    ]);
    const input = `${reviewerInput(brief, request, services)}\n\n${reviewBusLine(project, request.terms, mode)}`;
    const turn = queue
      .catch(() => undefined)
      .then(() => runPrompt(target, input));
    queue = turn;
    turn.catch(
      options.report([
        {
          store: target.store,
          links: { agentId: target.agent.id, ticketId: request.ticket.id },
        },
      ]),
    );
  };

  const exited = (): void => {
    const reviewer = current;
    if (reviewer === undefined) return;
    current = undefined;
    const report = options.report(
      reviewer.seats.map((seat) => ({
        store: seat.store,
        links: { agentId: seat.agent.id },
      })),
    );
    report(new AgentExitedError(reviewer.lead.agent));
    retireSeats(reviewer.seats, AGENT_RETIRED_EVENT).catch(report);
  };

  const close = async (): Promise<void> => {
    closed = true;
    await ensuring?.catch(() => undefined);
    await current?.sessions.closeAll();
    current = undefined;
  };

  return { requestReview, ensure, exited, close };
};
