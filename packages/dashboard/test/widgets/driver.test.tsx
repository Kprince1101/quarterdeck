// @vitest-environment happy-dom
import type { TurnReadResult } from '@quarterdeck/server/intents';
import type {
  AgentRow,
  RoundRow,
  StreamMessage,
  TurnRow,
} from '@quarterdeck/server/stream-schema';
import { act } from 'react';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createIntentClient, emptyTables } from '../../src/api/index.js';
import { DeckProvider } from '../../src/deck/deck.js';
import { DriverWidget } from '../../src/widgets/driver/driver.widget.js';
import { FAKE_WEBSOCKET, FakeSocket } from '../api/fake-socket.js';
import { choose, click } from '../grid/events.js';
import { typeInto, type DomElement } from '../primitives/dom.js';
import { all, render, textOf, type PageElement } from '../shell/page.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROUND_1 = '00000000-0000-4000-8000-000000000011';
const ROUND_2 = '00000000-0000-4000-8000-000000000012';
const ROUND_3 = '00000000-0000-4000-8000-000000000013';
const NEWT = '00000000-0000-4000-8000-000000000021';
const KITE = '00000000-0000-4000-8000-000000000022';
const OTTER = '00000000-0000-4000-8000-000000000023';
const AT = '2026-10-01T12:00:00.000Z';

const round = (id: string, number: number, status: RoundRow['status']) => ({
  id,
  projectId: PROJECT_ID,
  number,
  status,
  goal: `Goal ${number}.`,
  startedAt: AT,
  endedAt: null,
});

const agent = (
  id: string,
  name: string,
  role: AgentRow['role'],
  roundId: string,
): AgentRow => ({
  id,
  projectId: PROJECT_ID,
  roundId,
  name,
  role,
  runtime: 'claude',
  status: 'idle',
  sessionId: null,
  worktreePath: null,
  createdAt: AT,
  updatedAt: AT,
  endedAt: null,
});

const turn = (id: number, agentId: string, seq: number): TurnRow => ({
  id,
  agentId,
  ticketId: null,
  seq,
  stopReason: 'end_turn',
  inputTokens: 100,
  outputTokens: 20,
  transcriptPath: null,
  startedAt: AT,
  endedAt: AT,
});

const RUNNING = { ...turn(12, NEWT, 2), stopReason: null, endedAt: null };

const SNAPSHOT: StreamMessage = {
  type: 'snapshot',
  cursor: 0,
  tables: {
    ...emptyTables(),
    projects: [
      {
        id: PROJECT_ID,
        slug: 'deck',
        name: 'Deck',
        repoPath: null,
        createdAt: AT,
        updatedAt: AT,
        archivedAt: null,
        pausedAt: null,
      },
    ],
    rounds: [round(ROUND_1, 1, 'ended'), round(ROUND_2, 2, 'active')],
    agents: [
      agent(NEWT, 'newt', 'driver', ROUND_2),
      agent(KITE, 'kite', 'driver', ROUND_1),
      agent(OTTER, 'otter', 'builder', ROUND_2),
    ],
    turns: [turn(5, KITE, 1), turn(11, NEWT, 1), RUNNING, turn(20, OTTER, 1)],
  },
  machine: { pausedAt: null },
};

const READS: Record<number, Partial<TurnReadResult>> = {
  5: { agentId: KITE, round: 1, n: 1, latestSession: false },
  11: { round: 2, n: 1, latestSession: true, output: null, result: null },
  12: { round: 2, n: 2, latestSession: true },
};

const readOf = (turnId: number): TurnReadResult => ({
  turnId,
  agentId: NEWT,
  seq: 1,
  input: `input ${turnId}`,
  output: `output ${turnId}`,
  result: { summary: `result ${turnId}` },
  round: null,
  n: null,
  latestSession: false,
  ...READS[turnId],
});

const stream = { url: 'ws://127.0.0.1:4317/ws', WebSocket: FAKE_WEBSOCKET };

