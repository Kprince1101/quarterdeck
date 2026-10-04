import { readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadRule, runtimeSchema, type Runtime } from '@quarterdeck/rules';
import {
  AcpClientError,
  CLAUDE_ADAPTER,
  GEMINI_ADAPTER,
  KIRO_ADAPTER,
  NoBirthTurnError,
  QUARTERDECK_COMMAND,
  ReplaySignInError,
  TurnInputMissingError,
  findVoyageSessions,
  projectTurnsDir,
  quarterdeckHome,
  replayDriverChain,
  type AcpClientOptions,
  type ConnectReplay,
  type ReplayClient,
  type ReplayTurn,
  type VoyageSession,
  type RuntimeLaunch,
} from '@quarterdeck/server';
import { projectSlugSchema } from '@quarterdeck/server/intents';
import { CliError, type CliIo, type Command } from './io.js';

const RUNTIMES = runtimeSchema.options;

export const REPLAY_CLIENT_NAME = 'quarterdeck';
export const REPLAY_CLIENT_VERSION = '0.0.0';

export const REPLAY_USAGE = `Usage: ${QUARTERDECK_COMMAND} replay <voyage> [n] [options]

Sends the Driver's saved prompts for voyage <voyage> again, turns 1 to n of the
voyage (default: all of them), in one new session, and prints the replies.
Nothing is written: the agent runs in a throwaway folder with no Quarterdeck
tools, and every permission it asks for is refused.

  --project <slug>     The project that holds the voyage's Driver turns (default:
                       the only one that does; voyages are numbered across
                       every project, so only older voyages need it)
  --runtime <runtime>  ${RUNTIMES.join(', ')} (default: the Driver's runtime in ~/.quarterdeck)`;

export interface ReplayAdapter {
  connect: (
    launch: RuntimeLaunch,
    options: AcpClientOptions,
  ) => Promise<ReplayClient>;
}

export type ReplayAdapters = Record<Runtime, ReplayAdapter>;

export const REPLAY_ADAPTERS: ReplayAdapters = {
  kiro: KIRO_ADAPTER,
  claude: CLAUDE_ADAPTER,
  gemini: GEMINI_ADAPTER,
};

export interface ReplayCliOptions {
  adapters?: ReplayAdapters;
}

interface FoundVoyage {
  project: string;
  session: VoyageSession;
  sessions: number;
}

const POSITIVE = /^[1-9]\d*$/;

const parsePositive = (name: string, value: string): number => {
  const number = Number(value);
  if (!POSITIVE.test(value) || !Number.isSafeInteger(number)) {
    throw new CliError(`${name} must be a positive whole number, not ${value}`);
  }
  return number;
};

const parseThrough = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  return parsePositive('n', value);
};

const parseProject = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (projectSlugSchema.safeParse(value).success) return value;
  throw new CliError(
    `--project ${JSON.stringify(value)} is not a project slug`,
  );
};

const parseRuntime = async (
  value: string | undefined,
  io: CliIo,
): Promise<Runtime> => {
  if (value === undefined) {
    const models = await loadRule('models', { homeDir: io.homeDir });
    return models.driver.runtime;
  }
  const parsed = runtimeSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliError(`--runtime must be one of ${RUNTIMES.join(', ')}`);
};

