import type {
  AgentContext,
  McpServer,
  StopReason,
} from '@agentclientprotocol/sdk';

export type FakeScenario =
  | 'echo'
  | 'tool_call'
  | 'permission'
  | 'long_output'
  | 'large_output'
  | 'wait_for_cancel'
  | 'describe_session'
  | 'describe_mode'
  | 'crash'
  | 'sign_in_lapsed';

export type FakeAgentFlag =
  | 'supportsLoad'
  | 'supportsResume'
  | 'announce'
  | 'silent'
  | 'linger'
  | 'ignoreSigterm'
  | 'crew'
  | 'crashDriver'
  | 'builderAsks'
  | 'plannerSkipsDesign'
  | 'plannerSkipsDesignTwice'
  | 'plannerSpreads'
  | 'plannerNamesUnknown'
  | 'onGitlab'
  | 'leaksApiKey';

export interface FakeAgentOptions extends Partial<
  Record<FakeAgentFlag, boolean>
> {
  requireAuth?: boolean;
  stepDelayMs?: number;
}

export interface FakeAgentHooks {
  exitProcess?: (code: number) => void;
}

export interface FakeSessionSetup {
  cwd: string;
  mcpServers: McpServer[];
  meta: unknown;
  modeId: string;
}

export interface FakeTurn {
  sessionId: string;
  text: string;
  client: AgentContext;
  signal: AbortSignal;
  stepDelayMs: number;
  setup: FakeSessionSetup;
  exitProcess: (code: number) => void;
}

export type FakeScenarioHandler = (turn: FakeTurn) => Promise<StopReason>;

export interface FakeAgentLaunch {
  command: string;
  args: string[];
}