describe('Driver widget', () => {
  let failing: Set<number>;
  let reads: number[];
  let writeText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

  const fetchTurn = vi.fn<typeof fetch>((_url, init) => {
    const { turnId } = JSON.parse(String(init?.body)) as { turnId: number };
    reads.push(turnId);
    if (failing.has(turnId)) {
      const error = JSON.stringify({ error: `turn ${turnId} not found` });
      return Promise.resolve(new Response(error, { status: 404 }));
    }
    const reply = {
      intent: 'turn.read',
      status: 'applied',
      id: null,
      result: readOf(turnId),
    };
    return Promise.resolve(new Response(JSON.stringify(reply)));
  });

  const intents = createIntentClient({ fetch: fetchTurn });

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  const deliver = async (...messages: StreamMessage[]) => {
    act(() => {
      messages.forEach((message) => FakeSocket.opened[0]?.deliver(message));
    });
    await settle();
  };

  const mount = async () => {
    const rendered = render(
      <DeckProvider stream={stream} intents={intents}>
        <DriverWidget />
      </DeckProvider>,
    );
    await deliver(SNAPSHOT);
    return rendered;
  };

  const turnButtons = (container: PageElement) =>
    all(container, '[aria-label="Turns"] button');

  const pick = async (container: PageElement, turnId: number) => {
    const button = container.querySelector(`[data-turn-id="${turnId}"]`);
    if (button === null) throw new Error(`no turn ${turnId}`);
    click(button);
    await settle();
  };

  const block = (container: PageElement, title: string) =>
    textOf(container, `[aria-label="Turn detail"] [aria-label="${title}"]`);

  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  beforeEach(() => {
    failing = new Set();
    reads = [];
    writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
  });

  afterEach(() => {
    FakeSocket.opened = [];
    vi.unstubAllGlobals();
  });

  it('says so when there are no rounds', () => {
    const { container, unmount } = render(
      <DeckProvider stream={stream} intents={intents}>
        <DriverWidget />
      </DeckProvider>,
    );
    expect(container.textContent).toBe('No rounds yet.');
    unmount();
  });

  it("lists the active round's Driver turns, newest first", async () => {
    const { container, unmount } = await mount();
    expect(all(container, 'option').map((o) => o.textContent)).toEqual([
      '2 (active)',
      '1 (ended)',
    ]);
    expect(textOf(container, '.qd-driver-goal')).toBe('Goal 2.');
    expect(turnButtons(container).map((b) => b.textContent)).toEqual([
      'Turn 2newt · running',
      'Turn 1newt · end_turn',
    ]);
    expect(turnButtons(container)[0]?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    unmount();
  });

  it('reads the selected turn: input, output, result', async () => {
    const { container, unmount } = await mount();
    expect(reads).toEqual([12]);
    expect(block(container, 'Input')).toBe('Inputinput 12');
    expect(block(container, 'Output')).toBe('Outputoutput 12');
    expect(block(container, 'Result')).toContain('"summary": "result 12"');

    await pick(container, 11);
    expect(reads).toEqual([12, 11]);
    expect(block(container, 'Output')).toBe('OutputNone yet.');
    expect(block(container, 'Result')).toBe('ResultNone yet.');
    unmount();
  });

  it('shows the replay command and copies it', async () => {
    const { container, unmount } = await mount();
    const command = 'npx quarterdeck replay 2 2 --project deck';
    expect(textOf(container, '.qd-driver-command code')).toBe(command);

    const copy = container.querySelector('.qd-driver-command button');
    if (copy === null) throw new Error('no copy button');
    click(copy);
    await settle();
    expect(writeText).toHaveBeenCalledWith(command);
    expect(textOf(container, '[aria-live="polite"]')).toBe('Copied');

    await pick(container, 11);
    expect(textOf(container, '.qd-driver-command code')).toBe(
      'npx quarterdeck replay 2 1 --project deck',
    );
    expect(textOf(container, '[aria-live="polite"]')).toBe('');
    unmount();
  });

  it('replays through an earlier turn of the round', async () => {
    const { container, unmount } = await mount();
    const field = container.querySelector('.qd-driver-through input');
    if (field === null) throw new Error('no turn field');
    expect(field.getAttribute('max')).toBe('2');
    const through = field as unknown as DomElement;

    typeInto(through, '1');
    expect(textOf(container, '.qd-driver-command code')).toBe(
      'npx quarterdeck replay 2 1 --project deck',
    );

    typeInto(through, '3');
    expect(container.querySelector('.qd-driver-command')).toBeNull();
    expect(textOf(container, '.qd-driver-replay')).toContain(
      'Turn is a whole number from 1 to 2.',
    );

    typeInto(through, '0');
    expect(container.querySelector('.qd-driver-command')).toBeNull();

    await pick(container, 11);
    expect(textOf(container, '.qd-driver-command code')).toBe(
      'npx quarterdeck replay 2 1 --project deck',
    );
    unmount();
  });

  it('says when the copy fails', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const { container, unmount } = await mount();
    const copy = container.querySelector('.qd-driver-command button');
    if (copy === null) throw new Error('no copy button');
    click(copy);
    await settle();
    expect(textOf(container, '[aria-live="polite"]')).toBe('Copy failed');
    unmount();
  });

  it('picks another round and offers no command for a replaced session', async () => {
    const { container, unmount } = await mount();
    const select = container.querySelector('select');
    if (select === null) throw new Error('no round picker');
    choose(select, ROUND_1);
    await settle();
    expect(turnButtons(container).map((b) => b.textContent)).toEqual([
      'Turn 1kite · end_turn',
    ]);
    expect(reads).toEqual([12, 5]);
    expect(container.querySelector('.qd-driver-command')).toBeNull();
    expect(textOf(container, '[aria-label="Turn detail"]')).toContain(
      'Round 1 has a later Driver session',
    );
    unmount();
  });

  it('reads a running turn again when it ends', async () => {
    const { container, unmount } = await mount();
    await deliver({
      type: 'change',
      table: 'turns',
      op: 'update',
      id: 12,
      row: { ...RUNNING, stopReason: 'end_turn', endedAt: AT },
    });
    expect(reads).toEqual([12, 12]);
    expect(turnButtons(container)[0]?.textContent).toBe(
      'Turn 2newt · end_turn',
    );
    unmount();
  });

  it('shows why a turn could not be read', async () => {
    failing.add(12);
    const { container, unmount } = await mount();
    expect(textOf(container, '[role="alert"]')).toBe('turn 12 not found');
    unmount();
  });

  it('follows a new round until one is picked', async () => {
    const { container, unmount } = await mount();
    await deliver({
      type: 'change',
      table: 'rounds',
      op: 'insert',
      id: ROUND_3,
      row: round(ROUND_3, 3, 'active'),
    });
    expect(textOf(container, '.qd-driver-goal')).toBe('Goal 3.');
    expect(textOf(container, '.qd-driver')).toContain(
      'No Driver turns in round 3 yet.',
    );
    unmount();
  });
});
