# Quarterdeck

Run a crew of coding agents from one local board.

One process on your machine. It starts agents through their own CLIs (Kiro, Claude Code, Gemini CLI, anything that speaks the Agent Client Protocol), hands them tickets, reviews their pull requests (merge requests on GitLab), merges the ones that pass, and stops for you only when a decision is irreversible or product-shaped. One voyage, one Driver and one reviewer work every repository you add, so a change that spans libraries and the apps built on them runs as one effort. You watch and steer from a dashboard at localhost that you can rearrange however you like.

No API keys. No account. No telemetry. Everything Quarterdeck stores lives in one folder you can open, read and delete.

Status: alpha. Built, by itself, from a written spec. [docs/proof.md](docs/proof.md) records it running a voyage on its own repository end to end over claude: the Planner proposed a ticket, a builder opened the pull request, the reviewer and merge gate merged it, and the voyage wrapped itself up.

## Running it

Quarterdeck is installed and run locally only: clone it, install it, run it on your own machine. It is not published to npm. The `quarterdeck` package on npm is someone else's, unrelated to this one; do not install it, and do not run Quarterdeck through `npx`, which would download and run that package instead.

With Node 22 and one agent CLI installed:

```sh
git clone https://github.com/<owner>/quarterdeck.git && cd quarterdeck
npm install
npm run quarterdeck -- up
```

Open the URL `up` prints: the first time, it opens on Setup, which asks for your folder, your runtime and its sign-in, then puts you on the board with the Planner ready. After a `git pull`, run `npm install` again so the build is current.

## Getting started from a terminal

Setup does all of this from the dashboard. For scripts, or if you prefer the terminal, the same steps are three commands, from the clone:

```sh
npm run quarterdeck -- doctor                  # checks kiro-cli, claude, gemini, gh (and glab for GitLab), signs each signed-out one in through its own browser sign-in, and says what to run for anything left
npm run quarterdeck -- init /path/to/folder   # picks your workspace: one repository, or a folder of them; asks which runtime
npm run quarterdeck -- up                      # starts the server and prints the dashboard URL
```

Open the URL exactly as `up` prints it: the `#token=` part is a new token for each start, and the API refuses any request without it, including one from another program on your machine.

`npm run quarterdeck` runs the CLI in the folder you ran it from, so `npm --prefix /path/to/quarterdeck run quarterdeck -- doctor` from your own repository checks that repository's settings too.

### Pick a workspace

You point Quarterdeck at one folder, once. What it finds there decides how it works for you:

