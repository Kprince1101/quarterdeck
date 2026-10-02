import type { Models, Runtime } from '@quarterdeck/rules';

export type AgentRole = keyof Models;

export type AgentStatus =
  | 'starting'
  | 'idle'
  | 'working'
  | 'paused'
  | 'stuck'
  | 'ended'
  | 'killed'
  | 'retired';

export interface Agent {
  id: string;
  projectId: string;
  roundId: string | null;
  name: string;
  role: AgentRole;
  runtime: Runtime;
  status: AgentStatus;
  sessionId: string | null;
  worktreePath: string | null;
}

export const AGENT_COLUMNS = `id, project_id as "projectId", round_id as "roundId",
  name, role, runtime, status, session_id as "sessionId",
  worktree_path as "worktreePath"`;

export class AgentNotFoundError extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(`No agent ${agentId} in this project`);
    this.name = 'AgentNotFoundError';
    this.agentId = agentId;
  }
}
