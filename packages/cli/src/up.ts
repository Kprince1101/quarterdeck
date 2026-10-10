import { parseArgs } from 'node:util';
import { loadRule } from '@quarterdeck/rules';
import {
  DEFAULT_API_PORT,
  QUARTERDECK_COMMAND,
  createWorkspaces,
  ensurePrivateDir,
  quarterdeckHome,
  startQuarterdeck,
  type Quarterdeck,
} from '@quarterdeck/server';
import { resolveDashboardDir } from './dashboard.js';
import { runDoctorChecks } from './doctor.js';
import { CliError, type CliIo, type Command } from './io.js';
import { createSetupProbe } from './setup-probe.js';
import { ensureSignedIn } from './signin.js';

const MAX_PORT = 65_535;

export const SETUP_LINE =
  'No workspace yet: open the URL above and Setup walks you through the folder, the runtime and sign-in.';

export const UP_USAGE = `Usage: ${QUARTERDECK_COMMAND} up [--port <port>]

Starts the Quarterdeck server and dashboard on 127.0.0.1 and prints the URL
to open. The URL carries this run's API token; the dashboard needs it.
Every project's crew runs in it: the Planner, the Driver and its builders,
the reviewer and the merge gate. A voyage left open by an earlier run is
ended when it starts. Stop it with Ctrl+C; that stops every agent first.
In a terminal, a runtime the crew uses that is signed out is signed in first,
through its own browser sign-in. Without one, the dashboard shows the sign-in.

  --port <port>  Port to listen on (default ${DEFAULT_API_PORT}; 0 picks a free one)`;

const parsePort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_API_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > MAX_PORT) {
    throw new CliError(`--port must be a number from 0 to ${MAX_PORT}`);
  }
  return port;
};

const hasWorkspace = async (io: CliIo): Promise<boolean> => {
  const workspace = await createWorkspaces(quarterdeckHome(io.homeDir)).read();
  return (workspace?.projects.length ?? 0) > 0;
};

const signInRuntimesInUse = async (io: CliIo): Promise<void> => {
  if (io.signIn === undefined) return;
  const models = await loadRule('models', { homeDir: io.homeDir });
  const runtimes = new Set(Object.values(models).map(({ runtime }) => runtime));
  await ensureSignedIn(io, {
    checks: () => runDoctorChecks(io),
    wanted: (tool) => tool.kind === 'runtime' && runtimes.has(tool.runtime),
  });
};

const isPortTaken = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'EADDRINUSE';

const listen = async (port: number, io: CliIo): Promise<Quarterdeck> => {
  try {
    return await startQuarterdeck({
      port,
      homeDir: io.homeDir,
      dashboardDir: resolveDashboardDir(),
      setupProbe: createSetupProbe(io),
    });
  } catch (err) {
    if (!isPortTaken(err)) throw err;
    throw new CliError(
      `Port ${port} is already in use. Is Quarterdeck already running? Pass --port to pick another.`,
    );
  }
};

export const runUp: Command = async (args, io) => {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    io.out(UP_USAGE);
    return 0;
  }
  const port = parsePort(values.port);
  await ensurePrivateDir(quarterdeckHome(io.homeDir));
  const configured = await hasWorkspace(io);
  if (configured) await signInRuntimesInUse(io);
  const api = await listen(port, io);
  io.out(`Quarterdeck is running at ${api.url}/#token=${api.token}`);
  if (!configured) io.out(SETUP_LINE);
  io.out(`Data: ${api.location}`);
  io.out('Press Ctrl+C to stop.');
  await io.untilStopped();
  await api.close();
  io.out('Stopped.');
  return 0;
};
