# dashboard

The Quarterdeck dashboard: Vite + React, one page, served by the server on the same origin as the API.

## Build and serve

`npm run build` (or the root `npm run build`) writes the static app to `packages/dashboard/dist`:

```
dist/index.html
dist/assets/index-<hash>.js
dist/assets/index-<hash>.css
```

The server serves that folder at `/`:

- `GET /` and any other path that is not `/api/...` or `/ws` answers `dist/index.html`.
- `GET /assets/<file>` answers the file. The names are content-hashed, so they can be cached for good.
- Resolve the folder from the package, not the working directory: `dirname(require.resolve('@quarterdeck/dashboard/package.json')) + '/dist'`.

The page talks only to its own origin: intents go to `POST /api/intents/<name>`, the Rules widget reads rule files from `GET /api/rules`, and the stream opens at `ws(s)://<page host>/ws`. Nothing else is fetched. Each of those carries the token from the URL `quarterdeck up` prints (see [api](src/api/README.md#token)).

`npm run dev --workspace packages/dashboard` starts Vite on `http://127.0.0.1:5173` and proxies `/api` and `/ws` to the API on `127.0.0.1:4317`. The proxy keeps the browser's `Origin`, so start the API with `allowedOrigins: ['http://127.0.0.1:5173']` for dev.

## Layout

```
src/main.tsx                 mounts livePage() into #root
src/live.tsx                 livePage(): the API token from #token= and <App /> with it, or "open the link printed by npm run quarterdeck -- up"
src/mount.tsx                mountPage(node) / mountApp(props): the stylesheets and the page in #root
src/App.tsx                  DeckProvider > Shell > DeckLayout; `mode` labels the header
src/demo/                    demo mode: a fake server in the page, built by site/
src/deck/DeckProvider.tsx    DeckProvider and useDeck(): one stream per tab, plus the intent client
src/shell/Shell.tsx          Shell (header + workspace), Panel, StreamStatusBadge
src/shell/ClaudeAuthBadge.tsx  the header's read-only Claude auth mode, from auth.read
src/widgets/registry.ts      defineWidget, WidgetDefinition, createRegistry
src/widgets/widgets.ts       WIDGETS: every src/widgets/**/*Widget.tsx, found at build time
src/widgets/WidgetMount.tsx  WidgetMount: the grid over WIDGETS
src/widgets/starter/         the Tables starter widget
src/widgets/board/           Board: the voyage (Start/End/Kill all, per-project Kill), liveness strip, Pause all / Resume all, capped project picker, archived toggle
src/widgets/events/          Events: the feed, filtered by project and kind
src/widgets/data/            Data: table counts, rows a page at a time, paths on disk, Wipe project / Wipe everything typed to confirm
src/widgets/driver/          the Driver widget: voyage picker, turns, turn detail, replay command
src/widgets/planner/         Planner: the conversation, proposals to approve, edit or reject
src/widgets/rules/           Rules: edit rules.local.* with validation, a diff and provenance
src/lib/use-forge-terms.ts   useForgeTerms(project, enabled?): the project's forge terms from forge.read ({ short, long, cli, name }); GitHub's until read
src/widgets/project/         Project: pause, AI review and auto-merge (machine lifecycle layer), services (detected forge, tracker, publishes; services.read/set), reviewer, retired count, Refresh agents, archive
src/widgets/usage/           Usage: this project's tokens in the budget window and the share of budget.window.capTokens
src/widgets/agents/          Agents: state, since, tickets, held work; Pause/Poke/Kill/Retire/Reset
src/widgets/requests/        Requests: open pull/merge requests across projects, in each forge's terms, with ticket and agent links
src/grid/                    the grid: layout JSON, actions, drag, resize, keyboard, tray
src/layouts/                 DeckLayout: the saved layout, the preset bar, writes to the server
src/theme/tokens.css         dark theme tokens (--qd-*) and the page base
src/theme/tokens.ts          the same token names, typed: token('accent') is 'var(--qd-accent)'
```

The page is exactly the viewport's height and never scrolls. The header takes `--qd-header-height`; the workspace takes the rest. Each `Panel` has a fixed header and a body that scrolls on its own.

## Registering a widget

A widget is one file. Name it `src/widgets/<widget>/<Widget>Widget.tsx` after its component (`NotebookWidget.tsx`) and default-export a `defineWidget` call:

```tsx
import { defineWidget, type WidgetProps } from '../registry.js';
import { useNotebookWidget } from './use-notebook-widget.js';

export const NotebookWidget = ({ instanceId }: WidgetProps) => {
  const { notes } = useNotebookWidget(instanceId);
  return (
    <ul>
      {notes.map((note) => (
        <li key={note.id}>{note.body}</li>
      ))}
    </ul>
  );
};

export default defineWidget({
  type: 'notebook',
  title: 'Notebook',
  component: NotebookWidget,
  size: { w: 4, h: 6 },
  minSize: { w: 2, h: 3 },
});
```

That is the whole registration. `src/widgets/widgets.ts` picks up every `*Widget.tsx` with `import.meta.glob`, so no shared list is edited and widget tickets never conflict with each other. `defineWidget` types the definition:

| Field         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `type`        | Stable kebab-case id. Layout JSON stores it, so never rename a shipped one. |
| `title`       | The panel title. Copies are numbered: `Notebook`, `Notebook 2`.             |
| `component`   | Renders the panel body. Gets `{ instanceId }`, unique per copy on the grid. |
| `size`        | Default size in grid cells (12 columns by 12 rows).                         |
| `minSize`     | Smallest size a resize may reach. Defaults to 1 by 1.                       |
| `startHidden` | `true` puts it in the tray, not on the grid, in the default layout.         |

The grid draws the `Panel` (title, move, duplicate, hide, resize), so the component renders only its body. `createRegistry` throws at load on a repeated `type`, a type that is not kebab-case, or a `size` under `minSize`; a `*Widget.tsx` without a `defineWidget` default export fails the same way.

`useDeck()` gives every widget the same `StreamState` (see [`src/api`](src/api/README.md)), the same `IntentClient` and the same `RulesReader`, so a dashboard with ten widgets still opens one socket. `DeckProvider` takes `stream` options, an `intents` client and a `rules` reader, which is how tests and the site's demo mode feed it fake data.

### Single and multi workspaces

`useWorkspaceMode()` is the one place a widget learns whether the [workspace](../server/src/workspace/README.md) is one repository (`single`) or a folder of projects (`multi`). It reads `stream.workspace.mode` and answers `multi` when there is no workspace yet, so nothing changes for a dashboard that never had one. Every widget branches on it rather than guessing from the number of projects, and in `single` mode hides all project chrome: the Project widget's selector (it is titled Repository, from `singleTitle` in its definition) and the Services `publishes` toggle, the Board's project picker, strip names and per-project Kill, the Events project filter and label, project badges on Agents, Cards, Notebook and Planner proposals, the Planner's project field, and the PR/MR widget's per-project headings. `useWording()` (or `wordingFor(mode)`) says repository where multi mode says project, for text that is shared. The Data widget shows the workspace on its own line, and the header shows the one-line notice when the workspace switches from single to multi. `test/workspace/workspace-mode.test.tsx` renders every registered widget on single-mode demo data and checks nothing on screen says project, file contents in the Rules widget aside. `createDemoServer({ workspace: 'single' })` runs the demo as one repository.

## Demo mode

`src/demo/main.tsx` is a second entry: the same `App`, labelled **Demo** in the header, on a fake server that lives in the page. The site builds it (`site/demo/index.html`, `npm run build --workspace site`) to `site/dist/demo/`. It never opens a socket and never sends a request:

- **Stream.** `DeckProvider` gets `stream: { url, WebSocket: demoWebSocket(store) }`. The socket is an `EventTarget` that hands `openStream` the store's snapshot, the events after its cursor, then every change and event, as JSON, exactly as the real stream does.
- **Intents and rules.** `intents` and `rules` are the real `createIntentClient` and `createRulesReader` with a `fetch` that answers in the page (`demoFetch`): it checks each intent against the same schema, applies it to the store and replies like the API, refusals included. Recorded intents publish their `<intent>` event; reads (`data.*`, `turn.read`, `usage.read`, `forge.read`, `forge.requests`, `services.read`, machine `rules.*`) do not. The demo project is on GitHub. `forge.requests` (`demo-requests.ts`) lists Harbor's tickets in review or bounced as its pull requests, linked to their tickets and builders, plus a dependency bump, and a made-up GitLab project, `lighthouse`, with two merge requests, so the Requests widget shows both forges' terms.
- **Scripted voyages.** Every 2.5 s the director plays one beat of the open voyage (`demo-script.ts`): the Driver plans and assigns three tickets, each written as a spec (Requirements, Design, Tasks, Proven), two builders work, one asks through a card, the reviewer passes or bounces each pull request, the gate merges, and the Driver proposes a notebook entry. A card waits up to 12 beats for an answer, then expires and the builder takes its recommendation. Four beats after a voyage ends the next one starts; the voyages come from `DEMO_VOYAGE_PLANS`, in order, then again. Pausing the project, or everything from the Board, holds the script, and so does archiving it. The script leaves a `blocked` ticket alone; the voyage's end reopens it.
- **What a person can do.** Answer or decline cards, start, end and kill voyages, pause the project, an agent or everything (the store sends the `machine` message the Board reads), end, kill, retire or reset an agent (as on the server: a kill blocks the `assigned` and `in_progress` tickets it held, a reset clears the session and puts a running agent back to `idle`, a retired agent is refused with 409), archive the project (every agent retires, with `archive.retired`), talk to the Planner (it replies and proposes a ticket; an approved ticket goes into the next voyage), decide notebook proposals, edit the machine rules layer, move widgets and reset to a preset, browse the Data widget, poke an agent (`agent.message` is queued, as on the server), and wipe. A wipe touches nothing real: it answers `{ wiped: ['harbor'], stopped }` with the live agents, sends an empty snapshot and seeds the demo again, with event ids continuing so an open stream follows. Adding or editing a project is refused with a reason.
- **Where it opens.** The project `harbor` with voyage 1 finished, voyage 2 under way, a Planner conversation with a proposed ticket, and a machine `lifecycle` layer that sets `budget.window.capTokens`, so Usage shows a share. The demo's budget window opens at the start of the voyage before the open one.

Nothing is kept: a reload starts the demo over.

## The Rules widget

`rules` starts in the tray. It edits the machine layer, `~/.quarterdeck/rules.local.<file>`, of any rule in place:

- **Validation as you type.** The draft is parsed, merged over the shipped defaults and checked with the same zod schemas and merge code the loader uses (`@quarterdeck/rules/schemas` and `@quarterdeck/rules/merge`). A refusal names the machine file, like the loader's error. The server checks it again on save.
- **A diff before every write.** _Review changes_ shows the line diff against the file on disk; only _Save_ in that panel sends `rules.write`. _Remove file_ shows what goes and sends `rules.reset`. Both use `scope: "machine"`; the widget never writes the shipped defaults or a repo layer.
- **Where each value comes from.** The _In effect after saving_ table lists every key with its value and its layer: `defaults`, `machine` or `repo`. Arrays are one value, since a layer replaces them; a Markdown rule is one value from its highest layer.
- **The repo layer, read-only.** Pick a project and its `<repo>/.quarterdeck/rules.local.<file>` is shown, read-only, and applied on top. The widget says plainly that the repo layer can only tighten permissions (decided on their own, `deny` or `ask` only), `mergeGate` (a flag can only turn a gate on, and `base` and `aiReviewers` are machine-only) and `autoEndSettleSeconds` (only lengthened); those keys carry a `tighten-only` tag, and a repo value that tightened nothing is not credited to the repo.
- **Deprecated keys.** A layer that still sets `mergeGate.requireCopilotReview` is read as `mergeGate.requireAiReview`, as the loader does, and the widget lists it under _Deprecated keys_ naming the file. The project widget's AI review toggle renames the old key when it writes the machine layer.

## The Board widget

The Board runs the voyage and shows whether things are alive across projects:

- **The voyage** is one for every project. While none is open, a goal field and _Start voyage_ send `voyage.start { goal }`. While one is open (the newest `voyages` row not `ended`, from any project the stream carries), it shows `Voyage <n> · <status>`, the goal and each project in it (the row's `projects`), each with a _Kill_ button that sends `project.kill` for that project: its builders are killed and the voyage carries on. _End voyage_ sends `voyage.end { voyage }`; _Kill all_ asks first, with the number of tickets it will reopen (the active tickets held by the voyage's builders, killed or retired ones included), and sends `voyage.kill { voyage }` once confirmed. A refusal shows in the control.
- **Projects** are sorted by name. The first `BOARD_PROJECT_CAP` (4) are shown until the user picks; after that only picked projects are shown, and unpicked boxes are disabled while the cap is full. Picks hidden by the archived toggle are kept, but a pick made at the cap drops them rather than save more than 4.
- **Archived projects** (`archivedAt` set) stay out of the picker and the strip unless _Show archived_ is on.
- **The liveness strip** gives the stream status, then each shown project with its live agents (not ended, killed or retired) by role then name, tagged voyage (in the open voyage), paused or archived.
- **Pause all / Resume all** send `pause.all`, report how many projects were reached and name any that were not (`failed`). The machine-wide pause is read from `stream.machine.pausedAt`: while it is set the Board says _Paused everywhere_ and offers only Resume all.

## The Agents widget

The Agents widget has a card for every agent that is not retired, in projects the stream knows, by role (Planner, Driver, reviewer, builder) then name. The project is named when the stream has more than one.

- **State and since.** The agent's `status` and how long ago its row last changed (`updatedAt`).
- **Working on and tickets.** The tickets assigned to it that are still open: in progress, bounced, blocked (a kill blocks what the agent had), assigned, then in review. The first one is what it is working on.
- **Held work.** Each `pause.held` event with the agent's `agentId` (see [pause](../server/src/pause/README.md#events)) is shown as `held: <label> (<scopes>)`, oldest first, until a `pause.replayed` or `pause.dropped` names it as `heldEventId`. It reads the stream's events, so it sees held work among the newest 500 events.
- **Actions.** A live agent gets Pause (Resume while paused), Poke, Kill, Retire and Reset; an ended or killed one gets Retire and Reset. They send `agent.pause`, `agent.resume`, `agent.message`, `agent.kill`, `agent.retire` and `agent.reset`. Poke sends `agent.message`, which is still Pending on the server (see [the API](../server/src/api/README.md)), so nothing delivers it yet.
- **Killing.** After Kill the card says _killing…_ and its buttons are disabled until the stream acks the intent: `agent.killed` with the intent's `intentId`, or `agent.intent_failed`, whose `error` is shown. A refused request ends it at once and shows why.

## The Planner widget

The Planner is not tied to a project: one conversation plans for every active project (see [planner](../server/src/planner/README.md#where-a-conversation-lives)). The widget has no project picker. It sends `planner.message` to the first active project the stream holds, which is the tab's own project, and shows that project's conversation. _New conversation_ sends `planner.new` with no project, which ends the conversation everywhere.

Each proposal card shows its project's name, from the `project` on its `ticket.proposed` event, and Approve, Edit and Reject send `ticket.approve`, `ticket.update` and `ticket.reject` to that project. The editor has a Project field: saving with another project sends `planner.move`, and the card follows the `planner.proposal_moved` event to the new ticket. A proposal in a project whose tickets the stream does not hold shows _On the <name> board_ and can be approved or rejected but not edited, since its body is not here; once decided, the card shows the decision.

## The Driver widget

The Driver widget shows one voyage at a time: the active voyage, or the newest if none is active, until another is picked in the Voyage picker. It lists the turns of the voyage's Driver agents from the stream, newest first, so it holds each Driver's latest 20. Selecting a turn sends `turn.read` (see [the API](../server/src/api/README.md)) for its input, output and result, and reads it again when the turn ends. The replay command is `replayCommand({ voyage, through: n, project })` from `@quarterdeck/server/replay-command`, with `voyage` and `n` from `turn.read`, and a Copy button puts it on the clipboard. The turn field next to it starts at the selected turn's `n` and takes any whole number from 1 to it, so a voyage longer than the 20 listed turns can still be replayed through an earlier turn. A turn whose session a later Driver session replaced gets no command, since `quarterdeck replay` runs only the latest.

## The Usage widget

`usage` starts in the tray. It shows the budget window that holds launches (`lifecycle.budget.window`, see [budget](../server/src/budget/README.md)): it sends `usage.read` for the stream's project and renders the reply, so the widget and the hold always read the same meter. The count is per project, so the readout says _this project_. It never sums the stream's `turns` table, which keeps only each agent's latest 20 turns.

It reads on mount, every 15 seconds so old turns leave the window, and whenever a turn in the stream ends. With a cap it shows the percent of the cap, amber from 60% and red from 80%. Without one it shows the token total and _No cap set_. A failed read shows the error and keeps the last reading. It only displays usage: the hold is the budget module's.

## The Requests widget

`requests` lists the open pull and merge requests of every active project with a repository, from `forge.requests` (see [open requests](../server/src/api/README.md#open-requests)), one section per project under the project's name and forge. Each row has the number, linked to the request on its forge (`#7` on GitHub, `!3` on GitLab, labelled _Open PR #7 on GitHub_; a URL that is not http or https stays plain text), the title with a _Draft_ badge, the author, `branch → base`, the checks or pipeline state, the review state (_Approved_, _Changes requested_, _No review_), the Quarterdeck ticket and its agent when the branch or the reported URL matches one, and the age.

Words come from each project's forge through `forgeTerms`: the column headings (`PR` and _Checks_ on GitHub, `MR` and _Pipeline_ on GitLab), the link labels and the empty states. The heading inside the panel is _Pull requests_ or _Merge requests_ when every project is on one forge, and the neutral _Pull and merge requests_ when they mix, which is also the panel's registered title. With nothing open it says _No open pull requests_ (or merge requests, or _pull or merge requests_ when mixed); a quiet project beside a busy one gets its own line.

A project whose forge could not be read shows the error inside its own section; the others render as usual. It reads once the stream's snapshot names its project, then every 15 seconds and whenever a `ticket.*` event arrives on the stream; the server caches each project's list, so these reads are cheap. A failed read shows the error and keeps the last list.

## The grid

The workspace is a 12 by 12 grid that fills the viewport. Every widget can be:

- **dragged** by its `⠿` handle, or moved with the arrow keys while the handle has focus (it steps over neighbours to the next free cell);
- **resized** from its bottom-right corner, or with the arrow keys while the corner has focus;
- **duplicated** with `⧉` into the first free spot;
- **hidden** with `–`. Hidden widgets wait in the tray above the grid, with Show and Remove. The tray also adds any registered widget.

Widgets never overlap and never leave the grid: a move or resize into an occupied cell is refused. Every change and refusal is announced through a polite live region, and every control is a labelled `<button>`.

The layout is plain JSON, owned by whoever persists it:

```json
{
  "columns": 12,
  "rows": 12,
  "items": [
    {
      "id": "events-1",
      "widget": "events",
      "x": 0,
      "y": 0,
      "w": 8,
      "h": 12,
      "hidden": false
    },
    {
      "id": "tables-1",
      "widget": "tables",
      "x": 8,
      "y": 0,
      "w": 4,
      "h": 12,
      "hidden": false
    }
  ]
}
```

`x`/`y` are zero-based cells, `w`/`h` are spans. An item may also carry `tabs`, more widget types that share its slot after `widget`: `{ "widget": "planner", "tabs": ["driver", "notebook"] }`. The slot keeps `widget`'s title, size limits and controls, and shows one pane at a time under a `TabBar` (`src/primitives`, `grid/widget-slot.tsx`); each pane gets `instanceId` `<item id>:<type>`, the first keeps `<item id>`. Duplicating the slot copies its tabs.

The schema lives in the server (`@quarterdeck/server/layouts`), so the dashboard and the `layout.save` intent check the same thing. `parseGridLayout` (re-exported from `src/grid/layout.ts`) validates it: unique ids, every item inside the grid, no visible overlaps, no unknown keys, no widget twice in one slot. `<WidgetMount initialLayout={layout} />` starts from a given layout; without one, `defaultLayout(registry)` places every registered widget once, hiding any that do not fit. Items whose `widget` and `tabs` are all unregistered are skipped. In a slot, unregistered tabs are left out and the slot takes the title of its first registered widget. `applyGridAction(layout, action, registry)` (`src/grid/actions.ts`) is the pure state transition behind every control. `syncedLayout` replaces the grid's layout whenever a new one is passed (announced as "Layout loaded."), and `onLayoutChange` fires after each change a person makes, never after a load.

## Saved layouts and presets

`src/layouts/` keeps the grid in step with the server. There is one dashboard layout for the whole machine, whichever projects are open: the server keeps it in `~/.quarterdeck/layout.json`, the stream carries it as `layout` in the snapshot and as a `layout` message after each save, so the dashboard reads it from `useDeck().stream.layout` and writes it with intents that name no project:

- Every tab, on any project's stream, shares the one layout. `layout.save { name: "dashboard", spec }` and `layout.reset { name: "dashboard", preset }` send no `project` (`DASHBOARD_LAYOUT` from `@quarterdeck/server/layouts`).
- On load the grid shows the saved layout, or the `default` preset until the snapshot brings one. A snapshot with no layout, or one the grid cannot parse, leaves the grid on the preset.
- Each edit is sent as `layout.save` once edits pause for 300 ms. One write is in flight at a time and only the newest queued one follows it. The `layout` message the server streams back for our own write is recognised and dropped, so a slow echo never undoes a newer edit. A layout saved anywhere else (another tab, the CLI) loads into the grid, unless an edit of ours is still waiting to be sent: that edit is sent next and wins.
- The bar above the grid picks a preset and resets to it: the grid switches at once and `layout.reset` writes the same preset on the server. A refused write shows its error under the bar.
- A refresh or a closed tab does not lose the last edit. On `pagehide`, and when the tab is hidden (`visibilitychange`), the waiting write goes out at once as a `keepalive` request, which the browser finishes after the page is gone. It does not wait behind a write still in flight, since that one may never settle. Browsers cap keepalive bodies at 64 KiB (`KEEPALIVE_BODY_LIMIT`); a layout is far smaller, and one that is not is refused with a `413` `IntentError` before it is sent rather than dropped silently.
- An edit or reset made before the snapshot arrives is kept as the waiting write and sent once it does. The saved layout the snapshot brings does not replace the grid while that edit waits, so the person's edit is what the grid shows and what the server keeps. An edit still waiting when the page closes before any snapshot is lost.
- Layouts saved per project before the layout went global are not lost: the first start without `layout.json` copies the most recently updated project `dashboard` row into it. Those rows stay in each project's `layouts` table, unread.

`createLayoutWriter` (`layout-writer.ts`) holds the queue: writes wait until `setReady(true)`, and `flush({ keepalive: true })` sends the waiting one as the page leaves. `use-layout-sync.ts` sets it ready once the stream has a snapshot (`hasSnapshot`) and wires the page events.

Demo mode keeps the layout the same way: the demo store holds one global layout, seeds it with the demo's grid, puts it in each snapshot and sends a `layout` message when `layout.save` or `layout.reset` changes it.

The presets ship in the server (`LAYOUT_PRESETS` in `packages/server/src/layouts/presets.ts`) and name widgets by their registered `type`, so a preset slot for a widget that has not landed yet stays empty until it does:

| Preset    | Layout                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `default` | `board` (7×8) beside one slot of `planner` with `driver` and `notebook` (5×8); `events` and `requests` below |
| `ops`     | `board` and `agents` on top; `cards`, `events`, `requests` and `usage` below                                 |
| `minimal` | `board` (8×12) and `cards` (4×12)                                                                            |
