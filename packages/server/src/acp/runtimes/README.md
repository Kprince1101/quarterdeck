# Runtime adapters

One adapter per runtime turns a `RuntimeLaunch` into the command that starts that runtime's ACP agent, and connects to it with `spawnAcpClient` (see [../client/README.md](../client/README.md)). kiro and claude go through `launchAcpClient` ([../launch/README.md](../launch/README.md)), which adds the version probe and spawn retry.

```ts
const client = await KIRO_ADAPTER.connect(
  { cwd, project, agentName, mcpServers: [bus] },
  clientOptions,
);
```

| Field          | Meaning                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime`      | `kiro`, `claude` or `gemini`, as named in `rules/models.json`                                                                                                                    |
| `displayName`  | The name shown to people                                                                                                                                                         |
| `command(...)` | The runtime's own `AgentCommand` for a launch                                                                                                                                    |
| `connect(...)` | Spawns `launch.command` if given, otherwise `command(launch)`, and returns the connected `AcpClient`. An override runs in `launch.cwd` with `launch.env` unless it sets its own. |

`launch.command` replaces the runtime's command: tests point it at the fake ACP agent, and a user can point it at a custom install. `project` (the project slug) and `agentName` name kiro's `--agent`; other runtimes ignore them. `mcpServers` are the MCP servers the agent must always have, the bus first among them. A runtime that reads them from its own config (kiro) writes them there. The others ignore the field, and the caller passes the same servers to `session/new`.

Every adapter is tested with `describeRuntimeConformance(adapter, base?)` from `test/acp/runtime-conformance.ts`. It runs the ACP conformance suite through `adapter.connect` against the fake agent, merging `base` into every launch, and checks every spawned process has exited.

## kiro

`kiro-cli acp --agent quarterdeck-<project>-<agentName>`, started through `launchAcpClient` (see [../launch/README.md](../launch/README.md)), so every launch records `kiro-cli --version` and retries a spawn that fails to exec. `connect` takes `LaunchOptions`. Kiro reads an agent's tools and MCP servers from an agent config file, so `connect` writes one before it starts the process:

- Path: `~/.kiro/agents/quarterdeck-<project>-<agentName>.json` (`createKiroAdapter({ agentsDir })` changes the folder). The `quarterdeck-` prefix keeps it clear of the user's own agents. The project slug keeps two projects that reuse an agent name from removing each other's config. The file is removed when the client closes or the process exits, and rewritten on the next launch if a crash left it behind.
- `mcpServers`: the launch's stdio and http servers, converted to Kiro's shape (`env` and `headers` become objects). Kiro's config has no sse or acp transport, so those stay out of the file.
- `tools: ["*"]`, `allowedTools: []`: no tool is pre-approved, so every tool call reaches Quarterdeck as a `session/request_permission` and is answered from the project's rules.
- `includeMcpJson: false`: the user's own `mcp.json` servers are not loaded into Quarterdeck agents.

The returned client drops from `session/new` and `session/resume` any MCP server whose name is already in the config, so Kiro does not start the bus twice. Servers that are not in the config (sse, acp, or ones added per session) are passed through.

The project and agent name must be letters, digits, `-` and `_`. Anything else throws `KiroConfigError` before a file is written.

### The worktree is never the process directory

Kiro loads workspace agents from `.kiro/agents/` and prefers them over global agents with the same name. If `kiro-cli` ran in the agent's worktree, a `.kiro/agents/quarterdeck-<project>-<agentName>.json` or `.md` committed to the repo would replace Quarterdeck's config, pre-approving tools and dropping the bus. So:

- `kiro-cli` runs in `~/.quarterdeck/kiro/`, a folder Quarterdeck owns (`createKiroAdapter({ processDir })` changes it). This applies to a `launch.command` override too. The worktree is only the `cwd` the caller passes to `session/new`.
- Before writing anything, `connect` checks the worktree (`launch.cwd`) for that shadow file. If one exists it throws `KiroShadowConfigError`, which has `cardKind: 'kiro.shadow_config'` (`KIRO_SHADOW_CONFIG_CARD`), `agentName` and `path`, so the server can raise a card. Nothing is spawned.

### Extension methods

Kiro sends notifications outside the ACP schema. The adapter asks the client for every method in `KIRO_EXTENSIONS`, and `subscribeKiroEvents(client, listener)` turns each one into a `KiroEvent`. Every event carries `kind`, `method` and the raw `params`, plus whichever of `sessionId`, `serverName`, `url`, `status` and `contextUsagePercentage` the params hold.

| `kind`                 | Method                             | Use                                                         |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `commandsAvailable`    | `_kiro.dev/commands/available`     | Slash commands for the session                              |
| `mcpOauthRequest`      | `_kiro.dev/mcp/oauth_request`      | An MCP server needs sign-in: surface `url`, never follow it |
| `mcpServerInitialized` | `_kiro.dev/mcp/server_initialized` | An MCP server (the bus included) is ready                   |
| `compactionStatus`     | `_kiro.dev/compaction/status`      | Context compaction progress                                 |
| `clearStatus`          | `_kiro.dev/clear/status`           | Session history cleared                                     |
| `metadata`             | `_kiro.dev/metadata`               | Context usage percentage                                    |
| `agentSwitched`        | `_kiro.dev/agent/switched`         | The session moved to another Kiro agent                     |
| `sessionTerminate`     | `_session/terminate`               | A subagent session ended                                    |

Kiro's client-to-agent extension requests (`_kiro.dev/commands/execute`, `_kiro.dev/commands/options`) are not sent. Extension requests from Kiro to the client get method-not-found, so Quarterdeck never hands Kiro an access token.

### Sign-in

Sign-in stays with `kiro-cli login`. When Kiro is not signed in, `session/new` fails with auth required, which `isAuthRequiredError` recognises. Quarterdeck surfaces that to the dashboard and never calls `authenticate` on its own.

### Live smoke

`test/acp/kiro-live.test.ts` drives the real `kiro-cli` with a stub bus MCP server in the agent config. It checks:

- a turn ends with the expected reply;
- Kiro started the stub, which shows it loaded the global config while running in `~/.quarterdeck/kiro/`;
- a shell tool call reaches Quarterdeck as `session/request_permission`, and the rejection is honoured;
- the config file is gone after close.

It needs a signed-in `kiro-cli` on `PATH` and is skipped unless `QUARTERDECK_LIVE=1`. `QUARTERDECK_KIRO_LIVE=1` also works.

```sh
QUARTERDECK_LIVE=1 npx vitest run packages/server/test/acp/kiro-live.test.ts
```

## claude

`npx --yes @agentclientprotocol/claude-agent-acp@0.85.0` (`CLAUDE_AGENT_ACP_VERSION`), started through `launchAcpClient` like kiro. Every launch therefore records `claude --version` (`CLAUDE_VERSION_COMMAND`) and retries a spawn that fails to exec. `connect` takes `LaunchOptions`. The version is pinned so that an upgrade is a deliberate change. On Windows the command goes through `cmd.exe /d /s /c`, because `npx` there is a `.cmd` shim and Node only starts those through a shell.

### The worktree is never the process directory

npx runs in `~/.quarterdeck/runtimes/claude` (`claudeRuntimeDir()`; `createClaudeAdapter({ processDir })` changes it). An agent can write to its own worktree, so a `.npmrc` it planted there could otherwise choose where the package is downloaded from. The child env also sets `npm_config_registry=https://registry.npmjs.org/`. The worktree is only the `cwd` the caller passes to `session/new`.

