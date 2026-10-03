import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import {
  SETTLED_REASON,
  originRepository,
  redactSecrets,
  redactValue,
} from '@quarterdeck/server';
import { main, type CliIo } from 'quarterdeck';
import { cardCwd, createScrubber, permissionAnswer } from './policy.ts';

type Row = Record<string, unknown>;

interface Up {
  url: string;
  token: string;
  stop: () => Promise<void>;
}

interface IntentReply {
  status: number;
  body: Row;
}

interface DataPage {
  columns: string[];
  rows: unknown[][];
  total: number;
}

const PROJECT = 'quarterdeck';
const VOYAGE_TIMEOUT_MS = 90 * 60_000;
const STEP_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 3000;
const PAGE = 100;
const SETTLE_SECONDS = 60;
const PERMISSION_CARD = 'agent.permission';
const FAILURE_EVENTS = ['crew.failed', 'planner.failed', 'agent.intent_failed'];
const SNAPSHOT_TABLES = [
  'tickets',
  'agents',
  'voyages',
  'notebook',
  'notebook_proposals',
];
const PLANNER_MESSAGE = [
  'Propose exactly one ticket, and nothing else: a one-line documentation fix',
  'you find in one of this repository’s README files, such as a typo, a',
  'stale statement or an unclear sentence. One line in one file. Say which',
  'line and what it should say. Do not change code or tests.',
].join(' ');
const VOYAGE_GOAL = 'Ship the one approved documentation ticket.';
const RUNNING =
  /Quarterdeck is running at (http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/;

if (process.env['DATABASE_URL'])
  throw new Error(
    'Unset DATABASE_URL first: with it set, the proof would write to and wipe that database instead of the temp home.',
  );

const repo = resolve(process.argv[2] ?? '.');
const home = await mkdtemp('/tmp/qdp-');
const machine = join(home, '.quarterdeck');
const out = join(home, 'proof');
const answersDir = join(out, 'answers');
const allowedRoots = [
  repo,
  await realpath(repo),
  home,
  await realpath(home),
  '/dev/null',
];
const started = Date.now();
const lines: string[] = [];
const handled = new Set<string>();
let api: Up | undefined;

const scrub = createScrubber({
  home,
  repo,
  user: userInfo().username,
  owner: (await originRepository(repo)).owner,
});

const publish = (value: unknown): unknown =>
  JSON.parse(scrub(JSON.stringify(redactValue(value))));

const log = (line: string): void => {
  const seconds = Math.round((Date.now() - started) / 1000);
  const entry = `[+${seconds}s] ${scrub(redactSecrets(line))}`;
  lines.push(entry);
  process.stdout.write(`${entry}\n`);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

const executeAllow = (pattern: string): Row => ({
  kind: 'execute',
  pattern,
  decision: 'allow',
});

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

const writeMachineRules = async (): Promise<void> => {
  await mkdir(machine, { recursive: true, mode: 0o700 });
  await mkdir(answersDir, { recursive: true });
  const hardened = JSON.parse(
    await readFile(
      join(repo, 'rules', 'examples', 'hardened.permissions.json'),
      'utf8',
    ),
  ) as { default: string; rules: Row[] };
  await writeJson(join(machine, 'rules.local.permissions.json'), {
    ...hardened,
    rules: [
      ...hardened.rules,
      { kind: 'edit', decision: 'allow' },
      executeAllow('git add *'),
      executeAllow('git commit *'),
      executeAllow('gh pr create *'),
      executeAllow('gh pr view *'),
      executeAllow('gh pr diff *'),
      { kind: 'execute', pattern: '* --force*', decision: 'ask' },
      { kind: 'execute', pattern: 'gh pr merge*', decision: 'deny' },
    ],
  });
  await writeJson(join(machine, 'rules.local.lifecycle.json'), {
    autoEndSettleSeconds: SETTLE_SECONDS,
    mergeGate: { autoMerge: true },
  });
};

const cliIo = (
  onLine: (line: string) => void,
  untilStopped: () => Promise<void>,
): CliIo => ({
  out: (line) => {
    log(`cli: ${line}`);
    onLine(line);
  },
  err: (line) => log(`cli error: ${line}`),
  homeDir: home,
  cwd: repo,
  env: process.env,
  prompter: undefined,
  untilStopped,
});

const runCli = async (args: string[]): Promise<void> => {
  log(`$ quarterdeck ${args.join(' ')}`);
  const code = await main(
    args,
    cliIo(
      () => {},
      () => Promise.resolve(),
    ),
  );
  if (code !== 0) throw new Error(`quarterdeck ${args[0]} exited ${code}`);
};

const startUp = (): Promise<Up> =>
  new Promise((ready, fail) => {
    let release = (): void => {};
    const stopped = new Promise<void>((done) => {
      release = done;
    });
    log('$ quarterdeck up --port 0');
    const exited = main(
      ['up', '--port', '0'],
      cliIo(
        (line) => {
          const [, url, token] = RUNNING.exec(line) ?? [];
          if (url === undefined || token === undefined) return;
          ready({
            url,
            token,
            stop: async () => {
              release();
              const code = await exited;
              if (code !== 0) throw new Error(`quarterdeck up exited ${code}`);
            },
          });
        },
        () => stopped,
      ),
    );
    exited.then(
      (code) => fail(new Error(`quarterdeck up exited ${code} before it ran`)),
      fail,
    );
  });

const parseBody = (text: string): Row => {
  if (text === '') return {};
  return JSON.parse(text) as Row;
};

const intent = async (
  name: string,
  body: Row,
  { quiet = false } = {},
): Promise<IntentReply> => {
  if (api === undefined) throw new Error('up is not running');
  const res = await fetch(`${api.url}/api/intents/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${api.token}`,
    },
    body: JSON.stringify({ project: PROJECT, ...body }),
  });
  const parsed = parseBody(await res.text());
  if (!quiet) log(`intent ${name} -> ${res.status} ${JSON.stringify(parsed)}`);
  return { status: res.status, body: parsed };
};

