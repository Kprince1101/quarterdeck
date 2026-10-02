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

claude-agent-acp is not a dependency of the server. It brings Claude Code's native binary (about 240 MB), so it is only fetched on the first claude launch, and npx caches it after that. That first launch can take longer than the client's default 30s initialize deadline, so `CLAUDE_ADAPTER.connect` defaults `initializeTimeoutMs` to `CLAUDE_INITIALIZE_TIMEOUT_MS` (5 minutes). Callers can still pass their own. The longer wait can never hide a sign-in prompt, because claude-agent-acp answers `initialize` before it checks sign-in.

Sign-in stays with Claude Code. When it is not signed in, `session/new` fails with auth required, and so does `session/prompt` if the login lapses mid-session. `isAuthRequiredError` recognises both. Quarterdeck surfaces that to the dashboard and never calls `authenticate` on its own.

Permissions: claude-agent-acp sends `session/request_permission` for each tool call that its permission mode does not already settle. That mode comes from the user's Claude settings (`permissions.defaultMode` and `permissions.allow` in `~/.claude/settings.json` and the project's `.claude/`). A user whose default is `acceptEdits` or `bypassPermissions` therefore has some tool calls that never reach the project's rules. Forcing `default` mode means calling `session/set_mode` after `session/new`, which the client core does not offer yet. That is a follow-up.

The live test in `test/acp/runtimes/claude-live.test.ts` sends one prompt to the real claude-agent-acp. It never runs in CI. Elsewhere it is skipped when `claude --version` fails, and it skips itself when claude-agent-acp reports that Claude Code is not signed in.
