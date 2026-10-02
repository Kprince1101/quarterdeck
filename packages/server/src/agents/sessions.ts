import type { Agent } from './agent.js';

export interface SessionHost {
  open: (agent: Agent) => Promise<string>;
  close: (sessionId: string) => Promise<void>;
}
