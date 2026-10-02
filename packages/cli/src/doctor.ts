import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RulesError, loadRule, shellAllowWarnings } from '@quarterdeck/rules';
import {
  CLAUDE_AGENT_ACP_PACKAGE,
  CLAUDE_AGENT_ACP_VERSION,
  GEMINI_COMMAND,
  KIRO_COMMAND,
  NPM_PUBLIC_REGISTRY,
  claudeCliCommand,
  runCommand,
  type AgentCommand,
  type ChildEnvSpec,
  type CommandResult,
} from '@quarterdeck/server';
import { CliError, type CliIo, type Command } from './io.js';

export const DOCTOR_PROBE_TIMEOUT_MS = 15_000;

export const DOCTOR_USAGE = `Usage: quarterdeck doctor

Checks that kiro-cli, claude, gemini and gh are installed and signed in, and
prints the command to run for each one that is not. Warns when gh is signed
in only through GH_TOKEN or GITHUB_TOKEN, which agents do not get. Exits 1 if
any needs attention.`;

const CLAUDE_PINNED = `${CLAUDE_AGENT_ACP_PACKAGE}@${CLAUDE_AGENT_ACP_VERSION}`;

export const DOCTOR_FIXES = {
  kiroInstall: 'curl -fsSL https://cli.kiro.dev/install | bash',
  kiroSignIn: 'kiro-cli login',
  node: 'Node.js 22 or later from https://nodejs.org',
  claudeDownload: `npx --yes ${CLAUDE_PINNED} --cli --version`,
  claudeSignIn: `npx --yes ${CLAUDE_PINNED} --cli auth login --claudeai`,
  geminiInstall: 'npm install -g @google/gemini-cli',
  geminiSignIn: 'gemini, then choose Login with Google (or set GEMINI_API_KEY)',
  ghSignIn: 'gh auth login',
} as const;

const GH_INSTALL: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'brew install gh',
  win32: 'winget install --id GitHub.cli',
};
const GH_INSTALL_DOCS =
  'see https://github.com/cli/cli#installation for your system';

interface Fix {
  label: 'Install' | 'Download' | 'Sign in';
  command: string;
}

export interface DoctorCheck {
  name: string;
  state: string;
  fixes: Fix[];
}

interface Probe {
  io: CliIo;
  platform: NodeJS.Platform;
  run: (command: AgentCommand) => Promise<CommandResult>;
}

type Installed =
  | { ok: true; version: string }
  | { ok: false; state: string; notFound: boolean };

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0] ?? '';

const VERSION = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/;

const readVersion = (stdout: string, stderr: string): string => {
  const line = firstLine(stdout) || firstLine(stderr);
  return VERSION.exec(line)?.[0] ?? line;
};

const why = (result: CommandResult): string => {
  if (result.status === 'failed') return result.error;
  return `exited with ${result.code ?? result.signal}`;
};

const succeeded = (
  result: CommandResult,
): result is Extract<CommandResult, { status: 'exited' }> =>
  result.status === 'exited' && result.code === 0;

const installed = (result: CommandResult, display: string): Installed => {
  if (succeeded(result)) {
    return { ok: true, version: readVersion(result.stdout, result.stderr) };
  }
  if (result.status === 'failed' && result.notFound) {
    return { ok: false, state: 'not installed', notFound: true };
  }
  return {
    ok: false,
    state: `${display} failed (${why(result)})`,
    notFound: false,
  };
};

const signedIn = (
  name: string,
  version: string,
  account: string | undefined,
): DoctorCheck => {
  if (!account) return { name, state: `${version}, signed in`, fixes: [] };
  return { name, state: `${version}, signed in (${account})`, fixes: [] };
};

const signedOut = (name: string, version: string, fix: Fix): DoctorCheck => ({
  name,
  state: `${version}, not signed in`,
  fixes: [fix],
});

const viaShim = (
  command: string,
  args: string[],
  platform: NodeJS.Platform,
): AgentCommand => {
  if (platform !== 'win32') return { command, args };
  return {
    command: process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
};

const shellEnv = (
  io: CliIo,
  set: Record<string, string> = {},
): ChildEnvSpec => ({ source: io.env, pass: Object.keys(io.env), set });

const fileExists = (path: string) =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

const nonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value === '') return undefined;
  return value;
};

