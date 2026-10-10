import type { McpServer, StopReason } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FAKE_CRASH_EXIT_CODE, FAKE_PERMISSION_OPTIONS } from './constants.ts';
import type { FakeAgentOptions, FakeTurn } from './types.ts';

export const FAKE_PR_URL = 'https://github.com/example/example/pull/7';
export const FAKE_MR_URL =
  'https://gitlab.com/example/example/-/merge_requests/7';

const reportedChange = (
  options: FakeAgentOptions,
): { pr: string; notes: string } => {
  if (options.onGitlab)
    return {
      pr: FAKE_MR_URL,
      notes: 'Opened the merge request; the tests pass.',
    };
  return { pr: FAKE_PR_URL, notes: 'Opened the pull request; the tests pass.' };
};
export const FAKE_PR_HEAD = 'c0ffee0000000000000000000000000000c0ffee';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DRIVER_BIRTH =
  /^You are .+, the Driver of (?:this project|every project) for voyage \d+\./;
const WRAP_UP = /^Voyage \d+ has settled/;
const ASSIGNMENT = new RegExp(`^# Ticket (${UUID}):`, 'm');
const REVIEW = new RegExp(`Review ticket (${UUID}):`);
const APPROVED_LINE =
  /^- (?:\[[^\]]+\] )?(Ticket approved|Approved tickets waiting)/;
const WAITING_LINE = /^- "/;
const TICKET_IDS = new RegExp(`\\(ticket (${UUID})\\)`, 'g');
const NAMED_BUS = /use the tools of the bus `([^`]+)`/;
const WAKE = new RegExp(
  `^Ticket ".*" \\(ticket (${UUID})\\) is no longer blocked`,
);
const NEEDS = new RegExp(
  `ended its turn .*needs ticket (${UUID}).*\\(ticket (${UUID})\\)`,
);
const PUBLISH_LINE = /needs publishing/;

export const FAKE_WAIT_MARKER = 'Wait for the library change.';
export const FAKE_PACKAGE = 'acme-library';
export const FAKE_VERSION = '1.4.0-SNAPSHOT';

const PLANNER_OPENING = /^# Planner brief\n/;
const PLANNER_REPROMPT = /^\[Quarterdeck\] These proposals were refused/;

export const FAKE_PROPOSAL_TITLE = 'Fix the README greeting';

export const FAKE_SPEC_BODY = `## Requirements

- As a reader, I want the README to greet me, so that I feel welcome.
  - WHEN someone opens the README THE SYSTEM SHALL show Hello on its first line.

## Design

Edit README.md only.

## Tasks

1. Add the greeting.
2. Test that it shows.

Proven: the README starts with Hello.`;

export const FAKE_BODY_WITHOUT_DESIGN = FAKE_SPEC_BODY.replace(
  '## Design\n\nEdit README.md only.\n\n',
  '',
);

type CrewRole =
  | 'birth'
  | 'wrap-up'
  | 'builder'
  | 'wake'
  | 'reviewer'
  | 'driver'
  | 'planner'
  | 'planner-reprompt';

const roleOf = (text: string): CrewRole => {
  if (PLANNER_OPENING.test(text)) return 'planner';
  if (PLANNER_REPROMPT.test(text)) return 'planner-reprompt';
  if (DRIVER_BIRTH.test(text)) return 'birth';
  if (WRAP_UP.test(text)) return 'wrap-up';
  if (REVIEW.test(text)) return 'reviewer';
  if (WAKE.test(text)) return 'wake';
  if (ASSIGNMENT.test(text)) return 'builder';
  return 'driver';
};

const fenced = (value: unknown): string =>
  `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

const say = async (turn: FakeTurn, text: string): Promise<StopReason> => {
  await turn.client.notify('session/update', {
    sessionId: turn.sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  });
  return 'end_turn';
};

const busServer = (servers: readonly McpServer[], text: string) => {
  const named = NAMED_BUS.exec(text)?.[1];
  const server =
    servers.find((candidate) => candidate.name === named) ?? servers[0];
  if (!server || !('command' in server))
    throw new Error('the session has no bus server');
  return server;
};

interface BusConnection {
  client: Client;
  stderr: string[];
  connected: Promise<void>;
}

