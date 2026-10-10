import { startBusHost, type BusHost } from '../bus/host.js';
import { startCrew, type Coordinator, type Crew } from '../crew/index.js';
import { crewFailedEvent } from '../crew/failures.js';
import { projectForge, type ForgeHost } from '../gate/index.js';
import type { GlobalLayouts } from '../global-layout/index.js';
import type { PlannerAdapters } from '../planner/sessions.js';
import type { Store } from '../store/index.js';
import { createStream, type Stream } from '../stream/socket.js';
import type { Workspaces } from '../workspace/index.js';

export interface ProjectServicesContext {
  home: string;
  homeDir: string;
  token: string;
  layouts: GlobalLayouts;
  workspaces: Workspaces;
  allowedOrigins?: readonly string[] | undefined;
  onError?: ((err: unknown) => void) | undefined;
  openStores: () => readonly Store[];
  coordinator: Coordinator;
  adapters?: PlannerAdapters | undefined;
  forge?: ForgeHost | undefined;
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
      coordinator: context.coordinator,
      adapters: context.adapters,
      forge: context.forge,
      gatePollMs: context.gatePollMs,
      mode: context.workspaces.mode,
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
    const bus = await startBusHost({
      store,
      home: context.home,
      forge: async () =>
        context.forge?.forge ??
        projectForge(store, { homeDir: context.homeDir }),
      openStores: context.openStores,
      mode: context.workspaces.mode,
    });
    closers.push(() => bus.close());
    const stream = createStream({
      store,
      token: context.token,
      home: context.home,
      layouts: context.layouts,
      workspaces: context.workspaces,
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
