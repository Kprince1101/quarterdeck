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

## doctor

```sh
quarterdeck doctor
```

Checks the three agent runtimes and `gh`: installed, which version, and signed in. Each one gets a line; each miss is followed by the exact command to run. It exits 0 when everything is ready and 1 otherwise. It never signs in for you and never starts a download.

```
kiro-cli: 1.20.1, not signed in
  Sign in: kiro-cli login
claude: 2.1.30, signed in (legion@example.com)
gemini: 0.9.0, signed in (Google account)
gh: 2.81.0, signed in (legion on github.com)

1 of 4 need attention. Run the commands above, then quarterdeck doctor again.
```

| Tool       | Installed                                                                                                                          | Signed in                                                                                                                           | Install                                                                                              | Sign in                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `kiro-cli` | `kiro-cli --version`                                                                                                               | `kiro-cli whoami` exits 0                                                                                                           | `curl -fsSL https://cli.kiro.dev/install \| bash`                                                    | `kiro-cli login`                                                                     |
| `claude`   | `npx --yes --offline @agentclientprotocol/claude-agent-acp@0.85.0 --cli --version`, the same pinned package and CLI the agent runs | `… --cli auth status --json` reports a claude.ai login, an API key or a non-Anthropic backend                                       | `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli --version` fetches it                  | `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --claudeai` |
| `gemini`   | `gemini --version`                                                                                                                 | `GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI=true` with `GOOGLE_API_KEY` or `GOOGLE_CLOUD_PROJECT`, or `~/.gemini/oauth_creds.json` | `npm install -g @google/gemini-cli`                                                                  | `gemini`, then choose Login with Google (or set `GEMINI_API_KEY`)                    |
| `gh`       | `gh --version`                                                                                                                     | `gh auth status` exits 0                                                                                                            | `brew install gh` (macOS), `winget install --id GitHub.cli` (Windows), otherwise the gh install docs | `gh auth login`                                                                      |

Quarterdeck runs claude through npx, so a standalone `claude` is not needed and not checked; the claude commands work without one. The claude probes run offline, from a neutral folder, with `npm_config_registry` set to the public registry, as the agent does. If npx has not fetched the pinned package yet, doctor says so instead of starting the 240 MB download itself. Each probe gets 15 seconds.

`test/doctor.test.ts` runs every check against fake binaries on `PATH`. kiro-cli is only faked signed out; the signed-in path needs Legion's real `kiro-cli`:

```sh
QUARTERDECK_LIVE=1 npx vitest run packages/cli/test/doctor-live.test.ts
```