const projectSlugs = async (home: string): Promise<string[]> => {
  try {
    const entries = await readdir(home, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => projectSlugSchema.safeParse(name).success)
      .toSorted();
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
};

const countOf = (count: number, noun: string): string => {
  if (count === 1) return `1 ${noun}`;
  return `${count} ${noun}s`;
};

const searchedProjects = async (
  home: string,
  project: string | undefined,
): Promise<string[]> => {
  if (project !== undefined) return [project];
  return projectSlugs(home);
};

const searchedPlace = (home: string, project: string | undefined): string => {
  if (project !== undefined) return project;
  return `any project in ${home}`;
};

const findVoyage = async (
  home: string,
  voyage: number,
  project: string | undefined,
): Promise<FoundVoyage> => {
  const found: FoundVoyage[] = [];
  for (const slug of await searchedProjects(home, project)) {
    const sessions = await findVoyageSessions(
      projectTurnsDir(slug, home),
      voyage,
    );
    const session = sessions.at(-1);
    if (session)
      found.push({ project: slug, session, sessions: sessions.length });
  }
  const [first, ...rest] = found;
  if (!first) {
    throw new CliError(
      `No saved Driver turns for voyage ${voyage} in ${searchedPlace(home, project)}`,
    );
  }
  if (rest.length > 0) {
    const names = found.map((entry) => entry.project).join(', ');
    throw new CliError(
      `Voyage ${voyage} is in more than one project (${names}). Pass --project <slug>.`,
    );
  }
  return first;
};

const turnCount = (session: VoyageSession): number =>
  session.lastSeq - session.firstSeq + 1;

const pickTurns = (found: FoundVoyage, n: number | undefined): number => {
  const count = turnCount(found.session);
  if (n === undefined) return count;
  if (n > count) {
    throw new CliError(
      `Voyage ${found.session.voyage} of ${found.project} has ${countOf(count, 'Driver turn')}; n must be from 1 to ${count}`,
    );
  }
  return n;
};

const savedNote = (turn: ReplayTurn): string => {
  if (turn.savedOutput === null) return 'no saved reply';
  if (turn.savedOutput === turn.output) return 'same as the saved reply';
  return 'differs from the saved reply';
};

const resultNote = (turn: ReplayTurn): string => {
  if (turn.result.ok) return 'turn result parsed';
  return `no turn result (${turn.result.error})`;
};

const printTurn = (
  io: CliIo,
  turn: ReplayTurn,
  firstSeq: number,
  n: number,
) => {
  io.out(`--- Turn ${turn.seq - firstSeq + 1} of ${n} ---`);
  io.out(turn.output);
  io.out(`(${turn.stopReason}; ${resultNote(turn)}; ${savedNote(turn)})`);
  io.out('');
};

const cancelled = () => new DOMException('Replay cancelled', 'AbortError');

const isReplayError = (err: unknown): err is Error =>
  err instanceof AcpClientError ||
  err instanceof NoBirthTurnError ||
  err instanceof TurnInputMissingError;

export const replayVoyage = async (
  args: string[],
  io: CliIo,
  { adapters = REPLAY_ADAPTERS }: ReplayCliOptions = {},
): Promise<number> => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      runtime: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.out(REPLAY_USAGE);
    return 0;
  }
  const [voyageArg, nArg, ...extra] = positionals;
  if (voyageArg === undefined) {
    throw new CliError(`replay needs a voyage\n\n${REPLAY_USAGE}`);
  }
  if (extra.length > 0) throw new CliError('replay takes a voyage and n');
  const voyage = parsePositive('voyage', voyageArg);
  const n = parseThrough(nArg);
  const project = parseProject(values.project);
  const runtime = await parseRuntime(values.runtime, io);

  const home = quarterdeckHome(io.homeDir);
  const found = await findVoyage(home, voyage, project);
  const turns = pickTurns(found, n);
  const { session } = found;
  const through = session.firstSeq + turns - 1;

  let stopped = false;
  let client: ReplayClient | undefined;
  void io
    .untilStopped()
    .then(async () => {
      stopped = true;
      await client?.close();
    })
    .catch(() => undefined);
  const env = await loadRule('env', { homeDir: io.homeDir });
  const connect: ConnectReplay = async ({ cwd, onPermissionRequest }) => {
    client = await adapters[runtime].connect(
      {
        cwd,
        env: { pass: env.pass },
        project: found.project,
        agentName: `replay-${through}`,
      },
      {
        clientName: REPLAY_CLIENT_NAME,
        clientVersion: REPLAY_CLIENT_VERSION,
        onPermissionRequest,
      },
    );
    if (stopped) await client.close();
    return client;
  };

  io.out(
    `Replaying voyage ${voyage} of ${found.project}: Driver ${session.driverName} (${session.agentId}), turns 1 to ${turns} of ${turnCount(session)}, on ${runtime}.`,
  );
  if (found.sessions > 1) {
    io.out(
      `Voyage ${voyage} had ${found.sessions} Driver sessions; this is the latest.`,
    );
  }
  io.out(
    'Nothing is saved. The agent has no Quarterdeck tools and every permission is refused.',
  );
  io.out('');
  try {
    await replayDriverChain({
      runtime,
      connect,
      turnsDir: projectTurnsDir(found.project, home),
      agentId: session.agentId,
      through,
      onTurn: (turn) => printTurn(io, turn, session.firstSeq, turns),
    });
  } catch (err) {
    if (stopped) throw cancelled();
    if (err instanceof ReplaySignInError) {
      io.err(err.message);
      io.err(`Sign in: ${err.command}`);
      return 1;
    }
    if (isReplayError(err)) throw new CliError(err.message);
    throw err;
  }
  if (stopped) throw cancelled();
  io.out(`Replayed ${countOf(turns, 'turn')}.`);
  return 0;
};

export const runReplay: Command = (args, io) => replayVoyage(args, io);
