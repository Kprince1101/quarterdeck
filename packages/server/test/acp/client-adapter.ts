import { isAuthRequiredError, spawnAcpClient } from '@quarterdeck/server';
import type {
  AcpClient,
  AcpClientEvent,
  AcpClientOptions,
  PermissionHandler,
} from '@quarterdeck/server';
import type {
  ConformanceAdapter,
  ConformanceConnection,
  ConformanceHooks,
  SessionOpening,
} from './conformance/types.ts';
import type { FakeAgentLaunch } from './fake-agent/types.ts';

export interface ClientAdapter {
  adapter: ConformanceAdapter;
  spawnedPids: number[];
}

export type SpawnClient = (
  launch: FakeAgentLaunch,
  options: AcpClientOptions,
) => Promise<AcpClient>;

const forwardUpdates =
  (hooks: ConformanceHooks, spawnedPids: number[]) =>
  (event: AcpClientEvent) => {
    if (event.type === 'spawned') spawnedPids.push(event.pid);
    if (event.type === 'session_update') {
      hooks.onUpdate(event.sessionId, event.update);
    }
  };

export type PermissionWiring = (hooks: ConformanceHooks) => PermissionHandler;

export interface ClientAdapterOptions {
  name?: string;
  spawnClient?: SpawnClient;
  permissions?: PermissionWiring;
}

const askTheRecorder: PermissionWiring = (hooks) => async (request) => ({
  outcome: await hooks.decidePermission(request),
});

export const createClientAdapter = ({
  name = 'spawnAcpClient',
  spawnClient = spawnAcpClient,
  permissions = askTheRecorder,
}: ClientAdapterOptions = {}): ClientAdapter => {
  const spawnedPids: number[] = [];

  const connect = async (
    launch: FakeAgentLaunch,
    hooks: ConformanceHooks,
  ): Promise<ConformanceConnection> => {
    const client = await spawnClient(launch, {
      clientName: 'quarterdeck-conformance',
      clientVersion: '0.0.0',
      onPermissionRequest: permissions(hooks),
      onEvent: forwardUpdates(hooks, spawnedPids),
    });
    const authMethods = client.agent.authMethods ?? [];

    const openSession = async (cwd: string): Promise<SessionOpening> => {
      try {
        const { sessionId } = await client.newSession({ cwd, mcpServers: [] });
        return { status: 'ready', sessionId };
      } catch (err) {
        if (isAuthRequiredError(err)) {
          return { status: 'auth_required', authMethods };
        }
        throw err;
      }
    };

    const prompt = async (sessionId: string, text: string) => {
      const response = await client.prompt(sessionId, text);
      return response.stopReason;
    };

    return {
      openSession,
      authenticate: client.authenticate,
      prompt,
      cancel: client.cancel,
      close: client.close,
    };
  };

  return {
    adapter: { name, connect },
    spawnedPids,
  };
};
