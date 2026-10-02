# crew

Everything that runs agents for one open project: the [Planner](../planner/README.md), the Driver's rounds, the reviewer and the [merge gate](../gate/README.md), plus the [lifecycle](../lifecycle/README.md) and [archive](../archive/README.md) controls that act on those agents. [`startQuarterdeck`](../quarterdeck/README.md) starts one crew per project after its bus host and stream, and closes it first.

```ts
import { startCrew } from '@quarterdeck/server';

const crew = await startCrew({
  store,
  project: 'example',
  home, // ~/.quarterdeck
  homeDir, // where rules are read from
  bus, // the project's BusHost
  openStores, // every open project store, for unique names
});
await crew.close();
```

`adapters` (default: the runtime adapters), `github` (default: `ghCli()`), `gatePollMs` and `onError` are optional. Rules are read again whenever they are used, with the project's `repo_path` as the repo layer, so an edit in the Rules widget applies to the next birth, round or prompt. The merge gate reads `mergeGate` once, when the crew starts.

## What starts

In order, each on its own: a failure in one is reported (see [Failures](#failures)) and the rest still start.

1. The [pause](../pause/README.md) gate. Every launch, continue and turn below goes through it.
2. The session host (`createCrewSessions`). Every agent the crew births runs through it: the runtime adapter for the agent's runtime starts the process, with `env.pass` from `rules/env.json` on top of the [child environment allowlist](../acp/README.md#the-child-environment), the bus as its one MCP server, and a permission policy from the project's rules (the machine layer under `homeDir`). A request the rules leave at `ask` raises an `agent.permission` card with options `allow` and `deny`; anything but `allow`, an expiry or a stop refuses it. Nothing trusts every tool. The session `cwd` is the agent's worktree, or the repository for a Driver or reviewer.
3. Any reviewer left live by an earlier run is retired, since its process went with that run.
4. The Planner, so the Planner widget's `planner.message` and `planner.new` reach it. Its `ask` requests, the bus tool `propose` among them under the shipped rules, raise `agent.permission` cards like every other agent's, and its rules are read from `homeDir`.
5. `agent.kill`, `agent.reset` and `agent.retire` ([lifecycle intents](../lifecycle/README.md#intents)) and archiving, both through the crew's own session host, so the Agents widget acts on the live processes.
6. The merge gate, whose reviewer host is the crew's reviewer (see [The reviewer](#the-reviewer)).
7. The rounds (see [Rounds](#rounds)). Any round still open is ended first with `cleanUpRound`, reason `restart`, its tickets reopened: its Driver and builders stopped with the run that started them.

## Rounds

The crew applies `round.start` and `agent.message` intents, oldest first.

**`round.start { goal }`** is refused (`rejected` with `{ error }`) when the project has no `repo_path` or a round is still open. Otherwise, in one transaction, it adds the `rounds` row (the next number, status `active`), settles the intent `applied` with `{ roundId, round }` and records `round.started { intentId, roundId, round, goal }`. Then, in the background:

1. A reviewer is born if the project has no live one.
2. The Driver is born (`role: 'driver'`, the runtime `rules/models.json` names for `driver`), held as `launch` while paused, and its round opened with [`openDriverRound`](../driver/README.md#a-round) in the repository.
3. The round's builder context: builders on `models.builder`, worktrees under `~/.quarterdeck/<project>/worktrees/`, based on `origin/<mergeGate.base>`, or `origin/HEAD`, or `origin/main`.
4. The settle timer ([`startRoundAutoEnd`](../round-end/README.md#the-settle-timer)) and, for the dashboard's End and Kill, [`startRoundControl`](../round-end/README.md#end-and-kill-from-the-dashboard) with this round's Driver.

If the Driver cannot be born or its round opened, `crew.failed` is recorded with `service: 'driver'` and the round is ended with reason `driver_failed`, its tickets reopened.

### The Driver's turns

After its birth turn, the Driver gets a turn whenever something it should act on happens. Each becomes one line of the next turn's input, under `# Since your last turn`; lines that arrive while a turn runs wait for the next one, which takes them all:

| What happened                                  | Event                                      |
| ---------------------------------------------- | ------------------------------------------ |
| a ticket was approved or created on the board  | `ticket.approve`, `ticket.create`          |
| a builder reported its pull request            | `ticket.reported`                          |
| the reviewer approved or asked for changes     | `ticket.verdict`                           |
| the merge gate bounced a ticket                | `ticket.gate_bounced`                      |
| a pull request merged                          | `ticket.merged`                            |
| a builder's ticket was blocked by a kill       | `ticket.blocked`                           |
| a builder's turn ended, or failed              | the turn of an `assign` or `continue`      |
| the human sent the Driver a message            | `agent.message` (the Agents widget's Poke) |
| approved tickets were waiting when it was born | a first line listing them, after the birth |

Each line names the ticket and the builder by id, so the Driver can act on them. The Driver's [actions](../driver/README.md#actions) run in order once its turn ends. An `assign` adds a line saying who got the ticket to the next turn without asking for one. An action that does not parse or fails adds a line with the error and asks for a turn, but at most `MAX_RETRY_TURNS` (3) turns in a row are asked for by failures alone. A Driver turn that throws (its process died) records `crew.failed` and the round stops asking it for turns; End or Kill it from the dashboard.

**`agent.message { agentId, text }`** goes to the Driver of the live round as a line of its next turn, or to a builder of it as a [`continueBuilder`](../driver/README.md#continuing) prompt; a message for a round still starting waits until it has started. Anything else is refused with `agent.intent_failed`.

The round stops when `round.ended` is recorded for it: by the settle timer, End, Kill, or a failed Driver.

## The reviewer

The project has one reviewer (`role: 'reviewer'`, `models.reviewer`), born when a round starts or a ticket is reported and the project has none, and kept between rounds. The merge gate hands it each review; the crew sends `rules/reviewer.md` followed by the gate's `reviewPrompt` to its session, one review at a time, and the reviewer answers with the bus tool `verdict`. A reviewer whose process exits is retired, and the next round or report births a new one. The gate hands each report over once, so a review the dead reviewer had not finished waits until its builder reports again.

## Failures

A crew service that fails, an agent whose process exits on its own, or a Driver turn or review that throws is logged to `onError` and recorded as `crew.failed { service, error, roundId }`, with the agent and ticket when there are some. It shows in the Events widget. `service` is `start`, `planner`, `intents`, `archive`, `gate`, `reviewer`, `rounds`, `driver` or `builder`. Nothing else stops: other projects, the API and the stream carry on. Work that fails because the crew is closing is not recorded.

## Closing

`close()` stops the rounds' listeners and settle timers, then the merge gate, archive control, lifecycle intents and Planner, then closes every session the crew opened (each agent's process group gets SIGTERM, then SIGKILL), then the pause gate, then waits for what was in flight. Agents keep their rows; the next start's [recovery](../lifecycle/README.md#recovery) reaps anything left.
