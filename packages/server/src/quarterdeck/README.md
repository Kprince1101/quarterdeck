# quarterdeck

`startQuarterdeck` is the whole process `quarterdeck up` runs: the HTTP API, and for every open project its bus host and its WebSocket stream, all on the same stores. It owns the startup order and the shutdown, so a test can boot the whole thing without the CLI.

```ts
import { startQuarterdeck } from '@quarterdeck/server';

const qd = await startQuarterdeck({ port: 0, homeDir });
console.log(`${qd.url}/#token=${qd.token}`, qd.location);
qd.projects.get('example')?.bus.launch(agentId);
await qd.close();
```

Options are the API server's: `port`, `homeDir`, `dashboardDir`, `databaseUrl`, `allowedOrigins`, `onError`. It resolves to `{ url, port, token, location, api, projects, close }`. `projects` maps each open project's slug to its services, `{ project, store, bus, stream }`.

## Startup

1. One API token is made for the run. The API checks it on every request and the stream on every upgrade.
2. The API server starts (see [api](../api/README.md)) with the stream router on its `upgrade` event, then opens every project.
3. Each project that opens, at startup or later (`project.create`, or the first request that names one), gets its services from `startProjectServices`, in order: the bus host (see [bus](../bus/README.md)), then the stream (see [stream](../stream/README.md)). A service that fails to start closes the ones before it and the project's store, and the open fails; at startup that project is reported to `onError` and the rest carry on.

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

`close()` stops, in order: every project's stream (open sockets get `1001`), then its bus host (its connections are cut and the socket file removed), then the API (`api.close()`: ACP clients, the HTTP server, then the stores). Projects opened while it is closing get no services. A project wiped while running stops its stream and bus host the same way before its store closes. `close()` may be called more than once; later calls wait for the first.
