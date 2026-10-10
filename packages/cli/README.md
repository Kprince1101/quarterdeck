# @quarterdeck/cli

The `quarterdeck` command, run from the clone as `npm run quarterdeck -- <command>` after `npm install` (which builds it; see [Running it](../../README.md#running-it)). The root script runs `scripts/quarterdeck.mjs`, which starts `dist/bin.js` in the folder `npm run` was typed in, so `npm --prefix <clone> run quarterdeck -- <command>` works from any folder. The package is private and never published; the `quarterdeck` package on npm is unrelated.

The CLI's own usage text and the commands it prints (`Next: npm run quarterdeck -- up`) use the same form, `QUARTERDECK_COMMAND` from `@quarterdeck/server`.

## up

```sh
npm run quarterdeck -- up [--port <port>]
```

Starts the server on `127.0.0.1` (port 4317 by default, `0` picks a free one), creates `~/.quarterdeck/` as `0700` if it is missing (and tightens it to `0700` if it is looser), and prints the URL to open: `http://127.0.0.1:<port>/#token=<token>`. The token is new on every start, written to `~/.quarterdeck/api.token` (mode `0600`) and removed on a clean stop; every API request and the stream need it (see [api](../server/src/api/README.md#token)), and the dashboard takes it from the URL's fragment, which the browser never sends to the server. A command that talks to the running server reads it from `~/.quarterdeck/api.token`. The same port serves the HTTP intents API under `/api/` and the dashboard everywhere else. The dashboard is the built bundle in `@quarterdeck/dashboard`'s `dist/`; until that exists, a placeholder page says the server is running. At startup it opens every project in `~/.quarterdeck/` and recovers it from the last run (see [lifecycle](../server/src/lifecycle/README.md#recovery)): agent processes left running are reaped, overdue cards expire and work a pause was holding is dropped. Ctrl+C (or `SIGTERM`) closes every ACP client the server started, which stops each agent's process group, then the server and every open project store, then exits 0. Another Ctrl+C or `SIGTERM` while it stops is ignored, since `npm run` passes each one on a second time. A port that is already in use is an error that says so.

`DATABASE_URL` switches the store to an external Postgres, as it does for the server.

With no workspace yet (no `~/.quarterdeck/workspace.json`, or one with no projects), `up` starts anyway, prints one more line under the URL (`No workspace yet: open the URL above and Setup walks you through the folder, the runtime and sign-in.`), and the dashboard opens on the [Setup screen](#setup) instead of the board. It signs nothing in from the terminal then: Setup does it.

In a terminal, with a workspace, `up` first runs doctor's runtime checks for every runtime `~/.quarterdeck/rules.local.models.json` (or the default) gives a role, and signs in each one that is installed but signed out, as doctor does (see [Signing in](#signing-in)). Then it starts. A sign-in that fails is one line naming why, and `up` carries on: when an agent of that runtime starts, the dashboard shows the [sign-in card](../server/src/signin/README.md). Without a terminal (stdin or stdout not a TTY) `up` checks nothing and the dashboard card does it all.

The port also serves the WebSocket stream at `/ws` (`?project=<slug>` picks the project when more than one is open), and each open project gets its bus host, the socket its agents' MCP relay connects to (see [bus](../server/src/bus/README.md)). A socket file left by a crash is removed at start.

Each open project also gets its crew (see [crew](../server/src/crew/README.md)): the Planner answers the Planner widget, Start Voyage births a Driver that assigns approved tickets to builders, the reviewer and merge gate take each reported pull request to a merge under the project's rules, and a settled voyage ends itself. A project created while `up` runs gets its crew at once; a wiped one stops its crew first. A voyage still open from a run that stopped is ended at start with reason `restart` and its tickets reopened, since its agents went with that run. One project's crew failing is recorded as a `crew.failed` event on the dashboard and stops nothing else.

On stop, each project's agents stop first, then its stream and bus host (removing the socket file), then everything above. All of it is [`startQuarterdeck`](../server/src/quarterdeck/README.md).

### Setup

The Setup screen is one page with five steps and a progress line (`Step 2 of 5: Runtime`). Each step is a `setup.*` intent on the same token-protected API, and runs the code `init` and `doctor` run (see [setup](../server/src/setup/README.md)):

1. **Workspace.** Type or paste a folder's full path (`~/` works); `setup.detect` runs init's detection and says `One repository: <name>` or lists the repositories found, each with a box to untick. Browsers give a page no folder path from a picker, so there is no native picker.
2. **Runtime.** `setup.tools` runs doctor's checks, through `createSetupProbe` in `src/setup-probe.ts`, which `up` hands the server. Only installed runtimes can be picked; each missing one shows doctor's install command. With exactly one installed, it is picked for you.
3. **Profile.** The [rules profile](../../docs/rules-profiles.md) agents follow, from the `profiles` of `GET /api/rules`: every installed profile, what chose the active one, and the files the picked one reads. Keeping the active profile writes nothing; picking another says it writes `"profile": "<name>"` to `~/.quarterdeck/rules.local.profile.json`. Below it are the steering files a person may edit later (charter, reviewer, permissions, profile), each with its path and one line on what it controls. The profile's repo setup still runs from `init --setup` or `profile setup`.
4. **Sign in.** The picked runtime and the forge CLI each repository's `origin` needs (`gh`, or `glab` per GitLab host), each with its state. **Sign in to …** runs the same sign-in as [Signing in](#signing-in) on the server, with no terminal, and the step shows its progress (the code, the URL) until it settles; then the checks run again.
5. **Go.** The step lists the files it writes. `setup.save` writes a picked profile through `rules.write` (which refuses one not installed), then does what `init` does, through the same `applySetup`: a project for each repository, the runtime in `~/.quarterdeck/rules.local.models.json` when it is not the default, and `workspace.json`. A repository whose own `rules.local.models.json` would win is refused, as `init` refuses it. The board opens with the Planner ready and a **What to do first** panel (describe the work to the Planner, approve, Start Voyage) that goes away once the first voyage starts.

Signing in is not required to go on: anything still signed out is asked for again on the dashboard when an agent needs it. Once a workspace exists, `setup.save` refuses (`409`); add repositories with `init`.

## init

```sh
npm run quarterdeck -- init [path] [--project <slug>] [--name <name>] [--skip <slug>]... [--runtime kiro|claude|gemini] [--folder | --no-folder]
```

Picks the workspace (see [workspace](../server/src/workspace/README.md)): creates `~/.quarterdeck/` (`0700`), a project (the `project.create` intent) for each repository, and `~/.quarterdeck/workspace.json`. `path` is the current directory by default.

- **A git repository** (it has a `.git`): one project, and the workspace is in `single` mode, so nothing in Quarterdeck mentions projects. The slug comes from the folder name (lowercased, other characters turned into `-`) unless `--project` is given; the display name is the folder name unless `--name` is given. A project that already exists is an error.
- **A folder of git repositories** (like `~/Developer/Repos`): every child folder with a `.git`, one level down, is listed with its number, slug, `origin` and path, and becomes a project; the workspace is in `multi` mode. Interactively, init asks which to untick (`2 4`, enter keeps them all); scripted, `--skip <slug>` leaves one out, as often as needed. Repositories already in the workspace are listed as already a project and left alone, so running it again adds only the new ones. `--project` and `--name` are refused here. A path that is neither is an error.

A single-repository workspace that gets a second repository, from another `init` or from `project.create` on the dashboard, switches to `multi` and init prints one line saying so: `Workspace switched to multi mode: it now has 2 repositories, and each one is a project.` It never switches silently, and never back.

The runtime is asked for when stdin is a terminal, and otherwise taken from `--runtime` or left at the current default (`models.json`, `kiro` out of the box). Choosing the runtime the project would already get writes nothing. Choosing another one writes `models` for every role, through the `rules.write` intent, to one of two places:

| Choice        | File                                          | Applies to                                     |
| ------------- | --------------------------------------------- | ---------------------------------------------- |
| `--folder`    | `<repo>/.quarterdeck/rules.local.models.json` | This project only.                             |
| `--no-folder` | `~/.quarterdeck/rules.local.models.json`      | Every project on this machine without its own. |

Interactively, init asks which; without a terminal it refuses to guess and asks for one of the two flags. For a folder of repositories the runtime is saved on the machine (`--folder` is refused there), and a repository whose own `rules.local.models.json` would win is an error naming it. The `.quarterdeck/` folder is the only thing init ever writes into the repository, and only after that yes. An existing layer file keeps its other settings. If the repository already has a `rules.local.models.json`, it wins over the machine layer, so `--no-folder` is refused there.

Every question and check runs before anything is created, so a failed or cancelled init (Ctrl+C at a prompt exits 130) leaves nothing behind. What it then writes, it writes through `applySetup` from `@quarterdeck/server`, the function the [Setup screen](#setup) saves with.

Once the projects exist, init in a terminal signs in what they need, as doctor does (see [Signing in](#signing-in)): the runtime it chose, and the forge of each added repository's `origin` (`glab` for a GitLab host, `gh` otherwise; nothing for a repository without an origin). Then it prints `Next:` as usual. A sign-in that fails is one line naming why; init still succeeds.

## doctor

```sh
npm run quarterdeck -- doctor
```

Checks the three agent runtimes and `gh`: installed, which version, and signed in. In a terminal, every tool that is installed but signed out is then signed in through its own browser sign-in, one at a time, and doctor checks everything again (see [Signing in](#signing-in)). Each tool gets a line; each miss that is left is followed by the exact command to run, and by why the automatic sign-in did not fix it. It exits 0 when everything is ready and 1 otherwise. It never starts a download.

```
Signing in to Kiro with its own browser sign-in...
  Signed in to Kiro.
kiro-cli: 1.20.1, signed in (user@example.com)
claude: 2.1.30, signed in (user@example.com)
gemini: 0.9.0, signed in (Google account)
gh: 2.81.0, signed in (example-org on github.com)
claude auth: subscription (the default), uses the Claude Code sign-in
keep-awake: caffeinate found; the dashboard can keep this computer from sleeping

All set.
```

When a sign-in fails, or doctor runs without a terminal, the command stays:

```
gh: 2.81.0, not signed in
  Sign in: gh auth login
  Why: automatic sign-in failed: gh auth login --web exited with 1: error: device flow was denied

1 of 6 need attention. Run the commands above, then npm run quarterdeck -- doctor again.
```

| Tool       | Installed                                                                                                                          | Signed in                                                                                                                           | Install                                                                                              | Sign in                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `kiro-cli` | `kiro-cli --version`                                                                                                               | `kiro-cli whoami` exits 0                                                                                                           | `curl -fsSL https://cli.kiro.dev/install \| bash`                                                    | `kiro-cli login`                                                                     |
| `claude`   | `npx --yes --offline @agentclientprotocol/claude-agent-acp@0.85.0 --cli --version`, the same pinned package and CLI the agent runs | `… --cli auth status --json` reports a claude.ai login, an API key or a non-Anthropic backend                                       | `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli --version` fetches it                  | `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --claudeai` |
| `gemini`   | `gemini --version`                                                                                                                 | `GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI=true` with `GOOGLE_API_KEY` or `GOOGLE_CLOUD_PROJECT`, or `~/.gemini/oauth_creds.json` | `npm install -g @google/gemini-cli`                                                                  | `gemini`, then choose Login with Google (or set `GEMINI_API_KEY`)                    |
| `gh`       | `gh --version`                                                                                                                     | `gh auth status` exits 0                                                                                                            | `brew install gh` (macOS), `winget install --id GitHub.cli` (Windows), otherwise the gh install docs | `gh auth login`                                                                      |

When a GitLab host is in use, doctor checks `glab` too, once per host: every host mapped to `gitlab` in `~/.quarterdeck/rules.local.forges.json`, and the origin host of the folder it runs in when that is on GitLab (`gitlab.com` or a mapped host). With no GitLab host it says nothing about `glab`. A missing `glab` is one line naming the hosts that need it, with the install command (`brew install glab` on macOS, `winget install --id GLab.GLab` on Windows, otherwise the glab install docs) and a sign-in per host. An installed one gets a line per host: signed in when `glab auth status --hostname <host>` exits 0, and otherwise `glab auth login --hostname <host>`.

```
glab on git.example.org: 1.46.1, signed in (example-user on git.example.org)
```

The `claude auth` line reports this machine's [Claude auth mode](../server/src/acp/runtimes/README.md#auth-modes) (`subscription`, `api_key` or `vertex`), where it was set (`QUARTERDECK_CLAUDE_AUTH`, `~/.quarterdeck/claude.json` or the default), and whether the env the mode needs is there: for `api_key`, `ANTHROPIC_API_KEY` from the environment or, on macOS, the Keychain item `quarterdeck-anthropic-api-key`; for `vertex`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` and gcloud's application-default credentials. Anything missing is a `Set` (or `Sign in`) fix and counts toward the exit code. The `claude` probe runs with the env the mode gives agents, so a key found only in the Keychain counts as signed in. The key itself is never printed. `checkClaudeAuth` lives in `src/doctor-claude-auth.ts`.

```
claude auth: api_key (from QUARTERDECK_CLAUDE_AUTH), ANTHROPIC_API_KEY not set
  Set: export ANTHROPIC_API_KEY=<your key>, then start Quarterdeck from that shell
  Set: security add-generic-password -a "$USER" -s quarterdeck-anthropic-api-key -w
```

The `keep-awake` line says whether this computer has the tool the dashboard's [keep-awake](../server/src/keep-awake/README.md) control needs: `caffeinate` on macOS, `systemd-inhibit` on Linux, `powershell` on Windows, looked up on `PATH`. Without it, or on any other platform, the line gives the reason and says the control is off; the dashboard shows the same reason on the disabled control. It is informational and does not change the exit code. `checkKeepAwake` lives in `src/doctor-keep-awake.ts`.

```
keep-awake: systemd-inhibit is not on PATH, so Quarterdeck cannot keep this computer awake. The dashboard's keep-awake control is off.
```

When `kiro.json` names a Kiro base agent for any role, doctor adds a line per role with the base it resolves to, `none`, or the error naming the missing or broken file. The builder's comes from the repo layer of the folder doctor runs in. These lines are informational and do not change the exit code. See [Base agents](../server/src/acp/runtimes/README.md#base-agents).

```
kiro base for driver: everyday (/home/me/.kiro/agents/everyday.json)
kiro base for reviewer: none
kiro base for builder: library-builder (/work/library/.kiro/agents/library-builder.json)
```

Quarterdeck runs claude through npx, so a standalone `claude` is not needed and not checked; the claude commands work without one. The claude probes run offline, from a neutral folder, with `npm_config_registry` set to the public registry, as the agent does. If npx has not fetched the pinned package yet, doctor says so instead of starting the 240 MB download itself. Each probe gets 15 seconds.

`test/doctor.test.ts` runs every check against fake binaries on `PATH`. kiro-cli is only faked signed out; the signed-in path needs a real, signed-in `kiro-cli`:

```sh
QUARTERDECK_LIVE=1 npx vitest run packages/cli/test/doctor-live.test.ts
```

### Signing in

doctor, `up` and `init` share one sign-in path, `src/signin.ts`, and the Setup screen runs the same drivers (`runSignIn`) on the server. A check is a sign-in miss when its only fix is `Sign in`; a tool that is not installed is left to its install command. Each miss is mapped to its tool by the check's name and signed in by that tool's own flow:

| Tool             | How Quarterdeck signs it in                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`         | claude-agent-acp's `claude-ai-login` method: `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --claudeai`, which opens the browser for the claude.ai login. |
| `kiro-cli`       | ACP `authenticate` with `kiro-login` on `kiro-cli acp`; if `kiro-cli whoami` still fails, `kiro-cli login`, which opens the browser (a device code over SSH).                       |
| `gemini`         | ACP `authenticate` with `oauth-personal` on `gemini --acp`: Gemini CLI's Log in with Google.                                                                                        |
| `gh`             | `gh auth login --web --git-protocol https`: GitHub's device flow, with the one-time code.                                                                                           |
| `glab on <host>` | `glab auth login --hostname <host> --web --git-protocol https`: GitLab's OAuth web login.                                                                                           |

The runtime drivers, and the pinned method ids with where each comes from, are in [Signing in](../server/src/acp/runtimes/README.md#signing-in). The forge commands are `GH_WEB_SIGN_IN` and `glabWebSignIn(host)`, run by `runLoginProcess` from `@quarterdeck/server`.

In the terminal the login gets the terminal itself, so it prints its own code and prompts (gh asks for Enter before it opens the browser). An ACP sign-in prints what the runtime reports: `Code: …` and `Open: …`, with the URL opened in the default browser. When the tool exits, doctor runs every check again and reports the result: no command typed, nothing re-run.

The terminal runner is `CliIo.signIn`. `bin.ts` sets it to `terminalSignIn` only when both stdin and stdout are terminals; without it, doctor, `up` and `init` sign nothing in and doctor prints the commands as before. Tests set `signIn` to a stub. Quarterdeck never sees or stores a token: each tool keeps its credentials where it always does.

`test/signin.test.ts` covers the check-to-tool mapping, doctor running a stub runtime sign-in and finishing green, doctor signing a fake `gh` in through `gh auth login --web` (the code shown, the URL opened, then green), a failed `gh` login that leaves the command with why, and init signing its runtime in.

## replay

```sh
npm run quarterdeck -- replay <voyage> [n] [--project <slug>] [--runtime kiro|claude|gemini]
```

Sends a voyage's saved Driver prompts again, turns 1 to `n` of the voyage (1 is the birth; all of them by default), in one new session, and prints each reply as it arrives. This is the command the Driver widget prints (`replayCommand`). It is for seeing how the Driver reads a turn now, for example after changing the charter or the runtime.

```
Replaying voyage 3 of example: Driver driver-1 (7d0f3a4e-2b1c-4c5d-9e8f-0a1b2c3d4e5f), turns 1 to 2 of 5, on kiro.
Nothing is saved. The agent has no Quarterdeck tools and every permission is refused.

--- Turn 1 of 2 ---
<the reply>
(end_turn; turn result parsed; differs from the saved reply)

--- Turn 2 of 2 ---
…
Replayed 2 turns.
```

The voyage is found from the turn files under `~/.quarterdeck/<project>/turns/`, never the store, so replay runs while `quarterdeck up` has the project open and writes no row. Without `--project`, the voyage must be in exactly one project. A voyage spans every project but its Driver's turns are saved under its lead project only, and voyages are numbered across every project, so this holds for every voyage but older ones from when each project counted its own; for those, replay names the projects and asks for `--project`. If the voyage's Driver session was opened more than once, the latest is replayed. An `n` past the voyage's last turn is an error that says how many turns the voyage has. The runtime is `--runtime`, or else the Driver's runtime in `~/.quarterdeck/rules.local.models.json` (a project's `.quarterdeck/` folder is not read, since replay doesn't know the repository).

Replay writes nothing: it uses `replayDriverChain` (see [the driver README](../server/src/driver/README.md#replay)), so the agent runs in a throwaway folder that is removed afterwards, gets no MCP servers, and every permission request is refused. Kiro's adapter writes its launch config for an agent named `replay-<seq>` while the replay runs and removes it after.

If the runtime needs sign-in, replay exits 1 and prints the command to run:

```
Claude is not signed in; run `…` to sign in, then replay again
Sign in: …
```

A missing `input.md` in the chain is an error naming the file, before anything starts. Ctrl+C closes the agent and exits 130.

`test/replay.test.ts` runs the command against a stub runtime adapter; `packages/server/test/driver/replay.test.ts` covers `replayDriverChain` against real ACP agents.

## wipe

```sh
npm run quarterdeck -- wipe <project> [--confirm <project>]
npm run quarterdeck -- wipe --all [--confirm "wipe everything"]
```

Does what the Data widget's Wipe buttons do, through the same `wipe.project` and `wipe.all` intents: the project is archived, every live agent is killed, every process group it started is swept and each worktree is removed, then its rows and its folder under `~/.quarterdeck/` are deleted (see [where your data lives](../../README.md#where-your-data-lives)). Rules files and the rest of `~/.quarterdeck/` stay.

The confirmation is the dashboard's: type the project slug, or `wipe everything` for `--all`. Anything else wipes nothing and exits 1. Without a terminal there is no prompt, so pass the phrase you would have typed as `--confirm`; without it, wipe refuses. A project that does not exist is an error before anything is asked, and `--all` with no projects says there is nothing to wipe and exits 0.

```
$ npm run quarterdeck -- wipe deck
This stops deck's agents and deletes everything Quarterdeck stores for it in /home/you/.quarterdeck/deck.
Type deck to wipe: deck
Wiped deck. Stopped wren (deck) first.
```

Wipe opens the project's store itself, so it refuses (exit 1) while `quarterdeck up` or anything else has the project open: stop the server first, or use the dashboard. If a process cannot be confirmed stopped, the server's 409 is printed and the project is kept, archived, so the next start sweeps it.

## import harness

```sh
HARNESS_DATABASE_URL=postgres://… npm run quarterdeck -- import harness [--dry-run]
HARNESS_DATABASE_URL=postgres://… npm run quarterdeck -- import harness --apply [--include-archived]
```

A one-shot move from Harness: its projects, its docket items that are not `completed` and its `active` notebook entries become Quarterdeck projects, tickets and notebook entries. Without `--apply` (or with `--dry-run`) it only prints what it would do and writes nothing.

**Reading Harness.** The connection string is `--database-url` or `HARNESS_DATABASE_URL`; prefer the variable, since a flag shows in the process list. It is never printed, logged or written anywhere: a failure prints the error with the string and its password replaced by `[redacted]`. The connection (`connectPostgresSession` from `@quarterdeck/server`, application name `quarterdeck-import`) first runs `set default_transaction_read_only = on` and checks it took, then reads `harness_projects`, `docket_items` and `harness_notebook` in one `repeatable read read only` transaction, each row as `to_jsonb`, so a column Harness does not have (`depends_on`, say) reads as empty. Harness is never written to.

**Mapping.**

| Harness                                                     | Quarterdeck                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness_projects` row                                      | A project, made by the `project.create` intent like the dashboard's. An existing project with the same name (or slug, or repository) is matched, not duplicated. The slug comes from the name (`slugFromFolder`). The first of `repos`, with `~` expanded, is its repository if it is a folder here; the rest are printed, since a project has one repository. `paused` pauses a new project. Archived projects are skipped unless `--include-archived`. |
| `copilot_review`, `auto_merge`                              | `mergeGate.requireAiReview` and `mergeGate.autoMerge` in the home layer, `~/.quarterdeck/rules.local.lifecycle.json`, never a repo layer. That layer is one for the machine, so the stricter value wins: AI review if any imported project had it, auto-merge only if every one did. A deprecated `requireCopilotReview` key there is replaced.                                                                                                          |
| `reviewer`                                                  | Not imported as an agent. Printed, so you can set up the global reviewer.                                                                                                                                                                                                                                                                                                                                                                                |
| `docket_items` row                                          | A ticket in its project with `source` `harness` and `external_id` the Harness id. `proposed` stays `proposed`, `blocked` stays `blocked`, everything else (`approved`, and `in_progress` / `in_review` / `assigned` / `bounced`, which are in flight) is `open`. No agent assignment is imported.                                                                                                                                                        |
| `description`, `priority`, `pr_url`, `parent_id`, `context` | The description, then a footer: the Harness id, the priority unless `normal`, a note that it was in flight, the pull request (also kept in `pr_url`), the parent's new ticket id, and the context as JSON.                                                                                                                                                                                                                                               |
| `depends_on`                                                | The new ticket ids, across projects too. A dependency that was not imported (completed, or in a skipped project) is dropped and printed.                                                                                                                                                                                                                                                                                                                 |
| `harness_notebook` row                                      | An active notebook entry in its project, keeping `pinned` and `created_at`, with `external_id` the Harness id. A global entry is copied into every imported project, since each project has its own store.                                                                                                                                                                                                                                               |

**Running it again** updates what it imported before, matched on the Harness id, and adds nothing twice: a second run with nothing changed in Harness prints `Nothing to change: everything is already imported.` and writes nothing. A ticket is only updated while it is still `proposed`, `open` or `blocked` in Quarterdeck, and a retired notebook entry is left retired; once Quarterdeck has picked something up, it keeps it. Each project's tickets and notebook entries are written in one transaction, which records `tickets.imported` and `notebook.imported` with `{ source: "harness", created, updated }`.

**Refusals.** It opens every project's store, so like wipe it refuses while `quarterdeck up` has a project open. It refuses while any project has a voyage that has not ended, before it reads Harness.

```
$ npm run quarterdeck -- import harness
Read from Harness: 2 projects, 3 open docket items, 1 active notebook entry.
Project ui-kit (new), from Harness project "ui-kit"
  tickets: 2 to create, 0 to update, 0 unchanged, 0 left as they are
    ticket 9c1e… "Add the dial": create; approved -> open
    ticket 4b7d… "Ship the gauge": create; in_review -> open (in flight in Harness; noted in the description); 1 dependency remapped
  notebook entries: 1 to create, 0 to update, 0 unchanged, 0 left as they are
    notebook entry 0f2a…: create; pinned
…
Rules in /home/you/.quarterdeck/rules.local.lifecycle.json: mergeGate.requireAiReview true (copilot_review on in ui-kit); mergeGate.autoMerge false (auto_merge off in ui-kit); to write.
Dry run: nothing written. Run again with --apply to import.
```

`test/import-harness.test.ts` seeds an in-memory PGlite shaped like Harness's tables (two projects and an archived one, open, in-review, blocked and proposed items with a cross-project dependency, and notebook entries) and proves a dry run writes nothing, a real run creates the projects, tickets with remapped dependencies and notebook entries, a second run changes nothing, a run during a voyage is refused, the session is read-only and the connection string is never printed. With `QUARTERDECK_TEST_DATABASE_URL` set it also reads through a real Postgres session and checks a write there fails.