- **A git repository** (`init ~/code/my-app`): Quarterdeck is a single-repository tool. The dashboard, the Planner and the Driver talk about that repository and nothing else; there is no project picker, no project column and no cross-project dependency or publishing.
- **A folder of git repositories** (`init ~/Developer/Repos`): every repository one level down is listed for you to confirm or untick, and each one becomes a project. One `up` serves them all and one voyage can touch several (see [How Quarterdeck fits a multi-repo effort](#how-quarterdeck-fits-a-multi-repo-effort)).

The workspace (its root, its mode and its projects) is kept in `~/.quarterdeck/workspace.json` and shown in the Data widget. Adding a second repository to a single-repository workspace, with another `init` or from the dashboard, switches it to the multi-project way of working and says so in one line. `init <path>` stays the scripted form: without a terminal it takes every repository it finds, less any `--skip <slug>`. `init` writes nothing into your repositories unless you agree to a `.quarterdeck/` folder for one's settings. `npm run quarterdeck -- wipe <project>` removes a project and everything it stored; `npm run quarterdeck -- replay <voyage> [n]` re-runs a voyage's Driver turns in a fresh session that writes nothing, which is how you ask "why did it decide that?". See `packages/cli/README.md` for every command and flag.

## How a voyage works

A **voyage** is one run of work toward a goal, from Start Voyage until it ends. (An ACP **session** is something else: one agent's conversation with its runtime.)

- The **Planner** is one conversation for every active project. You describe what you want; it proposes tickets, each naming the project it belongs to, and you approve, edit or reject them on the board. Editing a proposal can move it to another project.
- Every ticket is a **spec**, in the shape Kiro uses: `## Requirements` (user stories with acceptance criteria written as WHEN … THE SYSTEM SHALL …), `## Design` (where in the repository, the approach, the decisions), `## Tasks` (a numbered checklist sized for one pull request) and a last line, `Proven: <observable check>`. A proposal that does not follow it never reaches the board; the Planner is told what is wrong and asked once more. A ticket can also carry its id in the project's tracker, its `external_ref`, which every agent working it is shown.
- **Start Voyage** births one **Driver**, the coordinator for every project with a repository. One voyage runs at a time, across all of them: the Driver is told each time a ticket is approved, a builder finishes a turn, the reviewer or the merge gate sends work back, or a pull request merges, in any project, each line labelled with its project. It births builders with names from the naming theme, assigns work, continues idle builders, and asks you questions as **cards** when something is irreversible or product-shaped. A declined or unanswered card is a result the Driver sees, not a crash.
- Each **builder** works in its own git worktree of its ticket's project, opens a pull request (a merge request on GitLab), and reports it. One **reviewer** for every project, born when a voyage starts and kept between voyages, reads it against `rules/reviewer.md` and returns a verdict. The [merge gate](#forges-and-the-merge-gate) then merges it with a squash merge, through `gh` or `glab`, or waits for you.
- **Tickets can depend on tickets in other projects.** An approved ticket waits until everything it depends on is done; the Driver can also `block` a ticket a builder already holds on tickets elsewhere, and the builder keeps its worktree and session while it waits. A project marked **`publishes`** (a library) is not done for its dependents when its pull request merges, but when it is published: the merge asks the Driver to publish it with the project's own tooling and send the **`published`** action with the package and version. Quarterdeck never publishes anything itself. Once every dependency is satisfied, Quarterdeck **wakes the blocked builder** by itself, telling it which versions to bump, and hands newly ready unassigned tickets to the Driver.
- A voyage **ends itself** when nothing is open and the settle time has passed, then runs a wrap-up that proposes **notebook** entries and charter edits. Approved entries are what the next Driver is born knowing. A voyage still open when `quarterdeck up` starts again is ended, its tickets reopened, because its agents stopped with the last run.
- A tool call your permission rules leave at `ask` becomes a card for you to allow or deny.
- Guardrails: pause an agent, one project (its launches and continues wait; every other project carries on) or everything; kill, retire or reset an agent; **Kill** one project's builders while the voyage, the Driver and the other projects keep going, or **Kill all**; a stuck detector for builders that stop making commits; a token budget that holds launches at 80% of a cap; and a merge gate you can turn off.

Agents are driven over the Agent Client Protocol. Permission requests are answered from `rules/permissions.json` (allow, deny, or card you), never by trusting every tool. A runtime that needs sign-in becomes a card with the exact command, never something Quarterdeck automates around.

## Forges and the merge gate

A project can be on GitHub or on GitLab, gitlab.com or self-hosted. The forge comes from the project's `origin` host: `github.com` is GitHub, `gitlab.com` is GitLab, and any other host needs one line in `~/.quarterdeck/rules.local.forges.json`, such as `{ "forges": { "git.example.org": "gitlab" } }`. An unmapped host is an error naming it, and only the machine layer may map hosts. On GitHub everything says pull request (PR) and agents use `gh`; on GitLab the charter, the reviewer's prompt, the Planner's spec format, the Services section and the dashboard all say merge request (MR), and agents use `glab`. `doctor` checks `glab`, installed and signed in, once for each GitLab host in use.

After the reviewer approves, the merge gate (`mergeGate` in `lifecycle.json`) decides whether the request merges:

- `requireReviewerApproval` and `requireChecksPassing` are on by default.
- `requireAiReview` (off by default) also waits for a review from one of the forge's `aiReviewers` and bounces the work while any thread one of them opened is unresolved. `aiReviewers` lists exact bot logins per forge; GitHub's ship as GitHub Copilot's reviewer logins, and GitLab ships none, so on GitLab you name your own bot in the machine layer or the gate stops with an error rather than pass. The old key, `requireCopilotReview`, is deprecated: it still reads as `requireAiReview`, with a warning naming the file.
- `autoMerge` is off: you get a merge card, and nothing merges until you answer it.

A repository's own `.quarterdeck/` layer can only tighten the gate. See `packages/server/src/gate/README.md`.

## Project services

Each project tells its agents how to reach the outside world: its **forge** (detected, read-only) and its **ticket service**, or tracker (Jira, Targetprocess, GitHub Issues, anything), reached through a CLI command or an MCP server you name. Set them in the dashboard's Project widget or in `~/.quarterdeck/rules.local.services.json`, keyed by project slug; the same place marks a project as `publishes`. Every prompt for work on a ticket carries a Services section: the Driver's lists every project's, and a builder's and the reviewer's add the ticket's `external_ref`, so an agent can update the tracker itself. Quarterdeck never calls the tracker. Services supersede the ticket-source plugins (QD13, `~/.quarterdeck/plugins/`): the loader still works, but nothing in the crew uses it. See `packages/server/src/services/README.md`.

## Kiro base agents

On Kiro, a role can start from one of your own Kiro agents and get its MCP servers, steering, skills, prompt, tools and model. `rules/kiro.json` names one per role in `baseAgents` (`driver`, `reviewer`, `builder`; none by default). A project can override the builder only, from its repo layer, so a component library's builders can start from a different agent than an app's; a builder's base is looked up in the repository's `.kiro/agents/` first, then `~/.kiro/agents/`. Quarterdeck always adds its own bus, never copies a base's `hooks`, and takes only the prompt, resources, tools and model from a base committed to the repository, since agents can write there. `doctor` prints the base each role resolves to. See `rules/README.md#kiro-base-agents`.

## How Quarterdeck fits a multi-repo effort

Take two libraries and three apps: `ui-kit`, a React component library; `ui-extras`, a library of bespoke components built on `ui-kit`; and `retrofit-a`, `retrofit-b` and `retrofit-c`, three existing apps being moved onto them. A new component has to land in `ui-kit`, be wrapped in `ui-extras`, be published, and then be adopted by all three apps.

1. **Pick the folder that holds the five repositories.** Run `npm run quarterdeck -- init <folder>`, confirm the five it lists, then one `npm run quarterdeck -- up`. If `retrofit-c` lives on a self-hosted GitLab, map its host in `rules.local.forges.json`; its agents then talk merge requests and `glab`.
2. **Mark the libraries.** In the Project widget, turn on _publishes_ for `ui-kit` and `ui-extras` (or set `"publishes": true` for both in `rules.local.services.json`), and name each project's tracker if it has one. Optionally give `ui-kit`'s builders their own Kiro base agent with `{ "baseAgents": { "builder": "component-builder" } }` in `ui-kit/.quarterdeck/rules.local.kiro.json`.
3. **Plan once.** Tell the Planner what you want. It proposes a spec ticket per project: the component in `ui-kit`; the wrapper in `ui-extras`, depending on the `ui-kit` ticket; and an adoption ticket in each `retrofit-*` app, depending on the `ui-extras` ticket. Approve them on the board.
4. **Start one voyage.** One Driver coordinates all five projects and one reviewer reviews every pull or merge request. The Driver assigns the `ui-kit` ticket; the others wait on their dependencies (the Events feed says why), or the Driver starts retrofit prep work and `block`s it on the library ticket.
5. **Merge, then publish.** When the `ui-kit` request merges, its dependents still wait: it is merged but not published yet. The Driver publishes `ui-kit` with the repository's own release tooling and sends `published` with the package and version. Now the `ui-extras` ticket is ready and the Driver assigns it; its merge and publish follow the same way.
6. **The retrofit work wakes up.** Once `ui-extras` is published, Quarterdeck hands the ready retrofit tickets to the Driver, and any retrofit builder it had blocked is woken by itself with the versions to bump. Three builders work three worktrees in parallel; the reviewer reads each request, and each project's merge gate merges it under that project's rules.
7. **Steer per project.** If `retrofit-b` goes wrong, pause it or Kill its builders from the Board; the voyage, the Driver and the other projects carry on. The voyage ends itself once everything has merged and settled.

## The dashboard

A grid of widgets you drag, resize, hide and duplicate; layouts are saved by the server and three presets ship (default, ops, minimal). Widgets: **Board** (the one voyage: start, end, Kill all or one project's Kill; liveness, pause all, project picker), **Project** (pause, AI review and auto-merge toggles, services: forge, tracker and publishes; reviewer), **Agents** (state, held work, actions), **Events** (filtered feed), **Cards** (open questions with reply), **Planner** (one conversation for every project; proposals as specs, each with its project), **Driver** (turns, replay command), **Notebook** (proposals with diffs), **Pull and merge requests** (every project's open requests in its forge's terms, with checks or pipeline, review state, and the ticket and agent behind each), **Usage** (tokens in the 5-hour window), **Rules** (edit any rules file in place, with validation), **Data** (every table, every path, wipe). See `site/public/docs/widgets.html`.

## Where your data lives

Nothing Quarterdeck stores leaves your machine. It has no hosted component, no account and no telemetry, and it sends nothing anywhere. What your agents send to their model providers, and what `git` and `gh` push, goes through those tools, signed in as you. Everything Quarterdeck writes is in one of these places:

```text
~/.quarterdeck/
  rules.local.<file>              your machine's rules
  claude.json                     which Claude auth mode this machine uses (the mode only, never a key)
  keep-awake.json                 the pid of the keep-awake child while the dashboard's keep-awake is on
  profiles/<name>/                rules profiles you add yourself; rules.local.profile.json picks one
  <project>/
    pg/                           the project's Postgres data (PGlite)
    pg.lock                       which process has the project open
    turns/<agent-id>/<seq>/       one folder per agent turn: input.md, output.md, updates.jsonl, result.json
    worktrees/<builder>-<ticket>/ a builder's git worktree
    attachments/<id>.<ext>        images you attached to a Planner message or a card answer
  plugins/<name>.mjs              ticket-source plugins you add yourself (superseded by project services)
  workspace.json                  your workspace: its root folder, single or multi, and its projects
  pause.json                      only while everything is paused
  sock/<hash>.sock                a project's bus socket, while running
  _deck/                          where the Driver and the reviewer run, outside every project
  kiro/                           where kiro-cli runs
  gemini/                         where gemini runs, and its locked settings
  runtimes/claude/                where the Claude Code agent runs
```

Outside that folder:

- `<repo>/.quarterdeck/rules.local.<file>`: a project's own rules, written only after you agree to it in `quarterdeck init`, when you save a rule for one project, or when you accept a charter proposal.
- `~/.kiro/agents/quarterdeck-<project>-<agent>.json`: the agent config Kiro needs to start an agent, removed when the agent's process exits.
- With `DATABASE_URL` set, every project's rows live in that database instead of `~/.quarterdeck/<project>/pg/`. Turn files, worktrees and attachments stay in `~/.quarterdeck/<project>/`.

Your runtimes' and `gh`'s sign-ins stay where those tools keep them; Quarterdeck does not copy them. On a machine that runs Claude on an API key (`QUARTERDECK_CLAUDE_AUTH=api_key`), the key stays in `ANTHROPIC_API_KEY` or the macOS Keychain item `quarterdeck-anthropic-api-key`: it is handed to the Claude agents Quarterdeck starts and never written to a database row, an event, a turn file or the notebook, and anything shaped like `sk-ant-` is stored as `[redacted]`. See [Claude auth mode](site/public/docs/rules.html#claude-auth).

The dashboard's Data widget lists every table with its rows and every path above with whether it exists. It also wipes:

- **Wipe project** (type the project's name to confirm) stops the project first: it is archived so nothing new starts, every live agent is killed, every process group it started is swept, and each worktree is removed from your repository. Then its rows, `pg/`, `pg.lock`, `turns/`, `worktrees/` and `attachments/` are deleted. If a process cannot be confirmed stopped, the wipe is refused and the project kept, so the next start can sweep it.
- **Wipe everything** (type `wipe everything`) does the same for every project.

`npm run quarterdeck -- wipe <project>` and `npm run quarterdeck -- wipe --all` do the same from a terminal, with the same typed confirmation (or `--confirm <phrase>` in a script). See `packages/cli/README.md`.

Wiping keeps the rules files and everything else under `~/.quarterdeck/` that is not a project: `claude.json`, `profiles/`, `plugins/`, `workspace.json` (less the wiped projects), `pause.json`, `sock/`, `_deck/` and the runtime folders. To remove everything by hand, stop Quarterdeck and delete `~/.quarterdeck/`, then run `git worktree prune` in each repository. See `site/public/docs/data.html`.

## Rules

The defaults live in `rules/`: `charter.md`, `reviewer.md`, `permissions.json`, `naming.json`, `lifecycle.json`, `models.json`, `env.json`, `kiro.json`, `forges.json` and `services.json`. Override any of them with a file named `rules.local.<file>`, for example `rules.local.lifecycle.json`. Quarterdeck reads three layers, last one wins:

1. `rules/<file>`, shipped with Quarterdeck
2. `~/.quarterdeck/rules.local.<file>`, for this machine
3. `<repo>/.quarterdeck/rules.local.<file>`, for one project

JSON layers merge key by key, so an override only needs the keys it changes; arrays are replaced whole. Markdown layers replace the file below them. Every layer is checked against the schema, and an error names the file that broke it. `rules.local.*` files are gitignored.

Permissions are the exception: the repo layer is not merged. It is checked on its own, may only contain `deny` and `ask`, and the stricter of its answer and the machine's answer wins, so a project can tighten permissions but never loosen them. See `packages/server/src/acp/permissions/README.md`. Any `execute` allow can amount to arbitrary code (`git *` also allows `git -c alias.x='!sh' x`); read `rules/README.md` before allowing shell commands, or start from `rules/examples/hardened.permissions.json`.

The merge gate (`mergeGate` in `lifecycle.json`) is tighten-only in the repo layer too: a `require*` flag is on if any layer turns it on, `autoMerge` is on only if no layer turns it off, and the repo layer may not set `base`. See `packages/server/src/gate/README.md`.

So is the auto-end settle time (`autoEndSettleSeconds`, how long a voyage must stay settled before it ends itself): the repo layer can lengthen it but never shorten it. See `packages/server/src/voyage-end/README.md`.

Agents do not inherit the server's environment. They get a short allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `SSH_AUTH_SOCK`, `QUARTERDECK_BUS_*`), plus the sign-in variables their runtime declares. `GH_TOKEN`, `GITHUB_TOKEN` and `DATABASE_URL` stay out. `env.json` lists more names in `pass`; values always come from the server's environment. Only the machine layer (`~/.quarterdeck/rules.local.env.json`) can add names: the repo layer is ignored, because agents can write to the repo. See `packages/server/src/acp/README.md`.

`forges.json` and `services.json` are machine-only: a repo layer for either is an error naming the file, because a repository must not choose which host its merges go to or which command its agents run. See [Forges and the merge gate](#forges-and-the-merge-gate) and [Project services](#project-services). In `kiro.json` the repo layer may set only `baseAgents.builder` (see [Kiro base agents](#kiro-base-agents)).

## Contributing

### Workspace packages

Each workspace package is written in TypeScript under `src/` and built to `dist/` by its own `build` script (`tsc -p tsconfig.build.json`). Node refuses to strip types from files under `node_modules`, so a package loaded from there has to ship JavaScript. Its `exports` map lists three conditions, in this order:

```json
"exports": {
  ".": {
    "@quarterdeck/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

- `@quarterdeck/source` is for this repo only. The root `tsconfig.json` (`customConditions`) and `vitest.config.ts` (`resolve.conditions`) turn it on, so typecheck and tests read `src/` directly and need no build.
- `types` and `default` are what plain Node sees, `npm run quarterdeck` included.
- `files` lists `dist` and any data files the package reads at runtime.

`npm run build` builds every package, `npm install` runs it (the root `prepare` script), and `npm test` builds before it runs vitest. Each package gets a test that spawns `process.execPath` to import it by name, which proves the built entry loads in plain Node. Every `package.json` is `"private": true`; nothing here is published.

The root `quarterdeck` script runs `scripts/quarterdeck.mjs`, which starts `packages/cli/dist/bin.js` in the folder `npm run` was typed in (`INIT_CWD`), since npm starts every script in the workspace root.

The `clean-machine` CI job follows [Running it](#running-it) on a machine with nothing else on it. It copies the clone into a `node:22-bookworm-slim` container, runs `npm install` there, and runs `scripts/clean-machine/check.ts`: `npm ls quarterdeck` must find no `quarterdeck` package, `npm run quarterdeck -- up` with no `~/.quarterdeck` must serve the built dashboard and the intents API, Setup must find a fake `kiro-cli` (the in-repo fake agent) installed and signed in and save a one-repository workspace on it, the ACP client must drive the in-repo fake agent through a turn, `up` must print `Stopped.` and let go of its port on `SIGTERM`, and `npm run quarterdeck -- wipe` must delete the project. To run the check in your clone after `npm install`:

```sh
node --experimental-strip-types scripts/clean-machine/check.ts
```
