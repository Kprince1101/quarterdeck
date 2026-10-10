import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnAcpClient } from '@quarterdeck/server';

const STARTUP_TIMEOUT_MS = 60_000;
const VOYAGE_TIMEOUT_MS = 90_000;
const POLL_MS = 250;
const PR_URL = 'https://github.com/example/example/pull/7';
const PR_HEAD = 'c0ffee0000000000000000000000000000c0ffee';
const RUNNING =
  /Quarterdeck is running at (http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/;
const PROJECT = 'deck';
const FAKE_RUNTIME = 'gemini';
const GREETING = 'hello from a clean machine';
const CLONE = join(import.meta.dirname, '..', '..');
const QUARTERDECK = ['run', 'quarterdeck', '--'];
const FAKE_AGENT_ENTRY = join(
  CLONE,
  'packages',
  'server',
  'test',
  'acp',
  'fake-agent',
  'main.ts',
);
const TYPESCRIPT_FLAGS = [
  '--experimental-strip-types',
  '--disable-warning=ExperimentalWarning',
];

interface Running {
  group: number;
  url: string;
  token: string;
  closed: Promise<unknown>;
  output: () => string;
}

const check = (ok: boolean, message: string): void => {
  if (!ok) throw new Error(`clean machine: ${message}`);
  process.stdout.write(`ok - ${message}\n`);
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const waitForUrl = (child: ChildProcess, output: () => string) =>
  new Promise<{ url: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`up did not start:\n${output()}`));
    }, STARTUP_TIMEOUT_MS);
    const look = () => {
      const [, url, token] = RUNNING.exec(output()) ?? [];
      if (url === undefined || token === undefined) return;
      clearTimeout(timer);
      resolve({ url, token });
    };
    child.stdout?.on('data', look);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`up exited ${code}:\n${output()}`));
    });
  });

const startUp = async (env: NodeJS.ProcessEnv): Promise<Running> => {
  const child = spawn('npm', [...QUARTERDECK, 'up', '--port', '0'], {
    cwd: CLONE,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) throw new Error('npm did not start');
  let text = '';
  const collect = (chunk: Buffer) => {
    text += chunk.toString('utf8');
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const closed = Promise.all([
    once(child.stdout, 'close'),
    once(child.stderr, 'close'),
  ]);
  const output = () => text;
  const { url, token } = await waitForUrl(child, output);
  return { group: child.pid, url, token, closed, output };
};

const answers = (url: string): Promise<boolean> =>
  fetch(url).then(
    () => true,
    () => false,
  );

const checkDashboard = async (url: string): Promise<void> => {
  const page = await fetch(`${url}/`);
  const html = await page.text();
  check(page.status === 200, `GET / answers 200 (${page.status})`);
  check(
    html.includes('<div id="root">'),
    'GET / serves the built dashboard, not the placeholder',
  );
};

interface IntentAnswer {
  status: number;
  result: Record<string, unknown>;
}

const sendIntent = async (
  { url, token }: Running,
  name: string,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${token}` },
): Promise<IntentAnswer> => {
  const res = await fetch(`${url}/api/intents/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const reply = (await res.json().catch(() => ({}))) as {
    result?: Record<string, unknown>;
  };
  return { status: res.status, result: reply.result ?? {} };
};

interface SetupRuntimeEntry {
  tool: { kind: string; runtime?: string };
  installed: boolean;
  signedIn: boolean;
}

const checkSetup = async (
  running: Running,
  home: string,
  repoPath: string,
): Promise<void> => {
  const tokenFile = join(home, '.quarterdeck', 'api.token');
  check(
    (await readFile(tokenFile, 'utf8')) === running.token,
    'up writes the printed token to ~/.quarterdeck/api.token',
  );
  check(
    running.output().includes('No workspace yet'),
    'up with nothing configured says Setup is waiting at the URL',
  );
  const refused = await sendIntent(running, 'setup.read', {}, {});
  check(refused.status === 401, `no token answers 401 (${refused.status})`);
  const before = await sendIntent(running, 'setup.read', {});
  check(before.result['needsSetup'] === true, 'setup.read asks for Setup');
  const detected = await sendIntent(running, 'setup.detect', {
    path: repoPath,
  });
  check(
    detected.result['mode'] === 'single',
    `setup.detect calls ${repoPath} one repository`,
  );
  const tools = await sendIntent(running, 'setup.tools', { root: repoPath });
  const runtimes = (tools.result['runtimes'] ?? []) as SetupRuntimeEntry[];
  const fake = runtimes.find(({ tool }) => tool.runtime === FAKE_RUNTIME);
  check(
    fake?.installed === true && fake.signedIn === true,
    'setup.tools finds the fake runtime installed and signed in',
  );
  const saved = await sendIntent(running, 'setup.save', {
    root: repoPath,
    runtime: FAKE_RUNTIME,
  });
  check(saved.status === 200, `setup.save answers 200 (${saved.status})`);
  const after = await sendIntent(running, 'setup.read', {});
  check(after.result['needsSetup'] === false, 'Setup is done after setup.save');
  const workspace = await sendIntent(running, 'workspace.read', {});
  check(
    JSON.stringify(workspace.result['workspace']).includes(
      `"slug":"${PROJECT}"`,
    ),
    `the workspace holds project ${PROJECT}`,
  );
};

type Row = Record<string, unknown>;

const rowsOf = async (running: Running, table: string): Promise<Row[]> => {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await sendIntent(running, 'data.rows', {
      project: PROJECT,
      table,
      offset,
      limit: 100,
    });
    const columns = (page.result['columns'] ?? []) as string[];
    const cells = (page.result['rows'] ?? []) as unknown[][];
    for (const row of cells)
      rows.push(Object.fromEntries(columns.map((name, i) => [name, row[i]])));
    if (cells.length === 0 || rows.length >= Number(page.result['total']))
      return rows;
  }
};

const rowWhere = async (
  running: Running,
  table: string,
  match: Row,
): Promise<Row | undefined> =>
  (await rowsOf(running, table)).find((row) =>
    Object.entries(match).every(([key, value]) => row[key] === value),
  );

const waitFor = async <T>(
  what: string,
  find: () => Promise<T | undefined>,
): Promise<T> => {
  const deadline = Date.now() + VOYAGE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await find();
    if (found !== undefined) return found;
    await sleep(POLL_MS);
  }
  throw new Error(`clean machine: timed out waiting for ${what}`);
};

