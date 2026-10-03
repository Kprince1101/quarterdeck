# bus

The bus MCP server handed to every agent session: the tools agents use to reach Quarterdeck: `status`, `read`, `ask`, `report`, `verdict` and the Planner's `propose`.

## How a session reaches it

PGlite lives inside the Quarterdeck process and takes one process per data dir, so the agent runtime cannot open the store itself. The runtime gets a stdio MCP server that relays bytes; the MCP server runs in Quarterdeck, next to the store.

1. `startBusHost({ store, home? })` listens on a Unix socket (a named pipe on Windows) at `busSocketPath(store.projectId, { home })`.
2. `host.launch(agentId, name?)` returns the ACP `McpServerStdio` to pass in `newSession({ mcpServers })`: `node relay.js` with `QUARTERDECK_BUS_SOCKET` and a one-time `QUARTERDECK_BUS_TOKEN`, named `name` (default `bus`). It throws `AgentNotFoundError` for an agent of another project or a `retired` one. An agent that works in several projects, the voyage's Driver or the reviewer, gets one server per project, each launched for its seat in that project and named `bus-<project>` (`projectBusName`); see [crew](../crew/README.md#seats).
3. The runtime spawns the relay. It connects, sends the token line, waits for `ok`, then pipes stdin and stdout through the socket. An unknown or spent token gets `denied`, and the relay exits 1 with `the bus refused this session (denied)` on stderr.
4. Each accepted connection gets its own MCP server bound to `{ store, agentId }`, so a tool always knows which agent called it and which project it may touch.

`host.revoke(agentId)` drops the agent's pending token and closes its connections; call it when the agent ends or retires. `host.close()` closes every connection and removes the socket.

### Socket path

A Unix socket path must fit in `sun_path` (104 bytes on macOS, 108 on Linux), so the name does not grow with the project slug or home: it is the first 16 hex characters of `sha256(projectId)`. `busSocketPath` tries `~/.quarterdeck/sock/<hash>.sock`, then `$TMPDIR/quarterdeck-<uid>/<hash>.sock`, and takes the first that is at most `SOCKET_PATH_MAX` (100) bytes; if neither fits it throws, naming both. The socket's dir is created mode 0700 (an existing one is tightened to 0700, and one that is a symlink or owned by another user is refused), so only this user can connect. An explicit `socketPath` over the limit is refused with its length.

### Tokens

The token is in the relay's environment, which any process of the same OS user can read. So a token is spent on its first connection, and that connection stays pinned to the agent; a copied token is useless once the relay has connected. `launch` issues a fresh token each call and drops the agent's previous unused one. A relay that reconnects with a spent token is refused, so a session that loses its bus connection needs a new `launch` (for example on `resumeSession`).

This binds a connection to an agent but does not make a tool call trustworthy beyond that. Tools that grant authority, such as `verdict`, must also check the calling agent's role server-side.

## Tools

### `status(text)`

Sets the caller's one-line progress note. Whitespace runs, newlines included, fold to one space; a blank note or one over 200 characters is an error. Records an `agent.status` event with `{ text }` for the caller; the latest one is the agent's note on the board. Returns `noted`.

### `read(table, columns?, filters?, order?, limit?)`

Reads rows of the caller's project. The caller never sends SQL: tables and columns come from the allowlist in `tables.ts`, values are bound as parameters, and every query is scoped to the project.

