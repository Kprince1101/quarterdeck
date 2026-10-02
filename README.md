# Quarterdeck for Kiro

Run a crew of Kiro and Claude Code agents from one local board.

One process on your machine. It starts the agents through their own CLIs (Kiro, Claude Code, Gemini CLI, anything that speaks the Agent Client Protocol), hands them tickets, reviews their pull requests, merges the ones that pass, and stops for you only when a decision is irreversible or product-shaped. You watch and steer from a dashboard at localhost that you can rearrange however you like.

No API keys. No account. No telemetry. Everything Quarterdeck stores lives in one folder you can open, read and delete.

Status: being built, by itself. See SPEC.md.

## Rules

The defaults live in `rules/`: `charter.md`, `reviewer.md`, `permissions.json`, `naming.json`, `lifecycle.json` and `models.json`. Override any of them with a file named `rules.local.<file>`, for example `rules.local.lifecycle.json`. Quarterdeck reads three layers, last one wins:

1. `rules/<file>`, shipped with Quarterdeck
2. `~/.quarterdeck/rules.local.<file>`, for this machine
3. `<repo>/.quarterdeck/rules.local.<file>`, for one project

JSON layers merge key by key, so an override only needs the keys it changes; arrays are replaced whole. Markdown layers replace the file below them. Every layer is checked against the schema, and an error names the file that broke it. `rules.local.*` files are gitignored.

Permissions are the exception: the repo layer is not merged. It is checked on its own, may only contain `deny` and `ask`, and the stricter of its answer and the machine's answer wins, so a project can tighten permissions but never loosen them. See `packages/server/src/acp/permissions/README.md`.

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
