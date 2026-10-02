# planner

The Planner turns a conversation with the human into proposed tickets. There is one conversation per project at a time, held in one ACP session with a Planner agent. The human approves, edits or rejects each proposal; only approved tickets reach the Driver. Starting a new conversation ends the old one.

```ts
import { openStore, startBusHost, startPlanner } from '@quarterdeck/server';

const store = await openStore({ project: 'deck' });
const bus = await startBusHost({ store });
const planner = await startPlanner({ store, bus, openStores: () => [store] });
await planner.close();
```

`openStores` lists every open project store, as for `createAgentLifecycle`, so Planner names stay unique across projects.

## How a conversation runs

The Planner applies the pending intents the HTTP API records, oldest first, one at a time. It wakes on their events and also drains whatever was pending when it started.

1. `planner.message` with no conversation open births a Planner agent (`role: 'planner'`, a name from the naming theme) on the runtime `rules/models.json` names for `planner`. Its process runs as the runtime adapter decides; the session `cwd` is the project's `repo_path`, and the bus is its MCP server. Permission requests are answered by `createPermissionPolicy` from the project's rules. A request the rules leave at `ask` is refused unless `cardHuman` is given.
2. The first turn sends the Planner brief (`PLANNER_BRIEF`), then the charter (`rules/charter.md` with its local overrides), then the human's message. Later turns send the message alone, prefixed with a `[Quarterdeck]` note naming every proposal from this conversation that the human has approved or rejected since it was last told.
3. Each turn is a `turns` row (`seq` from 1 per agent, `prompt`, `stop_reason`, `ended_at`). The agent is `working` during the turn and `idle` after it.
4. The Planner proposes tickets with the bus tool `propose` (see [bus](../bus/README.md#proposetitle-body-dependson)).
5. `planner.new` retires the agent: its session is closed, its process group stopped, its bus token revoked and its name freed. The next message births a new agent. If a turn is running when `planner.new` arrives it is cancelled first, and messages queued before the `planner.new` are rejected with `superseded by a new conversation`. Proposals stay on the board whatever happens to the conversation.

When the runtime is not signed in, opening the session or sending a prompt raises a sign-in card with the command to run. The conversation waits on that card. Once the person answers it, the session opens with a fresh process, or the prompt is sent again (see [signin](../signin/README.md)). Quarterdeck never signs in for you. A `planner.new` or `close()` stops the wait.

A message is refused (intent `rejected` with `{ error }`, plus a `planner.failed` event) in these cases:

- the project has no `repo_path`;
- the sign-in card is declined or expires (`SignInRequiredError`, whose message names the command);
- the wait for sign-in is stopped;
- the budget holds the birth (`BudgetHeldError`; see [budget](../budget/README.md));
- the agent cannot be born. If a turn fails, for example because the agent process died, the conversation ends and the next message starts a fresh one.

When the Planner starts it retires any Planner agent still live from an earlier run, because that agent's process is gone. `close()` cancels a running turn and retires the conversation.

## Events

| `kind`            | `agentId`        | `payload`                                                        |
| ----------------- | ---------------- | ---------------------------------------------------------------- |
| `planner.human`   | the Planner      | `{ intentId, seq, text }`: the message entered the turn          |
| `planner.reply`   | the Planner      | `{ seq, text, stopReason }`: the agent's reply text              |
| `planner.failed`  | the Planner/null | `{ intentId, error, seq? }`: a refused message or a failed turn  |
| `planner.cleared` | the old Planner  | `{ reason, intentId }`: `new`, `failed`, `restart` or `shutdown` |
| `ticket.proposed` | the Planner      | `{ title }`, with `ticketId`: from the `propose` tool            |

`planner.message` and `planner.new` intents are settled `applied` once handled; a message's result is `{ agentId, seq }`.

## API

| Export                  | What it does                                                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startPlanner(options)` | Starts applying one project's Planner intents. `store`, `bus` (`launch`, `revoke`) and `openStores` are required; `adapters`, `homeDir`, `cardHuman`, `onError` are optional. |
| `Planner.drain()`       | Applies every pending Planner intent and resolves once none is left.                                                                                                          |
| `Planner.close()`       | Stops listening, cancels a running turn and retires the conversation.                                                                                                         |
| `PLANNER_BRIEF`         | The text that opens every conversation, before the charter.                                                                                                                   |
| `PLANNER_ADAPTERS`      | The runtime adapters used when `adapters` is not given.                                                                                                                       |