The first launch has npx fetch claude-agent-acp and Claude Code's native binary (about 240 MB). That can take longer than the client's default 30s initialize deadline, so `connect` defaults `initializeTimeoutMs` to `CLAUDE_INITIALIZE_TIMEOUT_MS` (5 minutes). Callers can still pass their own. The longer wait can never hide a sign-in prompt, because claude-agent-acp answers `initialize` before it checks sign-in.

Follow-up, deferred: `npx` pins claude-agent-acp itself but not its dependencies, which resolve from version ranges on first fetch. Two machines can therefore run different transitive code. The planned fix is a lockfile-backed install under `~/.quarterdeck/runtimes/claude/`: `npm ci` from a committed lock, then start the installed binary instead of going through npx.

### Permissions

Every tool call has to reach the project's rules as a `session/request_permission`. Claude settings could settle some calls first:

- `permissions.allow` rules
- a `permissions.defaultMode` such as `acceptEdits` or `bypassPermissions`

They can come from three files:

| Tier      | File                                                              |
| --------- | ----------------------------------------------------------------- |
| `user`    | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) |
| `project` | `<cwd>/.claude/settings.json`                                     |
| `local`   | `<cwd>/.claude/settings.local.json`                               |

The project and local files sit in the agent's own worktree, so an agent could grant itself permissions there. The adapter has four defences:

