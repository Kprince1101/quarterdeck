# Runtime adapters

One adapter per runtime turns a `RuntimeLaunch` into the command that starts that runtime's ACP agent, and connects to it with `spawnAcpClient` (see [../client/README.md](../client/README.md)).

```ts
const client = await CLAUDE_ADAPTER.connect({ cwd }, clientOptions);
```

| Field          | Meaning                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime`      | `kiro`, `claude` or `gemini`, as named in `rules/models.json`                                                                                                                    |
| `displayName`  | The name shown to people                                                                                                                                                         |
| `command(...)` | The runtime's own `AgentCommand` for a launch                                                                                                                                    |
| `connect(...)` | Spawns `launch.command` if given, otherwise `command(launch)`, and returns the connected `AcpClient`. An override runs in `launch.cwd` with `launch.env` unless it sets its own. |

`launch.command` replaces the runtime's command: tests point it at the fake ACP agent, and a user can point it at a custom install. `agentName` is for kiro's `--agent <name>`; other runtimes ignore it.

Every adapter is tested with `describeRuntimeConformance(adapter)` from `test/acp/runtime-conformance.ts`, which runs the ACP conformance suite through `adapter.connect` against the fake agent and checks every spawned process has exited.

## claude

`npx --yes @agentclientprotocol/claude-agent-acp@0.85.0` (`CLAUDE_AGENT_ACP_VERSION`). The version is pinned so that an upgrade is a deliberate change. On Windows the command goes through `cmd.exe /d /s /c`, because `npx` there is a `.cmd` shim and Node only starts those through a shell.

npx runs in `~/.quarterdeck/runtimes/claude` (`claudeRuntimeDir()`), never in the session cwd. An agent can write to its own worktree, so a `.npmrc` it planted there could otherwise choose where the package is downloaded from. The child env also sets `npm_config_registry=https://registry.npmjs.org/`. The worktree reaches the agent only as the `cwd` of `session/new`, which is all ACP needs.

claude-agent-acp is not a dependency of the server. It brings Claude Code's native binary (about 240 MB), so it is only fetched on the first claude launch, and npx caches it after that. That first launch can take longer than the client's default 30s initialize deadline, so `CLAUDE_ADAPTER.connect` defaults `initializeTimeoutMs` to `CLAUDE_INITIALIZE_TIMEOUT_MS` (5 minutes). Callers can still pass their own. The longer wait can never hide a sign-in prompt, because claude-agent-acp answers `initialize` before it checks sign-in.

Follow-up, deferred: `npx` pins claude-agent-acp itself but not its dependencies, which resolve from version ranges on first fetch. Two machines can therefore run different transitive code. The planned fix is a lockfile-backed install under `~/.quarterdeck/runtimes/claude/`: `npm ci` from a committed lock, then start the installed binary instead of going through npx.

Sign-in stays with Claude Code. When it is not signed in, `session/new` fails with auth required, and so does `session/prompt` if the login lapses mid-session. `isAuthRequiredError` recognises both. Quarterdeck surfaces that to the dashboard and never calls `authenticate` on its own.

### Permissions

Every tool call has to reach the project's rules as a `session/request_permission`. Claude settings could settle some calls first:

- `permissions.allow` rules
- a `permissions.defaultMode` such as `acceptEdits` or `bypassPermissions`

They can come from any of three files: `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), `<cwd>/.claude/settings.json` and `<cwd>/.claude/settings.local.json`. The last two sit in the agent's own worktree, so an agent could otherwise grant itself permissions. `CLAUDE_ADAPTER` closes this in three ways:

- Every `session/new`, `session/resume` and `session/load` carries `_meta.claudeCode.options` set to `{ settingSources: [], allowDangerouslySkipPermissions: false }` (`CLAUDE_LOCKED_OPTIONS`). claude-agent-acp hands these to the Claude Agent SDK, so Claude Code loads no user, project or local settings for the session, and bypass mode is unavailable. Any other `meta` the caller passes is kept. The cost is that user settings such as hooks, `env` and CLAUDE.md loading do not apply inside Quarterdeck. Sign-in is not a setting and still works.
- Right after each of those calls, the adapter sends `session/set_mode` with `default` (`CLAUDE_DEFAULT_MODE_ID`). claude-agent-acp still picks a session's first mode from `permissions.defaultMode`, so this puts the session back in default before any prompt can run.
- The `_meta` options are known to work only with the pinned claude-agent-acp. When `launch.command` replaces the runtime's command, the adapter therefore reads the three settings files before it launches anything. If any of them has a non-empty `permissions.allow`, a `defaultMode` other than `default`/`manual`, or JSON it cannot read, `connect` rejects with `ClaudePermissionSettingsError` and starts nothing. The error has `code: 'claude_permission_settings'` and lists each `{ path, reason }`, so the server can raise it as a card.

The live test in `test/acp/runtimes/claude-live.test.ts` sends one prompt to the real claude-agent-acp. It runs only when `QUARTERDECK_LIVE=1` is set and `claude --version` succeeds. That keeps an ordinary `npm test` from downloading the package or using the contributor's Claude account. It skips itself when claude-agent-acp reports that Claude Code is not signed in.
