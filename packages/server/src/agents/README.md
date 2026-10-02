# agents

Birth and retirement of Quarterdeck agents, and the names they carry.

## Names

Names come from the naming theme, `rules/naming.json` (overridable through `rules.local.naming.json`), loaded with `loadRule('naming')` from `@quarterdeck/rules`. A name is held by every agent that is not `retired`, including `ended` and `killed` ones, in a project whose `archived_at` is null. Retiring an agent or archiving its project frees the name for the next birth.

Uniqueness spans the stores `openStores()` returns, so the server opens every non-archived project at startup and keeps it open; a project left closed could hold a live name that a birth elsewhere reuses. Births are claimed one at a time in the process (`withNameLock`), so two births in parallel never pick the same name, and the `agents_live_name` partial unique index rejects a duplicate live name within one project even if something bypasses the lifecycle. When every name in the theme is taken, birth throws `NamesExhaustedError`; add names to the theme to raise the limit.

## Retiring

Retire runs three steps and persists each as it completes, so a retire that fails part way is resumed by calling it again:

1. Close the session. `session_id` is cleared, `ended_at` set, and the status becomes `ended` (a `killed` agent stays `killed`); `agent.session_closed` is recorded.
2. Remove the worktree. `worktree_path` is cleared; `agent.worktree_removed` is recorded with `discarded` saying whether unsaved work was thrown away.
3. Mark the agent `retired`, freeing its name; `agent.retired` is recorded.

Unsaved work is never discarded silently. If the worktree has modified or untracked files, or a detached HEAD with commits on no branch, removal throws `WorktreeDirtyError` carrying the `path` and a `summary` (the `git status --porcelain` lines plus one `commit not on any branch` line per such commit), and the agent stays unretired with its worktree on disk. The Driver raises a card with `requestWorktreeDiscard(store, agent, err)`. Only after that card is answered `yes` does `retire(store, agentId, { discardCardId })` force the removal; any other card, answer or agent throws `DiscardNotApprovedError`.

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
  budget: async () => (await loadRule('lifecycle', { repoDir })).budget.window,
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

| Export                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createAgentLifecycle(options)`              | Returns `{ birth, retire }`. `openStores` lists every open project store, for cross-project name uniqueness. `budget` resolves the budget window each birth checks (see [budget](../budget/README.md)). `random` picks among free names (default `Math.random`); `now` is the clock for the budget check (default the current time).                                                                                                                                                                                                                      |
| `birth({ store, role, runtime, ticketId? })` | First checks the budget (`assertLaunchBudget`, with `ticketId` on its event): a held launch throws `BudgetHeldError` before any name, row or session exists. Then it claims a free name, writes the `agents` row (`starting`) with an `agent.born` event, opens the session through `SessionHost.open` and stores its id, leaving the agent `idle`. If the session fails to open, the agent is `retired` with `agent.birth_failed`, freeing its name, and the error is rethrown; if that retire fails too, both errors are thrown as an `AggregateError`. |
| `retire(store, agentId, { discardCardId? })` | Runs the steps under [Retiring](#retiring). Retiring a retired agent returns it unchanged; an agent of another project throws `AgentNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `requestWorktreeDiscard(store, agent, err)`  | Raises a `worktree.discard` card (`DISCARD_WORKTREE_CARD`) asking whether to discard the work in `err.summary`, with options `yes` / `no`, and returns its id.                                                                                                                                                                                                                                                                                                                                                                                            |
| `SessionHost`                                | `{ open(agent) → sessionId, close(sessionId) }`. The seam the ACP client plugs into; agents never call ACP directly. `close` of a session the host does not know must resolve, not throw.                                                                                                                                                                                                                                                                                                                                                                 |
| `WorktreeHost` / `gitWorktrees`              | `{ remove(path, { force? }) }`. `gitWorktrees` runs `git worktree remove` against the worktree's own repository, throwing `WorktreeDirtyError` instead of losing work unless `force` is set. A path that no longer exists is a no-op, and git refuses to remove a main working tree.                                                                                                                                                                                                                                                                      |
| `liveAgentNames(stores)`                     | The names held by live agents across `stores`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `pickAgentName(naming, taken)`               | A random free name from the theme, or `NamesExhaustedError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
