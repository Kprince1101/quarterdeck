# store

The Quarterdeck store: one in-process [PGlite](https://pglite.dev) Postgres per project, migrated from plain SQL files on every start.

## Where the data lives

`~/.quarterdeck/<project>/pg` is the Postgres data dir for one project. Deleting that folder deletes the project's state; the next `openStore` recreates it empty.

`~/.quarterdeck/sock/<hash>.sock` (or `$TMPDIR/quarterdeck-<uid>/<hash>.sock` when the home path is too long) is a project's bus MCP socket; see [bus](../bus/README.md#socket-path). It holds no data, exists only while the server is up, and is removed on shutdown.

`~/.quarterdeck/<project>/pg.lock` holds the pid of the process that has the project open. PGlite takes no lock of its own, and two processes on one data dir silently lose each other's writes, so `openStore` creates this file exclusively and throws `project <p> is already open (pid N)` while that pid is alive. A lock left by a dead pid is reclaimed. `close()` removes it, as does a failed open. `IN_MEMORY` stores are not locked.

## API

```ts
import { openStore } from '@quarterdeck/server';

const store = await openStore({ project: 'commander' });
await store.db.query('select * from tickets where project_id = $1', [
  store.projectId,
]);
const subscription = await store.subscribe((event) => broadcast(event));
await store.publish({ kind: 'ticket.created', payload: { title } });
await subscription.close();
await store.close();
```

| Export                                                   | What it does                                                                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openStore({ project, home?, dataDir? })`                | Locks and opens (creating if needed) the project's data dir, applies pending migrations, upserts the `projects` row and resolves to a `Store`.       |
| `Store.db`                                               | The `PGlite` instance. Use `query(sql, params)` with `$n` parameters, `exec` for multi-statement SQL, `transaction(tx => …)`, `listen(channel, fn)`. |
| `Store.projectId`                                        | The `projects.id` for `project`. Every other table is scoped by `project_id`.                                                                        |
| `Store.dataDir` / `Store.migrated`                       | The data dir in use, and the migration versions this open applied.                                                                                   |
| `Store.publish({ kind, payload?, agentId?, ticketId? })` | Inserts one `events` row for this project and resolves to it as a `StoreEvent`.                                                                      |
| `Store.subscribe(handler, { after?, onError? })`         | Calls `handler` with every event of this project, in id order, one at a time. See [Event bus](#event-bus).                                           |
| `Store.watch(handler, { onError? })`                     | Calls `handler` with every row change of this project's tables, one at a time. See [Table changes](#table-changes).                                  |
| `Store.close()`                                          | Closes open subscriptions and watchers and the database, then releases the lock. Call it on shutdown.                                                |
| `IN_MEMORY`                                              | Pass as `dataDir` for a throwaway in-memory database (tests).                                                                                        |
| `STORE_TABLES`                                           | Every table name, for the Data widget and wipe.                                                                                                      |
| `EVENTS_CHANNEL`                                         | `quarterdeck_events`. Every insert into `events` sends `{"id","project_id","kind"}` on it via `pg_notify`.                                           |
| `CHANGES_CHANNEL` / `WATCHED_TABLES`                     | `quarterdeck_changes`, and the tables whose row changes are sent on it.                                                                              |
| `projectDataDir(project, home?)`                         | The data dir path for a project. Slugs are `[a-z0-9][a-z0-9_-]{0,62}`; anything else throws.                                                         |
| `migrate(db, dir?)`                                      | Applies pending migrations from `dir` (default `migrations/`) and returns their versions. Used by `openStore`.                                       |

## Event bus

Every insert into `events`, through `publish` or plain SQL, fires `pg_notify` on `EVENTS_CHANNEL`. A subscription treats the notification only as a wake-up: it then reads `events` where `id` is past its `cursor`, in batches of `EVENT_BATCH`, so it never depends on the notification payload, never sees another project's events, and never gets an event twice.

- With no `after`, a subscription starts at the newest event and delivers only what is inserted from then on.
- `subscription.cursor` is the id of the last event handed to `handler`. Pass it back as `after` to resume after a disconnect, a closed subscription or a restart; everything inserted in between is replayed first, then live events follow. `after: 0` replays the whole log.
- A handler that throws, or a failed read, goes to `onError` (default: `console.error`) and the subscription keeps going. The failed event is not retried.
- `subscription.close()` stops delivery and waits for the handler call in flight. Calling it twice is safe.

`StoreEvent` is `{ id, projectId, agentId, ticketId, kind, payload, createdAt }`.

## Table changes

Every insert, update and delete on a table in `WATCHED_TABLES` (every table but the `events` and `intents` logs; each recorded intent already writes an event) fires `pg_notify` on `CHANGES_CHANNEL` (`quarterdeck_changes`) with `{"table","op","id","project_id"}`. A watcher drops other projects' notices, re-reads the row by `id` and calls `handler` with a `TableChange`: `{ table, op, id, row }`, where `row` has camelCase keys and is `null` for a delete (or a row deleted before it was read). Because the row is read at delivery, it is always the latest state, never an older version.

Changes have no cursor: a notification sent while nobody is watching is gone. Read the tables again after reconnecting (`readRows(db, projectId, table, { turnsPerAgent? })`), which is what the stream's snapshot does; `turnsPerAgent` keeps only each agent's latest turns.

`turns` rows, from `watch` and `readRows`, leave out `prompt`: it can be large and lives in the table, so read it on demand. A turn's project comes from its agent. When an agent is deleted its turns go with it by cascade and have no project left to report, so those turn deletes reach no watcher. Drop an agent's turns when its delete arrives.

## Migrations

`migrations/NNNN_name.sql`, applied in version order, each in its own transaction together with its row in `schema_migrations`. A failing migration rolls back and stays pending. Any other `*.sql` name in the folder (`0002_AddX.sql`, `2_x.sql`) makes `migrate` throw before anything runs. Tables with `updated_at` keep it current through the `touch_updated_at` trigger. Never edit a migration that has merged; add the next number. `npm run build` copies `migrations/` to `dist/store/migrations/` so the built package finds them next to `dist/store/migrate.js`.

## Tables

| Table               | Holds                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `projects`          | One row per project: `slug`, `name`, `repo_path`, `archived_at` (set once archived; its agents no longer hold their names).     |
| `rounds`            | Numbered rounds per project: `status` planning / active / ended, `goal`.                                                        |
| `agents`            | Planner, Driver, builders, reviewer: `name` (unique per project among agents not `retired`), `role`, `runtime`, `status`.       |
| `tickets`           | Local tickets: `status`, `assignee_id`, `depends_on`, `source` + `external_id` for ticket-source plugins, `pr_url`, `head_sha`. |
| `cards`             | Human gates: `kind`, `question`, `options`, `status` open / answered / declined / expired, `answer`.                            |
| `turns`             | One ACP prompt turn per row: `agent_id`, `seq`, `prompt`, `stop_reason`, token counts, `transcript_path`.                       |
| `events`            | Append-only event log with `kind` and `payload`; inserts notify `EVENTS_CHANNEL`.                                               |
| `notebook`          | Entries the next Driver is born with: `body`, `pinned`, `author_id`, `round_id`.                                                |
| `charter_proposals` | Proposed charter changes: `body`, `rationale`, `status` open / accepted / rejected.                                             |
| `budget`            | Token and USD limits and spend, one row per (project, round, agent) scope; null round/agent is wider.                           |
| `layouts`           | This project's saved dashboard layouts as JSON `spec`, unique by `name`. Shipped presets live in code or `rules/`, not here.    |
| `intents`           | Every intent the HTTP API accepted: `kind`, `input`, `status` pending / applied / rejected, `result`, `settled_at`.             |
