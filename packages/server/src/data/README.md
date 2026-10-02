# data

What Quarterdeck keeps for a project, for the Data widget and wipe. Read through the `data.summary` and `data.rows` intents (see [api](../api/README.md#reading-data)).

## Paths

`dataPaths({ homeDir, project, repoPath?, database? })` is the one list of every path on disk a project uses. `homeDir` is the user's home, not `~/.quarterdeck`. Each entry is `{ label, path, kind, scope }`:

| `scope`   | Paths                                                                                                                                                         | Wiped with the project |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `project` | `~/.quarterdeck/<project>/pg/` and `pg.lock`, or with `database` (the redacted `DATABASE_URL`) that database instead; then `turns/` and `worktrees/`.         | Yes                    |
| `repo`    | `<repo>/.quarterdeck/rules.local.<file>` for every rule, only when the project has a `repoPath`.                                                              | No                     |
| `machine` | `~/.quarterdeck/rules.local.<file>` for every rule, then `plugins/`, `pause.json`, `sock/`, `kiro/`, `gemini/` and `runtimes/claude/` under `~/.quarterdeck`. | No                     |

`kind` is `directory`, `file` or `database`. `withPresence(paths)` adds `exists` to each (a database always exists). Layouts are rows in the `layouts` table, not files. The docs page `site/public/docs/data.html` is tested to name every path this function returns.

## Tables

`countTables(db, projectId)` counts the project's rows in every `STORE_TABLES` table, in that order. `readTablePage(db, projectId, table, { offset, limit })` reads one page: every column, newest first (`id` desc for `turns` and `events`, `number` desc for `rounds`, `updated_at` desc for `budget`, `name` for `layouts`, `created_at` desc for the rest), `bigint` cells as strings and timestamps as ISO strings. `isStoreTable(name)` guards the table name, which is never taken from a request without it.
