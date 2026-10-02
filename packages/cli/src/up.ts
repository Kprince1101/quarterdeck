import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  DEFAULT_API_PORT,
  quarterdeckHome,
  startApiServer,
  type ApiServer,
} from '@quarterdeck/server';
import { resolveDashboardDir } from './dashboard.js';
import { CliError, type CliIo, type Command } from './io.js';

const MAX_PORT = 65_535;

export const UP_USAGE = `Usage: quarterdeck up [--port <port>]

Starts the Quarterdeck server and dashboard on 127.0.0.1 and prints the URL.
Stop it with Ctrl+C.

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

const listen = async (port: number, io: CliIo): Promise<ApiServer> => {
  try {
    return await startApiServer({
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
  await mkdir(quarterdeckHome(io.homeDir), { recursive: true });
  const api = await listen(port, io);
  io.out(`Quarterdeck is running at ${api.url}`);
  io.out(`Data: ${api.stores.location}`);
  io.out('Press Ctrl+C to stop.');
  await io.untilStopped();
  await api.close();
  io.out('Stopped.');
  return 0;
};
