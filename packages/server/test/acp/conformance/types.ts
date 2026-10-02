import type {
  AuthMethod,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { FakeAgentLaunch } from '../fake-agent/types.ts';

export type PermissionDecider = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionOutcome>;

export interface ConformanceHooks {
  decidePermission: PermissionDecider;
  onUpdate: (sessionId: string, update: SessionUpdate) => void;
}

export type SessionOpening =
  | { status: 'ready'; sessionId: string }
  | { status: 'auth_required'; authMethods: AuthMethod[] };

export interface ConformanceConnection {
  openSession: (cwd: string) => Promise<SessionOpening>;
  authenticate: (methodId: string) => Promise<void>;
  prompt: (sessionId: string, text: string) => Promise<StopReason>;
  cancel: (sessionId: string) => Promise<void>;
  close: () => Promise<void>;
}

export interface ConformanceAdapter {
  name: string;
  connect: (
    launch: FakeAgentLaunch,
    hooks: ConformanceHooks,
  ) => Promise<ConformanceConnection>;
}

export interface RecordedUpdate {
  sessionId: string;
  update: SessionUpdate;
}

export interface ConformanceCheck {
  name: string;
  run: (adapter: ConformanceAdapter) => Promise<void>;
}
