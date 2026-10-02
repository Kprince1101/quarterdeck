# bus

The bus MCP server handed to every agent session: the tools agents use to reach Quarterdeck. This package has `status` and `read`; `ask`, `report` and `verdict` follow.

## How a session reaches it

PGlite lives inside the Quarterdeck process and takes one process per data dir, so the agent runtime cannot open the store itself. The runtime gets a stdio MCP server that relays bytes; the MCP server runs in Quarterdeck, next to the store.

1. `startBusHost({ store, home? })` listens on a Unix socket (a named pipe on Windows) at `busSocketPath(store.projectId, { home })`.
2. `host.launch(agentId)` returns the ACP `McpServerStdio` to pass in `newSession({ mcpServers })`: `node relay.js` with `QUARTERDECK_BUS_SOCKET` and a one-time `QUARTERDECK_BUS_TOKEN`. It throws `AgentNotFoundError` for an agent of another project or a `retired` one.
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

- `table`: `projects` (this project's row only), `rounds`, `agents`, `tickets`, `cards`, `turns` (scoped through their agent), `events`, `notebook`, `charter_proposals`, `budget`. `layouts`, `intents`, `schema_migrations`, `project_id` and `agents.session_id` are not readable. Names are matched as own keys of the allowlist, so `constructor` or `__proto__` is just an unknown column.
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

`run` gets the `BusContext` (`store` with `db`, `projectId` and `publish`, plus the caller's `agentId`) and the parsed input. Its string is the tool result; a thrown error becomes an MCP tool error with the error's message, which the agent sees and can correct. Arguments that fail `input` are rejected the same way before `run` is called.

## API

| Export                                                         | What it does                                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `startBusHost({ store, home?, socketPath?, tools? })`          | Starts listening and resolves to `{ socketPath, tools, launch, revoke, close }`. `tools` defaults to `loadBusTools()`.        |
| `busSocketPath(projectId, { home?, tmp? })`, `SOCKET_PATH_MAX` | The socket path for a project (see [Socket path](#socket-path)), and its byte limit.                                          |
| `createBusServer(context, tools)`                              | One MCP server bound to one agent, for any MCP transport (the host uses stdio over the socket; tests use the in-memory pair). |
| `loadBusTools(dir?)`                                           | Imports the tools in `dir` (default `tools/`), sorted by name.                                                                |
| `defineBusTool(spec)`, `BusToolError`                          | Typed tool definition, and an error whose message is meant for the agent.                                                     |
| `buildReadQuery(projectId, request)`                           | The SQL and parameters `read` runs, for tests and for other readers that must stay inside the allowlist.                      |
| `READ_TABLES`, `READ_TABLE_NAMES`, `READ_REPLY_MAX_BYTES`      | The allowlist: readable tables, their columns and kinds, scope and default order.                                             |
| `BUS_RELAY`, `BUS_SOCKET_ENV`, `BUS_TOKEN_ENV`                 | The relay script path and the environment it reads.                                                                           |
