import { parseArgs } from 'node:util';
import {
  DEFAULT_API_PORT,
  QUARTERDECK_COMMAND,
  ensurePrivateDir,
  quarterdeckHome,
  startQuarterdeck,
  type Quarterdeck,
} from '@quarterdeck/server';
import { resolveDashboardDir } from './dashboard.js';
import { CliError, type CliIo, type Command } from './io.js';

const MAX_PORT = 65_535;

export const UP_USAGE = `Usage: ${QUARTERDECK_COMMAND} up [--port <port>]

Starts the Quarterdeck server and dashboard on 127.0.0.1 and prints the URL
to open. The URL carries this run's API token; the dashboard needs it.
Every project's crew runs in it: the Planner, the Driver and its builders,
the reviewer and the merge gate. A voyage left open by an earlier run is
ended when it starts. Stop it with Ctrl+C; that stops every agent first.

  --port <port>  Port to listen on (default ${DEFAULT_API_PORT}; 0 picks a free one)`;

const parsePort = (value: string | undefined): number => {
  if (value === undefined) return DEFAULT_API_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > MAX_PORT) {
    throw new CliError(`--port must be a number from 0 to ${MAX_PORT}`);
  }
  return port;
};

const isPortTaken = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && err.code === 'EADDRINUSE';

const listen = async (port: number, io: CliIo): Promise<Quarterdeck> => {
  try {
    return await startQuarterdeck({
      port,
      homeDir: io.homeDir,
      dashboardDir: resolveDashboardDir(),
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
  const api = await listen(port, io);
  io.out(`Quarterdeck is running at ${api.url}/#token=${api.token}`);
  io.out(`Data: ${api.location}`);
  io.out('Press Ctrl+C to stop.');
  await io.untilStopped();
  await api.close();
  io.out('Stopped.');
  return 0;
};
