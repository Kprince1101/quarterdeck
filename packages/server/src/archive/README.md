# archive

Archiving a project (`project.archive { archived: true }`, which sets `projects.archived_at`) retires every agent it has and stops anything new from starting. Unarchiving (`archived: false`) lifts that in the running server; nothing needs a restart.

```ts
import { startArchiveControl } from '@quarterdeck/server';

const archive = await startArchiveControl({ store, lifecycle });
await archive.close();
```

## What archiving does

- **Agents are retired.** `startArchiveControl` wakes on every `project.archive` event, and once at start, and while the project is archived it retires each agent that is not `retired`, oldest first, through `lifecycle.retire`, the same path every retire takes ([agents](../agents/README.md#retiring)). The session is closed, the worktree removed and the agent marked `retired`, so its name is free for a birth in any project and stays free after unarchive. Paused, ended and killed agents are retired too. `archive.retired { retired, discardCards }` records each pass that did something.
- **Unsaved work is never thrown away silently.** A worktree with unsaved work raises the usual `worktree.discard` card instead, and the agent waits. The control also wakes on `card.answer` and `card.decline`: a `yes` finishes the retire with a forced removal; any other answer, or a decline, leaves the agent and its worktree as they are, and no new card is raised for it while the project stays archived. Only cards raised since `archived_at` count, so archiving again asks again.
- **No launches, no turns.** Every launch, continue, Driver turn and Planner turn passes the project's [pause](../pause/README.md) gate, and the gate refuses all of them while the project is archived (`PauseDroppedError`, `reason: 'archived'`). Work a pause was holding when the project was archived is dropped, not replayed later.
- **The Planner lets go.** The [Planner](../planner/README.md) ends its conversation on archive and refuses messages until unarchive.

Unarchive clears `archived_at`. The gate lets work through again at once, the Planner births a new agent on the next message, and the control leaves agents born after that alone. Agents retired by the archive stay retired; a new round births new ones.

Rounds are left as they were. Their agents are retired, so end or kill an open round after unarchive to put its tickets back to `open`.

## API

| Export                                                 | What it does                                                                                                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startArchiveControl({ store, lifecycle, onError? })`  | Starts the control for one project. `drain()` runs a pass and resolves when it is done; `close()` stops listening and waits for the pass.                                                                   |
| `retireArchivedAgents({ store, lifecycle, onError? })` | One pass, as above. Returns `{ retired, discardCards }`; does nothing for a project that is not archived. A retire that fails for another reason goes to `onError` and the pass moves on to the next agent. |
| `ARCHIVE_RETIRED_EVENT`                                | `archive.retired`.                                                                                                                                                                                          |
