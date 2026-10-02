# pause

Pause stops new work from starting, at three scopes. A pause never cancels a turn that is already running; it holds what would start next and replays it, in order, once nothing pauses it any more.

| Scope     | Set by                              | Stored as                                                         |
| --------- | ----------------------------------- | ----------------------------------------------------------------- |
| `agent`   | `agent.pause` / `agent.resume`      | `agents.status = 'paused'`                                        |
| `project` | `pause.set { project, paused }`     | `projects.paused_at` (migration `0015_project_pause`)             |
| `global`  | `pause.all { paused }` (no project) | `~/.quarterdeck/pause.json`, `{ "pausedAt": "<iso>" }`, while set |

The global pause covers every project on the machine, including ones created while it is on. Deleting `pause.json` lifts it; the next unpause event (any `pause.set`, `pause.all` or `agent.resume`) replays what it held.

## The guard

Every launch, continue, resume, Driver turn and Planner turn goes through `hold(subject, run)` first:

```ts
import { startPauseGate } from '@quarterdeck/server';

const pause = await startPauseGate({ store });
const result = await pause.hold(
  { operation: 'continue', label: 'continue: fix lint', agentId },
  () => continueTheBuilder(),
);
await pause.close();
```

`hold` checks the global pause, the project and, when the subject names an `agentId`, that agent. If none is paused it calls `run` at once and returns its promise. Otherwise it records `pause.held`, queues `run`, and returns a promise that settles with `run`'s result once it is replayed. The caller simply waits longer. The pause comes first: the [budget](../budget/README.md) check and sign-in sit inside the held work, so they run when it is replayed, against the state at that time.

One gate per project store. It subscribes to the store's events and, on every `pause.set`, `pause.all` and `agent.resume`, re-checks each held item in the order they were held and starts the ones nothing pauses any more, recording `pause.replayed` first. Items still paused, for example by their agent after the project unpauses, stay queued. Replayed work is started in order but not awaited one by one, so a long turn does not hold back the next launch. While anything is held or a replay is running, new work that nothing pauses joins the back of the queue instead of running at once, so it cannot start before work held earlier. It records no `pause.held` or `pause.replayed`, and the next sweep, which `hold` triggers itself, starts it.

Held work lives in the process. `hold(..., { signal })` drops an item when `signal` aborts; `close()` drops everything still held. Either way the caller's promise rejects with `PauseDroppedError` (`reason: 'aborted' | 'closed'`) and `pause.dropped` is recorded. After `close()`, work that is paused is dropped at once rather than held; work that is not paused still runs.

| Operation      | Who holds it                                       | `agentId`               | `ticketId` | `label`                             |
| -------------- | -------------------------------------------------- | ----------------------- | ---------- | ----------------------------------- |
| `launch`       | `assignTicket`, `reassignTickets`                  | the builder, when named | the ticket | `assign: <title>`, `reassign: …`    |
| `launch`       | `openDriverRound` (bus launch and `session/new`)   | the Driver              |            | `<name>, round <n>`                 |
| `continue`     | `continueBuilder`                                  | the builder             |            | `continue: <first line of prompt>`  |
| `driver.turn`  | every `round.turn`, the birth turn included        | the Driver              |            | `turn: <first line>`, `birth turn…` |
| `planner.turn` | each `planner.message`, the Planner's birth within | the Planner, if live    |            | `message: <first line>`             |
| `resume`       | reserved for the session-resume path               |                         |            |                                     |

Labels are cut to `MAX_LABEL_LENGTH` (80) characters with `pauseLabel(prefix, text)`.

## Events

| `kind`           | `payload`                                   |
| ---------------- | ------------------------------------------- |
| `pause.held`     | `{ operation, label, scopes }`              |
| `pause.replayed` | `{ operation, label, heldEventId }`         |
| `pause.dropped`  | `{ operation, label, heldEventId, reason }` |

`scopes` lists what paused the work, in the order `global`, `project`, `agent`. Each event carries the subject's `agentId` and `ticketId` when it has them; `heldEventId` is the id of the `pause.held` event.

## API

| Export                                        | What it does                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `startPauseGate({ store, home?, onError? })`  | Starts a gate for one project. `home` is the data folder (`~/.quarterdeck`).                  |
| `PauseGate.hold(subject, run, { signal? })`   | See [The guard](#the-guard). `PauseGuard` is just this method, what the entry points take.    |
| `PauseGate.held()`                            | The subjects still held, oldest first.                                                        |
| `PauseGate.replay()`                          | Re-checks the held work now, as an unpause event would.                                       |
| `PauseGate.close()`                           | Stops listening and drops what is held.                                                       |
| `pausedScopes(db, projectId, home, agentId?)` | The scopes pausing work for that project and agent, `[]` when none.                           |
| `setGlobalPause(home, paused)`                | Writes or removes `pause.json`. `isGloballyPaused(home)` and `globalPausePath(home)` read it. |
