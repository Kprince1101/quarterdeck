# api

The dashboard's typed client for the server: one function per intent, and the stream as a hook. Both are built from the server's shared schemas (`@quarterdeck/server/intents` and `@quarterdeck/server/stream-schema`), which import nothing but `zod`, so nothing here is hand-written per intent or per table.

## Token

The server needs its per-start token on every `/api` request and on the stream (see the server's [api](../../../server/src/api/README.md#token)). `quarterdeck up` prints `http://127.0.0.1:<port>/#token=<token>`; a fragment is never sent to the server, and the page's HTML and JS never hold the token.

`takePageToken()` reads `token` from the fragment, keeps it in `sessionStorage` under `TOKEN_STORAGE_KEY` (`quarterdeck.token`), and removes it from the address bar with `history.replaceState`, leaving any other fragment parameters. It returns the stored token, so a reload in the same tab still works, or `null` when there is none. The live page (`src/live.tsx`) calls it once: with a token it builds the intent client, the rules reader and the stream from `liveSources(token)`; without one it shows a short "Open the link printed by `quarterdeck up`" screen instead of the dashboard. Demo mode never calls it and sends no token.

`createIntentClient({ token })` and `createRulesReader({ token })` send `Authorization: Bearer <token>`; `openStream({ token })` and `useStream({ token })` offer it as a WebSocket protocol (`streamProtocols(token)`), never in the URL. Without `token` none is sent, and the live server answers `401`.

## Intents

```ts
import { createIntentClient, intents, IntentError } from './api';

await intents.notebook.add({ project: 'deck', body: 'remember this' });

const remote = createIntentClient({ baseUrl: 'http://127.0.0.1:4317' });
const reply = await remote.planner.message({
  project: 'deck',
  text: 'ship it',
});
reply.status; // 'pending'
```

`intents` posts to the page's own origin. Every intent in the registry is `client.<group>.<action>`, typed from its schema's input (`IntentInput<N>`), and resolves to the server's `IntentReply` with `intent` narrowed to that name. `createIntentSender()` gives the same thing as one `send(name, input, options?)` function.

Every sender takes an optional second options argument (third for `send`). `{ keepalive: true }` sends the request with `fetch`'s `keepalive`, so it completes after the page unloads (the dashboard uses it to save the layout on `pagehide`). Browsers cap keepalive bodies at `KEEPALIVE_BODY_LIMIT` (64 KiB); a larger body is refused before sending with `IntentError` status `413` and `sent: false`.

The input is checked against the same schema before it is sent. A refusal, local or from the server, throws `IntentError`:

| Field    | Meaning                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| `intent` | The intent name.                                                                  |
| `status` | The HTTP status (`400` for a local refusal, `413` for a keepalive body too big).  |
| `issues` | zod's `{ path, message }` list for an invalid body, otherwise `undefined`.        |
| `sent`   | `false` when the schema refused it before any request went out, `true` otherwise. |

A network failure rejects with `fetch`'s own error.

## Rules

```ts
import { createRulesReader, readRules } from './api';

const machine = await readRules(null);
const deck = await readRules('deck');
deck.rules[0]; // { name, file, defaults, machine, repo }
```

`readRules(project)` reads `GET /api/rules` (with `?project=<slug>` when given) and parses the reply with `rulesViewSchema` from `@quarterdeck/server/intents`. Each rule carries its shipped `defaults` (`{ path, content }`), its `machine` layer and, for a project with a repo, its `repo` layer (`content` is `null` when the file does not exist). A refusal or a malformed reply throws `RulesReadError` with the HTTP `status` and the server's message. `createRulesReader({ baseUrl, fetch })` makes one for another origin or a fake `fetch`.

## Stream

```tsx
import { useStream } from './api';

const Board = () => {
  const { status, tables, events } = useStream();
  ...
};
```

`useStream(options?)` opens the WebSocket at `ws(s)://<page host>/ws` (or `options.url`) and returns a `StreamState`:

| Field     | Meaning                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------- |
| `status`  | `connecting` until the first snapshot, `live` after each snapshot, `reconnecting` while dropped, `closed` after.  |
| `tables`  | Every `STREAM_TABLES` table as an array of rows, empty until the first snapshot.                                  |
| `machine` | `{ pausedAt }`, the machine-wide pause, from each snapshot and each `machine` message. `UNPAUSED_MACHINE` before. |
| `events`  | The newest `eventLimit` (500) events, in id order.                                                                |
| `cursor`  | The last event id handled, or the snapshot's cursor, `null` before the first snapshot.                            |
| `error`   | Why the stream last dropped or which message it could not read; cleared by the next snapshot.                     |

Each snapshot replaces `tables`. A `change` upserts its row by `id`, or removes it when `row` is `null`; removing an agent also removes its turns, since the server sends no deletes for those. Turns are kept to each agent's latest `turnsPerAgent` (20), like the snapshot. Messages that do not match `streamMessageSchema` are skipped and reported through `error` and `onError`.

When the socket closes or errors, it reconnects after `retryDelayMs` (500), doubling up to `maxRetryDelayMs` (10 000), with `?after=<cursor>` so no event is lost or repeated. The hook closes the socket on unmount and starts over when `url` changes.

`openStream(options)` is the same connection without React: `state`, `subscribe(listener)` and `close()`. `applyStreamMessage(state, message)` is the reducer both use.