1. **Settings off.** Every `session/new`, `session/resume` and `session/load` carries `_meta.claudeCode.options` set to `{ settingSources: [], allowDangerouslySkipPermissions: false }` (`CLAUDE_LOCKED_OPTIONS`). Any other `meta` the caller passes is kept. In 0.85.0, claude-agent-acp builds the SDK options as `{ settingSources: ["user", "project", "local"], ...userProvidedOptions, … }` (`dist/acp-agent.js`, `createSession`), so the caller's `settingSources` replaces the default. The Agent SDK then loads only the listed sources (`settingSources ?? ["user","project","local"]`). The cost is that user settings such as hooks, `env` and CLAUDE.md loading do not apply inside Quarterdeck. Sign-in is not a setting and still works.
2. **Default mode.** Right after each of those calls, the adapter sends `session/set_mode` with `default` (`CLAUDE_DEFAULT_MODE_ID`). claude-agent-acp picks a session's first mode from `permissions.defaultMode` whatever the caller passes, so this resets it before any prompt can run.
3. **Repo allow rules refused.** Until the live check below has passed against the pinned version, defence 1 is not taken on trust for the tier an agent can write. Before it launches anything, `connect` reads the three files. If the project or local file has a non-empty `permissions.allow`, or JSON it cannot read, `connect` rejects with `ClaudePermissionSettingsError` and starts nothing. A `defaultMode` there is allowed, because defence 2 covers it. User-tier allow rules are the person's own choice and are only neutralised by defence 1. `createClaudeAdapter({ refuseRepoAllowRules: false })` turns this check off; the live test uses that to prove defence 1.
4. **Custom commands checked fully.** A `launch.command` override may not honour defence 1, so for an override any finding in any tier (allow rules, a non-default mode, unreadable JSON) is refused.

`ClaudePermissionSettingsError` has `code: 'claude_permission_settings'` (`CLAUDE_PERMISSION_SETTINGS`) and lists each override as `{ path, tier, kind, reason }`, so the server can raise it as a card.

### Sign-in

Sign-in stays with Claude Code. When it is not signed in, `session/new` fails with auth required, and so does `session/prompt` if the login lapses mid-session. `isAuthRequiredError` recognises both. Quarterdeck surfaces that to the dashboard and never calls `authenticate` on its own.

### Live smoke

`test/acp/claude-live.test.ts` drives the real claude-agent-acp. It checks:

- a turn ends with the expected reply;
- `CLAUDE_ADAPTER` refuses a worktree whose `.claude/settings.local.json` allows `Bash(*)`;
- with that refusal turned off, a `touch` through the Bash tool still arrives as `session/request_permission`, and the rejection is honoured (no file is created). This proves defence 1 against the pinned version.

It needs a signed-in Claude Code and `claude` on `PATH`, and is skipped unless `QUARTERDECK_LIVE=1`. It skips itself when claude-agent-acp reports that Claude Code is not signed in.

```sh
QUARTERDECK_LIVE=1 npx vitest run packages/server/test/acp/claude-live.test.ts
```
