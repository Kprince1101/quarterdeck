import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { createApiToken, verifyApiToken } from '../api/token.js';
import {
  createGlobalLayouts,
  type GlobalLayout,
  type GlobalLayouts,
} from '../global-layout/index.js';
import type { KeepAwakeFeed } from '../keep-awake/control.js';
import { reporter } from '../store/events.js';
import { quarterdeckHome } from '../store/index.js';
import type { StoreEvent, Store, TableChange } from '../store/index.js';
import { createWorkspaces, type Workspaces } from '../workspace/index.js';
import { MACHINE_EVENT_KINDS, readMachineState } from './machine.js';
import {
  STREAM_AFTER_PARAM,
  STREAM_PATH,
  STREAM_PROJECT_PARAM,
  STREAM_PROTOCOL,
  STREAM_TOKEN_PREFIX,
  type KeepAwakeState,
  type MachineState,
  type Workspace,
} from './schema.js';
import { readSnapshot, tailCursor, type SnapshotRows } from './snapshot.js';

export const STREAM_HOST = '127.0.0.1';

export const STREAM_TAIL = 200;

export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export const CLOSE_GOING_AWAY = 1001;

export const CLOSE_READ_ONLY = 1008;

export const CLOSE_FAILED = 1011;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const MAX_INBOUND_BYTES = 1024;

export interface StreamOptions {
  store: Store;
  token: string;
  home?: string;
  layouts?: GlobalLayouts | undefined;
  workspaces?: Workspaces | undefined;
  keepAwake?: KeepAwakeFeed | undefined;
  tail?: number;
  turnsPerAgent?: number;
  maxBufferedBytes?: number;
  allowedOrigins?: readonly string[] | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

export interface Stream {
  handleUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => boolean;
  readonly clients: number;
  close: () => Promise<void>;
}

export interface ServedStream {
  stream: Stream;
  port: number;
  url: string;
  token: string;
  close: () => Promise<void>;
}

export type ServeStreamOptions = Omit<StreamOptions, 'token'> & {
  token?: string;
  port?: number;
};

type Outgoing =
  | {
      type: 'snapshot';
      cursor: number;
      tables: SnapshotRows;
      machine: MachineState;
      layout: GlobalLayout | null;
      workspace: Workspace | null;
      keepAwake: KeepAwakeState | null;
    }
  | { type: 'event'; event: StoreEvent }
  | ({ type: 'change' } & TableChange)
  | { type: 'machine'; machine: MachineState }
  | { type: 'layout'; layout: GlobalLayout }
  | { type: 'workspace'; workspace: Workspace }
  | { type: 'keepAwake'; keepAwake: KeepAwakeState };

const jsonValue = (_: string, value: unknown): unknown => {
  if (typeof value === 'bigint') return Number(value);
  return value;
};

const serialize = (message: Outgoing): string =>
  JSON.stringify(message, jsonValue);

const isNewer = <T>(pending: T | undefined, sent: T | null): pending is T =>
  pending !== undefined && JSON.stringify(pending) !== JSON.stringify(sent);

const reject = (socket: Duplex, status: number, reason: string): void => {
  socket.on('error', () => undefined);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n` +
      'Connection: close\r\nContent-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
  );
};

const localHosts = (port: number): string[] => [
  `127.0.0.1:${port}`,
  `localhost:${port}`,
];

const refusal = (
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>,
): string | undefined => {
  const { remoteAddress, localPort } = request.socket;
  if (!LOOPBACK_ADDRESSES.has(remoteAddress ?? '')) {
    return 'stream accepts loopback connections only';
  }
  const hosts = localHosts(localPort ?? 0);
  if (!hosts.includes(request.headers.host ?? '')) {
    return 'Host not allowed';
  }
  const { origin } = request.headers;
  const ownOrigin = hosts.some((host) => origin === `http://${host}`);
  if (origin !== undefined && !ownOrigin && !allowedOrigins.has(origin)) {
    return 'Origin not allowed';
  }
  return undefined;
};

const protocolsOf = (request: IncomingMessage): string[] =>
  (request.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((protocol) => protocol.trim());

const presentedToken = (request: IncomingMessage): string | undefined =>
  protocolsOf(request)
    .find((protocol) => protocol.startsWith(STREAM_TOKEN_PREFIX))
    ?.slice(STREAM_TOKEN_PREFIX.length);

type Refusal = [status: number, reason: string];

const admission = (
  request: IncomingMessage,
  token: string,
  allowedOrigins: ReadonlySet<string>,
): Refusal | undefined => {
  const refused = refusal(request, allowedOrigins);
  if (refused) return [403, refused];
  if (!verifyApiToken(token, presentedToken(request))) return [401, ''];
  return undefined;
};

const parseAfter = (url: URL): number | undefined | null => {
  const after = url.searchParams.get(STREAM_AFTER_PARAM);
  if (after === null) return undefined;
  if (!/^\d+$/.test(after)) return null;
  const cursor = Number(after);
  if (!Number.isSafeInteger(cursor)) return null;
  return cursor;
};

export const createStream = (options: StreamOptions): Stream => {
  const { store } = options;
  const home = options.home ?? quarterdeckHome();
  const layouts = options.layouts ?? createGlobalLayouts(home);
  const workspaces = options.workspaces ?? createWorkspaces(home);
  const keepAwakeFeed = options.keepAwake;
  const tail = options.tail ?? STREAM_TAIL;
  const maxBuffered = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  const allowedOrigins = new Set(options.allowedOrigins);
  const report = reporter(options.onError);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INBOUND_BYTES,
    handleProtocols: (protocols) =>
      protocols.has(STREAM_PROTOCOL) && STREAM_PROTOCOL,
  });
  const connections = new Map<WebSocket, () => Promise<void>>();

