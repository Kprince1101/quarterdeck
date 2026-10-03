# Quarterdeck

Run a crew of coding agents from one local board.

One process on your machine. It starts agents through their own CLIs (Kiro, Claude Code, Gemini CLI, anything that speaks the Agent Client Protocol), hands them tickets, reviews their pull requests, merges the ones that pass, and stops for you only when a decision is irreversible or product-shaped. You watch and steer from a dashboard at localhost that you can rearrange however you like.

No API keys. No account. No telemetry. Everything Quarterdeck stores lives in one folder you can open, read and delete.

Status: alpha. Built, by itself, from a written spec. [docs/proof.md](docs/proof.md) records it running a round on its own repository end to end over claude: the Planner proposed a ticket, a builder opened the pull request, the reviewer and merge gate merged it, and the round wrapped itself up.

## Getting started

Node 22 and one agent CLI signed in. Then:

```sh
npx quarterdeck doctor                    # checks kiro-cli, claude, gemini and gh, and says exactly what to run for each miss
npx quarterdeck init path/to/your/repo   # creates ~/.quarterdeck and a project, asks which runtime
npx quarterdeck up                        # starts the server and prints the dashboard URL
```

Open the URL exactly as `up` prints it: the `#token=` part is a new token for each start, and the API refuses any request without it, including one from another program on your machine.

`init` writes nothing into your repository unless you agree to a `.quarterdeck/` folder for that project's settings. `quarterdeck wipe <project>` removes a project and everything it stored; `quarterdeck replay <round> [n]` re-runs a round's Driver turns in a fresh session that writes nothing, which is how you ask "why did it decide that?". See `packages/cli/README.md` for every command and flag.

## How a round works

- The **Planner** is a conversation per project. You describe what you want; it proposes tickets; you approve, edit or reject them on the board.
- **Start Round** births a **Driver**: one session that is told each time a ticket is approved, a builder finishes a turn, the reviewer or the merge gate sends work back, or a pull request merges. It births builders with names from the naming theme, assigns work, continues idle builders, and asks you questions as **cards** when something is irreversible or product-shaped. A declined or unanswered card is a result the Driver sees, not a crash. One round runs per project at a time.
- Each **builder** works in its own git worktree, opens a pull request, and reports it. The project's **reviewer**, born when a round starts and kept between rounds, reads the PR against `rules/reviewer.md` and returns a verdict. Approve plus auto-merge means a squash merge through `gh`; otherwise it waits for you.
- A round **ends itself** when nothing is open and the settle time has passed, then runs a wrap-up that proposes **notebook** entries and charter edits. Approved entries are what the next Driver is born knowing. A round still open when `quarterdeck up` starts again is ended, its tickets reopened, because its agents stopped with the last run.
- A tool call your permission rules leave at `ask` becomes a card for you to allow or deny.
- Guardrails: pause an agent, a project or everything; kill, retire or reset an agent; a stuck detector for builders that stop making commits; a token budget that holds launches at 80% of a cap; and a merge gate you can turn off.

Agents are driven over the Agent Client Protocol. Permission requests are answered from `rules/permissions.json` (allow, deny, or card you), never by trusting every tool. A runtime that needs sign-in becomes a card with the exact command, never something Quarterdeck automates around.

## The dashboard

A grid of widgets you drag, resize, hide and duplicate; layouts are saved by the server and three presets ship (default, ops, minimal). Widgets: **Board** (liveness, pause all, project picker), **Project** (round controls, toggles, reviewer), **Agents** (state, held work, actions), **Events** (filtered feed), **Cards** (open questions with reply), **Planner**, **Driver** (turns, replay command), **Notebook** (proposals with diffs), **Usage** (tokens in the 5-hour window), **Rules** (edit any rules file in place, with validation), **Data** (every table, every path, wipe). See `site/public/docs/widgets.html`.

## Where your data lives

Nothing Quarterdeck stores leaves your machine. It has no hosted component, no account and no telemetry, and it sends nothing anywhere. What your agents send to their model providers, and what `git` and `gh` push, goes through those tools, signed in as you. Everything Quarterdeck writes is in one of these places:

```text
~/.quarterdeck/
  rules.local.<file>              your machine's rules
  <project>/
    pg/                           the project's Postgres data (PGlite)
    pg.lock                       which process has the project open
    turns/<agent-id>/<seq>/       one folder per agent turn: input.md, output.md, updates.jsonl, result.json
    worktrees/<builder>-<ticket>/ a builder's git worktree
  plugins/<name>.mjs              ticket-source plugins you add yourself
  pause.json                      only while everything is paused
  sock/<hash>.sock                a project's bus socket, while running
  kiro/                           where kiro-cli runs
  gemini/                         where gemini runs, and its locked settings
  runtimes/claude/                where the Claude Code agent runs
```

Outside that folder:

