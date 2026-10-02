# driver

The Driver's turn loop: one ACP session per round, a structured turn result parsed from every reply, and every turn saved as files.

## A round

```ts
import { loadRule } from '@quarterdeck/rules';
import { openDriverRound, projectTurnsDir } from '@quarterdeck/server';

const round = await openDriverRound({
  store,
  client, // the Driver's AcpClient, from its runtime adapter
  bus, // the project's BusHost
  agentId: driver.id,
  roundId,
  cwd: repoPath,
  charter: await loadRule('charter', { repoDir: repoPath }),
  turnsDir: projectTurnsDir('commander'),
  pause, // the project's PauseGate
});
const birth = await round.birth;
const next = await round.turn('heron reported QD12: <report>');
```

`openDriverRound` checks the round (`RoundNotFoundError` for one outside the project, `RoundEndedError` once it has ended) and the agent (`NotADriverError` unless it is a `driver` that is not `ended`, `killed` or `retired`). It then:

1. Launches the bus for the Driver (`bus.launch(agentId)`) and opens one ACP session with `client.newSession({ cwd, mcpServers: [bus] })`. Every turn of the round goes to that session; nothing else opens one. If the runtime needs sign-in, a sign-in card waits for the person and the session opens after, with a fresh bus launch (see [../signin/README.md](../signin/README.md)).
2. Reads the active notebook: every `notebook` row of the project, pinned entries first, then oldest first.
3. Stores the session on the agent (`session_id`, `round_id`; a `starting` agent becomes `idle`) and records `driver.round_started` with `{ roundId, round, sessionId, notebook }`, where `notebook` lists the entry ids the Driver was born with.
4. Queues the birth turn and returns. `round.birth` settles with its outcome; await it.

The birth input (`buildBirthInput`) is the Driver's name and round number, the charter, the round's goal, the notebook entries and the turn result format. The next round gets a new session and a new birth input, carrying the notebook as it is then.

`round.turn(input)` queues one more turn in the round's session. Turns run one at a time, in the order they were asked for, the birth turn first. A turn that rejects does not stop the ones queued after it.

Both steps go through the [pause](../pause/README.md) guard (`pause`). The launch (steps 1 to 4) is held as `launch` while the Driver, the project or everything is paused, and opens on unpause after checking the round and the Driver again. Each turn, the birth turn included, is held as `driver.turn` when it reaches the front of the queue; the turns behind it wait in order.

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

| File            | Holds                                                           |
| --------------- | --------------------------------------------------------------- |
| `input.md`      | The prompt as sent. Written before the prompt goes out.         |
| `output.md`     | The agent's reply: its `agent_message_chunk` text, joined.      |
| `updates.jsonl` | Every `session/update` of the prompt, one JSON object per line. |
| `result.json`   | The parsed turn result, only for the prompt whose reply parsed. |

A prompt that throws still gets `output.md` and `updates.jsonl` with what arrived before it failed, and its row gets `ended_at` with a null `stop_reason`.

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
      { cwd, project: 'commander', agentName: `replay-${through}` },
      { clientName: 'quarterdeck', clientVersion, onPermissionRequest },
    ),
  turnsDir: projectTurnsDir('commander'),
  agentId: driver.id,
  through,
  onTurn: (turn) => console.log(turn.seq, turn.result),
});
```

Kiro, the default runtime, needs a `project` and an `agentName`. Give it a throwaway name such as `replay-<seq>` so it doesn't collide with a live agent's. While the replay runs, Kiro's adapter writes that agent's config to `~/.kiro/agents/quarterdeck-<project>-replay-<seq>.json` and starts the process in `~/.quarterdeck/kiro/`. It removes the config when replay closes the client. That file is the runtime's launch config, not Quarterdeck state; with no MCP servers passed, it names none.

`replayDriverChain` sends a Driver's saved prompts again, in order, in one new ACP session: each turn's `input.md`, re-prompts included, exactly as it was sent.

The replay mirrors one round's session: the one turn `n` was part of. Each `driver.round_started` opens a new session whose first prompt is the birth input (`isBirthInput`), so the chain runs from the latest birth at or before `n` through `n`, never across a round boundary. `readTurnChain` reads the inputs from `n` back to that birth before anything connects. A missing `input.md` rejects with `TurnInputMissingError` (its `seq` and `path`), and a chain with no birth input at or before `n` (not a Driver's) with `NoBirthTurnError`.

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

`replayCommand({ project, agentId, through })` is the command the dashboard shows beside a Driver turn to replay its round up to that turn:

```sh
npx quarterdeck replay commander 7d0f3a4e-2b1c-4c5d-9e8f-0a1b2c3d4e5f 7
```

`packages/cli` has no `replay` subcommand yet (ticket QD11d). Until then, the line shows the command's agreed shape, but it doesn't run.

It refuses a project that is not a slug, an agent id that is not a uuid and an `n` that is not a positive integer, so the line is always safe to paste. `agentId` is checked the same way by `readTurnChain`, since it names a folder under `turnsDir`.

## Events

| `kind`                 | Payload                                   |
| ---------------------- | ----------------------------------------- |
| `driver.round_started` | `{ roundId, round, sessionId, notebook }` |
| `turn.result`          | `{ seq, result }`                         |
| `turn.missed`          | `{ seq, error, reprompt }`                |
| `turn.stopped`         | `{ seq, stopReason }`                     |
| `turn.failed`          | `{ seq, error }`                          |

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
  }),
  sessions, // a BuilderSessionHost: the lifecycle's SessionHost plus client(sessionId)
  worktrees: gitWorktrees,
  runtime: 'kiro',
  repoPath,
  base: 'origin/main',
  worktreesDir: projectWorktreesDir('commander'),
  turnsDir: projectTurnsDir('commander'),
  pause, // the project's PauseGate
};
const assignment = await assignTicket(ctx, { ticketId });
await continueBuilder(ctx, { builderId, prompt: 'CI failed on lint; fix it.' });
await reassignTickets(ctx, retiredBuilderId);
```

