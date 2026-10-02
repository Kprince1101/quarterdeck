# Quarterdeck spec

Quarterdeck is the open version of Legion's harness v3, rebuilt from scratch in this repo. Nothing is copied from the harness or commander repos; their history, Supabase tables and Legion's personal rules stay out. What carries over is the design, proven over 12 rounds: a Planner that turns a conversation into tickets, a Driver that births agents and assigns work, builders and one reviewer per project, a merge gate, cards for the human, a notebook the next Driver is born with, and lifecycle guardrails (end, kill, pause, retire, stuck, budget).

## Non-negotiables

1. One process. `npx quarterdeck up` starts the server, the store and the dashboard on localhost. No hosted component, no account, no telemetry, no API keys in the tool.
2. Everything stored is viewable, local and deletable. One data folder per machine (`~/.quarterdeck/`) with one Postgres data dir per project plus plain-file transcripts. The dashboard has a Data widget that lists every table and the folder path, and a Wipe button per project and for everything. The README has a "where your data lives" section that names every path.
3. Agents are driven over the Agent Client Protocol. Quarterdeck is an ACP client. Runtimes: `kiro` (`kiro-cli acp --agent <name>`, default), `claude` (`@agentclientprotocol/claude-agent-acp`), `gemini` (Gemini CLI). Permission requests from the agent are answered from the project's rules, never by trusting all tools. Sign-in is surfaced to the dashboard, never automated around.
4. Rules are files. `rules/` holds the defaults (charter template, reviewer prompt, permission rules, naming theme, auto-end settle, stuck threshold, budget, merge gate). `rules.local.*` overrides per machine and is gitignored. A Rules widget edits them in place.
5. The dashboard is widgets. A grid of registered widgets the user drags, resizes, hides, duplicates. Layouts are JSON the server owns. Presets ship; the first preset is Board | tabbed Planner/Driver/Notebook, then Events.
6. Quarterdeck is the only writer of state. The dashboard sends intents over HTTP; the server applies them and streams events over WebSocket. Postgres NOTIFY is the internal event bus.
7. Human gates: destructive or product-shaped decisions become cards. A declined or unanswered card is a result the agent sees, not a crash.
8. Quarterdeck owns every process it starts. Each session runs in its own process group; on exit, kill, retire or shutdown the whole group is signalled, survivors are swept and logged. The human is never asked to kill a process.

## Architecture

- `packages/server`: Node 22, TypeScript. PGlite store (real Postgres, in-process, one data dir per project), migrations in SQL, `DATABASE_URL` switches to an external Postgres with the same code. ACP client with per-runtime adapters. Bus MCP server (stdio) passed to every agent session: `ask`, `report`, `status`, `verdict`, `read`. Driver, Planner, reviewer gate, lifecycle. HTTP + WebSocket API. Serves the built dashboard.
- `packages/dashboard`: Vite + React. Widget registry, grid, layouts, presets. Widgets: Board, Project, Agents, Events, Cards, Planner, Driver, Notebook, Usage, Rules, Data.
- `packages/cli`: `quarterdeck up | init | doctor | wipe`. `doctor` checks kiro-cli / claude / gemini / gh are installed and signed in and says exactly what is missing.
- `rules/`: defaults as markdown and JSON.
- `site/`: landing + docs + demo mode (dashboard on fake data), deployable to Vercel. Demo mode never connects to a real server.
- Tickets live in a local `tickets` table. A ticket-source plugin interface lets another system feed tickets; no plugin for any specific system ships in this repo.

## Testing

Every ticket ships with tests. ACP is tested against a fake ACP agent in-repo plus `claude-agent-acp`. The Kiro adapter's live smoke test needs Legion's signed-in `kiro-cli`; raise a card for that, do not fake it. Lint: legion-toolkit (public npm) for now; a contributor-friendly profile is a later ticket.

## Legal

MIT, copyright Kristopher Prince, who is credited as the author in LICENSE.md and every package.json. TRADEMARK.md governs the name. Nothing NAIC-related, ever. Repo stays private until Legion flips it public at launch.
