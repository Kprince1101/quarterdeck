import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAcpClient } from '@quarterdeck/server';

const STARTUP_TIMEOUT_MS = 60_000;
const RUNNING =
  /Quarterdeck is running at (http:\/\/127\.0\.0\.1:\d+)\/#token=([\w-]+)/;
const PROJECT = 'deck';
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

const checkCreate = async (
  { url, token }: Running,
  home: string,
  repoPath: string,
): Promise<void> => {
  const tokenFile = join(home, '.quarterdeck', 'api.token');
  check(
    (await readFile(tokenFile, 'utf8')) === token,
    'up writes the printed token to ~/.quarterdeck/api.token',
  );
  const create = (headers: Record<string, string>) =>
    fetch(`${url}/api/intents/project.create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ project: PROJECT, repoPath }),
    });
  const refused = await create({});
  check(refused.status === 401, `no token answers 401 (${refused.status})`);
  const res = await create({ authorization: `Bearer ${token}` });
  check(res.status === 200, `project.create answers 200 (${res.status})`);
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
  const repo = join(home, 'repo');
  await mkdir(join(repo, '.git'), { recursive: true });
  const env = { ...process.env, HOME: home, DATABASE_URL: '' };
  const running = await startUp(env);
  try {
    check(
      RUNNING.test(running.output()),
      `npm run quarterdeck -- up serves ${running.url}`,
    );
    await checkDashboard(running.url);
    await checkCreate(running, home, repo);
    await checkFakeAgent(repo);
  } finally {
    await stopUp(running);
  }
  await checkWipe(env, join(home, '.quarterdeck', PROJECT));
};

await main();
