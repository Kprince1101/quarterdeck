import { startBusHost, type BusHost } from '../bus/host.js';
import type { Store } from '../store/index.js';
import { createStream, type Stream } from '../stream/socket.js';

export interface ProjectServicesContext {
  home: string;
  token: string;
  allowedOrigins?: readonly string[] | undefined;
  onError?: ((err: unknown) => void) | undefined;
}

export interface ProjectServices {
  project: string;
  store: Store;
  bus: BusHost;
  stream: Stream;
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
    return { project, store, bus, stream, close };
  } catch (err) {
    await close();
    throw err;
  }
};
