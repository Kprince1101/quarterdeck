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
});
const birth = await round.birth;
const next = await round.turn('heron reported QD12: <report>');
```

`openDriverRound` checks the round (`RoundNotFoundError` for one outside the project, `RoundEndedError` once it has ended) and the agent (`NotADriverError` unless it is a `driver` that is not `ended`, `killed` or `retired`). It then:

1. Launches the bus for the Driver (`bus.launch(agentId)`) and opens one ACP session with `client.newSession({ cwd, mcpServers: [bus] })`. Every turn of the round goes to that session; nothing else opens one.
2. Reads the active notebook: every `notebook` row of the project, pinned entries first, then oldest first.
3. Stores the session on the agent (`session_id`, `round_id`; a `starting` agent becomes `idle`) and records `driver.round_started` with `{ roundId, round, sessionId, notebook }`, where `notebook` lists the entry ids the Driver was born with.
4. Queues the birth turn and returns. `round.birth` settles with its outcome; await it.

The birth input (`buildBirthInput`) is the Driver's name and round number, the charter, the round's goal, the notebook entries and the turn result format. The next round gets a new session and a new birth input, carrying the notebook as it is then.

`round.turn(input)` queues one more turn in the round's session. Turns run one at a time, in the order they were asked for, the birth turn first. A turn that rejects does not stop the ones queued after it.

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

## Turn files

Each ACP prompt, birth and re-prompt included, is one `turns` row (`seq` counts per agent from 1, `prompt` is the input, `stop_reason` and token counts come from the prompt response) and one folder, `turnDir(turnsDir, agentId, seq)`: `~/.quarterdeck/<project>/turns/<agent-id>/<seq>/` with `seq` zero-padded to 4 digits. `transcript_path` names the folder.

| File            | Holds                                                           |
| --------------- | --------------------------------------------------------------- |
| `input.md`      | The prompt as sent. Written before the prompt goes out.         |
| `output.md`     | The agent's reply: its `agent_message_chunk` text, joined.      |
| `updates.jsonl` | Every `session/update` of the prompt, one JSON object per line. |
| `result.json`   | The parsed turn result, only for the prompt whose reply parsed. |

A prompt that throws still gets `output.md` and `updates.jsonl` with what arrived before it failed, and its row gets `ended_at` with a null `stop_reason`.

While a prompt runs the agent is `working`; afterwards it is `idle` again. Only an `idle` or `working` agent is moved, so a pause or kill set meanwhile stands.

## Replay

```ts
import { projectTurnsDir, replayDriverChain } from '@quarterdeck/server';

const replay = await replayDriverChain({
  client, // an AcpClient for the runtime to replay against
  cwd: repoPath,
  turnsDir: projectTurnsDir('commander'),
  agentId: driver.id,
  through: 7,
  onTurn: (turn) => console.log(turn.seq, turn.result),
});
```

`replayDriverChain` sends a Driver's saved prompts 1..n again, in order, in one new ACP session: each turn's `input.md`, birth and re-prompts included, exactly as it was sent. It reads every input first (`readTurnChain`), so a missing `input.md` rejects with `TurnInputMissingError` (its `seq` and `path`) before any session opens.

Replay writes nothing: no `turns` row, no event, no agent change and no turn file. The session gets no MCP servers, so the bus tools (`ask`, `report`, `status`, `verdict`, `read`) are not there to write through either; what the agent's own tools may do is up to the client's permission handler.

Each `ReplayTurn` holds the `seq`, the `input` sent, the `savedOutput` from `output.md` (null if there is none), the replayed `output`, its `stopReason` and `result`, the reply parsed as a Driver turn result (`ParsedTurnResult`). Every prompt is sent whatever the one before it returned; a prompt that throws rejects the replay.

`replayCommand({ project, agentId, through })` is the command the dashboard shows beside a Driver turn to replay the chain up to it:

```sh
npx quarterdeck replay commander 7d0f3a4e-2b1c-4c5d-9e8f-0a1b2c3d4e5f 7
```

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

## Other agents

`runTurn(target, input, format)` and `runPrompt(target, input)` are not tied to the Driver. Any agent with an open session can use them with its own `TurnFormat` (a zod schema plus the instructions that describe it), and `ticketId` on the target files the turn and its events under a ticket.
