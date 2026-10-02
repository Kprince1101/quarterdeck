# ACP

How Quarterdeck starts and drives agents: [client](client/README.md), [launch](launch/README.md), [runtimes](runtimes/README.md) and [permissions](permissions/README.md).

## The child environment

No process Quarterdeck starts from here inherits the server's environment. `spawnAcpClient` and `runCommand` (agents, version probes, `ps`) both build the child's env with `childEnv(command.env)` from `env.ts`, and nothing in `src/acp` spreads or falls back to `process.env` (`test/acp/env-grep.test.ts` checks).

`AgentCommand.env` and `RuntimeLaunch.env` are a `ChildEnvSpec`, not an environment:

| Field    | Meaning                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `pass`   | More variable names to copy from `source`, on top of the allowlist                                      |
| `set`    | Values Quarterdeck sets itself. They win over anything copied.                                          |
| `source` | Where copied values come from. Defaults to the server's `process.env`; tests and doctor pass their own. |

`childEnv` copies from `source` only:

- `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `TZ` (`CHILD_ENV_NAMES`);
- `SSH_AUTH_SOCK`, so `git push` over ssh works;
- every `LC_*` and `QUARTERDECK_BUS_*` variable (`CHILD_ENV_PREFIXES`);
- on Windows, the variables programs there need to start (`WINDOWS_CHILD_ENV_NAMES`: `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP` and so on). Names match case-insensitively there;
- the names in `pass`.

`withChildEnv(spec, extra)` adds `extra`'s names to `spec`'s and lays its `set` over `spec`'s.

Everything else stays out, `GH_TOKEN`, `GITHUB_TOKEN` and `DATABASE_URL` included. Builders open pull requests with `gh`, which keeps working through its own keyring login; `quarterdeck doctor` warns when `gh` is signed in only through a token variable. The merge gate's `gh` calls (`gate/github.ts`) run in the server process and still see the server's environment.

### Runtime variables

Each adapter declares the variables its runtime needs to sign in, as `adapter.passEnv`, and adds them to every launch, a `launch.command` override included:

| Runtime  | `passEnv`                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR` (`CLAUDE_PASS_ENV`)                                                          |
| `gemini` | `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_GENAI_USE_GCA`, `GOOGLE_GENAI_USE_VERTEXAI` (`GEMINI_PASS_ENV`) |
| `kiro`   | none: `kiro-cli login` keeps its sign-in in Kiro's own store (`KIRO_PASS_ENV`)                                                                                                                 |

Claude Code on Bedrock or Vertex, for example, needs more (`CLAUDE_CODE_USE_BEDROCK`, `AWS_PROFILE`, ...); add those through the rule below.

### The env rule

`rules/env.json` holds `{ "pass": [] }`. A `rules.local.env.json` on the machine or in a project's repo lists more names, merged like the other rules (the last layer that sets `pass` wins). The rule holds names only; values always come from the server's environment. The Planner loads it with the project's repo and passes it as `launch.env.pass`.
