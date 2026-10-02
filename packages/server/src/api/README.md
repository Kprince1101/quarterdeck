# api

The HTTP intents API. The dashboard never writes state; it sends an intent and the server applies it.

```ts
import { startApiServer } from '@quarterdeck/server';

const api = await startApiServer({ port: 4317 });
await fetch(`${api.url}/api/intents/notebook.add`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ project: 'deck', body: 'remember this' }),
});
await api.close();
```

## Dashboard

Everything outside `/api` is the dashboard. `startApiServer({ dashboardDir })` serves the files in that folder with `GET` and `HEAD` (405 otherwise), and `index.html` for any path without a file extension, so the dashboard's own routes load. A path with an extension and no file is a 404, and nothing outside `dashboardDir` is ever served. Without `dashboardDir`, or before it holds an `index.html`, those paths get `DASHBOARD_PLACEHOLDER`, a page that says the server is running. The Host and Origin guard below applies to every path. `quarterdeck up` passes `@quarterdeck/dashboard`'s `dist/`.

## Requests

`POST /api/intents/<name>` with a JSON body. The schemas live in `src/intents/`, exported as `@quarterdeck/server/intents`. That module imports nothing but `zod` and `@quarterdeck/rules/schemas`, so the dashboard can import it without pulling in Node.

The server binds `127.0.0.1` only. It refuses a `Host` that is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), an `Origin` that is not one of those or in `allowedOrigins`, a `Content-Type` other than `application/json`, and a body over 1 MiB.

| Status | Meaning                                                                                      |
| ------ | -------------------------------------------------------------------------------------------- |
| 200    | Applied: `{ intent, status: "applied", id, result }`.                                        |
| 202    | Recorded for the Driver, lifecycle or Planner to apply: `{ intent, status: "pending", id }`. |
| 400    | Invalid body: `{ error, issues? }`, where `issues` are zod's `{ path, message }`.            |
| 403    | Host or Origin refused.                                                                      |
| 404    | Unknown route, intent, project, or a row the intent names.                                   |
| 405    | Not a POST.                                                                                  |
| 409    | The row is in a state the intent cannot change, or the project is open in another process.   |
| 413    | Body too large.                                                                              |
| 415    | Not JSON.                                                                                    |

## Intents

Every intent but `rules.*` with `scope: "machine"`, `wipe.all` and `pause.all` takes a `project` slug, and that project must exist (`project.create` makes it). Each one writes an `intents` row and an `events` row (kind = intent name, payload `{ intentId, status }`) in the same transaction as its change, so `EVENTS_CHANNEL` fires for it. `id` in the reply is the `intents` row. Intents that also change a rules file (`charter.decide` accepted, project-scope `rules.*`) validate the file inside the transaction and write or remove it only after the commit, so a rolled-back intent never leaves a changed file behind.

| Intent                                                     | Effect                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `round.start`, `round.end`                                 | Pending. `round.end` checks the round exists and has not ended.                                                                                                                                                                                                                                                                                                           |
| `pause.set`                                                | Applied. `paused: true` sets `projects.paused_at` (kept if already set), `false` clears it. Result `{ paused, pausedAt }`. See [pause](../pause/README.md).                                                                                                                                                                                                               |
| `pause.all`                                                | Applied, no project. Writes or removes `~/.quarterdeck/pause.json`, then records an applied `pause.all` intent in every project so each project's pause gate re-checks what it holds. A project that cannot be opened does not stop the rest. Result `{ paused, projects, failed: [{ project, error }] }`, `id: null`.                                                    |
| `agent.pause`, `agent.resume`                              | Applied. `agent.pause` makes a live agent `paused` (409 if it is already paused, ended, killed or retired). `agent.resume` makes a `paused` agent `working` if it has a turn still open, `idle` otherwise (409 if it is not paused). Result `{ agentId, status }`.                                                                                                        |
| `agent.end`, `agent.kill`, `agent.retire`, `agent.message` | Pending. The agent must exist and not be ended, killed or retired.                                                                                                                                                                                                                                                                                                        |
| `planner.message`, `planner.new`                           | Pending, applied by the Planner (see [planner](../planner/README.md)). `planner.new` ends the conversation; the next message starts a new one.                                                                                                                                                                                                                            |
| `card.answer`, `card.decline`                              | Settles an open card. When `options` is a list of strings, the answer must be one of them.                                                                                                                                                                                                                                                                                |
| `notebook.add`, `notebook.pin`, `notebook.remove`          | Applied to `notebook`.                                                                                                                                                                                                                                                                                                                                                    |
| `charter.decide`                                           | Settles an open proposal. Accepting writes its `body` to `<repo>/.quarterdeck/rules.local.charter.md`.                                                                                                                                                                                                                                                                    |
| `ticket.create`, `ticket.update`, `ticket.cancel`          | Local tickets. `dependsOn` must name tickets in the project. Done, cancelled and rejected tickets cannot be updated. Only open or bounced tickets can be cancelled.                                                                                                                                                                                                       |
| `ticket.approve`, `ticket.reject`                          | Settle a `proposed` ticket from the Planner. `ticket.approve` takes optional `title`, `body` and `dependsOn` edits, refuses while any dependency is still proposed or rejected, and makes the ticket `open`. `ticket.reject` makes it `rejected`.                                                                                                                         |
| `project.create`, `project.update`                         | Creates the project's data dir, sets `name` and `repoPath` (an existing directory, or `null` to clear).                                                                                                                                                                                                                                                                   |
| `rules.write`, `rules.reset`                               | Writes or removes `rules.local.<file>` in `~/.quarterdeck` (`machine`) or `<repo>/.quarterdeck` (`project`). A write is checked by the rules loader first and refused with the loader's error. Machine-scope changes have no project, so they are not recorded (`id: null`).                                                                                              |
| `layout.save`, `layout.delete`                             | Upserts or deletes a named layout `{ columns, items: [{ id, widget, x, y, w, h, hidden, config }] }`.                                                                                                                                                                                                                                                                     |
| `wipe.project`                                             | `confirm` must repeat the slug. Closes the store and deletes `~/.quarterdeck/<project>/`. With `DATABASE_URL`, it takes the project lock instead (409 while another process has the project open) and deletes the project's rows from every store table plus its `projects` row, in one transaction, then deletes `~/.quarterdeck/<project>/` (turn files). Not recorded. |
| `wipe.all`                                                 | `confirm` must be `wipe everything`. Wipes every project's state (`~/.quarterdeck/<project>/`, or every project in the `projects` table with `DATABASE_URL`). Machine rules (`~/.quarterdeck/rules.local.*`) are configuration, not state, and stay; remove them with `rules.reset`. Not recorded.                                                                        |

Pending intents stay `pending` with `settled_at` null until the logic that owns them marks them `applied` or `rejected`.
