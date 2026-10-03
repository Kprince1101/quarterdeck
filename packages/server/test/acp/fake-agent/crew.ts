import type { McpServer, StopReason } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FAKE_CRASH_EXIT_CODE, FAKE_PERMISSION_OPTIONS } from './constants.ts';
import type { FakeAgentOptions, FakeTurn } from './types.ts';

export const FAKE_PR_URL = 'https://github.com/example/example/pull/7';
export const FAKE_PR_HEAD = 'c0ffee0000000000000000000000000000c0ffee';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DRIVER_BIRTH = /^You are .+, the Driver of this project for voyage \d+\./;
const WRAP_UP = /^Voyage \d+ has settled/;
const ASSIGNMENT = new RegExp(`^# Ticket (${UUID}):`, 'm');
const REVIEW = new RegExp(`Review ticket (${UUID}):`);
const APPROVED_LINE = /^- (Ticket approved|Approved tickets waiting)/;
const TICKET_IDS = new RegExp(`\\(ticket (${UUID})\\)`, 'g');

const PLANNER_OPENING = /^# Planner brief\n/;

export const FAKE_PROPOSAL_TITLE = 'Fix the README greeting';

type CrewRole =
  'birth' | 'wrap-up' | 'builder' | 'reviewer' | 'driver' | 'planner';

const roleOf = (text: string): CrewRole => {
  if (PLANNER_OPENING.test(text)) return 'planner';
  if (DRIVER_BIRTH.test(text)) return 'birth';
  if (WRAP_UP.test(text)) return 'wrap-up';
  if (REVIEW.test(text)) return 'reviewer';
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

const busServer = (servers: readonly McpServer[]) => {
  const [server] = servers;
  if (!server || !('command' in server))
    throw new Error('the session has no bus server');
  return server;
};

const callBus = async (
  turn: FakeTurn,
  name: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const server = busServer(turn.setup.mcpServers);
  const client = new Client({ name: 'fake-crew', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.fromEntries(server.env.map((v) => [v.name, v.value])),
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(String(chunk)));
  try {
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { text?: string }[];
    return content.map((part) => part.text ?? '').join('');
  } catch (err) {
    throw new Error(`bus ${name} failed: ${String(err)} ${stderr.join('')}`, {
      cause: err,
    });
  } finally {
    await client.close();
  }
};

const PROPOSAL = {
  title: FAKE_PROPOSAL_TITLE,
  body: 'Say hello in the README.',
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

const propose = async (turn: FakeTurn): Promise<StopReason> => {
  const asked = await allowed(turn, {
    title: 'mcp__quarterdeck__propose',
    kind: 'other',
    rawInput: PROPOSAL,
  });
  if (!asked) return say(turn, 'Quarterdeck refused my propose call.');
  return say(turn, await callBus(turn, 'propose', PROPOSAL));
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

const approvedTickets = (text: string): string[] =>
  text
    .split('\n')
    .filter((line) => APPROVED_LINE.test(line))
    .flatMap((line) => [...line.matchAll(TICKET_IDS)].map((m) => m[1] ?? ''));

const HANDLERS: Record<
  CrewRole,
  (turn: FakeTurn, options: FakeAgentOptions) => Promise<StopReason>
> = {
  birth: async (turn, options) => {
    if (options.crashDriver) turn.exitProcess(FAKE_CRASH_EXIT_CODE);
    return say(turn, fenced({ summary: 'Born.', actions: [] }));
  },
  planner: propose,
  'wrap-up': (turn) =>
    say(turn, fenced({ summary: 'Voyage done.', notebook: [], charter: null })),
  driver: (turn) =>
    say(
      turn,
      fenced({
        summary: 'Assigned what was approved.',
        actions: approvedTickets(turn.text).map((ticket) => ({
          kind: 'assign',
          ticket,
        })),
      }),
    ),
  builder: async (turn, options) => {
    if (!(await pushAllowed(turn, options)))
      return say(turn, 'Quarterdeck refused my push.');
    const reply = await callBus(turn, 'report', {
      ticket: firstId(ASSIGNMENT, turn.text),
      pr: FAKE_PR_URL,
      head: FAKE_PR_HEAD,
      notes: 'Opened the pull request; the tests pass.',
    });
    return say(turn, reply);
  },
  reviewer: async (turn) => {
    const reply = await callBus(turn, 'verdict', {
      ticket: firstId(REVIEW, turn.text),
      decision: 'approve',
      notes: 'It does what the ticket asks.',
    });
    return say(turn, reply);
  },
};

export const runCrewTurn = (
  turn: FakeTurn,
  options: FakeAgentOptions,
): Promise<StopReason> => HANDLERS[roleOf(turn.text)](turn, options);