const answerCard = async (
  running: Running,
  kind: string,
  answer: string,
): Promise<void> => {
  const card = await waitFor(`an open ${kind} card`, () =>
    rowWhere(running, 'cards', { kind, status: 'open' }),
  );
  const answered = await sendIntent(running, 'card.answer', {
    project: PROJECT,
    cardId: card['id'],
    answer,
  });
  check(
    answered.status === 200,
    `the ${kind} card takes the answer ${answer} (${answered.status})`,
  );
};

const proposeAndApprove = async (running: Running): Promise<string> => {
  const asked = await sendIntent(running, 'planner.message', {
    project: PROJECT,
    text: 'Greet readers in the README.',
  });
  check(asked.status === 202, `planner.message answers 202 (${asked.status})`);
  await answerCard(running, 'agent.permission', 'allow');
  const proposed = await waitFor('the Planner’s proposal', () =>
    rowWhere(running, 'tickets', { status: 'proposed' }),
  );
  const title = String(proposed['title']);
  check(title !== '', `the Planner proposes "${title}"`);
  const ticketId = String(proposed['id']);
  const approved = await sendIntent(running, 'ticket.approve', {
    project: PROJECT,
    ticketId,
  });
  check(
    approved.status === 200,
    `ticket.approve answers 200 (${approved.status})`,
  );
  return ticketId;
};

const ticketEvents = async (
  running: Running,
  ticketId: string,
): Promise<string[]> =>
  (await rowsOf(running, 'events'))
    .filter((row) => row['ticket_id'] === ticketId)
    .map((row) => String(row['kind']));

const checkVoyage = async (running: Running, home: string): Promise<void> => {
  const ticketId = await proposeAndApprove(running);
  const started = await sendIntent(running, 'voyage.start', {
    goal: 'Greet readers',
  });
  check(started.status === 200, `voyage.start answers 200 (${started.status})`);
  const voyage = started.result['voyage'];
  await answerCard(running, 'ticket.merge', 'merge');
  await waitFor('the ticket to be done', () =>
    rowWhere(running, 'tickets', { id: ticketId, status: 'done' }),
  );
  const kinds = await ticketEvents(running, ticketId);
  for (const kind of [
    'ticket.assigned',
    'ticket.reported',
    'ticket.verdict',
    'ticket.merged',
  ])
    check(kinds.includes(kind), `the ticket's events include ${kind}`);
  const gh = await readFile(join(home, 'gh.log'), 'utf8');
  check(
    gh.includes(`pr merge ${PR_URL} --squash --match-head-commit ${PR_HEAD}`),
    'the merge gate squash merges the approved head through gh',
  );
  const ended = await sendIntent(running, 'voyage.end', { voyage });
  check(ended.status === 202, `voyage.end answers 202 (${ended.status})`);
  await waitFor('the voyage to end', () =>
    rowWhere(running, 'events', { kind: 'voyage.ended' }),
  );
  const tickets = await rowsOf(running, 'tickets');
  check(
    tickets.length === 1 && tickets[0]?.['status'] === 'done',
    `voyage ${String(voyage)} ended with its one ticket done`,
  );
};

const explain = async (running: Running): Promise<void> => {
  const events = await rowsOf(running, 'events').catch(() => []);
  const lines = events
    .toReversed()
    .map((row) => `${String(row['kind'])} ${JSON.stringify(row['payload'])}`);
  process.stderr.write(
    `up's output:\n${running.output()}\nevents, oldest first:\n${lines.join('\n')}\n`,
  );
};

