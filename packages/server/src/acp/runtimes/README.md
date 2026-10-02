# Runtime adapters

One adapter per runtime turns a `RuntimeLaunch` into the command that starts that runtime's ACP agent, and connects to it with `spawnAcpClient` (see [../client/README.md](../client/README.md)).

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

`kiro-cli acp --agent quarterdeck-<project>-<agentName>`. Kiro reads an agent's tools and MCP servers from an agent config file, so `connect` writes one before it starts the process:

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