const tableRows = async (table: string): Promise<Row[]> => {
  const all: Row[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { status, body } = await intent(
      'data.rows',
      { table, offset, limit: PAGE },
      { quiet: true },
    );
    if (status !== 200) throw new Error(`data.rows ${table}: ${status}`);
    const page = body['result'] as DataPage;
    for (const cells of page.rows)
      all.push(Object.fromEntries(page.columns.map((c, i) => [c, cells[i]])));
    if (offset + PAGE >= page.total) return all;
  }
};

const events = async (): Promise<Row[]> =>
  (await tableRows('events')).toSorted(
    (a, b) => Number(a['id']) - Number(b['id']),
  );

const once = (key: string): boolean => {
  if (handled.has(key)) return false;
  handled.add(key);
  return true;
};

const answerCard = async (card: Row, answer: string): Promise<void> => {
  log(`card ${card['kind']}: ${card['question']} -> ${answer}`);
  await intent('card.answer', { cardId: card['id'], answer });
};

const personAnswer = async (card: Row): Promise<string | undefined> => {
  const file = join(answersDir, `${String(card['id'])}.txt`);
  if (await exists(file)) return (await readFile(file, 'utf8')).trim();
  if (once(`waiting:${String(card['id'])}`))
    log(
      `card ${card['kind']} waits for a person: ${card['question']} options=${JSON.stringify(card['options'])}; answer in ${file}`,
    );
  return undefined;
};

const handleCard = async (card: Row): Promise<void> => {
  const id = String(card['id']);
  if (card['status'] !== 'open' || handled.has(id)) return;
  if (card['kind'] === PERMISSION_CARD) {
    handled.add(id);
    await answerCard(
      card,
      permissionAnswer(
        String(card['question']),
        cardCwd(card['recommendation']),
        allowedRoots,
      ),
    );
    return;
  }
  const answer = await personAnswer(card);
  if (answer === undefined) return;
  handled.add(id);
  await answerCard(card, answer);
};

const handleCards = async (): Promise<void> => {
  for (const card of await tableRows('cards')) await handleCard(card);
};

const logFailures = async (): Promise<void> => {
  for (const event of await events())
    if (
      FAILURE_EVENTS.includes(String(event['kind'])) &&
      once(`failure:${String(event['id'])}`)
    )
      log(`failure ${event['kind']}: ${JSON.stringify(event['payload'])}`);
};