const FAKE_GEMINI = `#!/bin/sh
case "$1" in
  --version) echo "0.1.0" ;;
  --acp) exec "${process.execPath}" ${TYPESCRIPT_FLAGS.join(' ')} "${FAKE_AGENT_ENTRY}" --crew ;;
  *) exit 1 ;;
esac
`;

const PULL_REQUEST = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        repository: {
          nameWithOwner: 'example/example',
          url: 'https://github.com/example/example',
          defaultBranchRef: { name: 'main' },
        },
        baseRefName: 'main',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        headRefOid: PR_HEAD,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  state: 'SUCCESS',
                  contexts: { nodes: [] },
                },
              },
            },
          ],
        },
        reviews: { nodes: [] },
        reviewThreads: { nodes: [] },
      },
    },
  },
});

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$HOME/gh.log"
case "$1" in
  --version) echo "gh version 2.0.0" ;;
  auth) echo "Logged in to github.com account clean-machine (keyring)" ;;
  api) echo '${PULL_REQUEST}' ;;
  pr) [ "$2" = list ] && echo '[]' ;;
  *) exit 1 ;;
esac
exit 0
`;

const installFakeTools = async (home: string): Promise<string> => {
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  for (const [name, script] of [
    [FAKE_RUNTIME, FAKE_GEMINI],
    ['gh', FAKE_GH],
  ] as const) {
    const path = join(bin, name);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
  return bin;
};

const git = (cwd: string, ...args: string[]): void => {
  const run = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (run.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
};

const createRepo = async (repo: string): Promise<void> => {
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '--quiet', '--initial-branch=main');
  await writeFile(join(repo, 'README.md'), '# deck\n');
  git(repo, 'add', 'README.md');
  git(
    repo,
    '-c',
    'user.name=Clean Machine',
    '-c',
    'user.email=clean@machine.invalid',
    'commit',
    '--quiet',
    '-m',
    'first',
  );
  git(
    repo,
    'remote',
    'add',
    'origin',
    'https://github.com/example/example.git',
  );
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
};

const checkFakeAgent = async (cwd: string): Promise<void> => {
  const replies: string[] = [];
  const client = await spawnAcpClient(
    {
      command: process.execPath,
      args: [...TYPESCRIPT_FLAGS, FAKE_AGENT_ENTRY],
    },
    {
      clientName: 'clean-machine',
      clientVersion: '0.0.0',
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
      onEvent: (event) => {
        if (event.type !== 'session_update') return;
        if (event.update.sessionUpdate !== 'agent_message_chunk') return;
        if (event.update.content.type !== 'text') return;
        replies.push(event.update.content.text);
      },
    },
  );
  try {
    const { sessionId } = await client.newSession({ cwd, mcpServers: [] });
    const { stopReason } = await client.prompt(sessionId, GREETING);
    check(stopReason === 'end_turn', `the fake agent ends its turn`);
    check(replies.join('') === GREETING, 'the fake agent echoes the prompt');
  } finally {
    await client.close();
  }
};

const stopUp = async ({
  group,
  url,
  closed,
  output,
}: Running): Promise<void> => {
  process.kill(-group, 'SIGTERM');
  await closed;
  check(output().includes('Stopped.'), 'up stops cleanly on SIGTERM');
  check(!(await answers(url)), 'up no longer answers');
};

const checkWipe = async (
  env: NodeJS.ProcessEnv,
  projectDir: string,
): Promise<void> => {
  const wipe = spawnSync(
    'npm',
    [...QUARTERDECK, 'wipe', PROJECT, '--confirm', PROJECT],
    { cwd: CLONE, env, encoding: 'utf8' },
  );
  check(wipe.status === 0, `wipe exits 0 (${wipe.status}) ${wipe.stderr}`);
  check(wipe.stdout.includes(`Wiped ${PROJECT}.`), 'wipe says what it wiped');
  check(!(await exists(projectDir)), 'wipe deleted the project folder');
};

const checkNoRegistryPackage = (): void => {
  const ls = spawnSync('npm', ['ls', 'quarterdeck', '--all', '--parseable'], {
    cwd: CLONE,
    encoding: 'utf8',
  });
  check(
    ls.stdout.trim() === '',
    'npm ls quarterdeck finds no quarterdeck package from the registry',
  );
};

const main = async (): Promise<void> => {
  checkNoRegistryPackage();
  const home = await mkdtemp(join(tmpdir(), 'qd-clean-home-'));
  const repo = join(home, PROJECT);
  await createRepo(repo);
  const bin = await installFakeTools(home);
  const env = {
    ...process.env,
    HOME: home,
    DATABASE_URL: '',
    GEMINI_API_KEY: 'clean-machine',
    PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
  };
  const running = await startUp(env);
  try {
    check(
      RUNNING.test(running.output()),
      `npm run quarterdeck -- up serves ${running.url}`,
    );
    await checkDashboard(running.url);
    await checkSetup(running, home, repo);
    await checkVoyage(running, home);
    await checkFakeAgent(repo);
  } catch (err) {
    await explain(running);
    throw err;
  } finally {
    await stopUp(running);
  }
  await checkWipe(env, join(home, '.quarterdeck', PROJECT));
};

await main();
