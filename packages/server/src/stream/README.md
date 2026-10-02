# stream

One read-only WebSocket per dashboard tab at `ws://localhost:<port>/ws`. It carries the project's events and table changes from the store's NOTIFY bus. Nothing is written over it: intents go to the HTTP API.

## Mounting

The stream has no server of its own. The HTTP API mounts it on its server:

```ts
import { attachStream, openStore } from '@quarterdeck/server';

const store = await openStore({ project: 'commander' });
const stream = attachStream(httpServer, {
  store,
  allowedOrigins: ['http://localhost:5173'],
});
httpServer.listen(port, '127.0.0.1');
// on shutdown
await stream.close();
await store.close();
```

`attachStream` answers every upgrade request; other paths get 404. A server with more than one upgrade path calls `createStream({ store }).handleUpgrade(req, socket, head)` itself: it returns `false` for paths that are not `/ws` and leaves the socket alone. `serveStream({ store, port? })` binds a bare server to `127.0.0.1` for tests and standalone use.

Bind the host server to `127.0.0.1` only. The stream also refuses, with 403:

- an upgrade from a non-loopback address;
- a `Host` header other than `127.0.0.1:<port>` or `localhost:<port>`, where `<port>` is the port the connection came in on (DNS rebinding);
- an `Origin` other than `http://127.0.0.1:<port>`, `http://localhost:<port>` or one listed in `allowedOrigins`. This blocks any other web page, including another local app on a different port.

These are the same rules as the HTTP API's guard.

## Protocol

Every message is one JSON object. `@quarterdeck/server/stream-schema` exports the zod schemas and types (`streamMessageSchema`, `StreamMessage`, the row schemas) and depends on nothing but zod, so the dashboard can import it; `z.toJSONSchema(streamMessageSchema)` gives the JSON Schema.

1. `{ type: 'snapshot', cursor, tables, machine }` comes first on every connection. `machine` is `{ pausedAt }`, the machine-wide pause from `pause.all`: the ISO time in `<home>/pause.json`, its file time if the file cannot be read, or `null` when there is no file. `home` is the `home` option (the data folder, `~/.quarterdeck` by default). `tables` holds this project's rows in each table of `STREAM_TABLES` (all tables but the `events` and `intents` logs; intents show up as their events), keyed by table name, with camelCase columns, ISO timestamps and money as decimal strings. It is kept small. `turns` holds only each agent's latest `SNAPSHOT_TURNS_PER_AGENT` (20) turns, and turn rows never carry `prompt` (token counts, stop reason and `transcriptPath` are there). Older turns and prompts are read on demand.
2. `{ type: 'event', event }` for each event after `cursor`, in id order, then live.
3. `{ type: 'change', table, op, id, row }` for each insert, update or delete, live. `row` is the row as it is now, or `null` once it is gone: upsert it by `id`, or remove `id`.
4. `{ type: 'machine', machine }` right after each event whose kind is in `MACHINE_EVENT_KINDS` (`pause.all`), re-read from `pause.json`. `pause.all` writes the file before it records its events, so the message carries the new state. Replace the snapshot's `machine` with it.

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