- `<repo>/.quarterdeck/rules.local.<file>`: a project's own rules, written only after you agree to it in `quarterdeck init`, when you save a rule for one project, or when you accept a charter proposal.
- `~/.kiro/agents/quarterdeck-<project>-<agent>.json`: the agent config Kiro needs to start an agent, removed when the agent's process exits.
- With `DATABASE_URL` set, every project's rows live in that database instead of `~/.quarterdeck/<project>/pg/`. Turn files and worktrees stay in `~/.quarterdeck/<project>/`.

Your runtimes' and `gh`'s sign-ins stay where those tools keep them; Quarterdeck does not copy them.

The dashboard's Data widget lists every table with its rows and every path above with whether it exists. It also wipes:

- **Wipe project** (type the project's name to confirm) stops the project first: it is archived so nothing new starts, every live agent is killed, every process group it started is swept, and each worktree is removed from your repository. Then its rows, `pg/`, `pg.lock`, `turns/` and `worktrees/` are deleted. If a process cannot be confirmed stopped, the wipe is refused and the project kept, so the next start can sweep it.
- **Wipe everything** (type `wipe everything`) does the same for every project.

`quarterdeck wipe <project>` and `quarterdeck wipe --all` do the same from a terminal, with the same typed confirmation (or `--confirm <phrase>` in a script). See `packages/cli/README.md`.

Wiping keeps the rules files and everything else under `~/.quarterdeck/` that is not a project: `plugins/`, `pause.json`, `sock/` and the runtime folders. To remove everything by hand, stop Quarterdeck and delete `~/.quarterdeck/`, then run `git worktree prune` in each repository. See `site/public/docs/data.html`.

## Rules

The defaults live in `rules/`: `charter.md`, `reviewer.md`, `permissions.json`, `naming.json`, `lifecycle.json`, `models.json`, `env.json` and `kiro.json`. Override any of them with a file named `rules.local.<file>`, for example `rules.local.lifecycle.json`. Quarterdeck reads three layers, last one wins:

1. `rules/<file>`, shipped with Quarterdeck
2. `~/.quarterdeck/rules.local.<file>`, for this machine
3. `<repo>/.quarterdeck/rules.local.<file>`, for one project

JSON layers merge key by key, so an override only needs the keys it changes; arrays are replaced whole. Markdown layers replace the file below them. Every layer is checked against the schema, and an error names the file that broke it. `rules.local.*` files are gitignored.

Permissions are the exception: the repo layer is not merged. It is checked on its own, may only contain `deny` and `ask`, and the stricter of its answer and the machine's answer wins, so a project can tighten permissions but never loosen them. See `packages/server/src/acp/permissions/README.md`. Any `execute` allow can amount to arbitrary code (`git *` also allows `git -c alias.x='!sh' x`); read `rules/README.md` before allowing shell commands, or start from `rules/examples/hardened.permissions.json`.

The merge gate (`mergeGate` in `lifecycle.json`) is tighten-only in the repo layer too: a `require*` flag is on if any layer turns it on, `autoMerge` is on only if no layer turns it off, and the repo layer may not set `base`. See `packages/server/src/gate/README.md`.

So is the auto-end settle time (`autoEndSettleSeconds`, how long a round must stay settled before it ends itself): the repo layer can lengthen it but never shorten it. See `packages/server/src/round-end/README.md`.

Agents do not inherit the server's environment. They get a short allowlist (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TERM`, `TMPDIR`, `TZ`, `SSH_AUTH_SOCK`, `QUARTERDECK_BUS_*`), plus the sign-in variables their runtime declares. `GH_TOKEN`, `GITHUB_TOKEN` and `DATABASE_URL` stay out. `env.json` lists more names in `pass`; values always come from the server's environment. Only the machine layer (`~/.quarterdeck/rules.local.env.json`) can add names: the repo layer is ignored, because agents can write to the repo. See `packages/server/src/acp/README.md`.

## Contributing

### Workspace packages

Each workspace package is written in TypeScript under `src/` and built to `dist/` by its own `build` script (`tsc -p tsconfig.build.json`). Node refuses to strip types from files under `node_modules`, so a published package has to ship JavaScript. Its `exports` map lists three conditions, in this order:

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
- `types` and `default` are what plain Node and npm consumers see.
- `files` lists `dist` and any data files the package reads at runtime.

`npm run build` builds every package, and `npm test` builds before it runs vitest. Each package gets a test that spawns `process.execPath` to import it by name, which proves the built entry loads in plain Node.

The `clean-machine` CI job goes one step further. It packs `rules`, `server`, `dashboard` and `cli` with `npm pack`, installs the tarballs into an empty folder in a `node:22-bookworm-slim` container that has nothing else on it, and runs `scripts/clean-machine/check.ts` there: `npx quarterdeck up` must serve the built dashboard and the intents API, the installed ACP client must drive the in-repo fake agent through a turn, `up` must print `Stopped.` and let go of its port on `SIGTERM`, and `npx quarterdeck wipe` must delete the project. To run the check against a local build, from `packages/cli` (so `npx` finds the bin):

```sh
node --experimental-strip-types ../../scripts/clean-machine/check.ts ../server/test/acp/fake-agent/main.ts
```
