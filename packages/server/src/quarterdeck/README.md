# quarterdeck

`startQuarterdeck` is the whole process `quarterdeck up` runs: the HTTP API, the [coordinator](../crew/README.md) that runs the one voyage, Driver and reviewer across every project, and for every open project its bus host, its WebSocket stream and its [crew](../crew/README.md), all on the same stores. It owns the startup order and the shutdown, so a test can boot the whole thing without the CLI.

```ts
import { startQuarterdeck } from '@quarterdeck/server';

const qd = await startQuarterdeck({ port: 0, homeDir });
console.log(`${qd.url}/#token=${qd.token}`, qd.location);
qd.projects.get('example')?.bus.launch(agentId);
await qd.close();
```

Options are the API server's: `port`, `homeDir`, `dashboardDir`, `databaseUrl`, `allowedOrigins`, `onError`, plus the crew's `adapters` (the runtime adapters agents start through; default the real ones), `forge` (the merge gate's `ForgeHost`; default the project's [forge](../gate/README.md#forges)) and `gatePollMs`. Tests pass a fake runtime and a fake forge there. Each project's bus describes its tools in the project's forge terms. It resolves to `{ url, port, token, location, api, projects, coordinator, close }`. `projects` maps each open project's slug to its services, `{ project, store, bus, stream, crew }`.

## Startup

1. One API token is made for the run. The API checks it on every request and the stream on every upgrade.
2. The coordinator starts (`startCoordinator`), holding no project yet.
3. The API server starts (see [api](../api/README.md)) with the stream router on its `upgrade` event and the coordinator's desk as `voyages`, so `voyage.start`, `voyage.end` and `voyage.kill` reach it, then opens every project.
4. Each project that opens, at startup or later (`project.create`, or the first request that names one), gets its services from `startProjectServices`, in order: the bus host (see [bus](../bus/README.md)), then the stream (see [stream](../stream/README.md)), then the crew (see [crew](../crew/README.md)), which joins the coordinator. The store's [recovery](../lifecycle/README.md#recovery) has already run by then. A bus host or stream that fails to start closes the ones before it and the project's store, and the open fails; at startup that project is reported to `onError` and the rest carry on. A crew that fails to start is recorded as `crew.failed` with `service: 'start'` and the project is served without it; a crew service that fails later is recorded the same way and stops nothing else.

The bus host removes whatever is at its socket path before it listens, so a socket file left by a crash does not stop the next start. That is safe because the project's store is already open here, and only one process can hold a project open.

`startProjectServices(context, project, store)` in `project-services.ts` is the one place a per-project service is added: start it after the services it needs, and push its `close` so it stops before them.

## The stream

The stream is mounted at `/ws` on the API's port. The router checks the Host, the Origin and the token first, as the stream itself does, then picks the project's stream:

| Request                                | Answer                                                           |
| -------------------------------------- | ---------------------------------------------------------------- |
| `/ws?project=<slug>`, the project open | That project's stream.                                           |
| `/ws?project=<slug>`, not open         | `404`.                                                           |
| `/ws`, exactly one project open        | That project's stream.                                           |
| `/ws`, none open                       | `404`. The dashboard keeps retrying, so it connects once one is. |
| `/ws`, more than one open              | `400`, asking for `?project=<slug>`.                             |
| Any other path                         | `404`.                                                           |

## Shutdown

`close()` stops, in order: the coordinator (the Driver and the reviewer; an open voyage stays open, and the next start ends it), every project's crew (its agents' processes are stopped, see [crew](../crew/README.md#closing)), then its stream (open sockets get `1001`), then its bus host (its connections are cut and the socket file removed), then the API (`api.close()`: any ACP client still open, the HTTP server, then the stores). Projects opened while it is closing get no services. A project wiped while running stops its crew, stream and bus host the same way before its store closes. `close()` may be called more than once; later calls wait for the first.
