# ACP client

Quarterdeck's Agent Client Protocol client. It drives one agent process over stdio, using the wire types and JSON-RPC framing from `@agentclientprotocol/sdk`.

## Entry points

- `spawnAcpClient(command, options)` starts the agent process and connects to it over ndjson on stdin and stdout. It returns once `initialize` has been answered.
- `connectAcpClient({ stream, options })` is the same client over any ACP `Stream`, with no process attached.

The returned client offers:

- `newSession({ cwd, mcpServers, meta? })`. `meta` is sent as the request's `_meta`, the ACP extension point that runtime adapters use for agent-specific options. When the agent needs sign-in, this rejects with an error that `isAuthRequiredError(err)` recognises. Its auth methods are in `client.agent.authMethods`.
- `authenticate(methodId)`, which is only called once a person has chosen to sign in. The client never signs in on its own.
- `prompt(sessionId, input)`
- `cancel(sessionId)`
- `resumeSession({ sessionId, cwd, mcpServers, meta? })`, which uses `session/resume` when the agent supports it and `session/load` otherwise
- `setSessionMode(sessionId, modeId)`, which sends `session/set_mode`. Runtime adapters use it to pin a session to the mode in which every tool call asks for permission.
- `subscribe(listener)`
- `close()`

## Client capabilities: `fs: false`, `terminal: false`

`initialize` advertises `fs: { readTextFile: false, writeTextFile: false }` and `terminal: false` on purpose. Quarterdeck does not serve file reads, file writes or terminals to agents. Each runtime (kiro, claude, gemini) reads files, writes files and runs commands with its own built-in tools, inside the session `cwd`.

What Quarterdeck does control is permission: every `session/request_permission` goes to `onPermissionRequest`, which answers from the project's rules through `createPermissionPolicy` (see `../permissions/README.md`). Runtime adapters should expect agents to use their own tools, and should not count on client-side `fs/*` or `terminal/*` callbacks.

## Lifecycle guarantees

- **Initialize deadline.** `initialize` must be answered within `initializeTimeoutMs` (default 30s), and before `signal` aborts if one is given. Otherwise the client closes, stops the child, and rejects with an `AcpClientError` whose code is `initialize_timeout`. An agent that is waiting for sign-in therefore shows up as an error the dashboard can surface, not a hang.
- **Shutdown kills the whole process tree.** Agents are often started through wrappers such as `npx`, shell scripts or `sh -c`, and they fork their own tool processes, so signalling only the direct child would leave the real agent running.
  - On POSIX the agent is spawned with `detached: true`, which makes it the leader of its own process group. `close()` ends the connection and sends SIGTERM to the whole group (`process.kill(-pid, 'SIGTERM')`). If anything in the group is still alive after `killGraceMs` (default 5s), the group gets SIGKILL.
  - On Windows, the first step is `taskkill /pid <pid> /T` and the escalation is `taskkill /pid <pid> /T /F`.
  - `close()` resolves once the child has exited and the group is gone.
- **The server must close clients on SIGINT and SIGTERM.** A detached group does not get the terminal's Ctrl-C, and it outlives the server if the server exits without calling `close()`. The server's own SIGINT/SIGTERM handlers therefore have to `close()` every open client before exiting. The lifecycle ticket QD5i owns that.
- **Cancel.** `cancel(sessionId)` answers any permission request still pending for that turn with `cancelled`, as the ACP spec requires.
- **Permission handler failure.** If the permission handler throws, the agent gets a `cancelled` answer. It is never told to allow.
- **Listener errors.** The client's own control flow never sees an error thrown by an event listener. The error goes to `onListenerError`, or to the console by default, and every other listener still gets the event.

## Events

| `type`           | When                                                  |
| ---------------- | ----------------------------------------------------- |
| `spawned`        | The agent process started (carries `pid`)             |
| `session_update` | Every `session/update` notification                   |
| `permission`     | A permission request was answered (request and reply) |
| `extension`      | A notification named in `extensionNotifications`      |
| `turn_end`       | `session/prompt` returned a stop reason               |
| `stderr`         | One line of agent stderr                              |
| `process_error`  | The child process or its stdin raised an error        |
| `exit`           | The agent process exited (code, signal)               |
| `closed`         | The ACP connection closed                             |

`agent_version` and `spawn_retry` come from `launchAcpClient`, which adapters use to start agents; see [`../launch/README.md`](../launch/README.md).

## Extension notifications

Runtimes send their own notifications outside the ACP schema, such as Kiro's `_kiro.dev/*` methods. The client listens only for the method names listed in `options.extensionNotifications`. Each one arrives as an `extension` event carrying the method and its params as a plain object. Params that are not an object arrive as `{}`. Extension requests from the agent are not served: the agent gets method-not-found.
