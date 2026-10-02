# quarterdeck

The `quarterdeck` command. `npx quarterdeck <command>`, or `node packages/cli/dist/bin.js <command>` in this repo after `npm run build`.

## up

```sh
quarterdeck up [--port <port>]
```

Starts the server on `127.0.0.1` (port 4317 by default, `0` picks a free one), creates `~/.quarterdeck/` if it is missing, and prints the URL. The same port serves the HTTP intents API under `/api/` and the dashboard everywhere else. The dashboard is the built bundle in `@quarterdeck/dashboard`'s `dist/`; until that exists, a placeholder page says the server is running. Ctrl+C (or `SIGTERM`) closes the server and every open project store, then exits 0. A port that is already in use is an error that says so.

`DATABASE_URL` switches the store to an external Postgres, as it does for the server.

## init

```sh
quarterdeck init [repo-path] [--project <slug>] [--name <name>] [--runtime kiro|claude|gemini] [--folder | --no-folder]
```

Creates `~/.quarterdeck/` and a project (the `project.create` intent) for the git repository at `repo-path`, the current directory by default. The slug comes from the folder name (lowercased, other characters turned into `-`) unless `--project` is given; the display name is the folder name unless `--name` is given. A project that already exists is an error.

The runtime is asked for when stdin is a terminal, and otherwise taken from `--runtime` or left at the current default (`models.json`, `kiro` out of the box). Choosing the runtime the project would already get writes nothing. Choosing another one writes `models` for every role, through the `rules.write` intent, to one of two places:

| Choice        | File                                          | Applies to                                     |
| ------------- | --------------------------------------------- | ---------------------------------------------- |
| `--folder`    | `<repo>/.quarterdeck/rules.local.models.json` | This project only.                             |
| `--no-folder` | `~/.quarterdeck/rules.local.models.json`      | Every project on this machine without its own. |

Interactively, init asks which; without a terminal it refuses to guess and asks for one of the two flags. The `.quarterdeck/` folder is the only thing init ever writes into the repository, and only after that yes. An existing layer file keeps its other settings. If the repository already has a `rules.local.models.json`, it wins over the machine layer, so `--no-folder` is refused there.

Every question and check runs before anything is created, so a failed or cancelled init (Ctrl+C at a prompt exits 130) leaves nothing behind.