const checkKiro = async ({ run }: Probe): Promise<DoctorCheck> => {
  const name = KIRO_COMMAND;
  const signIn: Fix = { label: 'Sign in', command: DOCTOR_FIXES.kiroSignIn };
  const install: Fix = {
    label: 'Install',
    command: DOCTOR_FIXES.kiroInstall,
  };
  const version = installed(
    await run({ command: KIRO_COMMAND, args: ['--version'] }),
    'kiro-cli --version',
  );
  if (!version.ok) {
    return { name, state: version.state, fixes: [install, signIn] };
  }
  const whoami = await run({ command: KIRO_COMMAND, args: ['whoami'] });
  if (!succeeded(whoami)) return signedOut(name, version.version, signIn);
  return signedIn(name, version.version, nonEmpty(firstLine(whoami.stdout)));
};

interface ClaudeAuthStatus {
  loggedIn?: unknown;
  email?: unknown;
  apiKeySource?: unknown;
  apiProvider?: unknown;
}

const parseClaudeStatus = (stdout: string): ClaudeAuthStatus | undefined => {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const claudeAccount = (status: ClaudeAuthStatus): string | undefined => {
  const provider = nonEmpty(status.apiProvider);
  if (provider && provider !== 'firstParty') return provider;
  const keySource = nonEmpty(status.apiKeySource);
  if (keySource) return `API key from ${keySource}`;
  if (status.loggedIn === true) return nonEmpty(status.email) ?? 'claude.ai';
  return undefined;
};

const claudeSignedIn = (result: CommandResult): string | undefined => {
  if (result.status !== 'exited') return undefined;
  const status = parseClaudeStatus(result.stdout);
  if (status) return claudeAccount(status);
  if (result.code === 0) return 'claude.ai';
  return undefined;
};

const checkClaude = async ({
  io,
  platform,
  run,
}: Probe): Promise<DoctorCheck> => {
  const name = 'claude';
  const signIn: Fix = { label: 'Sign in', command: DOCTOR_FIXES.claudeSignIn };
  const claude = (args: string[]): AgentCommand => ({
    ...claudeCliCommand(args, platform),
    cwd: tmpdir(),
    env: shellEnv(io, { npm_config_registry: NPM_PUBLIC_REGISTRY }),
  });
  const version = installed(
    await run(claude(['--version'])),
    `${CLAUDE_PINNED} --cli --version`,
  );
  if (!version.ok && version.notFound) {
    return {
      name,
      state: 'npx not found',
      fixes: [{ label: 'Install', command: DOCTOR_FIXES.node }, signIn],
    };
  }
  if (!version.ok) {
    return {
      name,
      state: `${CLAUDE_PINNED} is not downloaded yet`,
      fixes: [
        { label: 'Download', command: DOCTOR_FIXES.claudeDownload },
        signIn,
      ],
    };
  }
  const account = claudeSignedIn(
    await run(claude(['auth', 'status', '--json'])),
  );
  if (!account) return signedOut(name, version.version, signIn);
  return signedIn(name, version.version, account);
};

const geminiCredentials = async (io: CliIo): Promise<string | undefined> => {
  if (io.env['GEMINI_API_KEY']) return 'GEMINI_API_KEY';
  const vertex = io.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true';
  if (vertex && (io.env['GOOGLE_API_KEY'] || io.env['GOOGLE_CLOUD_PROJECT'])) {
    return 'Vertex AI';
  }
  const oauth = join(io.homeDir, '.gemini', 'oauth_creds.json');
  if (await fileExists(oauth)) return 'Google account';
  return undefined;
};

const checkGemini = async ({
  io,
  platform,
  run,
}: Probe): Promise<DoctorCheck> => {
  const name = GEMINI_COMMAND;
  const signIn: Fix = { label: 'Sign in', command: DOCTOR_FIXES.geminiSignIn };
  const version = installed(
    await run(viaShim(GEMINI_COMMAND, ['--version'], platform)),
    'gemini --version',
  );
  if (!version.ok) {
    return {
      name,
      state: version.state,
      fixes: [
        { label: 'Install', command: DOCTOR_FIXES.geminiInstall },
        signIn,
      ],
    };
  }
  const credentials = await geminiCredentials(io);
  if (!credentials) return signedOut(name, version.version, signIn);
  return signedIn(name, version.version, credentials);
};

const GH_ACCOUNT = /Logged in to (\S+) (?:account|as) (\S+)/;

const ghAccount = (output: string): string | undefined => {
  const match = GH_ACCOUNT.exec(output);
  if (!match) return undefined;
  return `${match[2]} on ${match[1]}`;
};

const checkGh = async ({ platform, run }: Probe): Promise<DoctorCheck> => {
  const name = 'gh';
  const signIn: Fix = { label: 'Sign in', command: DOCTOR_FIXES.ghSignIn };
  const version = installed(
    await run({ command: 'gh', args: ['--version'] }),
    'gh --version',
  );
  if (!version.ok) {
    const install = GH_INSTALL[platform] ?? GH_INSTALL_DOCS;
    return {
      name,
      state: version.state,
      fixes: [{ label: 'Install', command: install }, signIn],
    };
  }
  const status = await run({ command: 'gh', args: ['auth', 'status'] });
  if (!succeeded(status)) return signedOut(name, version.version, signIn);
  const account = ghAccount(`${status.stdout}\n${status.stderr}`);
  return signedIn(name, version.version, account);
};

const GH_TOKEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN'];

const checkGhForAgents = async ({
  io,
  run,
}: Probe): Promise<DoctorCheck | undefined> => {
  const tokens = GH_TOKEN_ENV.filter((name) => io.env[name]);
  if (tokens.length === 0) return undefined;
  const status = (env: ChildEnvSpec) =>
    run({ command: 'gh', args: ['auth', 'status'], env });
  const [shell, agent] = await Promise.all([
    status(shellEnv(io)),
    status({ source: io.env }),
  ]);
  if (!succeeded(shell) || succeeded(agent)) return undefined;
  const named = tokens.join(' and ');
  return {
    name: 'gh for agents',
    state: `signed in only through ${named}, which agents do not get; unset ${named} and sign in`,
    fixes: [{ label: 'Sign in', command: DOCTOR_FIXES.ghSignIn }],
  };
};

export interface DoctorOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

export const runDoctorChecks = async (
  io: CliIo,
  {
    platform = process.platform,
    timeoutMs = DOCTOR_PROBE_TIMEOUT_MS,
  }: DoctorOptions = {},
): Promise<DoctorCheck[]> => {
  const probe: Probe = {
    io,
    platform,
    run: (command) =>
      runCommand({ cwd: io.cwd, env: shellEnv(io), ...command }, { timeoutMs }),
  };
  const checks = await Promise.all(
    [checkKiro, checkClaude, checkGemini, checkGh, checkGhForAgents].map(
      (check) => check(probe),
    ),
  );
  return checks.filter((check) => check !== undefined);
};

const render = (io: CliIo, checks: DoctorCheck[], misses: number) => {
  for (const check of checks) {
    io.out(`${check.name}: ${check.state}`);
    for (const fix of check.fixes) io.out(`  ${fix.label}: ${fix.command}`);
  }
  io.out('');
  if (misses === 0) {
    io.out('All set.');
    return;
  }
  io.out(
    `${misses} of ${checks.length} need attention. Run the commands above, then quarterdeck doctor again.`,
  );
};

const SHELL_RULES_CHECK = 'permissions';

export const checkShellRules = async (io: CliIo): Promise<DoctorCheck[]> => {
  try {
    const permissions = await loadRule('permissions', { homeDir: io.homeDir });
    return shellAllowWarnings(permissions).map((warning) => ({
      name: SHELL_RULES_CHECK,
      state: warning,
      fixes: [],
    }));
  } catch (err) {
    if (!(err instanceof RulesError)) throw err;
    return [{ name: SHELL_RULES_CHECK, state: err.message, fixes: [] }];
  }
};

export const runDoctor: Command = async (args, io) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    io.out(DOCTOR_USAGE);
    return 0;
  }
  if (positionals.length > 0) throw new CliError('doctor takes no arguments');
  const checks = [
    ...(await runDoctorChecks(io)),
    ...(await checkShellRules(io)),
  ];
  const misses = checks.filter((check) => check.fixes.length > 0).length;
  render(io, checks, misses);
  if (misses > 0) return 1;
  return 0;
};
