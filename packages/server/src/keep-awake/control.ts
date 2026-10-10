import { stopOwnTree } from '../acp/client/index.js';
import type { KeepAwakeRequest } from '../intents/keep-awake.js';
import type { KeepAwakeMode, KeepAwakeState } from '../stream/schema.js';
import { KeepAwakeError } from './errors.js';
import {
  KEEP_AWAKE_KILL_GRACE_MS,
  spawnHoldProcess,
  type HeldProcess,
  type SpawnHold,
} from './process.js';
import {
  readKeepAwakeRecord,
  removeKeepAwakeRecord,
  writeKeepAwakeRecord,
} from './record.js';
import {
  KEEP_AWAKE_BACKENDS,
  keepAwakeSupport,
  type KeepAwakeSupport,
} from './support.js';

export type KeepAwakeListener = (state: KeepAwakeState) => void;

export interface KeepAwakeFeed {
  read: () => Promise<KeepAwakeState>;
  subscribe: (listener: KeepAwakeListener) => () => void;
}

export interface KeepAwake extends KeepAwakeFeed {
  start: (request: KeepAwakeRequest) => Promise<KeepAwakeState>;
  stop: () => Promise<KeepAwakeState>;
  voyageEnded: () => Promise<KeepAwakeState>;
  recover: () => Promise<void>;
  close: () => Promise<void>;
}

export interface KeepAwakeOptions {
  home: string;
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  ownerPid?: number | undefined;
  spawn?: SpawnHold | undefined;
  support?: (() => Promise<KeepAwakeSupport>) | undefined;
  now?: (() => number) | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

interface Hold {
  mode: KeepAwakeMode;
  expiresAt: Date | null;
  process: HeldProcess;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

const reportError = (err: unknown): void => {
  console.error('quarterdeck keep-awake failed', err);
};

const holdSeconds = (request: KeepAwakeRequest): number | null => {
  if ('minutes' in request) return request.minutes * SECONDS_PER_MINUTE;
  return null;
};

const holdMode = (request: KeepAwakeRequest): KeepAwakeMode => {
  if ('minutes' in request) return 'duration';
  return 'untilVoyageEnds';
};

const unavailableReason = (support: KeepAwakeSupport): string | null => {
  if (support.available) return null;
  return support.reason;
};

export const createKeepAwake = (options: KeepAwakeOptions): KeepAwake => {
  const { home } = options;
  const platform = options.platform ?? process.platform;
  const ownerPid = options.ownerPid ?? process.pid;
  const spawnHold = options.spawn ?? spawnHoldProcess;
  const now = options.now ?? Date.now;
  const report = options.onError ?? reportError;
  const probe =
    options.support ?? (() => keepAwakeSupport({ platform, env: options.env }));
  const listeners = new Set<KeepAwakeListener>();
  let support: Promise<KeepAwakeSupport> | undefined;
  let hold: Hold | undefined;
  let closing: Promise<void> | undefined;
  let turn: Promise<unknown> = Promise.resolve();

  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const done = turn.then(work);
    turn = done.catch(() => undefined);
    return done;
  };

  const supported = (): Promise<KeepAwakeSupport> => {
    support ??= probe();
    return support;
  };

  const read = async (): Promise<KeepAwakeState> => {
    const found = await supported();
    const availability = {
      available: found.available,
      unavailableReason: unavailableReason(found),
    };
    if (hold === undefined) {
      return { on: false, mode: null, expiresAt: null, ...availability };
    }
    return {
      on: true,
      mode: hold.mode,
      expiresAt: hold.expiresAt?.toISOString() ?? null,
      ...availability,
    };
  };

  const announce = async (): Promise<KeepAwakeState> => {
    const state = await read();
    listeners.forEach((listener) => listener(state));
    return state;
  };

  const stopOnExit = (): void => {
    hold?.process.stopNow();
  };

  const detach = (current: Hold): void => {
    if (hold === current) hold = undefined;
    clearTimeout(current.timer);
    if (hold === undefined) process.off('exit', stopOnExit);
  };

  const release = async (current: Hold): Promise<void> => {
    detach(current);
    await current.process.stop();
    await removeKeepAwakeRecord(home);
  };

  const ended = async (current: Hold): Promise<void> => {
    if (hold !== current) return;
    detach(current);
    await removeKeepAwakeRecord(home);
    await announce();
  };

  const expire = async (current: Hold): Promise<void> => {
    if (hold !== current) return;
    await release(current);
    await announce();
  };

  const backendFor = async () => {
    if (closing !== undefined) {
      throw new KeepAwakeError('Quarterdeck is shutting down.');
    }
    const found = await supported();
    if (!found.available) throw new KeepAwakeError(found.reason);
    const backend = KEEP_AWAKE_BACKENDS[platform];
    if (backend === undefined) {
      throw new KeepAwakeError(`Keep-awake is not supported on ${platform}.`);
    }
    return backend;
  };

  const own = async (held: HeldProcess): Promise<void> => {
    try {
      await writeKeepAwakeRecord(home, held);
    } catch (err) {
      await held.stop();
      throw err;
    }
  };

  const watch = (current: Hold, seconds: number | null): void => {
    process.on('exit', stopOnExit);
    if (seconds !== null) {
      current.timer = setTimeout(() => {
        inTurn(() => expire(current)).catch(report);
      }, seconds * MS_PER_SECOND);
      current.timer.unref();
    }
    void current.process.exited
      .then(() => inTurn(() => ended(current)))
      .catch(report);
  };

  const begin = async (request: KeepAwakeRequest): Promise<KeepAwakeState> => {
    const backend = await backendFor();
    if (hold !== undefined) await release(hold);
    const seconds = holdSeconds(request);
    const held = await spawnHold(backend.command({ seconds, ownerPid }));
    await own(held);
    let expiresAt: Date | null = null;
    if (seconds !== null) {
      expiresAt = new Date(now() + seconds * MS_PER_SECOND);
    }
    const current: Hold = {
      mode: holdMode(request),
      expiresAt,
      process: held,
      timer: undefined,
    };
    hold = current;
    watch(current, seconds);
    return announce();
  };

  const start = (request: KeepAwakeRequest): Promise<KeepAwakeState> =>
    inTurn(async () => {
      const wasOn = hold !== undefined;
      try {
        return await begin(request);
      } catch (err) {
        if (wasOn) await announce();
        throw err;
      }
    });

  const releaseWhen = (
    applies: (current: Hold) => boolean,
  ): Promise<KeepAwakeState> =>
    inTurn(async () => {
      if (hold === undefined || !applies(hold)) return read();
      await release(hold);
      return announce();
    });

  const recover = (): Promise<void> =>
    inTurn(async () => {
      const recorded = await readKeepAwakeRecord(home);
      if (recorded !== null) {
        await stopOwnTree(recorded, KEEP_AWAKE_KILL_GRACE_MS).catch(report);
      }
      await removeKeepAwakeRecord(home);
    });

  const shutdown = (): Promise<void> =>
    inTurn(async () => {
      if (hold !== undefined) await release(hold).catch(report);
      listeners.clear();
    });

  return {
    read,
    start,
    stop: () => releaseWhen(() => true),
    voyageEnded: () =>
      releaseWhen((current) => current.mode === 'untilVoyageEnds'),
    recover,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closing ??= shutdown();
      return closing;
    },
  };
};
