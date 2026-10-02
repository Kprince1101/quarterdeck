import { startBusHost, type BusHost } from '../bus/host.js';
import { startCrew, type Crew } from '../crew/index.js';
import { crewFailedEvent } from '../crew/failures.js';
import type { GitHubHost } from '../gate/index.js';
import type { PlannerAdapters } from '../planner/sessions.js';
import type { Store } from '../store/index.js';
import { createStream, type Stream } from '../stream/socket.js';

export interface ProjectServicesContext {
  home: string;
  homeDir: string;
  token: string;
  allowedOrigins?: readonly string[] | undefined;
  onError?: ((err: unknown) => void) | undefined;
  openStores: () => readonly Store[];
  adapters?: PlannerAdapters | undefined;
  github?: GitHubHost | undefined;
  gatePollMs?: number | undefined;
}

export interface ProjectServices {
  project: string;
  store: Store;
  bus: BusHost;
  stream: Stream;
  crew: Crew | undefined;
}

export interface RunningProject extends ProjectServices {
  close: () => Promise<void>;
}

type Closer = () => Promise<void>;

const reportError = (err: unknown): void => {
  console.error(err);
};

const closeInReverse = async (
  closers: Closer[],
  onError: (err: unknown) => void,
): Promise<void> => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(onError);
  }
};

const startProjectCrew = async (
  context: ProjectServicesContext,
  project: string,
  store: Store,
  bus: BusHost,
): Promise<Crew | undefined> => {
  const onError = context.onError ?? reportError;
  try {
    return await startCrew({
      store,
      project,
      bus,
      home: context.home,
      homeDir: context.homeDir,
      openStores: context.openStores,
      adapters: context.adapters,
      github: context.github,
      gatePollMs: context.gatePollMs,
      onError,
    });
  } catch (err) {
    onError(err);
    await store.publish(crewFailedEvent('start', err)).catch(onError);
    return undefined;
  }
};

export const startProjectServices = async (
  context: ProjectServicesContext,
  project: string,
  store: Store,
): Promise<RunningProject> => {
  const onError = context.onError ?? reportError;
  const closers: Closer[] = [];
  const close = () => closeInReverse(closers, onError);
  try {
    const bus = await startBusHost({ store, home: context.home });
    closers.push(() => bus.close());
    const stream = createStream({
      store,
      token: context.token,
      home: context.home,
      allowedOrigins: context.allowedOrigins,
      onError: context.onError,
    });
    closers.push(() => stream.close());
    const crew = await startProjectCrew(context, project, store, bus);
    if (crew) closers.push(() => crew.close());
    return { project, store, bus, stream, crew, close };
  } catch (err) {
    await close();
    throw err;
  }
};
