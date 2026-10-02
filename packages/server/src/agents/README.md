# agents

Birth, kill, reset and retirement of Quarterdeck agents, the names they carry and the processes they run in.

## Names

Names come from the naming theme, `rules/naming.json` (overridable through `rules.local.naming.json`), loaded with `loadRule('naming')` from `@quarterdeck/rules`. A name is held by every agent that is not `retired`, including `ended` and `killed` ones, in a project whose `archived_at` is null. Retiring an agent or archiving its project frees the name for the next birth.

Uniqueness spans the stores `openStores()` returns, so the server opens every non-archived project at startup and keeps it open; a project left closed could hold a live name that a birth elsewhere reuses. Births are claimed one at a time in the process (`withNameLock`), so two births in parallel never pick the same name, and the `agents_live_name` partial unique index rejects a duplicate live name within one project even if something bypasses the lifecycle. When every name in the theme is taken, birth throws `NamesExhaustedError`; add names to the theme to raise the limit.

## Retiring

Retire runs three steps and persists each as it completes, so a retire that fails part way is resumed by calling it again:

1. Close the session. `session_id` is cleared, `ended_at` set, and the status becomes `ended` (a `killed` agent stays `killed`); `agent.session_closed` is recorded. Then the agent's process group is swept (see [Processes](#processes)).
2. Remove the worktree. `worktree_path` is cleared; `agent.worktree_removed` is recorded with `discarded` saying whether unsaved work was thrown away.
3. Mark the agent `retired`, freeing its name; `agent.retired` is recorded with `{ name }`, plus `intentId` when the retire came from an intent.

Unsaved work is never discarded silently. If the worktree has modified or untracked files, or a detached HEAD with commits on no branch, removal throws `WorktreeDirtyError` carrying the `path` and a `summary` (the `git status --porcelain` lines plus one `commit not on any branch` line per such commit), and the agent stays unretired with its worktree on disk. The Driver raises a card with `requestWorktreeDiscard(store, agent, err)`. Only after that card is answered `yes` does `retire(store, agentId, { discardCardId })` force the removal; any other card, answer or agent throws `DiscardNotApprovedError`.

## Killing and resetting

`kill(store, agentId, { intentId? })` stops an agent that is doing damage. It marks the agent `killed` (with `ended_at`) first, so a turn that ends because its session died does not move it back to `idle`; then it closes the session through `SessionHost.close`, which SIGTERMs the session's process group, sweeps the group (see [Processes](#processes)) and records `agent.killed` with `{ name, sessionId, sweep, intentId? }`. `session_id` is kept, so the session can still be resumed; the worktree and the name stay until a retire. An agent that is already `ended`, `killed` or `retired` throws `AgentFinishedError` and nothing is touched. If closing the session throws, the group is still swept and the agent stays `killed`, then the error is thrown and no `agent.killed` is recorded.

`reset(store, agentId, { intentId? })` drops an agent's session so its next launch opens a fresh one. It closes the session, sweeps the group, clears `session_id` and records `agent.session_reset` with `{ name, sessionId, sweep, intentId? }`, where `sessionId` is the session it dropped. An agent that was `starting`, `working` or `stuck` becomes `idle`; any other status stands. A `retired` agent throws `AgentFinishedError`.

## Processes

