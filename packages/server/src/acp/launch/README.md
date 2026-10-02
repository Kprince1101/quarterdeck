# ACP launch

`launchAcpClient(launch, options)` is the way runtime adapters start an agent. It wraps `spawnAcpClient` with two things every launch needs, and returns the same `AcpClient`.

```ts
const client = await launchAcpClient(
  {
    command: { command: 'kiro-cli', args: ['acp', '--agent', name] },
    version: { command: 'kiro-cli', args: ['--version'] },
  },
  options,
);
```

## Version on every launch

Each adapter names the command that prints its CLI's version in `launch.version`. The wrapper runs it twice and emits an `agent_version` event each time, carrying the first line the command printed (stdout, else stderr):

- `stage: 'before_spawn'` runs before the first attempt, so a launch that never starts still records which binary was on disk.
- `stage: 'after_spawn'` runs once the agent has started. During an update the binary that finally starts can differ from the one the first probe saw.

The version step is advisory and never stops an agent from starting. If the probe fails or prints nothing, the event has `version: null` and an `error`, and the launch goes ahead. The probe gets `versionTimeoutMs` (default 10s); after that its whole process group is sent SIGKILL, the event's error is `timed out`, and the launch goes ahead. That holds even for a CLI that ignores SIGTERM or sits on a prompt.

If `options.signal` aborts during either probe, the probe's process group is killed. The launch then rejects with an `AcpClientError` whose code is `aborted`, closing the client first if it had already started. The version the agent reports over ACP is in `client.agent.agentInfo` as usual.

The probe is built on `runCommand(command, { timeoutMs, signal })`, which `quarterdeck doctor` also uses. It runs the command in its own process group and resolves, never rejects, with either `{ status: 'exited', code, signal, stdout, stderr }` (any exit code) or `{ status: 'failed', error, notFound }`: `notFound` is true when the binary is not on `PATH`, and `error` is `timed out` or `aborted` after the group has been sent SIGKILL.

## Spawn retry

A spawn that fails to exec (`spawn_failed`: ENOENT, EACCES, ETXTBSY while the binary is being updated) is retried `spawnRetries` times (default 3), `spawnRetryDelayMs` apart (default 15s). Each retry emits a `spawn_retry` event (`attempt`, `retries`, `delayMs`, `message`) before the wait. When the retries run out the last `spawn_failed` error is thrown, which is the normal failure path.

Only exec failures are retried. An agent that starts and then exits, times out on `initialize` or needs sign-in fails at once.

If `options.signal` aborts during a wait, no further attempt is made and the last `spawn_failed` error is thrown.

The wait is `options.sleep(ms, signal)`, so tests can pass one that returns at once.

## Events

Both events go to `options.onEvent`, through the same listener isolation as the client's own events.

| `type`          | When                                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| `agent_version` | Before the first spawn and after a successful one (`stage`, `command`, `version`) |
| `spawn_retry`   | A spawn failed to exec and will be retried after `delayMs`                        |