  const connect = async (
    ws: WebSocket,
    requested: number | undefined,
  ): Promise<void> => {
    const resources: Array<() => Promise<void>> = [];
    let open = true;
    let releasing: Promise<void> | undefined;
    const release = (): Promise<void> => {
      open = false;
      connections.delete(ws);
      releasing ??= Promise.allSettled(resources.map((close) => close())).then(
        () => undefined,
      );
      return releasing;
    };
    const keep = async (close: () => Promise<void>): Promise<boolean> => {
      if (open) {
        resources.push(close);
        return true;
      }
      await close();
      return false;
    };
    connections.set(ws, release);
    ws.on('close', () => void release());
    ws.on('error', report);
    ws.on('message', () => ws.close(CLOSE_READ_ONLY, 'read-only stream'));

    const behind = (): boolean => {
      if (ws.bufferedAmount <= maxBuffered) return false;
      ws.terminate();
      return true;
    };
    const write = (message: Outgoing): Promise<void> =>
      new Promise((resolve) => {
        if (ws.readyState !== WebSocket.OPEN) {
          resolve();
          return;
        }
        const done = (): void => {
          ws.off('close', done);
          resolve();
        };
        ws.once('close', done);
        ws.send(serialize(message), done);
      });
    const sendNow = (message: Outgoing): void => {
      if (ws.readyState !== WebSocket.OPEN || behind()) return;
      ws.send(serialize(message));
    };
    const sendChange = (change: TableChange): void => {
      sendNow({ type: 'change', ...change });
    };
    const sendLayout = (layout: GlobalLayout): void => {
      sendNow({ type: 'layout', layout });
    };
    const sendWorkspace = (workspace: Workspace): void => {
      sendNow({ type: 'workspace', workspace });
    };
    const sendKeepAwake = (keepAwake: KeepAwakeState): void => {
      sendNow({ type: 'keepAwake', keepAwake });
    };
    const sendEvent = async (event: StoreEvent): Promise<void> => {
      if (behind()) return;
      await write({ type: 'event', event });
      if (!MACHINE_EVENT_KINDS.has(event.kind)) return;
      await write({ type: 'machine', machine: await readMachineState(home) });
    };

    try {
      const pending: TableChange[] = [];
      let live = false;
      const watcher = await store.watch(
        (change) => {
          if (live) sendChange(change);
          else pending.push(change);
        },
        { onError: report },
      );
      if (!(await keep(() => watcher.close()))) return;
      let pendingLayout: GlobalLayout | undefined;
      const unsubscribe = layouts.subscribe((layout) => {
        if (live) sendLayout(layout);
        else pendingLayout = layout;
      });
      if (!(await keep(() => Promise.resolve(unsubscribe())))) return;
      let pendingWorkspace: Workspace | undefined;
      const unwatch = workspaces.subscribe((next) => {
        if (live) sendWorkspace(next);
        else pendingWorkspace = next;
      });
      if (!(await keep(() => Promise.resolve(unwatch())))) return;
      let pendingKeepAwake: KeepAwakeState | undefined;
      const unhear = keepAwakeFeed?.subscribe((next) => {
        if (live) sendKeepAwake(next);
        else pendingKeepAwake = next;
      });
      if (!(await keep(() => Promise.resolve(unhear?.())))) return;
      const after = requested ?? (await tailCursor(store, tail));
      const tables = await readSnapshot(store, options.turnsPerAgent);
      const machine = await readMachineState(home);
      const layout = await layouts.read();
      const workspace = await workspaces.read();
      const keepAwake = (await keepAwakeFeed?.read()) ?? null;
      if (!open) return;
      await write({
        type: 'snapshot',
        cursor: after,
        tables,
        machine,
        layout,
        workspace,
        keepAwake,
      });
      if (!open) return;
      live = true;
      pending.splice(0).forEach(sendChange);
      if (isNewer(pendingLayout, layout)) sendLayout(pendingLayout);
      if (isNewer(pendingWorkspace, workspace)) sendWorkspace(pendingWorkspace);
      if (isNewer(pendingKeepAwake, keepAwake)) sendKeepAwake(pendingKeepAwake);
      const subscription = await store.subscribe(sendEvent, {
        after,
        onError: report,
      });
      await keep(() => subscription.close());
    } catch (err) {
      report(err);
      ws.close(CLOSE_FAILED, 'stream failed');
      await release();
    }
  };

