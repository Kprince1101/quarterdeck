# tickets

Where tickets come from and where their progress goes. A ticket source lists approved tickets and takes back a status, a note and a pull request. The project's `tickets` table is the default source; a plugin lets another system feed tickets in. No plugin for any specific system ships in this repo.

## The interface

```ts
interface TicketSource {
  readonly name: string;
  listApproved: () => Promise<ApprovedTicket[]>; // { ref, title, body }
  setStatus: (ref: string, status: TicketStatus) => Promise<void>;
  note: (ref: string, body: string) => Promise<void>;
  attachPr: (
    ref: string,
    pr: { url: string; head: string | null },
  ) => Promise<void>;
}
```

A `ref` is the source's own id for a ticket. Every source checks its arguments before acting and throws `TicketSourceInputError` for a bad one:

| Argument | Must be                                                                                    |
| -------- | ------------------------------------------------------------------------------------------ |
| `ref`    | 1 to `TICKET_REF_MAX` (200) characters.                                                    |
| `status` | One of `TICKET_STATUSES`: the `tickets.status` values, `proposed` through `rejected`.      |
| `body`   | Not blank after trimming, at most `TICKET_NOTE_MAX` (8000) characters. Sent trimmed.       |
| `pr`     | An `http(s)` `url` of at most 2000 characters, and a `head` of 40 lowercase hex or `null`. |

## The local source

`localTicketSource(store)` (`name` `local`) is the project's `tickets` table. Its refs are ticket ids, and it covers every row of the project, whichever source the row came from.

| Method         | Does                                                                                |
| -------------- | ----------------------------------------------------------------------------------- |
| `listApproved` | Every `open` ticket, oldest first. `open` is what approving a proposal sets.        |
| `setStatus`    | Sets `status` and records `ticket.status_set` with `{ status, from }`.              |
| `note`         | Records `ticket.noted` with `{ body }`. The table has no notes column.              |
| `attachPr`     | Sets `pr_url` and `head_sha` and records `ticket.pr_attached` with `{ url, head }`. |

Each write is one transaction: it locks the row, changes it, sets `updated_at`, and records its event on the ticket, so the change reaches the stream like every other ticket write. A ref that is not a ticket of this project throws `TicketNotFoundError` and writes nothing. It needs no migration: `source` and `external_id` have been on `tickets` since `0001_init`.

## Plugins

A plugin is one ES module at `~/.quarterdeck/plugins/<name>.mjs` (`ticketPluginPath(name)`), and is never loaded from anywhere else, a repository included:

- `name` is a slug (`[a-z0-9][a-z0-9_-]{0,62}`) and not `local`, so it cannot climb out of the folder.
- The plugins folder must be its own real path. If it, `~/.quarterdeck`, or anything above them is a symlink, loading is refused, so the folder cannot be pointed at a repository.
- The file's real path must sit directly in that folder. A symlink to a file elsewhere, such as a repository checkout, is refused.
- `openTicketSource` always uses the real `~/.quarterdeck`. `loadTicketSource` takes `home` for tests only; callers never pass it.
- Nothing in Quarterdeck writes to the folder.

Its default export takes `{ name, project }` and returns (or resolves to) the four methods:

```js
// ~/.quarterdeck/plugins/tracker.mjs
export default ({ project }) => ({
  listApproved: async () => [{ ref: 'TRK-12', title: 'Widget', body: '…' }],
  setStatus: async (ref, status) => {},
  note: async (ref, body) => {},
  attachPr: async (ref, { url, head }) => {},
});
```

```ts
import { loadTicketSource, openTicketSource } from '@quarterdeck/server';

const tracker = await loadTicketSource('tracker', { project: 'commander' });
const source = await openTicketSource(store, { project: 'commander', plugin }); // local when plugin is undefined
```

`loadTicketSource` throws `TicketSourcePluginError` when the name is refused, the folder or file is missing, the folder is reached through a symlink, the file resolves outside the folder, the module fails to import, its default export is not a function, throws, or returns something without all four methods. Once loaded, anything a method throws becomes a `TicketSourceError` naming the plugin and the method, with the original as `cause`, and a `listApproved` result is checked: a list of `{ ref, title, body? }` with a non-blank title and no ref twice (`body` defaults to `''`, `title` is trimmed). Node caches the module, so an edited plugin takes effect on the next start.

## Feeding the table

```ts
import { importApprovedTickets } from '@quarterdeck/server';

const { created, updated } = await importApprovedTickets(store, tracker);
```

`importApprovedTickets(store, source)` lists the source's approved tickets and, in one transaction, adds each as an `open` row with `source` = the plugin name and `external_id` = its ref, where the Driver's `assignTicket` finds it like any approved ticket. A ref already imported updates that row's title and body only while it is still `open`; once it is assigned, done or closed it is left alone. Imported tickets have no `depends_on`. When anything was created or updated it records `tickets.imported` with `{ source, created, updated }` (ticket ids). The local source cannot import into itself (`TicketSourceInputError`). A source that fails writes nothing.

A ticket the plugin stops listing is not withdrawn: its row stays as it is, and if it is still `open` the Driver can still assign it. Cancel it by hand (`ticket.cancel`) if it should not be worked.

Nothing writes progress back to a plugin yet: the Driver, the gate and `report` change only the local row. For a row whose `source` is a plugin, a caller can pass the row's `external_id` to that plugin's `setStatus`, `note` or `attachPr`.

## Events

| `kind`               | Payload                                             |
| -------------------- | --------------------------------------------------- |
| `ticket.status_set`  | `{ status, from }`: the new and the previous status |
| `ticket.noted`       | `{ body }`                                          |
| `ticket.pr_attached` | `{ url, head }`                                     |
| `tickets.imported`   | `{ source, created, updated }`: ticket ids          |

The three `ticket.*` events carry the ticket's id. These are the local source's events; a plugin records nothing in the store.
