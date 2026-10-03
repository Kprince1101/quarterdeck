# planner

The Planner turns a conversation with the human into proposed tickets for any of their active projects. A conversation is held in one ACP session with a Planner agent, knows every active project and its repository, and each ticket it proposes names its project. The human approves, edits or rejects each proposal, and an edit can move it to another project; only approved tickets reach the Driver. Starting a new conversation ends the old one everywhere.

```ts
import {
  openStore,
  startBusHost,
  startPauseGate,
  startPlanner,
} from '@quarterdeck/server';

const store = await openStore({ project: 'deck' });
const bus = await startBusHost({ store });
const pause = await startPauseGate({ store });
const planner = await startPlanner({
  store,
  bus,
  pause,
  openStores: () => [store],
});
await planner.close();
```

`openStores` lists every open project store, as for `createAgentLifecycle`, so Planner names stay unique across projects. It is also the Planner's list of projects: the active ones (open and not archived) are the projects a conversation can plan for.

## Where a conversation lives

There is no store shared by every project: each project's store may be its own database. So a conversation is stored in one project's store, the one its messages are sent to, which is the project the dashboard tab streams. Its agent, turns, `planner.*` events and `ticket.proposed` events live there; the tickets it proposes live in the projects they name. Every project still runs its own `startPlanner`, and the Planner widget sends `planner.message` to its tab's project, so that project's Planner is the one that answers. A later global store can hold the conversation instead without changing what the Planner sees: the project list, the `project` on each proposal and the decisions reported back are already project-agnostic.

## How a conversation runs

The Planner applies the pending intents the HTTP API records, oldest first, one at a time. It wakes on their events and also drains whatever was pending when it started.

