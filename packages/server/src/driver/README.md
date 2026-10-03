# driver

The Driver's turn loop: one ACP session per voyage, a structured turn result parsed from every reply, and every turn saved as files.

## A voyage

```ts
import { loadRule } from '@quarterdeck/rules';
import { openDriverVoyage, projectTurnsDir } from '@quarterdeck/server';

const voyage = await openDriverVoyage({
  store,
  client, // the Driver's AcpClient, from its runtime adapter
  bus, // the project's BusHost
  agentId: driver.id,
  voyageId,
  cwd: repoPath,
  charter: await loadRule('charter', { repoDir: repoPath }),
  turnsDir: projectTurnsDir('example'),
  budget: (await loadRule('lifecycle', { repoDir: repoPath })).budget.window,
  pause, // the project's PauseGate
});
const birth = await voyage.birth;
const next = await voyage.turn('heron reported QD12: <report>');
```

`openDriverVoyage` checks the voyage (`VoyageNotFoundError` for one outside the project, `VoyageEndedError` once it has ended) and the agent (`NotADriverError` unless it is a `driver` that is not `ended`, `killed` or `retired`). It then:

1. Checks the budget (`assertLaunchBudget` with the Driver's id; see [budget](../budget/README.md)). A held launch throws `BudgetHeldError` before the bus or a session starts.
2. Launches the bus for the Driver (`bus.launch(agentId)`) and opens one ACP session with `client.newSession({ cwd, mcpServers: [bus] })`. Every turn of the voyage goes to that session; nothing else opens one. If the runtime needs sign-in, a sign-in card waits for the person and the session opens after, with a fresh bus launch (see [../signin/README.md](../signin/README.md)).
3. Reads the active notebook: every `notebook` row of the project, or with no project (an entry for every project), that is not retired (`retired_at` null), pinned entries first, then oldest first.
4. Stores the session on the agent (`session_id`, `voyage_id`; a `starting` agent becomes `idle`) and records `driver.voyage_started` with `{ voyageId, voyage, sessionId, notebook }`, where `notebook` lists the entry ids the Driver was born with.
5. Queues the birth turn and returns. `voyage.birth` settles with its outcome; await it.

The birth input (`buildBirthInput`) is the Driver's name and voyage number, the charter, the voyage's goal, the notebook entries and the turn result format. The next voyage gets a new session and a new birth input, carrying the notebook as it is then.

### Every project

The [coordinator](../crew/README.md#voyages) opens one voyage across every project, so it passes two more options:

- `seats`: the Driver's seat in each project, `{ project, store, bus, agentId, voyageId }`, the lead (`store`, `agentId`, `voyageId`) among them. The session gets one MCP server per seat instead of one bus: that project's bus launched for its seat and named `bus-<project>` (`projectBusName`). Every seat is attached to the session and records `driver.voyage_started` with its own `voyageId`. The notebook is every seat's active notebook, each entry tagged with its project, or `every project` for an entry with no project (`readNotebooks`). Stuck flags come from every project, each line starting with `[<project>]`, and are marked surfaced in their own project.
- `projects`: a `ProjectBrief` per project, `{ project, repoPath, bus, terms, waiting, builders }`, which the birth input lists under `# Projects`: the repository, the bus, the forge in its own terms (`Forge: GitLab (merge requests, MR).`), the approved tickets waiting for a builder and the live builders with their tickets. The first line then reads `You are <name>, the Driver of every project for voyage <n>.`

Turns run on the lead seat, in the lead's store and under its turns folder.

`voyage.turn(input)` queues one more turn in the voyage's session. Turns run one at a time, in the order they were asked for, the birth turn first. A turn that rejects does not stop the ones queued after it. `voyage.turnAs(input, format)` queues a turn in the same line that expects another `TurnFormat`; the [wrap-up](../voyage-end/README.md#wrap-up) uses it.

Both steps go through the [pause](../pause/README.md) guard (`pause`). The launch (steps 1 to 4) is held as `launch` while the Driver, the project or everything is paused, and opens on unpause after checking the voyage and the Driver again. Each turn, the birth turn included, is held as `driver.turn` when it reaches the front of the queue; the turns behind it wait in order.

## Turn results

Every reply ends with a turn result: one JSON object in a fenced `json` block (`DRIVER_TURN_INSTRUCTIONS`).

```json
{ "summary": "Assigned QD12 to a new builder.", "actions": [] }
```

| Field     | Meaning                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `summary` | One or two sentences on what the Driver did this turn and why. Not empty.                                                       |
| `actions` | What Quarterdeck should do next, in order. Each is an object with a non-empty `kind`; its other fields are kept as they arrive. |

`actions` is open on purpose: the tickets that carry out actions narrow `driverActionSchema` to the kinds they handle.

`parseTurnResult(text, schema)` tries, in order, the last fenced block, then the one before, the whole reply, and the span from its first `{` to its last `}`. The first candidate that is valid JSON is checked against the schema; a mismatch is reported with the fields it names.

A turn's outcome (`TurnOutcome`) is one of:

| `status`  | When                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `result`  | A reply parsed. `result` is the parsed value.                                                                               |
| `missed`  | The reply did not parse, the one re-prompt (`MAX_REPROMPTS`) did not either. `error` says what was wrong with the last one. |
| `stopped` | A prompt ended `cancelled` or `refusal`. It is not re-prompted.                                                             |

On a miss the loop sends one re-prompt in the same session (`repromptText`): the error and the format instructions again. `turns` lists every prompt the turn took, so a re-prompted turn has two. A prompt that throws (the agent died, the connection closed) closes its row, records `turn.failed` and rejects the turn.

A prompt the runtime refuses for sign-in raises a sign-in card and waits, its turn still open and the agent still `working`. Once the person answers, the same input goes to the same session again in the same `turns` row. A declined or expired card rejects the turn with `SignInRequiredError` and records `turn.failed` (see [../signin/README.md](../signin/README.md)).

## Turn files

Each ACP prompt, birth and re-prompt included, is one `turns` row (`seq` counts per agent from 1, `prompt` is the input, `stop_reason` and token counts come from the prompt response) and one folder, `turnDir(turnsDir, agentId, seq)`: `~/.quarterdeck/<project>/turns/<agent-id>/<seq>/` with `seq` zero-padded to 4 digits. `transcript_path` names the folder.

| File            | Holds                                                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.md`      | The prompt as sent. Written before the prompt goes out.                                                                                                                                                                                                   |
| `output.md`     | The agent's reply: its `agent_message_chunk` text, joined.                                                                                                                                                                                                |
| `updates.jsonl` | Every `session/update` of the prompt, one JSON object per line. Each run of consecutive `agent_message_chunk` (or `agent_thought_chunk`) text updates is stored as one update with the joined text, so a secret streamed across chunks is still redacted. |
| `result.json`   | The parsed turn result, only for the prompt whose reply parsed.                                                                                                                                                                                           |

A prompt that throws still gets `output.md` and `updates.jsonl` with what arrived before it failed, and its row gets `ended_at` with a null `stop_reason`.

Secrets are redacted before anything of a turn is stored: the files, the row's `prompt` and the `turn.*` event payloads (and the Planner's `planner.*` reply events). `redactSecrets` replaces with `[redacted]` GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), Anthropic and OpenAI keys (`sk-ant-`, `sk-`), AWS access key ids (`AKIA`, `ASIA`), the token after `Bearer`, the password in `scheme://user:pass@` URLs, PEM private key blocks, and the literal value of every server env var whose name contains `TOKEN`, `SECRET`, `KEY`, `PASSWORD` or `DATABASE_URL` (values of 8 characters or more; a path in an env var such as `SSH_KEY_PATH` is redacted too). The agent itself still gets the unredacted prompt; only the stored copy changes, so a replay sends the redacted input. Turn folders are `0700` and their files `0600`.

While a prompt runs the agent is `working`; afterwards it is `idle` again. Only an `idle` or `working` agent is moved, so a pause or kill set meanwhile stands. A pause does not cancel a running prompt; it holds the next one.

## Replay

```ts
import {
  KIRO_ADAPTER,
  projectTurnsDir,
  replayDriverChain,
} from '@quarterdeck/server';

const through = 7;
const replay = await replayDriverChain({
  runtime: 'kiro',
  connect: ({ cwd, onPermissionRequest }) =>
    KIRO_ADAPTER.connect(
      { cwd, project: 'example', agentName: `replay-${through}` },
      { clientName: 'quarterdeck', clientVersion, onPermissionRequest },
    ),
  turnsDir: projectTurnsDir('example'),
  agentId: driver.id,
  through,
  onTurn: (turn) => console.log(turn.seq, turn.result),
});
```

Kiro, the default runtime, needs a `project` and an `agentName`. Give it a throwaway name such as `replay-<seq>` so it doesn't collide with a live agent's. While the replay runs, Kiro's adapter writes that agent's config to `~/.kiro/agents/quarterdeck-<project>-replay-<seq>.json` and starts the process in `~/.quarterdeck/kiro/`. It removes the config when replay closes the client. That file is the runtime's launch config, not Quarterdeck state; with no MCP servers passed, it names none.

`replayDriverChain` sends a Driver's saved prompts again, in order, in one new ACP session: each turn's `input.md`, re-prompts included, exactly as it was sent.

The replay mirrors one voyage's session: the one turn `n` was part of. Each `driver.voyage_started` opens a new session whose first prompt is the birth input (`isBirthInput`), so the chain runs from the latest birth at or before `n` through `n`, never across a voyage boundary. `readTurnChain` reads the inputs from `n` back to that birth before anything connects. A missing `input.md` rejects with `TurnInputMissingError` (its `seq` and `path`), and a chain with no birth input at or before `n` (not a Driver's) with `NoBirthTurnError`.

### Replay writes nothing

No `turns` row, event, card, agent change or turn file. Replay owns everything the agent could write through:

- **Its client.** `connect` is called once with the `cwd` and the permission handler to build the client with, and replay closes the client when it is done, failed or not. Pass the handler through unchanged; a `connect` that swaps it breaks this guarantee.
- **Its permissions.** The handler is `REPLAY_PERMISSIONS`: every request gets a reject option (`reject_once`, else `reject_always`), or `cancelled` when none is offered. It never allows and never raises a card, so a replayed turn can't run a shell command, edit a file or page the human.
- **Its directory.** Without `cwd` the agent is launched and the session opened in a fresh temporary directory, removed afterwards, so read-only tools can't see the live repo or work done since the original turn. A caller that passes `cwd` gets that directory, which replay leaves in place.
- **Its servers.** The session gets no MCP servers, so the bus tools (`ask`, `report`, `status`, `verdict`, `read`) are not there.
- **Its sign-in.** If opening the session or a prompt fails with auth required, replay raises no sign-in card. It rejects with `ReplaySignInError`, whose message and `command` give the sign-in command for `runtime` (`signInCommand(runtime, client.agent.authMethods)`). Sign in, then replay again.

The Driver therefore replies without its tools; a turn that leaned on them can read differently from the original.

Each `ReplayTurn` holds the `seq`, the `input` sent, the `savedOutput` from `output.md` (null if there is none), the replayed `output`, its `stopReason` and `result`, the reply parsed as a Driver turn result (`ParsedTurnResult`). Every prompt is sent whatever the one before it returned; a prompt that throws rejects the replay.

### The dashboard's command

`replayCommand({ voyage, through?, project? })` is the command the Driver widget shows to replay a voyage up to its `through`th Driver turn (1 is the birth), or the whole voyage without `through`. It runs [`quarterdeck replay`](../../../cli/README.md#replay):

```sh
npx quarterdeck replay 3 7
npx quarterdeck replay 3 7 --project example
```

Voyages are numbered across every project, and a voyage's Driver turns are saved under its lead project only, so the CLI finds a voyage without `project`. Voyages from before then were numbered from 1 in each project; for one of those two projects share, pass `project`. `through` counts Driver turns within the voyage, not `seq`: the turn with `seq` s in a session born at `seq` b is turn s - b + 1.

It refuses a voyage or `n` that is not a positive integer and a project that is not a slug, so the line is always safe to paste. It lives in `replay-command.ts`, which imports nothing from Node, and the dashboard imports it as `@quarterdeck/server/replay-command`. `readTurnChain` checks `agentId` is a uuid, since it names a folder under `turnsDir`.

### Finding a voyage's Driver

`findVoyageSessions(turnsDir, voyage)` finds a voyage's Driver sessions from the turn files alone, so it works while `quarterdeck up` has the store open. It reads each agent folder's first input; a Driver's is a birth input (`readBirth` gives the Driver's name and voyage from its first line; a birth input saved before voyages were renamed, which says `for round <n>`, reads the same way, and so does a voyage across every project's, which says `the Driver of every project`, so older turn files still replay). Each birth starts a session that runs through the turns after it, up to the next birth. It resolves to the sessions of `voyage`, oldest birth first (by `input.md`'s modification time), each with `agentId`, `driverName`, `firstSeq`, `lastSeq` and `bornAt`. A voyage has more than one when its Driver session was opened again or another Driver took the voyage over.

`findTurnSession(turnsDir, agentId, seq, voyageAgents)` places one turn: the session of `agentId` that holds `seq`, its `n` (`seq - firstSeq + 1`) and whether it is the voyage's latest session, the one the CLI replays. It returns `null` for a turn outside a Driver session. For `latest` it reads only the sessions of `agentId` and of the agents `voyageAgents(voyage)` names, not every agent folder; `turn.read` passes the agents with a `driver.voyage_started` event for that voyage.

## Events

| `kind`                  | Payload                                     |
| ----------------------- | ------------------------------------------- |
| `driver.voyage_started` | `{ voyageId, voyage, sessionId, notebook }` |
| `turn.result`           | `{ seq, result }`                           |
| `turn.missed`           | `{ seq, error, reprompt }`                  |
| `turn.stopped`          | `{ seq, stopReason }`                       |
| `turn.failed`           | `{ seq, error }`                            |

`seq` is the `turns.seq` of the prompt the event is about; every event carries the agent's id.

## Builders

The Driver hands tickets to builders and keeps them going with three entry points. All take a `BuilderContext`:

```ts
import {
  assignTicket,
  continueBuilder,
  createAgentLifecycle,
  gitWorktrees,
  projectTurnsDir,
  projectWorktreesDir,
  reassignTickets,
  type BuilderContext,
} from '@quarterdeck/server';

const ctx: BuilderContext = {
  store,
  lifecycle: createAgentLifecycle({
    naming,
    sessions,
    worktrees: gitWorktrees,
    openStores,
    budget: () => Promise.resolve(budget),
  }),
  sessions, // a BuilderSessionHost: the lifecycle's SessionHost plus client(sessionId)
  worktrees: gitWorktrees,
  runtime: 'kiro',
  repoPath,
  base: 'origin/main',
  worktreesDir: projectWorktreesDir('example'),
  turnsDir: projectTurnsDir('example'),
  budget, // (await loadRule('lifecycle', { repoDir: repoPath })).budget.window
  pause, // the project's PauseGate
};
const assignment = await assignTicket(ctx, { ticketId });
await continueBuilder(ctx, { builderId, prompt: 'CI failed on lint; fix it.' });
await reassignTickets(ctx, retiredBuilderId);
```

`pause` is the project's [pause](../pause/README.md) guard. An assignment or re-assignment is held as `launch` (with the builder, when one is named, and the ticket), and a continue as `continue` (with the builder), while any of them is paused; the call resolves once it has been replayed and run. An assignment re-reads the ticket when it runs, so one cancelled or taken while held throws `TicketNotAssignableError` then. A re-assignment re-reads the retired builder's tickets when it runs and skips, without birthing a builder, a ticket that was reopened, cancelled or handed on while held; the rest still go.

`sessions` must be the `SessionHost` the lifecycle was made with. Its `open(agent)` opens the session with `agent.worktreePath` as the `cwd` (and the bus as an MCP server, as for the Driver); `client(sessionId)` returns the ACP client a live session prompts through, or `undefined` once it is gone.

### Assigning

`assignTicket(ctx, { ticketId, builderId? })` takes an approved ticket: status `open`, no assignee, and every ticket in `depends_on` `done`. Anything else throws `TicketNotAssignableError` before a builder is touched.

Every assign and continue is a launch, so it checks `ctx.budget` first (see [budget](../budget/README.md)). A held launch throws `BudgetHeldError` and touches no builder, worktree, session or ticket. A new builder is checked by the lifecycle's birth with the ticket's id. A moved builder is checked with its id and the ticket's, and a continue with the builder's id.

Every builder works a ticket in its own worktree, `builderWorktreePath(worktreesDir, name, ticketId)`: `<worktreesDir>/<name>-<first 8 of the ticket id>`, detached at `base`. The builder branches there itself.

- Without `builderId`, a new builder is born (`role: 'builder'`, `runtime`, `voyageId` if set). Its worktree is added before its session opens, so the session starts in it. If the worktree or the session fails, the builder is retired (`agent.birth_failed`) and a worktree already added is removed.
- With `builderId`, the builder must be an `idle` builder holding no ticket (`BuilderNotAvailableError` otherwise). It is marked `working`, its old worktree is removed, the new one added, and its session closed and reopened in the new worktree. Each step is saved as it completes. A dirty old worktree throws `WorktreeDirtyError` (raise the discard card as for a retire); the builder goes back to `idle` with its work in place.

The ticket then becomes `assigned` to the builder, the builder `working`, and `ticket.assigned` is recorded with `{ name, worktreePath, born, previousAssigneeId }`, all in one transaction that fails with `TicketNotAssignableError` if the ticket changed meanwhile. Finally the assignment prompt (`buildAssignmentPrompt`: the ticket, to work its `## Tasks` list in order and prove its `Proven:` line, where to work, and to `report` when the pull request is open) goes to the builder's session as one turn filed under the ticket.

`assignTicket` resolves once the prompt is sent. `assignment.turn` settles with the `TurnRecord` when the builder's reply ends, which can take as long as the ticket does; the builder is `idle` again after it.

### Continuing

`continueBuilder(ctx, { builderId, prompt })` sends an `idle` builder with a session one more prompt in that session, filed under the ticket it holds if any, and records `builder.continued` with `{ name, prompt, head }`, where `head` is the commit its worktree is at (`worktreeHead`; `null` without a worktree). A builder that is not idle (a `paused` one is held instead, until it resumes), not a builder or has no session throws `BuilderNotAvailableError`; a session the host no longer knows throws `BuilderSessionLostError` and leaves the builder `idle`. `continuation.turn` settles like `assignment.turn`.

### Stuck

A builder is stuck when `STUCK_AFTER_CONTINUES` (3) continue turns in a row on the same ticket ran without moving its worktree's head: its last four continues, the one being sent included, all found the same head, so the three before it each ran in full and made no commit. `continueBuilder` checks after recording each continue (`flagIfStuck`) and records `builder.stuck` with `{ name, head, continues }`, once per builder, ticket and head. A new commit starts the count again; a later stall at the new head is flagged again. The flag changes nothing about the builder: it stays `idle` and can still be continued.

The Driver sees each flag once. Every `voyage.turn`, the birth included (not `voyage.turnAs`, so the wrap-up leaves them for the next voyage), appends a `# Stuck builders` section to its input listing the `builder.stuck` events it has not seen yet (`unsurfacedStuckFlags`), each with the builder's name and id, the ticket and the head. Once the turn has run, `driver.stuck_surfaced` records `{ flags }`, the event ids it carried; the next lookup leaves out every id an earlier `driver.stuck_surfaced` lists, so a flag whose event commits out of id order is never skipped. A turn that throws or ends `stopped` records nothing, so its flags go out again with the next one. The record is per project, so flags raised between voyages reach the next Driver's birth.

### Re-assigning on retire

`reassignTickets(ctx, agentId)` hands every ticket a retired builder still holds (`assigned`, `in_progress`, `in_review`, `bounced`, and `blocked`, which a kill leaves behind) to a new builder, one at a time, in a new worktree. `in_review` and `bounced` keep their status; the others become `assigned`. The prompt names an open pull request if the ticket has one, so the new builder carries it on. An agent that is not `retired` throws `AgentNotRetiredError`; retire it first, which removes its worktree or raises the discard card.

### Actions

The Driver asks for these through its turn result. `DRIVER_TURN_INSTRUCTIONS` includes `BUILDER_ACTION_INSTRUCTIONS`:

| `kind`     | Fields                         | Runs                                  |
| ---------- | ------------------------------ | ------------------------------------- |
| `assign`   | `ticket`, `builder` (optional) | `assignTicket`                        |
| `continue` | `builder`, `prompt`            | `continueBuilder` (prompt is trimmed) |

`builderActionSchema` parses one of them; `applyBuilderAction(ctx, action)` runs it and resolves to `{ kind: 'assign', assignment }` or `{ kind: 'continue', continuation }`.

### Builder events

| `kind`              | Payload                                            |
| ------------------- | -------------------------------------------------- |
| `ticket.assigned`   | `{ name, worktreePath, born, previousAssigneeId }` |
| `builder.continued` | `{ name, prompt, head }`                           |
| `builder.stuck`     | `{ name, head, continues }`                        |

All carry the builder's id and, when there is one, the ticket's. `driver.stuck_surfaced` (`{ flags }`) carries the Driver's id.

## Other agents

`runTurn(target, input, format)` and `runPrompt(target, input)` are not tied to the Driver. Any agent with an open session can use them with its own `TurnFormat` (a zod schema plus the instructions that describe it), and `ticketId` on the target files the turn and its events under a ticket.