const waitFor = async <T>(
  label: string,
  check: () => Promise<T | undefined>,
  timeoutMs = STEP_TIMEOUT_MS,
): Promise<T> => {
  log(`waiting: ${label}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await handleCards();
    await logFailures();
    const found = await check();
    if (found !== undefined) {
      log(`done: ${label}`);
      return found;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`timed out: ${label}`);
};

const eventOf =
  (kind: string, where: (event: Row) => boolean = () => true) =>
  async (): Promise<Row | undefined> =>
    (await events()).find((event) => event['kind'] === kind && where(event));

const proposedTickets = async (): Promise<Row[] | undefined> => {
  if ((await eventOf('planner.reply')()) === undefined) return undefined;
  const tickets = (await tableRows('tickets')).filter(
    (ticket) => ticket['status'] === 'proposed',
  );
  if (tickets.length === 0)
    throw new Error('the Planner replied without proposing a ticket');
  return tickets.toSorted((a, b) =>
    String(a['created_at']).localeCompare(String(b['created_at'])),
  );
};

const planTicket = async (): Promise<void> => {
  await intent('planner.message', { text: PLANNER_MESSAGE });
  const [ticket, ...extra] = await waitFor(
    'the Planner proposes a ticket',
    proposedTickets,
  );
  if (ticket === undefined) throw new Error('the Planner proposed nothing');
  log(`proposed: ${ticket['title']}\n${ticket['body']}`);
  await intent('ticket.approve', { ticketId: ticket['id'] });
  for (const other of extra)
    await intent('ticket.reject', { ticketId: other['id'] });
};

const runVoyage = async (): Promise<void> => {
  const start = await intent('voyage.start', { goal: VOYAGE_GOAL });
  if (start.status !== 202) throw new Error('voyage.start was refused');
  const begun = await waitFor('the voyage starts', eventOf('voyage.started'));
  const voyageId = (begun['payload'] as Row)['voyageId'];
  const ended = await waitFor(
    'the voyage ends itself',
    eventOf(
      'voyage.ended',
      (e) => (e['payload'] as Row)['voyageId'] === voyageId,
    ),
    VOYAGE_TIMEOUT_MS,
  );
  const reason = (ended['payload'] as Row)['reason'];
  if (reason !== SETTLED_REASON)
    throw new Error(`the voyage ended with reason ${String(reason)}`);
  const merged = await eventOf('ticket.merged')();
  if (merged === undefined) throw new Error('the voyage ended with no merge');
};

const acceptNotebookAdd = async (): Promise<void> => {
  const proposals = (await tableRows('notebook_proposals')).filter(
    (proposal) => proposal['status'] === 'open',
  );
  log(`wrap-up proposed ${proposals.length} notebook change(s)`);
  const add = proposals.find((proposal) => proposal['op'] === 'add');
  if (add === undefined) return;
  await intent('notebook.decide', {
    proposalId: add['id'],
    decision: 'accepted',
  });
};

const snapshot = async (): Promise<Row> => {
  const summary = await intent('data.summary', {}, { quiet: true });
  const tables: Row = {};
  for (const table of SNAPSHOT_TABLES) tables[table] = await tableRows(table);
  return { summary: summary.body['result'], tables, events: await events() };
};

const save = (name: string, value: unknown): Promise<void> =>
  writeFile(join(out, name), `${JSON.stringify(publish(value), null, 2)}\n`);

const showAndWipe = async (): Promise<void> => {
  const data = await snapshot();
  await save('data.json', data);
  log(`data widget: ${JSON.stringify((data['summary'] as Row)['tables'])}`);
  const projectDir = join(machine, PROJECT);
  log(`before wipe: ${projectDir} exists = ${await exists(projectDir)}`);
  const wipe = await intent('wipe.project', { confirm: PROJECT });
  const wiped = (wipe.body['result'] as { wiped?: unknown } | undefined)?.wiped;
  if (wipe.status !== 200 || !Array.isArray(wiped) || !wiped.includes(PROJECT))
    throw new Error(`wipe.project did not wipe ${PROJECT}: ${wipe.status}`);
  const after = await intent('data.summary', {});
  const left = await exists(projectDir);
  log(`after wipe: data.summary answers ${after.status}`);
  log(`after wipe: ${projectDir} exists = ${left}`);
  if (after.status !== 404 || left)
    throw new Error(`the wipe left ${PROJECT} behind`);
};

const proof = async (): Promise<void> => {
  process.stdout.write(`QD_HOME=${home}\n`);
  await writeMachineRules();
  await runCli([
    'init',
    repo,
    '--project',
    PROJECT,
    '--name',
    'Quarterdeck',
    '--runtime',
    'claude',
    '--no-folder',
  ]);
  const running = await startUp();
  api = running;
  try {
    await planTicket();
    await runVoyage();
    await acceptNotebookAdd();
    await showAndWipe();
  } finally {
    await running.stop();
    await writeFile(join(out, 'log.txt'), `${lines.join('\n')}\n`);
    process.stdout.write(`proof files in ${out}\n`);
  }
};

await proof();
