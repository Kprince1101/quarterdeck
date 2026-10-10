# stream

One read-only WebSocket per dashboard tab at `ws://localhost:<port>/ws`. It carries the project's events and table changes from the store's NOTIFY bus. Nothing is written over it: intents go to the HTTP API.

## Mounting

The stream has no server of its own. The HTTP API mounts it on its server:

```ts
import { attachStream, openStore } from '@quarterdeck/server';

const store = await openStore({ project: 'example' });
const stream = attachStream(httpServer, {
  store,
  token: api.token,
  allowedOrigins: ['http://localhost:5173'],
});
httpServer.listen(port, '127.0.0.1');
// on shutdown
await stream.close();
await store.close();
```

`quarterdeck up` mounts one stream per open project on the API's port with `routeStreams({ token, streams, allowedOrigins })`, which picks the project's stream from `?project=<slug>` (`STREAM_PROJECT_PARAM`), or the only open project when there is one; see [quarterdeck](../quarterdeck/README.md#the-stream).

`attachStream` answers every upgrade request; other paths get 404. A server with more than one upgrade path calls `createStream({ store }).handleUpgrade(req, socket, head)` itself: it returns `false` for paths that are not `/ws` and leaves the socket alone. `serveStream({ store, port?, token? })` binds a bare server to `127.0.0.1` for tests and standalone use; without `token` it makes one, and `served.token` gives it.

Bind the host server to `127.0.0.1` only. The stream also refuses, with 403:

- an upgrade from a non-loopback address;
- a `Host` header other than `127.0.0.1:<port>` or `localhost:<port>`, where `<port>` is the port the connection came in on (DNS rebinding);
- an `Origin` other than `http://127.0.0.1:<port>`, `http://localhost:<port>` or one listed in `allowedOrigins`. This blocks any other web page, including another local app on a different port.

These are the same rules as the HTTP API's guard.

## Token

`token` is the HTTP API's per-start token (see [api](../api/README.md#token)), and the upgrade must carry it before anything is sent. A browser cannot set headers on a WebSocket, and a query string ends up in logs, so the token rides in `Sec-WebSocket-Protocol`: the client offers `streamProtocols(token)`, which is `['quarterdeck', 'quarterdeck.token.<token>']`, and the server answers with `quarterdeck` alone, so the token is never echoed. An upgrade with no token protocol or the wrong token gets HTTP `401` with an empty body, after the Host and Origin checks; no socket is opened and no frame is sent. The check is `verifyApiToken`, the same one the HTTP API uses. `STREAM_PROTOCOL`, `STREAM_TOKEN_PREFIX` and `streamProtocols` are exported from `@quarterdeck/server/stream-schema` for the dashboard.

```ts
import { streamProtocols } from '@quarterdeck/server/stream-schema';

const ws = new WebSocket('ws://127.0.0.1:4317/ws', streamProtocols(token));
```

## Protocol

Every message is one JSON object. `@quarterdeck/server/stream-schema` exports the zod schemas and types (`streamMessageSchema`, `StreamMessage`, the row schemas) and depends on nothing but zod, so the dashboard can import it; `z.toJSONSchema(streamMessageSchema)` gives the JSON Schema.

1. `{ type: 'snapshot', cursor, tables, machine, layout, workspace, keepAwake }` comes first on every connection. `machine` is `{ pausedAt }`, the machine-wide pause from `pause.all`: the ISO time in `<home>/pause.json`, its file time if the file cannot be read, or `null` when there is no file. `home` is the `home` option (the data folder, `~/.quarterdeck` by default). `layout` is the dashboard layout every project shares, `{ spec, updatedAt }` from `<home>/layout.json`, or `null` when there is none or the grid could not show it (see [api](../api/README.md#dashboard-layout)). `tables` holds this project's rows in each table of `STREAM_TABLES` (all tables but the `events` and `intents` logs; intents show up as their events), keyed by table name, with camelCase columns, ISO timestamps and money as decimal strings. It is kept small. `turns` holds only each agent's latest `SNAPSHOT_TURNS_PER_AGENT` (20) turns, and turn rows never carry `prompt` (token counts, stop reason and `transcriptPath` are there). A turn's prompt, output and result are read on demand with the `turn.read` intent.
2. `{ type: 'event', event }` for each event after `cursor`, in id order, then live.
3. `{ type: 'change', table, op, id, row }` for each insert, update or delete, live. `row` is the row as it is now, or `null` once it is gone: upsert it by `id`, or remove `id`.
4. `{ type: 'machine', machine }` right after each event whose kind is in `MACHINE_EVENT_KINDS` (`pause.all`), re-read from `pause.json`. `pause.all` writes the file before it records its events, so the message carries the new state. Replace the snapshot's `machine` with it.
5. `{ type: 'layout', layout }` after each save of the dashboard layout, live, with the layout as saved. It comes from the `layouts` option, the `GlobalLayouts` the API saves through, so every stream sharing that instance sends it whichever project it is on; without the option the stream reads the file for its snapshot but hears no saves. Replace the snapshot's `layout` with it.
6. `{ type: 'workspace', workspace }` after each change to `<home>/workspace.json` made through the `workspaces` option (the `Workspaces` the API writes through; see [workspace](../workspace/README.md)). The snapshot carries the same `workspace`, `{ root, mode, projects, updatedAt }`, or `null` when there is none, which readers treat as `multi`. Replace it with each one; a switch from `single` to `multi` is when the dashboard shows its one-line notice.
7. `{ type: 'keepAwake', keepAwake }` after each change to the machine's [keep-awake](../keep-awake/README.md) hold made through the `keepAwake` option (the `KeepAwake` the API's `keepAwake.*` intents act on): start, stop, the time running out, the voyage end, or the child exiting. The snapshot carries the same state, `{ on, mode, expiresAt, available, unavailableReason }`, or `null` on a stream with no `keepAwake` option. Replace it with each one.

Events and changes are separate streams; their relative order on the wire is not meaningful. When an agent is deleted, its turns go with it, and no separate `turns` deletes are sent.

## Slow clients

The snapshot is always sent whole, and nothing follows it until it has been written to the socket. Events go out one at a time, each after the previous one has been written, so a slow reader slows the replay rather than piling it up in memory. Changes are not paced. A client whose unsent backlog passes `maxBufferedBytes` (default 8 MiB) after its snapshot is dropped. It reconnects with `after` and loses no event.

## Resuming

Connect with `?after=<id>`, where `id` is the last event the client handled (or the snapshot's `cursor` if it saw none). Events after it are replayed, then live ones follow, so a reconnect loses no event. Without `after`, the stream replays the last `STREAM_TAIL` (200) events. `after=0` replays the whole log. Table changes have no cursor: every connection, including a resumed one, starts with a fresh snapshot, and changes made during the snapshot read are sent after it. The snapshot reads every table in one `repeatable read, read only` transaction, so on external Postgres all its tables come from the same moment.

## Closing

| Code   | Meaning                                                                                            |
| ------ | -------------------------------------------------------------------------------------------------- |
| `1001` | The server is shutting down (`stream.close()`).                                                    |
| `1008` | The client sent a message; the stream is read-only.                                                |
| `1011` | The stream failed to start (the store closed, a query failed).                                     |
| `1006` | The client fell more than 8 MiB behind after its snapshot and was dropped. Reconnect with `after`. |
