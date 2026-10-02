import type { AgentContext, StopReason } from '@agentclientprotocol/sdk';

export type FakeScenario =
  'echo' | 'tool_call' | 'permission' | 'long_output' | 'wait_for_cancel';

export interface FakeAgentOptions {
  requireAuth?: boolean;
  stepDelayMs?: number;
}

export interface FakeTurn {
  sessionId: string;
  text: string;
  client: AgentContext;
  signal: AbortSignal;
  stepDelayMs: number;
}

export type FakeScenarioHandler = (turn: FakeTurn) => Promise<StopReason>;

export interface FakeAgentLaunch {
  command: string;
  args: string[];
}
