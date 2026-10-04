# crew

Everything that runs agents. Each open project gets a crew: its [Planner](../planner/README.md), builders and [merge gate](../gate/README.md), plus the [lifecycle](../lifecycle/README.md) and [archive](../archive/README.md) controls that act on its agents. Above the crews sits one coordinator: the voyage, which spans every project, its one Driver, and the one reviewer every project's gate hands reviews to. [`startQuarterdeck`](../quarterdeck/README.md) starts the coordinator, then one crew per project after its bus host and stream; each crew joins the coordinator once it has started and leaves it first when it closes.

```ts
import { startCoordinator, startCrew } from '@quarterdeck/server';

const coordinator = startCoordinator({
  home, // ~/.quarterdeck
  homeDir, // where machine rules are read from
  openStores, // every open project store, for unique names
});
const crew = await startCrew({
  store,
  project: 'example',
  home,
  homeDir,
  bus, // the project's BusHost
  coordinator,
  openStores,
});
await coordinator.desk.start('Ship the greeting');
await crew.close();
await coordinator.close();
```

`adapters` (default: the runtime adapters) and `onError` are optional on both; `forge` (a `ForgeHost`; default: `forgeHost(mergeForge(...))` for the project's [forge](../gate/README.md#forges), resolved on the gate's first evaluation and retried until the origin can be read) and `gatePollMs` on the crew. A crew reads rules again whenever they are used, with the project's `repo_path` as the repo layer, so an edit in the Rules widget applies to the next birth or prompt. The merge gate reads `mergeGate` once, when the crew starts. The reviewer brief comes back in the project's forge terms (`forgeWording`), and builders' assignment prompts use them too, so a GitLab project reads merge requests throughout. The coordinator reads the machine layer only (`homeDir`) for the Driver's and reviewer's runtimes, the charter, naming, budget and `autoEndSettleSeconds`; each review's brief is read from the review's project, and its prompt names the change in that project's terms (`This merge request belongs to project …`). The Driver's charter is worded in the forge's terms when every project of the voyage is on the same forge, and left as written when they differ; each project's line in the birth input names its forge and terms either way.

## What a crew starts

