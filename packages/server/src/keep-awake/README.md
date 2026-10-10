# keep-awake

Keeps the local machine from idle-sleeping while agents work and the person is away. It holds off system idle sleep only: the screen can still turn off and lock, and on a laptop, closing the lid on battery still sleeps. The dashboard's header control drives it through the `keepAwake.start` and `keepAwake.stop` intents (see [api](../api/README.md#keep-awake)).

## Backends

One `KeepAwakeBackend` per platform, `{ platform, tool, command({ seconds, ownerPid }) }`, in `KEEP_AWAKE_BACKENDS`. `seconds` is `null` for "until voyage ends"; `ownerPid` is the server's pid.

| Platform | Command                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS    | `caffeinate -i -t <seconds> -w <ownerPid>`, or `caffeinate -i -w <ownerPid>` with no limit. `-i` is system idle sleep only, no `-d`; `-w` lets caffeinate go when the server does, even if it is killed.                                                                                                                                                     |
| Windows  | `powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <script>`. The script calls `SetThreadExecutionState(ES_CONTINUOUS \| ES_SYSTEM_REQUIRED)` (no `ES_DISPLAY_REQUIRED`) and holds it with `Wait-Process -Id <ownerPid> -Timeout <seconds>`, so it also ends with the server. `windowsKeepAwakeScript` gives the script. |
| Linux    | `systemd-inhibit --what=idle --why=Quarterdeck sleep <seconds>`, or `sleep infinity` with no limit.                                                                                                                                                                                                                                                          |

`keepAwakeSupport({ platform, env })` looks for the backend's tool on `PATH` (with `PATHEXT` on Windows) and answers `{ available: true, tool, path }` or `{ available: false, tool, reason }`. Any other platform is `Keep-awake is not supported on <platform>.`; it is reported, never thrown at start-up. `quarterdeck doctor` prints the same answer on its `keep-awake` line.

## The controller

`createKeepAwake({ home })` gives `{ read, start, stop, voyageEnded, recover, subscribe, close }`. Calls run one at a time, in order.

- `start({ minutes })` or `start({ untilVoyageEnds: true })` releases any hold that is on, spawns the backend's command and answers the new state. A `duration` hold has a timer for its end and the tool's own limit behind it. Refused (`KeepAwakeError`) when the tool is missing or the server is shutting down.
- `stop()` releases the hold. `voyageEnded()` releases it only in `untilVoyageEnds` mode; [`startQuarterdeck`](../quarterdeck/README.md) calls it on every project's `voyage.ended` event, which both `voyage.end` and `voyage.kill` record.
- A child that exits on its own turns the state off.
- `subscribe(listener)` hears every change; `read()` answers the current state. The stream sends both.

## Ownership

The server owns the child the way it owns agents. The child is spawned in its own process group (detached, as agents are, except on Windows) and released with the same tree stop (`stopTree`: `SIGTERM` to the group, `SIGKILL` after `KEEP_AWAKE_KILL_GRACE_MS`, `taskkill /T` on Windows). It is released when its time runs out, on `stop`, on the voyage end for its mode and on `close()`, which `quarterdeck up` runs on shutdown before anything else.

For a crash, the hold is recorded as `{ pid, startedAt }` in `~/.quarterdeck/keep-awake.json` while it is on. A Node exit (an uncaught error, `process.exit`) kills it from the `exit` handler. On macOS and Windows it also waits on the server's pid and goes on its own if the server is killed outright. On the next start, `recover()` reads the record and stops that process only if it is still the one recorded (`stopOwnTree`, the check the agent sweep uses, so a reused pid is left alone), then removes the file. Keep-awake does not come back after a restart: the state starts off.