Every agent runs in its own process group (see [ACP client](../acp/client/README.md#lifecycle-guarantees)). A session host that spawns one passes `onEvent: trackAgentProcess(store, agent.id)` to the client; it stores the group's `pid` and `pid_started_at` on the agent when the client reports `spawned`, and clears them once the client reports `exit` and nothing is left in the group. The Planner's session host does.

`sweepAgentProcess(store, agent, reason, graceMs?)` stops whatever is left of the recorded group with `stopOwnTree` (SIGTERM, then SIGKILL after `graceMs`, default `DEFAULT_KILL_GRACE_MS`) and clears `pid`. When it had to signal something, or could not check, it records `agent.process_swept` with `{ name, pid, reason, outcome }`: `reason` is `kill`, `reset`, `retire` or `restart`; `outcome` is `terminated`, `killed` or `unverified`. It resolves to the outcome, `none` when no pid was recorded or `gone` when the group had already exited. Kill, reset and retire run it after closing the session; [recovery](../lifecycle/README.md#recovery) runs it for every agent with a pid when the server opens a project.

## API

```ts
import { loadRule } from '@quarterdeck/rules';
import {
  WorktreeDirtyError,
  createAgentLifecycle,
  gitWorktrees,
  requestWorktreeDiscard,
} from './agents/index.js';

const agents = createAgentLifecycle({
  naming: await loadRule('naming'),
  sessions,
  worktrees: gitWorktrees,
  openStores: () => [...stores.values()],
});
const agent = await agents.birth({ store, role: 'builder', runtime: 'kiro' });
const cardId = await agents
  .retire(store, agent.id)
  .then(() => undefined)
  .catch((err: unknown) => {
    if (!(err instanceof WorktreeDirtyError)) throw err;
    return requestWorktreeDiscard(store, agent, err);
  });
```

When the card comes back `yes`, `agents.retire(store, agent.id, { discardCardId: cardId })` finishes the retire.

| Export                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAgentLifecycle(options)`                             | Returns `{ birth, retire, kill, reset }`. `openStores` lists every open project store, for cross-project name uniqueness. `random` picks among free names (default `Math.random`). `killGraceMs` is how long a swept group gets between SIGTERM and SIGKILL (default 5s).                                                                                                                                                                                                                                              |
| `birth({ store, role, runtime, prepare? })`                 | Claims a free name, writes the `agents` row (`starting`) with an `agent.born` event, runs `prepare(agent)` if given (it returns the agent as the session should see it, a builder with its worktree for example), opens the session through `SessionHost.open` and stores its id, leaving the agent `idle`. If `prepare` or the session fails, the agent is `retired` with `agent.birth_failed`, freeing its name, and the error is rethrown; if that retire fails too, both errors are thrown as an `AggregateError`. |
| `retire(store, agentId, { discardCardId?, intentId? })`     | Runs the steps under [Retiring](#retiring). Retiring a retired agent returns it unchanged; an agent of another project throws `AgentNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                    |
| `kill(store, agentId, { intentId? })`, `reset(…)`           | See [Killing and resetting](#killing-and-resetting). `killAgent` / `resetAgent` take the session host directly. `AGENT_KILLED_EVENT`, `AGENT_RESET_EVENT`.                                                                                                                                                                                                                                                                                                                                                             |
| `trackAgentProcess(store, agentId)`, `sweepAgentProcess(…)` | See [Processes](#processes). `recordAgentProcess`, `forgetAgentProcess` and `agentProcess` read and write the `pid` columns; `PROCESS_SWEPT_EVENT` is `agent.process_swept`.                                                                                                                                                                                                                                                                                                                                           |
| `requestWorktreeDiscard(store, agent, err)`                 | Raises a `worktree.discard` card (`DISCARD_WORKTREE_CARD`) asking whether to discard the work in `err.summary`, with options `yes` / `no`, and returns its id.                                                                                                                                                                                                                                                                                                                                                         |
| `SessionHost`                                               | `{ open(agent) → sessionId, close(sessionId) }`. The seam the ACP client plugs into; agents never call ACP directly. `close` of a session the host does not know must resolve, not throw.                                                                                                                                                                                                                                                                                                                              |
| `WorktreeHost` / `gitWorktrees`                             | `{ add({ repoPath, path, base }), remove(path, { force? }) }`. `add` creates `path`'s parent folder and runs `git worktree add --detach path base` in `repoPath`; it fails if `path` exists. `remove` runs `git worktree remove` against the worktree's own repository, throwing `WorktreeDirtyError` instead of losing work unless `force` is set. A path that no longer exists is a no-op, and git refuses to remove a main working tree. The lifecycle only needs `remove`.                                         |
| `attachWorktree` / `detachWorktree`                         | Set or clear an agent's `worktree_path`, recording `agent.worktree_added` or `agent.worktree_removed` (`WORKPLACE_EVENTS`). They only write the row; the caller adds or removes the worktree itself.                                                                                                                                                                                                                                                                                                                   |
| `replaceSession(store, agent, sessionId)`                   | Sets or clears an agent's `session_id` without changing its status, recording `agent.session_opened` or `agent.session_closed`. The caller opens or closes the session itself.                                                                                                                                                                                                                                                                                                                                         |
| `liveAgentNames(stores)`                                    | The names held by live agents across `stores`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pickAgentName(naming, taken)`                              | A random free name from the theme, or `NamesExhaustedError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