In order, each on its own: a failure in one is reported (see [Failures](#failures)) and the rest still start.

1. The [pause](../pause/README.md) gate. Every launch, continue and turn in the project goes through it.
2. The session host (`createCrewSessions`). Every builder and Planner runs through it: the runtime adapter for the agent's runtime starts the process, with `env.pass` from `rules/env.json` on top of the [child environment allowlist](../acp/README.md#the-child-environment), the project's bus as its one MCP server, and a permission policy from the project's rules (the machine layer under `homeDir`). A request the rules leave at `ask` raises an `agent.permission` card with options `allow` and `deny`; anything but `allow`, an expiry or a stop refuses it. Nothing trusts every tool. The session `cwd` is the agent's worktree.
3. Any reviewer left live by an earlier run is retired, since its process went with that run.
4. The Planner, so the Planner widget's `planner.message` and `planner.new` reach it. Its `ask` requests, the bus tool `propose` among them under the shipped rules, raise `agent.permission` cards like every other agent's, and its rules are read from `homeDir`.
5. `agent.kill`, `agent.reset`, `agent.retire` and `project.kill` ([lifecycle intents](../lifecycle/README.md#intents)) and archiving, all through the crew's own session host, so the Agents widget and the Board act on the live processes.
6. The merge gate, whose reviewer host is the coordinator's reviewer (see [The reviewer](#the-reviewer)).
7. It joins the coordinator. Any voyage the project still has open is ended first with `cleanUpVoyage`, reason `restart`, its tickets reopened: its Driver and builders stopped with the run that started them.

## Seats

The Driver and the reviewer each run as one process with one ACP session, but every project they work in has a row for them in its `agents` table: a seat. Seats share the agent's name and session id; they are born together (`birthSeated`), with the name picked once across every open store. The first seat, the project first by slug, is the lead: the process's pid, its permission cards and sign-in cards, and the Driver's turns are recorded there. The process is started in `~/.quarterdeck/_deck/` (`coordinatorDir`), not in any project's repository, with `deck` (`COORDINATOR_SITE`) as its launch's project, and gets one MCP server per seat: that project's bus, named `bus-<project>` (`projectBusName`) and launched for that project's seat. A tool call on `bus-example` acts on project `example` as the seat there.

## Voyages

There is one voyage at a time, and it spans every project. The API's voyage intents go straight to the coordinator's desk (`coordinator.desk`).

**`voyage.start { goal }`** is refused (409) while a voyage is open, or when no open, unarchived project has a `repo_path`. Otherwise its projects are every such project, its number is one more than the highest voyage number in any open project, and each project gets its own `voyages` row with that number, the goal and the list of projects (`projects`), and records `voyage.started { voyageId, voyage, goal, projects }`, `voyageId` being that project's row. The reply is `applied` with `{ voyage, goal, projects }`. Then, in the background:

1. The reviewer is born if it has no seat in some open project.
2. The Driver is born with a seat in each of the voyage's projects (`role: 'driver'`, the runtime `models.driver` names), held as `launch` while everything or its lead seat is paused (a paused project does not hold it), and its voyage opened with [`openDriverVoyage`](../driver/README.md#a-voyage) with every seat. Its birth input lists each project: its repository and bus, the approved tickets waiting for a builder and the live builders, each with its id.
3. The settle timer ([`startAutoEnd`](../voyage-end/README.md#the-settle-timer)) over every project's row: the voyage settles once every project has settled.
4. Tickets approved while the Driver was being born go to it as a first line, per project.

If the Driver cannot be born or its voyage opened, `crew.failed` is recorded with `service: 'driver'` in every project and the voyage is ended in each with reason `driver_failed`, its tickets reopened. If a project's row cannot be written, the rows already written are ended with reason `start_failed` and the start is refused. If one of its projects closes (it is wiped, or the server stops serving it) while the voyage runs, the Driver is stopped before the project's store closes and the voyage is ended in the other projects with reason `project_closed`. End, Kill all and those endings clear the voyage only once every project's row has ended: a project whose cleanup failed keeps it open, End retries that project's cleanup once and records `crew.failed` (`service: 'voyages'`) if it is still open, and Kill all answers 409 naming the projects, so Kill all can be sent again.

**`voyage.end { voyage }`** ends the open voyage with that number: it answers `pending` and, in the background, releases every project's builders, gives the Driver its wrap-up turn, closes the Driver, and cleans up each project (see [voyage-end](../voyage-end/README.md#end)). **`voyage.kill { voyage }`** (Kill all) closes the Driver and kills the voyage in every project, reopening its tickets, and answers `applied` with each project's cleanup. Both are refused (409) for a voyage that is not the open one.

**Per-project Kill** is the lifecycle intent `project.kill { project }`: it kills that project's live builders, which blocks their tickets and tells the Driver, and leaves the voyage, the Driver and every other project running. Per-project pause (`pause.set`) holds that project's launches and continues and nothing else.

### The Driver's turns

After its birth turn, the Driver gets a turn whenever something it should act on happens in any of the voyage's projects. Each becomes one line of the next turn's input, under `# Since your last turn`, starting with the project in brackets (`[example] Ticket approved: …`); lines that arrive while a turn runs wait for the next one, which takes them all:

| What happened                                 | Event                                      |
| --------------------------------------------- | ------------------------------------------ |
| a ticket was approved or created on the board | `ticket.approve`, `ticket.create`          |
| a builder reported its pull request           | `ticket.reported`                          |
| the reviewer approved or asked for changes    | `ticket.verdict`                           |
| the merge gate bounced a ticket               | `ticket.gate_bounced`                      |
| a pull request merged                         | `ticket.merged`                            |
| a builder's ticket was blocked by a kill      | `ticket.blocked`                           |
| a builder's turn ended, or failed             | the turn of an `assign` or `continue`      |
| the human sent the Driver a message           | `agent.message` (the Agents widget's Poke) |
| tickets were approved while it was being born | a first line listing them, after the birth |
| an unassigned ticket's dependencies are ready | `ticket.unblocked` (`held: false`)         |
| a woken builder could not be continued        | see [Blocked work](#blocked-work)          |

A merged ticket of a project that [publishes](../services/README.md) says so on its line and asks the Driver to publish it and send `published`. Some lines ride along with the next turn without asking for one: a ticket blocked on its dependencies (`ticket.blocked` with `reason: 'dependencies'`), an unassigned ticket that now waits on some (`ticket.waiting`, with each dependency's reason), and a held ticket Quarterdeck woke (`ticket.unblocked` with `held: true`).

Each line names the ticket and the builder by id, so the Driver can act on them. The Driver's [actions](../driver/README.md#actions) run in order once its turn ends, each in the project that holds the ticket (`assign`, `block`, `published`) or the builder (`continue`); one that names a ticket or builder in none of the voyage's projects fails with `NotInVoyageError`. A `block` may name tickets of any project in `on`. A builder is born in the project of its ticket, with that project's runtime, base and worktree folder (`~/.quarterdeck/<project>/worktrees/`). An `assign` adds a line saying who got the ticket to the next turn without asking for one. An action that does not parse or fails adds a line with the error and asks for a turn, but at most `MAX_RETRY_TURNS` (3) turns in a row are asked for by failures alone. A Driver turn that throws (its process died) records `crew.failed` and the voyage stops asking it for turns; End or Kill all from the Board.

**`agent.message { agentId, text }`**, in any project, goes to the Driver when `agentId` is one of its seats, as a line of its next turn, or to a builder of the voyage as a [`continueBuilder`](../driver/README.md#continuing) prompt; a message for a voyage still starting waits until it has started. Anything else is refused with `agent.intent_failed`.

### Blocked work

While a voyage runs, the coordinator wakes blocked work by itself (`startWake`). It looks again whenever a ticket merges, is published, blocked, reopened, approved, created or edited in any open project, when a builder's turn ends, and once when the voyage starts. Each look goes over every project of the voyage, resolving [dependencies](../driver/README.md#dependencies) across every open store:

- **A held ticket** (one the Driver blocked) whose dependencies are all satisfied is put back to the status it had and its builder continued (`continueBuilder`) with `wakePrompt`: each dependency with its published package and version, and to bump them and carry on. The Driver is not asked. A builder still in a turn is woken once that turn ends. The wake goes through the project's pause guard as `continue` and checks the budget for the builder first; while either holds, the ticket stays `blocked` and nothing is recorded. A budget hold is tried again at its `releaseAt`, a pause on unpause. The ticket's move back and its `ticket.unblocked` are one transaction that only a still-held ticket passes, so each unblock wakes its builder once, however many looks race. If the builder is finished, or the continue fails, the Driver gets a line saying so and continues or reassigns it itself.
- **An unassigned open ticket** with dependencies gets `ticket.waiting` the first time a look finds them unsatisfied, and `ticket.unblocked` (`held: false`) once they all are; that line asks the Driver for a turn, so it assigns the ticket.

Every mark is an event or a status in the project's store, not memory, so a restart does not repeat a wake or a line. A restart ends the voyage that was open, which reopens held tickets as unassigned ones (see [Recovery](../lifecycle/README.md#recovery)); the next voyage's Driver sees them among the tickets waiting for a builder, and its first look marks those still waiting on something as `ticket.waiting`.

## The reviewer

There is one reviewer for every project (`role: 'reviewer'`, `models.reviewer`), born with a seat in each open, unarchived project when a voyage starts or a ticket is reported, and kept between voyages. When a project opens that it has no seat in, the next voyage or report takes no new reviews on the old reviewer, lets the ones it is running finish, retires it and births one that has. Each project's merge gate finds the reviewer's seat in that project and hands it the review; the coordinator sends `rules/reviewer.md`, the gate's `reviewPrompt` and a line naming the project's bus to the reviewer's session, one review at a time across every project, and records the turn under the ticket in the ticket's project. The reviewer answers with `verdict` on that project's bus. A reviewer whose process exits is retired in every project, and the next voyage or report births a new one. The gate hands each report over once, so a review the dead reviewer had not finished waits until its builder reports again.

## Failures

A crew service that fails, an agent whose process exits on its own, or a Driver turn or review that throws is logged to `onError` and recorded as `crew.failed { service, error, voyageId }`, with the agent and ticket when there are some. A Driver's failure is recorded in each of its voyage's projects, a reviewer's in each project it has a seat in. It shows in the Events widget. `service` is `start`, `planner`, `intents`, `archive`, `gate`, `reviewer`, `voyages`, `driver` or `builder`. Nothing else stops: other projects, the API and the stream carry on. Work that fails because the crew is closing is not recorded.

## Closing

`startQuarterdeck` closes the coordinator first: it stops the voyage's settle timer and the Driver (the voyage stays open, so the next start ends it with reason `restart`), each project's listeners, and the reviewer. A crew's `close()` leaves the coordinator, stops the merge gate, archive control, lifecycle intents and Planner, then closes every session it opened (each agent's process group gets SIGTERM, then SIGKILL), then the pause gate. Agents keep their rows; the next start's [recovery](../lifecycle/README.md#recovery) reaps anything left.
