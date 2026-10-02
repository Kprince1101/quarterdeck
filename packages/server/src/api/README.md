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

Every intent but `rules.*` with `scope: "machine"` and `wipe.all` takes a `project` slug, and that project must exist (`project.create` makes it). Each one writes an `intents` row and an `events` row (kind = intent name, payload `{ intentId, status }`) in the same transaction as its change, so `EVENTS_CHANNEL` fires for it. `id` in the reply is the `intents` row. Intents that also change a rules file (`charter.decide` accepted, project-scope `rules.*`) validate the file inside the transaction and write or remove it only after the commit, so a rolled-back intent never leaves a changed file behind.

| Intent                                                                                    | Effect                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `round.start`, `round.end`                                                                | Pending. `round.end` checks the round exists and has not ended.                                                                                                                                                                                                                                                    |
| `pause.set`                                                                               | Pending.                                                                                                                                                                                                                                                                                                           |
| `agent.pause`, `agent.resume`, `agent.end`, `agent.kill`, `agent.retire`, `agent.message` | Pending. The agent must exist and not be ended, killed or retired.                                                                                                                                                                                                                                                 |
| `planner.message`                                                                         | Pending.                                                                                                                                                                                                                                                                                                           |
| `card.answer`, `card.decline`                                                             | Settles an open card. When `options` is a list of strings, the answer must be one of them.                                                                                                                                                                                                                         |
| `notebook.add`, `notebook.pin`, `notebook.remove`                                         | Applied to `notebook`.                                                                                                                                                                                                                                                                                             |
| `charter.decide`                                                                          | Settles an open proposal. Accepting writes its `body` to `<repo>/.quarterdeck/rules.local.charter.md`.                                                                                                                                                                                                             |
| `ticket.create`, `ticket.update`, `ticket.cancel`                                         | Local tickets. `dependsOn` must name tickets in the project. Only open or bounced tickets can be cancelled.                                                                                                                                                                                                        |
| `project.create`, `project.update`                                                        | Creates the project's data dir, sets `name` and `repoPath` (an existing directory, or `null` to clear).                                                                                                                                                                                                            |
| `rules.write`, `rules.reset`                                                              | Writes or removes `rules.local.<file>` in `~/.quarterdeck` (`machine`) or `<repo>/.quarterdeck` (`project`). A write is checked by the rules loader first and refused with the loader's error. Machine-scope changes have no project, so they are not recorded (`id: null`).                                       |
| `layout.save`, `layout.delete`                                                            | Upserts or deletes a named layout `{ columns, items: [{ id, widget, x, y, w, h, hidden, config }] }`.                                                                                                                                                                                                              |
| `wipe.project`                                                                            | `confirm` must repeat the slug. Closes the store and deletes `~/.quarterdeck/<project>/`. With `DATABASE_URL`, it takes the project lock instead (409 while another process has the project open) and deletes the project's rows from every store table plus its `projects` row, in one transaction. Not recorded. |
| `wipe.all`                                                                                | `confirm` must be `wipe everything`. Wipes every project's state (`~/.quarterdeck/<project>/`, or every project in the `projects` table with `DATABASE_URL`). Machine rules (`~/.quarterdeck/rules.local.*`) are configuration, not state, and stay; remove them with `rules.reset`. Not recorded.                 |

Pending intents stay `pending` with `settled_at` null until the logic that owns them marks them `applied` or `rejected`.
