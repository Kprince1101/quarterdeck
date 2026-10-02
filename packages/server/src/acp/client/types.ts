import type {
  ContentBlock,
  InitializeResponse,
  LoadSessionResponse,
  McpServer,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionResponse,
  SessionId,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';

export interface AgentCommand {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SessionSetup {
  cwd: string;
  mcpServers: McpServer[];
}

export interface ResumeSetup extends SessionSetup {
  sessionId: SessionId;
}

export type ResumeMethod = 'session/resume' | 'session/load';

export interface ResumedSession {
  sessionId: SessionId;
  method: ResumeMethod;
  response: ResumeSessionResponse | LoadSessionResponse;
}

export type PromptInput = string | ContentBlock[];

export type PermissionHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

export type ListenerErrorHandler = (
  err: unknown,
  event: AcpClientEvent,
) => void;

export interface AcpClientOptions {
  clientName: string;
  clientVersion: string;
  onPermissionRequest: PermissionHandler;
  onEvent?: AcpClientListener;
  onListenerError?: ListenerErrorHandler;
  initializeTimeoutMs?: number;
  killGraceMs?: number;
  signal?: AbortSignal;
}

export interface SpawnedEvent {
  type: 'spawned';
  pid: number;
}

export interface SessionUpdateEvent {
  type: 'session_update';
  sessionId: SessionId;
  update: SessionUpdate;
}

export interface PermissionEvent {
  type: 'permission';
  sessionId: SessionId;
  request: RequestPermissionRequest;
  response: RequestPermissionResponse;
}

export interface TurnEndEvent {
  type: 'turn_end';
  sessionId: SessionId;
  stopReason: StopReason;
}

export interface StderrEvent {
  type: 'stderr';
  line: string;
}

export interface ExitEvent {
  type: 'exit';
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessErrorEvent {
  type: 'process_error';
  message: string;
}

export interface ClosedEvent {
  type: 'closed';
}

export interface AgentVersionEvent {
  type: 'agent_version';
  command: string;
  version: string | null;
  error?: string;
}

export interface SpawnRetryEvent {
  type: 'spawn_retry';
  attempt: number;
  retries: number;
  delayMs: number;
  message: string;
}

export type AcpClientEvent =
  | AgentVersionEvent
  | SpawnRetryEvent
  | SpawnedEvent
  | SessionUpdateEvent
  | PermissionEvent
  | TurnEndEvent
  | StderrEvent
  | ExitEvent
  | ProcessErrorEvent
  | ClosedEvent;

export type AcpClientListener = (event: AcpClientEvent) => void;

export interface AcpClient {
  readonly agent: InitializeResponse;
  authenticate: (methodId: string) => Promise<void>;
  newSession: (setup: SessionSetup) => Promise<NewSessionResponse>;
  resumeSession: (setup: ResumeSetup) => Promise<ResumedSession>;
  prompt: (sessionId: SessionId, input: PromptInput) => Promise<PromptResponse>;
  cancel: (sessionId: SessionId) => Promise<void>;
  subscribe: (listener: AcpClientListener) => () => void;
  close: () => Promise<void>;
  readonly closed: Promise<void>;
}