1. `planner.message` with no conversation open births a Planner agent (`role: 'planner'`, a name from the naming theme) on the runtime `rules/models.json` names for `planner`. Its process runs as the runtime adapter decides; the session `cwd` is the project's `repo_path`, and the bus is its MCP server. Permission requests are answered by `createPermissionPolicy` from the project's rules, read with `homeDir` as the machine layer. A request the rules leave at `ask`, which under the shipped rules includes the bus tool `propose`, goes to `permissionCards(agent, signal)` when given (the crew raises an `agent.permission` card), else to `cardHuman`, and is refused when neither is given. The signal aborts on `planner.new` and `close()`.
2. The first turn sends the Planner brief (`plannerBrief(terms)`), then the charter (`rules/charter.md` with its local overrides), then a `# Projects` section listing every active project as ``- `slug` (name): repo_path`` (or `no repository path set`), then the human's message. The brief and charter are in the conversation project's [forge](../gate/README.md#forges) terms, so a GitLab project's Planner reads merge requests. Later turns send the message alone, prefixed with a `[Quarterdeck]` note naming every proposal from this conversation that the human has approved, rejected or moved since it was last told, with its project: ``- approved in `example`: title (id)``, or ``- moved to `sample`: title (old id, now new id)``. A moved proposal is followed to its new ticket, whose decision is reported in turn.
3. Each turn is a `turns` row (`seq` from 1 per agent, `prompt`, `stop_reason`, `ended_at`). The agent is `working` during the turn and `idle` after it.
4. The Planner proposes tickets with the bus tool `propose` (see [bus](../bus/README.md#proposeproject-title-body-dependson)), each naming an active project and with a spec body (see [Spec tickets](#spec-tickets)). The ticket is stored in the project it names.
5. `planner.new` takes no project: the API records it in every project (see [api](../api/README.md)), so every project's Planner retires its agent: its session is closed, its process group stopped, its bus token revoked and its name freed. The next message births a new agent. If a turn is running when `planner.new` arrives it is cancelled first, and messages queued before the `planner.new` are rejected with `superseded by a new conversation`. Proposals stay on the board whatever happens to the conversation.

When the runtime is not signed in, opening the session or sending a prompt raises a sign-in card with the command to run. The conversation waits on that card. Once the person answers it, the session opens with a fresh process, or the prompt is sent again (see [signin](../signin/README.md)). Quarterdeck never signs in for you. A `planner.new` or `close()` stops the wait.

A message is refused (intent `rejected` with `{ error }`, plus a `planner.failed` event) in these cases:

- the project has no `repo_path`;
- the sign-in card is declined or expires (`SignInRequiredError`, whose message names the command);
- the wait for sign-in is stopped;
- the budget holds the birth (`BudgetHeldError`; see [budget](../budget/README.md));
- the project is archived (`PROJECT_ARCHIVED`);
- the agent cannot be born. If a turn fails, for example because the agent process died, the conversation ends and the next message starts a fresh one.

Archiving the project ends the conversation: on `project.archive` the Planner stops any sign-in wait, cancels a running turn and retires its agent, closing the session and its process, with `planner.cleared { reason: 'archived' }`. Messages are refused while the project is archived, and the first message after it is unarchived births a new Planner, with no restart. If the conversation's agent is retired some other way, the next message ends it with `reason: 'retired'` and starts afresh.

Each message goes through the [pause](../pause/README.md) guard (`pause`) before its turn, and before the birth when it starts a conversation. While the Planner agent, the project or everything is paused the message is held as `planner.turn` and stays `pending`; the messages behind it wait, and it is answered on unpause. A `planner.new` drops a held message, which is then rejected as superseded like any other message queued before it; `close()` drops it and leaves it `pending` for the next start.

When the Planner starts it retires any Planner agent still live from an earlier run, because that agent's process is gone. `close()` cancels a running turn and retires the conversation.

## Spec tickets

Every ticket body is a spec, so a builder starts with requirements, design and tasks. The brief ends with the ticket format (`TICKET_SPEC_FORMAT`): in order, `## Requirements` (user stories with acceptance criteria in the form WHEN ... THE SYSTEM SHALL ...), `## Design` (where in the repository, the approach, the constraints and decisions), `## Tasks` (a numbered checklist sized for one pull request, or merge request on GitLab), and a last line `Proven: <observable check>`. The brief, the re-prompt and `propose`'s refusal all show it in the project's forge terms. The spec lives only in the ticket body; nothing is written to the project's repository.

`propose` refuses a proposal that names no active project, or whose body does not follow the format, stores nothing and records `planner.proposal_refused`; the error names the active projects. A `## ` line inside a fenced code block (` ``` ` or `~~~`) is content, not a section heading. When a turn ends, any proposal refused during it whose title was not proposed again successfully in the same turn counts as a miss, as a turn result does for the Driver: `planner.missed { seq, error, reprompt }` is recorded and, the first time, the Planner gets one more turn with a `[Quarterdeck]` prompt (`repromptText`) listing each refused title and its problems, followed by the format. A miss after that re-prompt is recorded with `reprompt: false` and the turn ends; the refused proposal never reaches the board. A cancelled or refused turn, or a `planner.new`, `close()` or archive during the turn, ends it without a re-prompt. That holds even when the cancel lands after the turn ended, while the refusals are read or the re-prompt turn is being opened: the prompt is checked against the cancel right before it is sent, and a re-prompt turn opened by then ends `cancelled` without reaching the agent. The re-prompt turn is a `turns` row like any other.

## Moving a proposal

The `planner.move` intent (see [api](../api/README.md)) moves a proposed ticket to another project with `moveProposal({ ticketId, from, to, title?, body? })`: it stores a proposed ticket in `to` with the edited title and body, then rejects the old one in `from`. If the old one was decided in the meantime, the new one is deleted and the move fails. Dependencies are not carried over, since they named `from`'s tickets. The API records `planner.proposal_moved` in the conversation's project, which is how the Planner widget and the decisions note follow the proposal. It checks the conversation's project exists before moving anything, and if the move cannot be recorded, `undoMove` deletes the new ticket and puts the old one back to `proposed`.

`parseTicketSpec(body)` reads a valid body into `{ intro, sections, proven }` and `specBody(spec)` writes it back; the Planner widget uses both, from `@quarterdeck/server/ticket-spec`, to show and edit a proposal section by section.

## Events

| `kind`                     | `agentId`        | `payload`                                                                                                      |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `planner.human`            | the Planner      | `{ intentId, seq, text }`: the message entered the turn                                                        |
| `planner.reply`            | the Planner      | `{ seq, text, stopReason }`: the agent's reply text                                                            |
| `planner.failed`           | the Planner/null | `{ intentId, error, seq? }`: a refused message or a failed turn                                                |
| `planner.cleared`          | the old Planner  | `{ reason, intentId }`: `new`, `failed`, `restart`, `shutdown`, `archived` or `retired`                        |
| `ticket.proposed`          | the Planner      | `{ title, project, ticketId }`: from the `propose` tool; the `ticketId` column only when `project` is this one |
| `planner.proposal_refused` | the Planner      | `{ title, project, problems }`: `propose` refused a proposal                                                   |
| `planner.proposal_moved`   | null             | `{ ticketId, project, title, to: { project, ticketId } }`: `planner.move` moved a proposal                     |
| `planner.missed`           | the Planner      | `{ seq, error, reprompt }`: turn `seq` left refused proposals; `reprompt` says another turn follows            |

`planner.message` and `planner.new` intents are settled `applied` once handled; a message's result is `{ agentId, seq }`.

## API

| Export                          | What it does                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startPlanner(options)`         | Starts applying one project's Planner intents. `store`, `bus` (`launch`, `revoke`), `pause` and `openStores` are required; `adapters`, `homeDir`, `cardHuman`, `permissionCards`, `onError` are optional.                                 |
| `Planner.drain()`               | Applies every pending Planner intent and resolves once none is left.                                                                                                                                                                      |
| `Planner.close()`               | Stops listening, cancels a running turn and retires the conversation.                                                                                                                                                                     |
| `plannerBrief(terms)`           | The text that opens every conversation, before the charter, in the forge's terms.                                                                                                                                                         |
| `TICKET_SPEC_FORMAT`            | The ticket format the brief and every refusal show the Planner, written for GitHub; `ticketSpecFormat(terms)` gives it in the forge's terms.                                                                                              |
| `proposalProblems(p, projects)` | Every problem with a proposal `{ project, title, body, dependsOn }` given the active project slugs, `[]` when it may reach the board. `projectProblems(project, projects)` checks the project alone, `specProblems(body)` the body alone. |
| `activeProjects(stores)`        | The open, unarchived projects of `stores` as `{ slug, name, repoPath, archived, store }`, by slug. `openProjects(stores)` includes archived ones.                                                                                         |
| `moveProposal(move)`            | Moves a proposed ticket to another project (see [Moving a proposal](#moving-a-proposal)); throws `ProposalMoveError`.                                                                                                                     |
| `parseTicketSpec(body)`         | `{ intro, sections, proven }` for a valid spec body, else `null`. `specBody(spec)` writes one back.                                                                                                                                       |
| `PLANNER_ADAPTERS`              | The runtime adapters used when `adapters` is not given.                                                                                                                                                                                   |
