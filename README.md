# Quarterdeck for Kiro

Run a crew of Kiro and Claude Code agents from one local board.

One process on your machine. It starts the agents through their own CLIs (Kiro, Claude Code, Gemini CLI, anything that speaks the Agent Client Protocol), hands them tickets, reviews their pull requests, merges the ones that pass, and stops for you only when a decision is irreversible or product-shaped. You watch and steer from a dashboard at localhost that you can rearrange however you like.

No API keys. No account. No telemetry. Everything Quarterdeck stores lives in one folder you can open, read and delete.

Status: being built, by itself. See SPEC.md.

## Getting started

```sh
npx quarterdeck init path/to/your/repo   # creates ~/.quarterdeck and a project
npx quarterdeck up                        # starts the server and prints the dashboard URL
```

`init` writes nothing into your repository unless you agree to a `.quarterdeck/` folder for that project's settings. See `packages/cli/README.md`.

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

The defaults live in `rules/`: `charter.md`, `reviewer.md`, `permissions.json`, `naming.json`, `lifecycle.json` and `models.json`. Override any of them with a file named `rules.local.<file>`, for example `rules.local.lifecycle.json`. Quarterdeck reads three layers, last one wins:

1. `rules/<file>`, shipped with Quarterdeck
2. `~/.quarterdeck/rules.local.<file>`, for this machine
3. `<repo>/.quarterdeck/rules.local.<file>`, for one project

JSON layers merge key by key, so an override only needs the keys it changes; arrays are replaced whole. Markdown layers replace the file below them. Every layer is checked against the schema, and an error names the file that broke it. `rules.local.*` files are gitignored.

Permissions are the exception: the repo layer is not merged. It is checked on its own, may only contain `deny` and `ask`, and the stricter of its answer and the machine's answer wins, so a project can tighten permissions but never loosen them. See `packages/server/src/acp/permissions/README.md`.

The merge gate (`mergeGate` in `lifecycle.json`) is tighten-only in the repo layer too: a `require*` flag is on if any layer turns it on, `autoMerge` is on only if no layer turns it off, and the repo layer may not set `base`. See `packages/server/src/gate/README.md`.

So is the auto-end settle time (`autoEndSettleSeconds`, how long a round must stay settled before it ends itself): the repo layer can lengthen it but never shorten it. See `packages/server/src/round-end/README.md`.

## Workspace packages

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
