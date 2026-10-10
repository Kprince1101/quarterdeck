# Runtime adapters

One adapter per runtime turns a `RuntimeLaunch` into the command that starts that runtime's ACP agent, and connects to it. `defineRuntimeAdapter` connects with `spawnAcpClient` (see [../client/README.md](../client/README.md)). The kiro, gemini and claude adapters connect with `launchAcpClient` (see [../launch/README.md](../launch/README.md)), so every launch records the runtime's version and retries a spawn that fails to exec. Their `connect` takes `LaunchOptions`. None of them runs its CLI in the agent's worktree: the worktree is only the `cwd` the caller passes to `session/new`.

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
| `passEnv`      | The variable names the runtime needs to sign in, added to every launch's child env (see [../README.md](../README.md#the-child-environment))                                      |
| `command(...)` | The runtime's own `AgentCommand` for a launch                                                                                                                                    |
| `connect(...)` | Spawns `launch.command` if given, otherwise `command(launch)`, and returns the connected `AcpClient`. An override runs in `launch.cwd` with `launch.env` unless it sets its own. |

`launch.env` is a `ChildEnvSpec` (names to pass, values to set), never a whole environment; the process gets only what `childEnv` builds from it. `launch.command` replaces the runtime's command: tests point it at the fake ACP agent, and a user can point it at a custom install. `project` (the project slug) and `agentName` name kiro's `--agent`; other runtimes ignore them. `role` and `rules` (the `homeDir` and `repoDir` the project's rules load from) pick kiro's [base agent](#base-agents); other runtimes ignore them too. `mcpServers` are the MCP servers the agent must always have, the bus first among them. A runtime that reads them from its own config (kiro) writes them there. The others ignore the field, and the caller passes the same servers to `session/new`.

## Images in prompts

An agent says it takes images in a prompt with `agentCapabilities.promptCapabilities.image` in its `initialize` reply (`acceptsImages(client.agent)`). What each runtime reports, checked on 2026-10-10:

| Runtime | `promptCapabilities`                                  | Source                                                                                                                                                                          |
| ------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude  | `{ image: true, embeddedContext: true }`              | claude-agent-acp 0.85.0, `dist/acp-agent.js` `initialize`. An image block with `data` becomes an Anthropic base64 image; one with only an `http` `uri` becomes a URL image.     |
| gemini  | `{ image: true, audio: true, embeddedContext: true }` | Gemini CLI `packages/cli/src/acp/acpRpcDispatcher.ts` `initialize`.                                                                                                             |
| kiro    | `{ image: true }`                                     | Kiro CLI's ACP docs (kiro.dev/docs/cli/acp): the `initialize` example and "Supports image content in prompts". `kiro-cli` was not installed on the machine this was checked on. |

All three take images today. Whatever a runtime reports, the client never drops an image silently: `AcpClient.prompt` throws `AcpClientError` with code `image_unsupported` (and sends nothing) when the prompt holds an `image` block and the agent did not set `promptCapabilities.image`. Its message names the agent and says to send the image's file path as text instead. The Planner checks the capability first, so it sends an image block only to an agent that takes one and a path line otherwise (see [planner](../../planner/README.md#images)). The fake agent advertises `{ image: true }` with `acceptsImages` (`--accepts-images`) and echoes each image block it gets as `[image block: <mimeType>, <bytes> bytes]`.

Every adapter is tested with `describeRuntimeConformance(adapter, base?)` from `test/acp/runtime-conformance.ts`. It runs the ACP conformance suite through `adapter.connect` against the fake agent, merging `base` into every launch, and checks every spawned process has exited.

## kiro

`kiro-cli acp --agent quarterdeck-<project>-<agentName>`, started through `launchAcpClient` (see [../launch/README.md](../launch/README.md)), so every launch records `kiro-cli --version` and retries a spawn that fails to exec. `connect` takes `LaunchOptions`. Kiro reads an agent's tools and MCP servers from an agent config file, so `connect` writes one before it starts the process:

- Path: `~/.kiro/agents/quarterdeck-<project>-<agentName>.json` (`createKiroAdapter({ agentsDir })` changes the folder). The `quarterdeck-` prefix keeps it clear of the user's own agents. The project slug keeps two projects that reuse an agent name from removing each other's config. The file is removed when the client closes or the process exits, and rewritten on the next launch if a crash left it behind.
- `mcpServers`: the launch's stdio and http servers, converted to Kiro's shape (`env` and `headers` become objects). Kiro's config has no sse or acp transport, so those stay out of the file.
- `tools: ["*"]`, `allowedTools: []`: no tool is pre-approved, so every tool call reaches Quarterdeck as a `session/request_permission` and is answered from the project's rules.
- `includeMcpJson: false`: the user's own `mcp.json` servers are not loaded into Quarterdeck agents.

That is the whole file when the role has no base agent. With one, the base fills in the rest (see below).

The returned client drops from `session/new` and `session/resume` any MCP server whose name is already in the config, so Kiro does not start the bus twice. Servers that are not in the config (sse, acp, or ones added per session) are passed through.

The project and agent name must be letters, digits, `-` and `_`. Anything else throws `KiroConfigError` before a file is written.

### Base agents

A Quarterdeck agent can start from one of the user's own Kiro agents, so it gets their MCP servers, steering, skills, prompt and model. `rules/kiro.json` names one per role in `baseAgents` (`driver`, `reviewer`, `builder`; all `null` by default). A project's repo layer may set only `builder` (see [rules/README.md](../../../../../rules/README.md#kiro-base-agents)). Other roles, the planner among them, never get a base.

`connect` resolves the base for `launch.role`, by name:

- a builder's from `<repoDir>/.kiro/agents/<name>.json`, then `~/.kiro/agents/<name>.json` (the adapter's `agentsDir`). The workspace wins, as it does in Kiro. `repoDir` is the project's checkout from `launch.rules`, never the agent's worktree, so an agent cannot plant a base for its next launch;
- a driver's or reviewer's from `~/.kiro/agents/<name>.json` only, with the rule read from the machine layer only.

A base that is missing, is not JSON, or has a field of the wrong type (an MCP server also needs a `command` or a `url`) throws `KiroConfigError` naming the path, before anything is written or spawned. So does a base named `quarterdeck-…`, which could be the very file `connect` writes and removes. A rule layer that breaks the schema throws `RulesError`.

`buildKiroAgentConfig(name, servers, { base, prompt })` then writes the generated agent (the name stays `quarterdeck-<project>-<agentName>`, so the shadow check above is unchanged):

| Field            | Value                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`         | The base's prompt, then Quarterdeck's, joined by a blank line. A `file://` prompt is read from disk, relative to the base file (`~/` is the home folder).                                                    |
| `mcpServers`     | The base's servers as written, then Quarterdeck's. A base server with the name of any server in the launch (the bus, or one Kiro's config cannot hold such as sse) throws `KiroConfigError` naming the base. |
| `tools`          | The base's, or `["*"]`. When the base lists tools without `*`, `@<server>` is added for each server in the launch, whatever its transport, so the bus stays usable.                                          |
| `allowedTools`   | The base's, or `[]`. Tools listed here skip `session/request_permission`, so a machine base decides what runs without a card.                                                                                |
| `toolsSettings`  | The base's, if any.                                                                                                                                                                                          |
| `resources`      | The base's, in order. A relative `file://` or `skill://` path, and a knowledge base's relative `file://` `source`, is resolved against the base file's folder, because Kiro runs in `~/.quarterdeck/kiro/`.  |
| `model`          | The base's, if any.                                                                                                                                                                                          |
| `includeMcpJson` | The base's, or `false`. Always `false` for a builder.                                                                                                                                                        |

Some fields are dropped. The base is still used, and the adapter logs `Kiro base agent <path> sets <fields>; Quarterdeck ignored them.` through its `warn` option (`console.warn` by default), naming each dropped field the base actually sets. Any field not in the table is left out silently.

- `hooks` are never copied, from any base.
- A builder never gets `includeMcpJson: true`, even from a machine base. With it, Kiro loads the workspace `.kiro/settings/mcp.json` under the session cwd, which for a builder is its own worktree: a builder could add an MCP server by writing that file, and Kiro would start it on the next launch with no card. The servers in the global `~/.kiro/settings/mcp.json` are not copied in either; list the ones a builder needs in the base's `mcpServers`.
- A base read from `<repoDir>/.kiro/agents/` also loses `mcpServers`, `allowedTools` and `toolsSettings`. Agents can write to the repo (a builder's pull request lands there, and the planner runs in it), so a committed agent must not start a server command or pre-approve a tool. It keeps `prompt`, `resources`, `tools` and `model`. A project that needs servers or pre-approvals for its builders puts the agent in `~/.kiro/agents/` and names it from the repo layer.

A repo base may also only point inside the repo. Its `file://` prompt, and every `file://` or `skill://` resource and knowledge-base `source`, must resolve, after `~/` and `..`, to a path under `repoDir`. They are checked again on disk, against the repo's real path:

- the prompt file after following symlinks;
- each resource's path up to its first glob segment after following symlinks;
- when that is a folder, every symlink anywhere under it.

Anything else, such as `file://~/.quarterdeck/api.token`, throws `KiroConfigError` naming the base, and nothing is read. The same applies to the base file itself: a `.kiro/agents/<name>.json` that links outside the repo is refused before it is read. A repo prompt file whose text is itself a `file://` reference is refused, because Kiro would follow it. A folder that cannot be inspected is reported as a `KiroConfigError` too.

`quarterdeck doctor` prints the base each role resolves to (`kiro base for builder: everyday (~/.kiro/agents/everyday.json)`), or the error, whenever any role has one. The builder line uses the repo layer of the folder doctor runs in.

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

Quarterdeck signs Kiro in through Kiro itself: ACP `authenticate` with `kiro-login`, then `kiro-cli whoami` to confirm, then `kiro-cli login` if Kiro is still signed out (see [Signing in](#signing-in) below). When Kiro is not signed in, `session/new` fails with auth required, which `isAuthRequiredError` recognises, and the [sign-in gate](../../signin/README.md) runs that flow before it falls back to a card naming `kiro-cli login`.

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

## gemini

`gemini --acp --approval-mode default --admin-policy ~/.quarterdeck/gemini/admin-policy.toml`, started through `launchAcpClient`. `--acp` is Gemini CLI's native ACP mode; it replaced `--experimental-acp`. The process gets two extra variables:

- `GEMINI_CLI_SYSTEM_SETTINGS_PATH=~/.quarterdeck/gemini/system-settings.json`
- `GEMINI_CLI_TRUST_WORKSPACE=false`

`createGeminiAdapter({ dir })` changes the folder. The `gemini --version` probe gets the same folder and environment. `project` and `agentName` are ignored. `mcpServers` is ignored too: the caller passes the bus to `session/new`.

### The worktree is never the process directory

`gemini` runs in `~/.quarterdeck/gemini/`. That also applies to a `launch.command` override. The worktree is only the `cwd` passed to `session/new`, and Gemini scopes the session's tools to that cwd.

### Every tool call asks

`--approval-mode default` alone is not enough. Gemini CLI also reads the user's `~/.gemini/settings.json` and `~/.gemini/policies/*.toml`, and the workspace's `.gemini/settings.json` and `.env`, which sit inside the repo the agent edits. All of these can let a tool run with no `session/request_permission`, or change the account the agent bills:

- `tools.allowed`
- MCP servers with `trust: true`
- saved "always allow" answers
- user policy `allow` rules
- hooks
- `GOOGLE_API_KEY` or `GOOGLE_CLOUD_PROJECT` in a project `.env`

The adapter locks all of these down. `connect` rewrites both Quarterdeck-owned files before every launch, so an agent's edit to them does not survive into the next launch.

| Layer                                                            | What it does                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System settings (`GEMINI_SYSTEM_SETTINGS`)                       | Gemini merges system settings last, over user and workspace. Ours set `tools.allowed: []`, `security.disableYoloMode`, `security.disableAlwaysAllow` (no "always allow" options, and saved ones are ignored), `general.defaultApprovalMode: "default"`, `hooksConfig.enabled: false` and `advanced.ignoreLocalEnv` (no project `.env`).                          |
| `GEMINI_CLI_TRUST_WORKSPACE=false`                               | The session folder is untrusted. Gemini then ignores workspace settings and `.gemini/.env`, refuses `session/set_mode` to `yolo` or `auto_edit`, and does not honour MCP `trust: true` (the settings schema cannot force `trust` off). The cost is that Gemini does not load project `GEMINI.md`, hooks or skills; Quarterdeck passes its charter in the prompt. |
| Admin policy (`GEMINI_ADMIN_POLICY`, passed by `--admin-policy`) | `ask_user` for every tool at Gemini's admin tier, which outranks user policy files and the rules Gemini derives from settings. The shell rule carries an `argsPattern` so Gemini's "known safe command" heuristic cannot turn ask into allow.                                                                                                                    |

Every tool call, reads included, reaches Quarterdeck as `session/request_permission` and is answered from the project's rules. `rules/permissions.json` allows `read`, `search` and `think`.

A `launch.command` override always gets the folder and the environment. It also gets `--admin-policy` when the command's file name is `gemini` (or `gemini.cmd`, `.exe`, `.ps1`; see `isGeminiCommand`). Any other wrapper has to pass `--admin-policy` itself.

### Administrator policy

`connect` refuses to start gemini when Gemini CLI administrator policy is already on the machine, and spawns nothing. It throws `GeminiAdminPolicyError`, which has `cardKind: 'gemini.admin_policy'` (`GEMINI_ADMIN_POLICY_CARD`), `source` and `path`, so the server can raise a card.

| `source`          | Found                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`             | `GEMINI_CLI_SYSTEM_SETTINGS_PATH` already set to another file. Quarterdeck would replace it.                                                                                                               |
| `system_settings` | Gemini's standard system settings file (`/Library/Application Support/GeminiCli/settings.json`, `/etc/gemini-cli/settings.json`, `C:\ProgramData\gemini-cli\settings.json`). Quarterdeck would replace it. |
| `system_policies` | `.toml` files in the standard system `policies/` folder. Gemini then ignores `--admin-policy`.                                                                                                             |

Quarterdeck does not merge an unknown administrator policy under its own, because the combination is hard to reason about.

### Sign-in

When Gemini CLI has no usable credentials, `session/new` fails with auth required, which `isAuthRequiredError` recognises. The methods it offers (Google sign-in, Gemini API key, Vertex AI, a gateway) are in `client.agent.authMethods`. Quarterdeck signs in with ACP `authenticate` and `oauth-personal`, Gemini's own Log in with Google, which opens the browser (see [Signing in](#signing-in) below). Only if that fails does the [sign-in gate](../../signin/README.md) fall back to a card telling the person to run `gemini` and pick a method.

### Live test

`test/acp/gemini.test.ts` has a live test against the real `gemini`. It runs three steps:

1. A tool-free reply.
2. A shell command in a worktree whose `.gemini/settings.json` lists `run_shell_command` in `tools.allowed`. The test asserts the command still arrives as `session/request_permission`.
3. An allowed `write_file`. The test asserts the file lands in the session cwd, not in Gemini's process folder.

It is skipped unless `QUARTERDECK_LIVE=1` (or `QUARTERDECK_GEMINI_LIVE=1`). It is also skipped when:

- `gemini --version` fails or takes longer than 10s;
- `session/new` reports that Gemini CLI is not signed in;
- the adapter refuses an administrator policy.

```sh
QUARTERDECK_LIVE=1 npx vitest run packages/server/test/acp/gemini.test.ts
```

## claude

`npx --yes @agentclientprotocol/claude-agent-acp@0.85.0` (`CLAUDE_AGENT_ACP_VERSION`), started through `launchAcpClient`. The version is pinned so that an upgrade is a deliberate change. On Windows the command goes through `cmd.exe /d /s /c`, because `npx` there is a `.cmd` shim and Node only starts those through a shell.

The version probe is `npx --yes --offline @agentclientprotocol/claude-agent-acp@0.85.0 --cli --version` (`claudeVersionCommand()`). It runs from the same folder and env as the agent. `--cli` makes claude-agent-acp pass `--version` to the Claude Code binary it bundles, so the `agent_version` event reports the CLI the agent really runs, not a standalone `claude` on `PATH`. `--offline` keeps the probe from starting the download itself. On the very first launch the `before_spawn` probe therefore reports `version: null`, and the `after_spawn` probe, which runs once npx has fetched the package, reports the version. claude-agent-acp's own version is `client.agent.agentInfo.version`. `claudeCliCommand(args)` builds the same offline `--cli` command for any other Claude Code arguments; `quarterdeck doctor` uses it for `auth status --json`.

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

When Claude Code is not signed in, `session/new` fails with auth required, and so does `session/prompt` if the login lapses mid-session. `isAuthRequiredError` recognises both. Quarterdeck runs claude-agent-acp's `claude-ai-login` terminal method, which is `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --claudeai`: Claude Code's own claude.ai login, which opens the browser (see [Signing in](#signing-in) below). It then resumes the session, re-sending the prompt in the same session. Only if the sign-in fails does the [sign-in gate](../../signin/README.md) fall back to a card with that command.

### Auth modes

How Claude Code signs in is a per-machine setting, never a project's: `QUARTERDECK_CLAUDE_AUTH` in the server's environment, else `~/.quarterdeck/claude.json` (`{ "auth": "<mode>" }`, `claudeAuthPath()`), else `subscription`. Nothing about it is stored in Postgres. `connect` reads it on every launch (`claudeAuthEnv`, under `launch.rules.homeDir` when given) and adds to the child env, by name, only what the mode needs:

| Mode           | Adds                                                                                                                                                                                                                                                                | Fails the launch when                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `subscription` | nothing; the launch is exactly what it was before auth modes                                                                                                                                                                                                        | never                                                         |
| `api_key`      | `ANTHROPIC_API_KEY`, from the server's env or, on macOS, `security find-generic-password -s quarterdeck-anthropic-api-key -w` (`CLAUDE_KEYCHAIN_SERVICE`)                                                                                                           | neither has a key                                             |
| `vertex`       | `CLAUDE_CODE_USE_VERTEX=1`, and passes `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG`, `ANTHROPIC_VERTEX_BASE_URL` when set (`CLAUDE_VERTEX_PASS_ENV`); gcloud's application-default credentials do the rest | `ANTHROPIC_VERTEX_PROJECT_ID` or `CLOUD_ML_REGION` is not set |

`ANTHROPIC_BASE_URL` is in `CLAUDE_PASS_ENV`, so a gateway works in every mode. A failed launch rejects with `ClaudeAuthError` (`code: 'claude_auth'`, `mode`, `missing`) before anything starts, and its message says what to set. An unknown mode in the env or the file is a `ClaudeAuthError` too. Its message is run through `redactShapes`, so a key pasted where the mode belongs is not echoed. `createClaudeAdapter({ auth: { readKeychain, platform } })` swaps the Keychain lookup in tests. `claudeAuthStatus()` reports `{ mode, source, missing, keySource, gateway }` without the key, for `quarterdeck doctor` and the dashboard's `auth.read`.

`test/acp/claude-auth.test.ts` launches an env-printing agent through the adapter in each mode and checks the exact env it got. `test/quarterdeck/claude-key-leak.test.ts` runs a ticket end to end in `api_key` mode with agents that paste their key into every channel they have, then checks that no table row and no file under `~/.quarterdeck` holds `sk-ant-`.

### Live smoke

`test/acp/claude-live.test.ts` drives the real claude-agent-acp. It checks:

- a turn ends with the expected reply;
- `CLAUDE_ADAPTER` refuses a worktree whose `.claude/settings.local.json` allows `Bash(*)`;
- with that refusal turned off, a `touch` through the Bash tool still arrives as `session/request_permission`, and the rejection is honoured (no file is created). This proves defence 1 against the pinned version.

It needs a signed-in Claude Code and `claude` on `PATH`, and is skipped unless `QUARTERDECK_LIVE=1`. It skips itself when claude-agent-acp reports that Claude Code is not signed in.

```sh
QUARTERDECK_LIVE=1 npx vitest run packages/server/test/acp/claude-live.test.ts
```

## Signing in

Quarterdeck never prints a sign-in command for a person to copy while it can run the sign-in itself. The drivers are in [`../auth/`](../auth/) and exported from `@quarterdeck/server`. `quarterdeck doctor`, `up` and `init` use them in a terminal, and the [sign-in gate](../../signin/README.md) uses them for the dashboard. Each driver runs the runtime's own browser sign-in, so the runtime keeps its credentials where it always does. Quarterdeck never sees, stores or logs a token.

### The pinned methods

Every runtime advertises its sign-in methods in its `initialize` reply (`authMethods`). Quarterdeck picks one by id, pinned in `BROWSER_AUTH_METHODS` (`acp/auth/methods.ts`). Each id was read from the runtime's own source or published output, not guessed:

| Runtime | Method id         | Type       | What it runs                                                                           | Where the id comes from                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------- | ----------------- | ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| claude  | `claude-ai-login` | `terminal` | The agent invocation plus `--cli auth login --claudeai`: Claude Code's claude.ai login | `@agentclientprotocol/claude-agent-acp@0.85.0`, `dist/acp-agent.js`, `initialize`: `id: "claude-ai-login"`, `type: "terminal"`, `args: ["--cli", "auth", "login", "--claudeai"]`. It is advertised only when the client sets `clientCapabilities.auth.terminal`, and not under SSH or `NO_BROWSER` (there it offers `claude-login`, the interactive `/login`). Its `authenticate` handles only the `gateway` methods and throws `Method not implemented.` for anything else.         |
| kiro    | `kiro-login`      | agent      | ACP `authenticate`, then `kiro-cli login` if `kiro-cli whoami` still fails             | kiro-cli is closed source. Its `initialize` reply is quoted in [kirodotdev/Kiro#6603](https://github.com/kirodotdev/Kiro/issues/6603) (kiro-cli 1.28.1): `{"id": "kiro-login", "name": "Kiro Login", "description": "Run 'kiro-cli login' in terminal to authenticate."}`, with no `type`, so ACP treats it as an `authenticate` method. `kiro-cli login` opens the browser locally and uses a device code over SSH ([CLI commands](https://kiro.dev/docs/reference/cli-commands/)). |
| gemini  | `oauth-personal`  | agent      | ACP `authenticate`: Gemini CLI's Log in with Google                                    | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) at `9b6e0265`: `packages/cli/src/acp/acpRpcDispatcher.ts` advertises `id: AuthType.LOGIN_WITH_GOOGLE`, and `packages/core/src/core/contentGenerator.ts` sets `LOGIN_WITH_GOOGLE = 'oauth-personal'`. Its `authenticate` calls `config.refreshAuth(method)`, which runs the Google OAuth flow, then saves `security.auth.selectedType` in the user's settings.                                                |

The ACP spec decides how a method runs. An agent method (no `type`) goes to `authenticate`. A `terminal` method must not: the client runs the agent's own invocation again with the method's `args` and `env` added, and a zero exit means signed in. That is why claude is signed in by running a process rather than by `authenticate`, though both are claude-agent-acp's own flow. Gemini CLI is signed in over ACP, not by spawning `gemini`, because its source shows it has an `authenticate` method that opens the browser.

`connectAcpClient` advertises `clientCapabilities.auth.terminal: true`, because Quarterdeck can now run the agent invocation for a terminal method. claude-agent-acp therefore lists `claude-ai-login` and `console-login` to every client, and the [fallback card](../../signin/README.md#the-command) names the first.

### The drivers

`signInRuntime(runtime, options)` runs one runtime's sign-in, and `runtimeSignInDriver(runtime)` returns it as a `SignInDriver`:

1. Start the runtime's ACP agent in the folder Quarterdeck owns for it, never a worktree: `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0` in `~/.quarterdeck/runtimes/claude`, `kiro-cli acp` in `~/.quarterdeck/kiro`, `gemini --acp` in `~/.quarterdeck/gemini`. No session is opened, so no agent config or lockdown file is written, and every permission request is cancelled. The process gets the user's whole environment, as the sign-in command would in their shell.
2. Find the pinned method in `authMethods`. If it is missing, fail with the ids the agent did offer.
3. Run it: `client.authenticate(id)` for an agent method, `runLoginProcess` for a terminal method (after closing the agent).
4. For claude only, before anything starts: in the `api_key` or `vertex` [auth mode](#auth-modes) the claude.ai login would not change what the agent uses, so the driver fails at once with what the mode needs, and the fallback card says so.
5. For kiro only, check `kiro-cli whoami`. If Kiro is still signed out, run `kiro-cli login` and check again. ACP `authenticate` with `kiro-login` is not documented to open the browser, so the documented login command backs it up.

`signInOverAcp(target, options)` is steps 1 to 3 for any `AcpSignInTarget`; tests point it at the fake agent.

The forge CLIs have no ACP agent, so they are signed in by running their web login with `runLoginProcess`: `GH_WEB_SIGN_IN` (`gh auth login --web --git-protocol https`) and `glabWebSignIn(host)` (`glab auth login --hostname <host> --web --git-protocol https`). Success is checked by running the existing signed-in check again (doctor does that). `runSignIn(tool, options)` signs in any `SignInTool` (`{ kind: 'runtime', runtime }`, `{ kind: 'gh' }`, `{ kind: 'glab', host }`), and `signInToolName(tool)` names it for a card or a terminal line. Every driver, the forge commands and the progress types are exported from `acp/auth/index.ts`, and so from `@quarterdeck/server`; the CLI and the server use them from there. `withRuntimeSignIn(adapter)` wraps an adapter so every client it connects carries `client.signIn`, the driver for its runtime (a `launch.command` override signs in through that command). `PLANNER_ADAPTERS` wraps all three, which is how the sign-in gate finds a driver. Adapters a test passes in are not wrapped, so tests never start a real runtime.

Every driver takes `SignInRunOptions`:

| Option       | Meaning                                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tty`        | A spawned login gets the terminal (`stdio: 'inherit'`), so it can prompt and print its own code. Otherwise its output is piped and read for the URL and code.                                                 |
| `onProgress` | Called with `{ status, url?, code?, message? }` as the sign-in moves through `starting`, `waiting` (a URL or device code was seen), `signed_in` or `failed` (with why).                                       |
| `openUrl`    | Opens the URL a sign-in printed, once, in the default browser (`openInBrowser`: `open`, `xdg-open` or `rundll32 url.dll`, and only `http(s)` URLs). Skipped for runtimes that open it themselves (all three). |
| `signal`     | Cancels the sign-in and stops its process.                                                                                                                                                                    |
| `timeoutMs`  | Gives up after `SIGN_IN_TIMEOUT_MS` (10 minutes) by default.                                                                                                                                                  |
| `env`        | The environment for the agent and the login; `process.env` by default.                                                                                                                                        |

The URL and code come from the tool's own output (`readSignInPrompt`): the first `http(s)` URL on a line, and a code such as `ABCD-1234`, after the word `code` or alone. Only the URL, the code and Quarterdeck's own status text reach a card; raw output lines do not. A failure's reason ends with the last line the tool printed, so the card says why.

### Tests

`test/acp/auth.test.ts` drives the ACP path against the fake agent: `authenticate` with an agent method (the URL and code it prints on stderr reach `onProgress`), a terminal method run as the invocation plus its `args` (success and a non-zero exit), a pinned method the agent does not offer, an agent that does not start, and `withRuntimeSignIn`. `test/acp/login-process.test.ts` drives `runLoginProcess` with stub commands: gh's device-code output, a failure, a missing tool, a timeout and a cancel.
