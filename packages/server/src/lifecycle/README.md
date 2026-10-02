# lifecycle

Applies the dashboard's `agent.kill`, `agent.retire` and `agent.reset` intents, and recovers a project from the last run when the server opens it. Quarterdeck owns every process it starts; the human is never asked to kill one.

## Intents

```ts
import {
  createAgentLifecycle,
  startLifecycleIntents,
} from '@quarterdeck/server';

const intents = await startLifecycleIntents({
  store,
  lifecycle: createAgentLifecycle({ naming, sessions, worktrees, openStores }),
});
await intents.close();
```

`startLifecycleIntents({ store, lifecycle, onError? })` applies every pending intent of the three kinds, oldest first, when it starts and again on each new one. Each is applied through the [agent lifecycle](../agents/README.md) with the intent's id, and the ack is an event that carries `intentId`:

| Intent         | Runs                                                                      | Ack                                                    | `intents.result` |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------- |
| `agent.kill`   | [`kill`](../agents/README.md#killing-and-resetting), blocking its tickets | `agent.killed { name, sessionId, sweep, closeError? }` | `{ status }`     |
| `agent.reset`  | [`reset`](../agents/README.md#killing-and-resetting)                      | `agent.session_reset { … }`                            | `{ status }`     |
| `agent.retire` | [`retire`](../agents/README.md#retiring), freeing the name                | `agent.retired { name }`                               | `{ status }`     |

A kill whose session would not close is still applied: the agent is `killed`, its group swept, and `agent.killed` names the error as `closeError`. An intent that cannot be applied (the agent ended since it was queued, a reset whose session would not close) is `rejected` with `{ error }` and acked with `agent.intent_failed { intentId, intent, error }`.

A retire whose worktree holds unsaved work waits for the human. A `worktree.discard` card is raised (`requestWorktreeDiscard`), its id is kept in the intent's `result` as `{ discardCardId }`, the intent stays `pending` and `agent.retire_held { intentId, discardCardId, path }` is recorded. On every `card.answer`, `card.decline` and `card.expired` the waiting retires are checked: a `yes` finishes the retire, forcing the removal; any other answer, a decline or an expiry rejects the intent with `DISCARD_REFUSED` and `discardCardId`, and the agent keeps its worktree.

`close()` stops listening and waits for the intent being applied.

## Recovery

`recoverProject(store, { killGraceMs? })` cleans up after a run that ended without shutting down, in this order:

1. **Reap.** Every agent with a recorded `pid` gets `sweepAgentProcess(…, 'restart')`: the group is SIGTERMed, then SIGKILLed after the grace period, if it is still the group that was recorded (see [ACP client](../acp/client/README.md#lifecycle-guarantees)), and `pid` is cleared. Each signalled group is logged as `agent.process_swept`. A group that cannot be checked (Windows, or `ps` failing) is logged with `outcome: 'unverified'` and keeps its `pid`, so the next restart tries again.
2. **Expire overdue cards.** Every `open` card whose `expires_at` has passed becomes `expired`, with `card.expired { cardId, reason: 'restart' }`, as the waiting `ask` would have done had the process lived. Cards without `expires_at` stay open.
3. **Drop orphaned pauses.** Every `pause.held` with no `pause.replayed` or `pause.dropped` naming it as `heldEventId` gets `pause.dropped { operation, label, heldEventId, reason: 'restart' }`, with the held event's agent and ticket. Held work lives in the process, so it did not survive. A project with no pause events has nothing to drop.

It resolves to `{ reaped: [{ agentId, name, outcome }], expiredCards, droppedPauses }`, the card ids and held event ids it settled. Running it again finds nothing, apart from pids left `unverified`.

The server runs it each time it opens a project store (`ProjectStores.get` and `create`), which the project lock makes the only process with that project open. A failure goes to `onError` and the store is still served. `startApiServer({ openProjects: true })`, which `quarterdeck up` uses, opens every project at startup so this happens before any request; a project that will not open (another process holds it) is reported and skipped.

## Shutdown

`ApiServer.close()` closes every ACP client first (`closeAllAcpClients`), so each agent's group gets SIGTERM, then SIGKILL after its grace period, before the stores close. `quarterdeck up` calls it on SIGINT and SIGTERM.

## API

| Export                                                                 | What it does                                |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| `startLifecycleIntents(options)`                                       | See [Intents](#intents).                    |
| `LIFECYCLE_EVENTS`, `DISCARD_REFUSED`                                  | `agent.retire_held`, `agent.intent_failed`. |
| `AGENT_KILL`, `AGENT_RETIRE`, `AGENT_RESET`, `LIFECYCLE_INTENT_KINDS`  | The intent kinds it applies.                |
| `recoverProject(store, options)`                                       | See [Recovery](#recovery).                  |
| `reapAgentProcesses`, `expireOverdueCards` (bus), `dropOrphanedPauses` | The three recovery steps on their own.      |
| `RESTART_REASON`, `PAUSE_HELD_EVENT`, `PAUSE_DROPPED_EVENT`            | `restart`, `pause.held`, `pause.dropped`.   |