const busConnections = new Map<string, BusConnection>();

const connectBus = (server: ReturnType<typeof busServer>): BusConnection => {
  const client = new Client({ name: 'fake-crew', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.fromEntries(server.env.map((v) => [v.name, v.value])),
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  return { client, stderr, connected: client.connect(transport) };
};

const reusedSessionBus = (turn: FakeTurn): BusConnection => {
  const server = busServer(turn.setup.mcpServers, turn.text);
  const key = JSON.stringify(server.env);
  const known = busConnections.get(key);
  if (known) return known;
  const connection = connectBus(server);
  busConnections.set(key, connection);
  return connection;
};

const callBus = async (
  turn: FakeTurn,
  name: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const bus = reusedSessionBus(turn);
  try {
    await bus.connected;
    const result = await bus.client.callTool({ name, arguments: args });
    const content = result.content as { text?: string }[];
    return content.map((part) => part.text ?? '').join('');
  } catch (err) {
    throw new Error(
      `bus ${name} failed: ${String(err)} ${bus.stderr.join('')}`,
      { cause: err },
    );
  }
};

export const FAKE_BUILDER_PUSH = 'git push origin fake-branch';

const allowed = async (
  turn: FakeTurn,
  toolCall: { title: string; kind: 'other' | 'execute'; rawInput: object },
): Promise<boolean> => {
  const response = await turn.client.request('session/request_permission', {
    sessionId: turn.sessionId,
    toolCall: { toolCallId: 'fake-asked', status: 'pending', ...toolCall },
    options: FAKE_PERMISSION_OPTIONS,
  });
  if (response.outcome.outcome === 'cancelled') return false;
  return response.outcome.optionId === 'allow-once';
};

const proposalBody = (skipDesign: boolean | undefined): string => {
  if (skipDesign) return FAKE_BODY_WITHOUT_DESIGN;
  return FAKE_SPEC_BODY;
};

export const FAKE_UNKNOWN_PROJECT = 'nowhere';

const PROJECT_LINE = /^- `([^`]+)` \(/gm;

const knownProjects: string[] = [];

const learnProjects = (text: string): void => {
  const section = text.split('\n# Projects\n')[1]?.split('\n# The human\n')[0];
  if (section === undefined) return;
  knownProjects.splice(
    0,
    knownProjects.length,
    ...[...section.matchAll(PROJECT_LINE)].map((match) => match[1] ?? ''),
  );
};

interface FakeProposal {
  project: string;
  title: string;
  body: string;
}

const proposalsFor = (
  options: FakeAgentOptions,
  reprompt: boolean,
): FakeProposal[] => {
  const [first = ''] = knownProjects;
  if (reprompt) {
    const body = proposalBody(options.plannerSkipsDesignTwice);
    return [{ project: first, title: FAKE_PROPOSAL_TITLE, body }];
  }
  const body = proposalBody(options.plannerSkipsDesign);
  if (options.plannerNamesUnknown)
    return [
      { project: FAKE_UNKNOWN_PROJECT, title: FAKE_PROPOSAL_TITLE, body },
    ];
  if (options.plannerSpreads)
    return knownProjects.map((project) => ({
      project,
      title: `${FAKE_PROPOSAL_TITLE} in ${project}`,
      body,
    }));
  return [{ project: first, title: FAKE_PROPOSAL_TITLE, body }];
};

const proposeOne = async (
  turn: FakeTurn,
  proposal: FakeProposal,
): Promise<string> => {
  const asked = await allowed(turn, {
    title: 'mcp__quarterdeck__propose',
    kind: 'other',
    rawInput: proposal,
  });
  if (!asked) return 'Quarterdeck refused my propose call.';
  return callBus(turn, 'propose', { ...proposal });
};

const propose = async (
  turn: FakeTurn,
  options: FakeAgentOptions,
  reprompt: boolean,
): Promise<StopReason> => {
  if (!reprompt) learnProjects(turn.text);
  const replies: string[] = [];
  for (const proposal of proposalsFor(options, reprompt))
    replies.push(await proposeOne(turn, proposal));
  return say(turn, replies.join('\n'));
};

const pushAllowed = (
  turn: FakeTurn,
  options: FakeAgentOptions,
): Promise<boolean> => {
  if (!options.builderAsks) return Promise.resolve(true);
  return allowed(turn, {
    title: FAKE_BUILDER_PUSH,
    kind: 'execute',
    rawInput: { command: FAKE_BUILDER_PUSH },
  });
};

const firstId = (pattern: RegExp, text: string): string =>
  pattern.exec(text)?.[1] ?? '';

const ticketsOn = (text: string, pattern: RegExp): string[] =>
  text
    .split('\n')
    .filter((line) => pattern.test(line))
    .flatMap((line) => [...line.matchAll(TICKET_IDS)].map((m) => m[1] ?? ''));

const assignAll = (tickets: readonly string[]) =>
  tickets.map((ticket) => ({ kind: 'assign', ticket }));

const blockedOnce = new Set<string>();

const blocksIn = (text: string) =>
  text.split('\n').flatMap((line) => {
    const [, on = '', ticket = ''] = NEEDS.exec(line) ?? [];
    if (ticket === '' || blockedOnce.has(ticket)) return [];
    blockedOnce.add(ticket);
    return [{ kind: 'block', ticket, on: [on] }];
  });

const publishesIn = (text: string) =>
  ticketsOn(text, PUBLISH_LINE).map((ticket) => ({
    kind: 'published',
    ticket,
    package: FAKE_PACKAGE,
    version: FAKE_VERSION,
  }));

const leaked = (options: FakeAgentOptions): string => {
  if (!options.leaksApiKey) return '';
  return ` ${process.env['ANTHROPIC_API_KEY'] ?? ''}`;
};

const leakStatus = async (
  turn: FakeTurn,
  options: FakeAgentOptions,
): Promise<void> => {
  if (!options.leaksApiKey) return;
  await callBus(turn, 'status', { text: `Working${leaked(options)}` });
};

const HANDLERS: Record<
  CrewRole,
  (turn: FakeTurn, options: FakeAgentOptions) => Promise<StopReason>
> = {
  birth: async (turn, options) => {
    if (options.crashDriver) turn.exitProcess(FAKE_CRASH_EXIT_CODE);
    return say(
      turn,
      fenced({
        summary: `Born.${leaked(options)}`,
        actions: assignAll(ticketsOn(turn.text, WAITING_LINE)),
      }),
    );
  },
  planner: (turn, options) => propose(turn, options, false),
  'planner-reprompt': (turn, options) => propose(turn, options, true),
  'wrap-up': (turn, options) =>
    say(
      turn,
      fenced({
        summary: `Voyage done.${leaked(options)}`,
        notebook: [],
        charter: null,
      }),
    ),
  driver: (turn, options) =>
    say(
      turn,
      fenced({
        summary: `Assigned what was approved.${leaked(options)}`,
        actions: [
          ...assignAll(ticketsOn(turn.text, APPROVED_LINE)),
          ...blocksIn(turn.text),
          ...publishesIn(turn.text),
        ],
      }),
    ),
  wake: (turn) => say(turn, `Bumped ${FAKE_PACKAGE}; carrying on.`),
  builder: async (turn, options) => {
    if (turn.text.includes(FAKE_WAIT_MARKER))
      return say(turn, 'This needs a library change first.');
    if (!(await pushAllowed(turn, options)))
      return say(turn, 'Quarterdeck refused my push.');
    await leakStatus(turn, options);
    const change = reportedChange(options);
    const reply = await callBus(turn, 'report', {
      ticket: firstId(ASSIGNMENT, turn.text),
      ...change,
      notes: `${change.notes}${leaked(options)}`,
      head: FAKE_PR_HEAD,
    });
    return say(turn, `${reply}${leaked(options)}`);
  },
  reviewer: async (turn, options) => {
    const reply = await callBus(turn, 'verdict', {
      ticket: firstId(REVIEW, turn.text),
      decision: 'approve',
      notes: `It does what the ticket asks.${leaked(options)}`,
    });
    return say(turn, `${reply}${leaked(options)}`);
  },
};

export const runCrewTurn = (
  turn: FakeTurn,
  options: FakeAgentOptions,
): Promise<StopReason> => HANDLERS[roleOf(turn.text)](turn, options);