  const handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): boolean => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== STREAM_PATH) return false;
    const refused = admission(request, options.token, allowedOrigins);
    if (refused) {
      reject(socket, ...refused);
      return true;
    }
    const after = parseAfter(url);
    if (after === null) {
      reject(socket, 400, `${STREAM_AFTER_PARAM} must be an event id`);
      return true;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void connect(ws, after);
    });
    return true;
  };

  const close = async (): Promise<void> => {
    const releases = [...connections].map(([ws, release]) => {
      ws.close(CLOSE_GOING_AWAY, 'server closing');
      return release();
    });
    await Promise.all(releases);
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  };

  return {
    handleUpgrade,
    get clients() {
      return connections.size;
    },
    close,
  };
};

export const attachStream = (
  server: Server,
  options: StreamOptions,
): Stream => {
  const stream = createStream(options);
  server.on('upgrade', (request, socket, head) => {
    if (!stream.handleUpgrade(request, socket, head)) {
      reject(socket, 404, 'no such stream');
    }
  });
  return stream;
};

export type UpgradeHandler = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

export interface StreamRouterOptions {
  token: string;
  streams: () => ReadonlyMap<string, Stream>;
  allowedOrigins?: readonly string[] | undefined;
}

const pickStream = (
  streams: ReadonlyMap<string, Stream>,
  project: string | null,
): Stream | Refusal => {
  if (project !== null)
    return streams.get(project) ?? [404, `no open project ${project}`];
  const [only, ...others] = streams.values();
  if (only === undefined) return [404, 'no project is open'];
  if (others.length > 0)
    return [400, `name a project with ?${STREAM_PROJECT_PARAM}=<slug>`];
  return only;
};

export const routeStreams = (options: StreamRouterOptions): UpgradeHandler => {
  const allowedOrigins = new Set(options.allowedOrigins);
  return (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== STREAM_PATH) {
      reject(socket, 404, 'no such stream');
      return;
    }
    const refused = admission(request, options.token, allowedOrigins);
    if (refused) {
      reject(socket, ...refused);
      return;
    }
    const picked = pickStream(
      options.streams(),
      url.searchParams.get(STREAM_PROJECT_PARAM),
    );
    if (Array.isArray(picked)) {
      reject(socket, ...picked);
      return;
    }
    picked.handleUpgrade(request, socket, head);
  };
};

export const serveStream = async (
  options: ServeStreamOptions,
): Promise<ServedStream> => {
  const server = createServer((_, response) => {
    response.writeHead(404).end();
  });
  const token = options.token ?? createApiToken();
  const stream = attachStream(server, { ...options, token });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, STREAM_HOST, resolve);
  });
  const { port } = server.address() as AddressInfo;
  const close = async (): Promise<void> => {
    await stream.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return {
    stream,
    port,
    url: `ws://${STREAM_HOST}:${port}${STREAM_PATH}`,
    token,
    close,
  };
};