- `table`: `projects` (this project's row only), `voyages`, `agents`, `tickets`, `cards`, `turns` (scoped through their agent), `events`, `notebook`, `notebook_proposals`, `charter_proposals`, `budget`. `layouts`, `intents`, `schema_migrations`, `project_id` and `agents.session_id` are not readable. Names are matched as own keys of the allowlist, so `constructor` or `__proto__` is just an unknown column.
- `columns`: any subset of the table's readable columns; all of them by default.
- `filters`: ANDed `{ column, op, value }`. `op` defaults to `eq`.

  | Column kind                                | Ops                                                                            |
  | ------------------------------------------ | ------------------------------------------------------------------------------ |
  | `uuid`, `int`, `numeric`, `bool`, `time`   | `eq`, `neq` (null-safe), `lt`, `lte`, `gt`, `gte`, `in`, `is_null`, `not_null` |
  | `text`                                     | the above plus `contains` (case-insensitive substring, `%` and `_` literal)    |
  | `uuids` (`tickets.depends_on`)             | `contains` (has this id), `is_null`, `not_null`                                |
  | `json` (`events.payload`, `cards.options`) | `is_null`, `not_null`                                                          |

  `in` takes an array of 1 to 100 values; `is_null` and `not_null` take none.

- `order`: up to 5 `{ column, direction }`, `asc` by default; not on `uuids` or `json` columns. The table's default order (newest first) breaks ties and applies when `order` is omitted.
- `limit`: 1 to 200, default 50.

Returns a JSON array of rows built by Postgres (`json_build_object`), so timestamps are ISO strings and `bigint` and `numeric` are numbers. A reply over `READ_REPLY_MAX_BYTES` (100 000 bytes) is an error asking the agent to narrow its columns, add filters or lower the limit. A bad table, column, op, value or limit is a tool error naming what was wrong.

### `ask(question, options?, checked, recommendation)`

Puts a decision in front of the person and waits for it. The tool call blocks until the card is answered, declined or expires; declined and expired are results the agent gets back, never a crash.

- `question`: 1 to 500 characters.
- `options`: 2 to 10 distinct choices of up to 100 characters each, or omitted (or `[]`) for a free-text answer. The `card.answer` intent then only accepts one of them.
- `checked`: what the agent already checked or tried, up to 2000 characters.
- `recommendation`: what the agent would pick, up to 500 characters; one of `options` when there are options.

Text fields are trimmed; a blank one, one option, a repeated option or a recommendation outside the options is a tool error and raises no card.

`ask` inserts a `cards` row with `kind` `ask` (`ASK_CARD`), the caller as `agent_id`, the caller's most recently updated ticket in `assigned`, `in_progress`, `in_review` or `bounced` as `ticket_id` (null when it has none), and `expires_at` `askExpiryMs` from now (`ASK_EXPIRY_MS`, one hour, unless the host sets another). In the same transaction it records a `card.asked` event with `{ cardId }`.

It then listens on `CHANGES_CHANNEL` for changes to that card and re-reads it, after a first read so an answer that lands before the listen is not missed. The first of these ends the wait:

| What happens                                             | Card                                                                      | Result                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| The person answers (`card.answer`)                       | `answered`                                                                | `{"cardId","status":"answered","answer":"<answer>"}`    |
| The person declines                                      | `declined`                                                                | `{"cardId","status":"declined","answer":null}`          |
| `askExpiryMs` passes                                     | `expired`, only if still `open`; records `card.expired` with `{ cardId }` | `{"cardId","status":"expired","answer":null}`           |
| The call is cancelled or the session's connection closes | stays `open`                                                              | none; the waiting stops and the call ends with an error |

Expiry never overwrites an answer that landed first: the update only touches an `open` card, and the result is read back from the row. A card left `open` by a cancelled call or a server restart can still be answered on the board; passing that answer on is the Driver's job.

While waiting, a caller that sent a `progressToken` gets a `notifications/progress` every `ASK_PROGRESS_MS` (30 s), so MCP clients that reset their request timeout on progress do not give up on a long wait.

A runtime's MCP client may still give up first. The tool description tells the agent what to do then: `read` `cards` filtered by its own `agent_id` (newest first), or the `card.asked` events with its `agent_id` for the `cardId`, and take the card's `status` and `answer` from there.

### `report(ticket, pr, notes, head?)`

A builder hands its pull request to review. `ticket` is a ticket id of this project assigned to the caller, in status `assigned`, `in_progress`, `bounced` or `in_review` (a re-report after new commits); anything else, or a ticket assigned to another agent, is an error and changes nothing. `pr` is an `http(s)` URL of at most `PR_URL_MAX` (2000) characters, `notes` is trimmed and 1 to `REVIEW_NOTES_MAX` (8000) characters, and `head`, when given, is the 40-character lowercase head commit.

In one transaction the ticket becomes `in_review` with `pr_url` and `head_sha` set (`head_sha` is cleared when `head` is left out, so a stale commit never stands), and a `ticket.reported` event is recorded for the caller and the ticket with `{ pr, head, notes, reviewerId }`. That event is the reviewer handoff: `reviewerId` is the project's live reviewer (role `reviewer`, not `ended`, `killed` or `retired`; the oldest if there are several), or `null` when there is none yet. Returns `ticket <id> is in review; handed to <reviewer>`, or says it waits for a reviewer.

### `verdict(ticket, decision, notes)`

The reviewer's verdict on a ticket in review. Only an agent with role `reviewer` that is not `ended`, `killed` or `retired` may call it; the role is checked against the `agents` row on every call, not taken from the session. The ticket must be in this project, `in_review`, and not assigned to the caller. `decision` is `approve` or `changes`; `notes` is as for `report`.

- `approve` leaves the ticket `in_review` for the merge gate.
- `changes` moves it to `bounced`, back to its builder, who fixes it and reports again.

Either way a `ticket.verdict` event is recorded for the reviewer and the ticket with `{ decision, notes, pr, head }`, `pr` and `head` being what the ticket held when the verdict was given. The latest `ticket.verdict` for a ticket is its verdict, and a later `ticket.reported` withdraws it, so the [merge gate](../gate/README.md) merges only when the newest of the two is an approval and the PR head still matches its `head`.

### `propose(project, title, body?, dependsOn?)`

Planner only: the caller must be a `planner` agent that is not ended, killed or retired, or the call is an error. Stores one ticket with status `proposed` in the project it names and records a `ticket.proposed` event in the caller's project, with the caller as `agentId` and `{ title, project, ticketId }`. The event's `ticketId` column is set only when the ticket is in the caller's project, since another project may be another database. Returns `proposed <ticketId>`.

- `project`: the slug of an active project: the caller's own project or one in the host's `openStores`, and not archived. The caller's project always counts, even before the host lists it as open.
- `title`: 1 to 200 characters after trimming. `body`: up to 100 000 characters, written as a spec (below).
- `dependsOn`: up to 50 distinct ticket ids of the named project. Proposed tickets may be named; `rejected` and `cancelled` ones may not, since they will never be built.
- `externalRef` (optional): the ticket's id in the project's tracker (a Jira key, a story number), 1 to 200 characters after trimming. Stored as `tickets.external_ref` and shown to agents in the ticket's [Services](../services/README.md#the-services-section) section.

The proposal must pass `proposalProblems` from [planner/spec.ts](../planner/spec.ts): it names an active project, and its body has `## Requirements` (user stories with acceptance criteria containing `SHALL`, as in WHEN ... THE SYSTEM SHALL ...), `## Design`, and `## Tasks` (a numbered list), once each, in that order and not empty, with a last line `Proven: <observable check>`. Text before `## Requirements` is allowed, and a `## ` line inside a fenced code block is content, not a heading. A proposal that fails stores nothing: the call is an error naming each problem (an unknown project is named with the active ones), followed by the format (`TICKET_SPEC_FORMAT`), and a `planner.proposal_refused` event is recorded for the caller with `{ title, project, problems }`. The Planner uses that event to re-prompt once (see [planner](../planner/README.md#spec-tickets)). Every per-proposal check goes in `proposalProblems`, so the tool and the re-prompt agree.

The human then approves (`ticket.approve`, which opens it), edits (`ticket.update`) or rejects (`ticket.reject`) the proposal; see [api](../api/README.md#intents).

## Adding a tool

A tool is one file in `tools/`, named after the tool: `tools/ask.ts` serves `ask`. `loadBusTools()` imports every `tools/*.ts` (or `*.js` when built) and needs no other change.

```ts
import { z } from 'zod';
import { defineBusTool } from '../tool.js';

export default defineBusTool({
  description: 'What the agent sees.',
  input: { question: z.string().min(1) },
  run: async ({ store, agentId }, { question }) => {
    return 'the text result';
  },
});
```

`run` gets a `BusCall` and the parsed input. A `BusCall` is the connection's `BusContext` (`store` with `db`, `projectId` and `publish`, the caller's `agentId`, and the host's `askExpiryMs` and `openStores`) plus this call's `signal`, aborted when the caller cancels or the connection closes, and `progress(message)`, which sends a progress notification when the caller asked for them and does nothing otherwise. Its string is the tool result; a thrown error becomes an MCP tool error with the error's message, which the agent sees and can correct. Arguments that fail `input` are rejected the same way before `run` is called.

## API

| Export                                                                                                                                                 | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startBusHost({ store, home?, socketPath?, tools?, askExpiryMs?, forge?, openStores? })`                                                               | Starts listening and resolves to `{ socketPath, tools, launch, revoke, close }`. `tools` defaults to `loadBusTools()`; `askExpiryMs` (1 to `ASK_EXPIRY_MAX_MS`, the largest timer delay) to `ASK_EXPIRY_MS`. `forge` resolves the project's [forge](../gate/README.md#forges) on each connection, and the tools' descriptions and errors (such as `propose`'s refusal with the ticket format) reach the agent in its terms (`wordedTools`), so a GitLab project's builders report merge requests; without it they read GitHub's. Tool results are left as they are: they carry data (ticket rows from `read`, a person's answer from `ask`) whose words are not Quarterdeck's to change. `openStores` lists every open project store, the projects `propose` may name; `startQuarterdeck` passes its own. |
| `raiseAskCard(store, agentId, card, expiryMs)`, `awaitCard(store, cardId, { expiryMs, signal, onWaiting?, progressMs? })`, `expireCard(store, cardId)` | The steps of `ask`: insert the card and its `card.asked` event; wait for it to settle; expire it if still open. Each settled card is a `CardOutcome` `{ cardId, status, answer }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `raiseCard(store, agentId, card, expiryMs, notices?)`                                                                                                  | `raiseAskCard` for any `card.kind`. Each notice `{ kind, payload }` is recorded as one more event, with `cardId` added, in the same transaction. `insertCard(tx, projectId, …)` is the same insert inside a caller's transaction; the sign-in card uses it (see [../signin/README.md](../signin/README.md)).                                                                                                                                                                                                                                                                                                                                               |
| `ASK_CARD`, `ASK_EXPIRY_MS`, `ASK_EXPIRY_MAX_MS`, `ASK_PROGRESS_MS`                                                                                    | The `ask` card kind, the default and largest expiry, and the progress interval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `busSocketPath(projectId, { home?, tmp? })`, `SOCKET_PATH_MAX`                                                                                         | The socket path for a project (see [Socket path](#socket-path)), and its byte limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `createBusServer(context, tools)`                                                                                                                      | One MCP server bound to one agent, for any MCP transport (the host uses stdio over the socket; tests use the in-memory pair).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `loadBusTools(dir?)`                                                                                                                                   | Imports the tools in `dir` (default `tools/`), sorted by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `defineBusTool(spec)`, `BusToolError`, `BusContext`, `BusCall`                                                                                         | Typed tool definition, and an error whose message is meant for the agent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `buildReadQuery(projectId, request)`                                                                                                                   | The SQL and parameters `read` runs, for tests and for other readers that must stay inside the allowlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `READ_TABLES`, `READ_TABLE_NAMES`, `READ_REPLY_MAX_BYTES`                                                                                              | The allowlist: readable tables, their columns and kinds, scope and default order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `PR_URL_MAX`, `REVIEW_NOTES_MAX`                                                                                                                       | The longest `pr` URL and `notes` that `report` and `verdict` take.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BUS_RELAY`, `BUS_SOCKET_ENV`, `BUS_TOKEN_ENV`                                                                                                         | The relay script path and the environment it reads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
