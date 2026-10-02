# ACP client

Quarterdeck's Agent Client Protocol client. It drives one agent process over stdio, using the wire types and JSON-RPC framing from `@agentclientprotocol/sdk`.

## Entry points

- `spawnAcpClient(command, options)` starts the agent process and connects to it over ndjson on stdin and stdout. It returns once `initialize` has been answered.
- `connectAcpClient({ stream, options })` is the same client over any ACP `Stream`, with no process attached.

The returned client offers:

- `newSession({ cwd, mcpServers })`
- `prompt(sessionId, input)`
- `cancel(sessionId)`
- `resumeSession({ sessionId, cwd, mcpServers })`, which uses `session/resume` when the agent supports it and `session/load` otherwise
- `subscribe(listener)`
- `close()`

## Client capabilities: `fs: false`, `terminal: false`

`initialize` advertises `fs: { readTextFile: false, writeTextFile: false }` and `terminal: false` on purpose. Quarterdeck does not serve file reads, file writes or terminals to agents. Each runtime (kiro, claude, gemini) reads files, writes files and runs commands with its own built-in tools, inside the session `cwd`.

What Quarterdeck does control is permission: every `session/request_permission` goes to `onPermissionRequest`, which answers from the project's rules. Runtime adapters should expect agents to use their own tools, and should not count on client-side `fs/*` or `terminal/*` callbacks.

## Lifecycle guarantees

- **Initialize deadline.** `initialize` must be answered within `initializeTimeoutMs` (default 30s), and before `signal` aborts if one is given. Otherwise the client closes, stops the child, and rejects with an `AcpClientError` whose code is `initialize_timeout`. An agent that is waiting for sign-in therefore shows up as an error the dashboard can surface, not a hang.
- **Shutdown.** `close()` ends the connection and sends the child SIGTERM. If the child is still running after `killGraceMs` (default 5s), it gets SIGKILL. `close()` resolves once the child has exited.
- **Cancel.** `cancel(sessionId)` answers any permission request still pending for that turn with `cancelled`, as the ACP spec requires.
- **Permission handler failure.** If the permission handler throws, the agent gets a `cancelled` answer. It is never told to allow.
- **Listener errors.** The client's own control flow never sees an error thrown by an event listener. The error goes to `onListenerError`, or to the console by default, and every other listener still gets the event.

## Events

| `type`           | When                                                  |
| ---------------- | ----------------------------------------------------- |
| `spawned`        | The agent process started (carries `pid`)             |
| `session_update` | Every `session/update` notification                   |
| `permission`     | A permission request was answered (request and reply) |
| `turn_end`       | `session/prompt` returned a stop reason               |
| `stderr`         | One line of agent stderr                              |
| `process_error`  | The child process or its stdin raised an error        |
| `exit`           | The agent process exited (code, signal)               |
| `closed`         | The ACP connection closed                             |
