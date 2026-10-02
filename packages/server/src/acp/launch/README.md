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

Before spawning, the wrapper runs `launch.version` and emits one `agent_version` event with the first line it printed (stdout, else stderr). Each adapter names the command that prints its CLI's version. A probe that fails, times out (`versionTimeoutMs`, default 10s) or prints nothing gives `version: null` and an `error`, and the launch goes ahead. The version the agent reports over ACP is in `client.agent.agentInfo` as usual.

## Spawn retry

A spawn that fails to exec (`spawn_failed`: ENOENT, EACCES, ETXTBSY while the binary is being updated) is retried `spawnRetries` times (default 3), `spawnRetryDelayMs` apart (default 15s). Each retry emits a `spawn_retry` event (`attempt`, `retries`, `delayMs`, `message`) before the wait. When the retries run out the last `spawn_failed` error is thrown, which is the normal failure path.

Only exec failures are retried. An agent that starts and then exits, times out on `initialize` or needs sign-in fails at once.

If `options.signal` aborts during a wait, no further attempt is made and the last `spawn_failed` error is thrown.

The wait is `options.sleep(ms, signal)`, so tests can pass one that returns at once.

## Events

Both events go to `options.onEvent`, through the same listener isolation as the client's own events.

| `type`          | When                                                           |
| --------------- | -------------------------------------------------------------- |
| `agent_version` | Once per launch, before the first spawn (`command`, `version`) |
| `spawn_retry`   | A spawn failed to exec and will be retried after `delayMs`     |