`pause` is the project's [pause](../pause/README.md) guard. An assignment or re-assignment is held as `launch` (with the builder, when one is named, and the ticket), and a continue as `continue` (with the builder), while any of them is paused; the call resolves once it has been replayed and run. An assignment re-reads the ticket when it runs, so one cancelled or taken while held throws `TicketNotAssignableError` then.

`sessions` must be the `SessionHost` the lifecycle was made with. Its `open(agent)` opens the session with `agent.worktreePath` as the `cwd` (and the bus as an MCP server, as for the Driver); `client(sessionId)` returns the ACP client a live session prompts through, or `undefined` once it is gone.

### Assigning

`assignTicket(ctx, { ticketId, builderId? })` takes an approved ticket: status `open`, no assignee, and every ticket in `depends_on` `done`. Anything else throws `TicketNotAssignableError` before a builder is touched.

Every builder works a ticket in its own worktree, `builderWorktreePath(worktreesDir, name, ticketId)`: `<worktreesDir>/<name>-<first 8 of the ticket id>`, detached at `base`. The builder branches there itself.

- Without `builderId`, a new builder is born (`role: 'builder'`, `runtime`, `roundId` if set). Its worktree is added before its session opens, so the session starts in it. If the worktree or the session fails, the builder is retired (`agent.birth_failed`) and a worktree already added is removed.
- With `builderId`, the builder must be an `idle` builder holding no ticket (`BuilderNotAvailableError` otherwise). It is marked `working`, its old worktree is removed, the new one added, and its session closed and reopened in the new worktree. Each step is saved as it completes. A dirty old worktree throws `WorktreeDirtyError` (raise the discard card as for a retire); the builder goes back to `idle` with its work in place.

The ticket then becomes `assigned` to the builder, the builder `working`, and `ticket.assigned` is recorded with `{ name, worktreePath, born, previousAssigneeId }`, all in one transaction that fails with `TicketNotAssignableError` if the ticket changed meanwhile. Finally the assignment prompt (`buildAssignmentPrompt`: the ticket, where to work, and to `report` when the pull request is open) goes to the builder's session as one turn filed under the ticket.

`assignTicket` resolves once the prompt is sent. `assignment.turn` settles with the `TurnRecord` when the builder's reply ends, which can take as long as the ticket does; the builder is `idle` again after it.

### Continuing

`continueBuilder(ctx, { builderId, prompt })` sends an `idle` builder with a session one more prompt in that session, filed under the ticket it holds if any, and records `builder.continued` with `{ name, prompt }`. A builder that is not idle (a `paused` one is held instead, until it resumes), not a builder or has no session throws `BuilderNotAvailableError`; a session the host no longer knows throws `BuilderSessionLostError` and leaves the builder `idle`. `continuation.turn` settles like `assignment.turn`.

### Re-assigning on retire

`reassignTickets(ctx, agentId)` hands every ticket a retired builder still holds (`assigned`, `in_progress`, `in_review`, `bounced`) to a new builder, one at a time, in a new worktree. `in_review` and `bounced` keep their status; the others become `assigned`. The prompt names an open pull request if the ticket has one, so the new builder carries it on. An agent that is not `retired` throws `AgentNotRetiredError`; retire it first, which removes its worktree or raises the discard card.

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
| `builder.continued` | `{ name, prompt }`                                 |

Both carry the builder's id and, when there is one, the ticket's.

## Other agents

`runTurn(target, input, format)` and `runPrompt(target, input)` are not tied to the Driver. Any agent with an open session can use them with its own `TurnFormat` (a zod schema plus the instructions that describe it), and `ticketId` on the target files the turn and its events under a ticket.
