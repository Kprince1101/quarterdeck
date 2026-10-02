export {
  AGENT_COLUMNS,
  AgentNotFoundError,
  type Agent,
  type AgentRole,
  type AgentStatus,
} from './agent.js';
export type { BirthRequest } from './birth.js';
export {
  DISCARD_APPROVED,
  DISCARD_WORKTREE_CARD,
  DiscardNotApprovedError,
  requestWorktreeDiscard,
} from './discard.js';
export {
  createAgentLifecycle,
  type AgentLifecycle,
  type AgentLifecycleOptions,
} from './lifecycle.js';
export {
  NamesExhaustedError,
  liveAgentNames,
  pickAgentName,
  withNameLock,
} from './names.js';
export { findAgent } from './rows.js';
export type { RetireOptions } from './retire.js';
export type { SessionHost } from './sessions.js';
export {
  WORKPLACE_EVENTS,
  attachWorktree,
  detachWorktree,
  replaceSession,
} from './workplace.js';
export {
  WorktreeDirtyError,
  gitWorktrees,
  type AddWorktreeOptions,
  type RemoveWorktreeOptions,
  type WorktreeHost,
} from './worktrees.js';
