import type { OpenRequest, ProjectRequests } from '@quarterdeck/server/intents';
import type { TicketRow } from '@quarterdeck/server/stream-schema';
import { DEMO_FORGE, DEMO_PROJECT } from './demo-seed.js';
import type { DemoWorld } from './demo-world.js';

const HOUR_MS = 3_600_000;
const TICKET_PREFIX_LENGTH = 8;

const OPEN_STATUSES: ReadonlySet<string> = new Set(['in_review', 'bounced']);

const PR_NUMBER = /\/(\d+)\/?$/;

export const DEMO_GITLAB_PROJECT = 'lighthouse';

interface StaticRequest {
  number: number;
  title: string;
  author: string;
  branch: string;
  draft: boolean;
  checks: OpenRequest['checks'];
  review: OpenRequest['review'];
  hoursOld: number;
}

const HARBOR_EXTRA: StaticRequest = {
  number: 4,
  title: 'Bump the tide-table library to 3.2',
  author: 'dependabot',
  branch: 'dependabot/npm/tide-table-3.2.0',
  draft: false,
  checks: 'pending',
  review: 'none',
  hoursOld: 30,
};

const LIGHTHOUSE: StaticRequest[] = [
  {
    number: 18,
    title: 'Dim the beam schedule after midnight',
    author: 'keeper',
    branch: 'beam-schedule',
    draft: false,
    checks: 'passing',
    review: 'approved',
    hoursOld: 5,
  },
  {
    number: 17,
    title: 'Fog horn volume per season',
    author: 'keeper',
    branch: 'fog-horn-seasons',
    draft: true,
    checks: 'failing',
    review: 'none',
    hoursOld: 52,
  },
];

const prNumber = (url: string): number => Number(PR_NUMBER.exec(url)?.[1] ?? 1);

export const createDemoRequests = (
  world: DemoWorld,
): (() => ProjectRequests[]) => {
  const { store } = world;
  const hoursAgo = (hours: number): string =>
    new Date(Date.parse(store.now()) - hours * HOUR_MS).toISOString();

  const fromStatic = (base: string, request: StaticRequest): OpenRequest => ({
    url: `${base}${request.number}`,
    number: request.number,
    title: request.title,
    author: request.author,
    branch: request.branch,
    base: 'main',
    draft: request.draft,
    checks: request.checks,
    review: request.review,
    createdAt: hoursAgo(request.hoursOld),
    ticket: null,
    agent: null,
  });

  const agentOf = (ticket: TicketRow): OpenRequest['agent'] => {
    const agent =
      ticket.assigneeId !== null && store.find('agents', ticket.assigneeId);
    if (!agent) return null;
    return { id: agent.id, name: agent.name };
  };

  const fromTicket = (ticket: TicketRow & { prUrl: string }): OpenRequest => {
    const agent = agentOf(ticket);
    const request: OpenRequest = {
      url: ticket.prUrl,
      number: prNumber(ticket.prUrl),
      title: ticket.title,
      author: 'quarterdeck-builder',
      branch: `${agent?.name ?? 'builder'}-${ticket.id.slice(0, TICKET_PREFIX_LENGTH)}`,
      base: 'main',
      draft: false,
      checks: 'passing',
      review: 'none',
      createdAt: ticket.updatedAt,
      ticket: { id: ticket.id, title: ticket.title, status: ticket.status },
      agent,
    };
    if (ticket.status === 'bounced')
      return { ...request, checks: 'failing', review: 'changes' };
    return request;
  };

  const harbor = (): OpenRequest[] => [
    ...store
      .rows('tickets')
      .filter(
        (ticket): ticket is TicketRow & { prUrl: string } =>
          ticket.prUrl !== null && OPEN_STATUSES.has(ticket.status),
      )
      .map(fromTicket)
      .toSorted((a, b) => b.number - a.number),
    fromStatic('https://github.com/demo/harbor/pull/', HARBOR_EXTRA),
  ];

  return (): ProjectRequests[] => [
    {
      project: DEMO_PROJECT,
      name: 'Harbor',
      forge: DEMO_FORGE,
      requests: harbor(),
      error: null,
      fetchedAt: store.now(),
    },
    {
      project: DEMO_GITLAB_PROJECT,
      name: 'Lighthouse',
      forge: 'gitlab',
      requests: LIGHTHOUSE.map((request) =>
        fromStatic(
          'https://gitlab.com/demo/lighthouse/-/merge_requests/',
          request,
        ),
      ),
      error: null,
      fetchedAt: store.now(),
    },
  ];
};
