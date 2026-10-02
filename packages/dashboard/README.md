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

The page talks only to its own origin: intents go to `POST /api/intents/<name>`, the Rules widget reads rule files from `GET /api/rules`, and the stream opens at `ws(s)://<page host>/ws`. Nothing else is fetched.

`npm run dev --workspace packages/dashboard` starts Vite on `http://127.0.0.1:5173` and proxies `/api` and `/ws` to the API on `127.0.0.1:4317`. The proxy keeps the browser's `Origin`, so start the API with `allowedOrigins: ['http://127.0.0.1:5173']` for dev.

## Layout

```
src/main.tsx                 mounts <App /> into #root
src/app.tsx                  DeckProvider > Shell > DeckLayout
src/deck/deck.tsx            DeckProvider and useDeck(): one stream per tab, plus the intent client
src/shell/shell.tsx          Shell (header + workspace), Panel, StreamStatusBadge
src/widgets/registry.ts      defineWidget, WidgetDefinition, createRegistry
src/widgets/widgets.ts       WIDGETS: every src/widgets/**/*.widget.tsx, found at build time
src/widgets/widget-mount.tsx WidgetMount: the grid over WIDGETS
src/widgets/starter/         the Tables starter widget
src/widgets/board/           Board: liveness strip, Pause all / Resume all, capped project picker, archived toggle
src/widgets/events/          Events: the feed, filtered by project and kind
src/widgets/data/            Data: table counts, rows a page at a time, paths on disk
src/widgets/driver/          the Driver widget: round picker, turns, turn detail, replay command
src/widgets/planner/         Planner: the conversation, proposals to approve, edit or reject
src/widgets/rules/           Rules: edit rules.local.* with validation, a diff and provenance
src/widgets/project/         Project: round Start/End/Kill, pause, Copilot and auto-merge (machine lifecycle layer), reviewer, retired count, Refresh agents, archive
src/widgets/usage/           Usage: this project's tokens in the budget window and the share of budget.window.capTokens
src/grid/                    the grid: layout JSON, actions, drag, resize, keyboard, tray
src/layouts/                 DeckLayout: the saved layout, the preset bar, writes to the server
src/theme/tokens.css         dark theme tokens (--qd-*) and the page base
src/theme/tokens.ts          the same token names, typed: token('accent') is 'var(--qd-accent)'
```

The page is exactly the viewport's height and never scrolls. The header takes `--qd-header-height`; the workspace takes the rest. Each `Panel` has a fixed header and a body that scrolls on its own.

## Registering a widget

A widget is one file. Name it `src/widgets/<widget>/<widget>.widget.tsx` and default-export a `defineWidget` call:

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

That is the whole registration. `src/widgets/widgets.ts` picks up every `*.widget.tsx` with `import.meta.glob`, so no shared list is edited and widget tickets never conflict with each other. `defineWidget` types the definition:

| Field         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `type`        | Stable kebab-case id. Layout JSON stores it, so never rename a shipped one. |
| `title`       | The panel title. Copies are numbered: `Notebook`, `Notebook 2`.             |
| `component`   | Renders the panel body. Gets `{ instanceId }`, unique per copy on the grid. |
| `size`        | Default size in grid cells (12 columns by 12 rows).                         |
| `minSize`     | Smallest size a resize may reach. Defaults to 1 by 1.                       |
| `startHidden` | `true` puts it in the tray, not on the grid, in the default layout.         |

The grid draws the `Panel` (title, move, duplicate, hide, resize), so the component renders only its body. `createRegistry` throws at load on a repeated `type`, a type that is not kebab-case, or a `size` under `minSize`; a `*.widget.tsx` without a `defineWidget` default export fails the same way.

`useDeck()` gives every widget the same `StreamState` (see [`src/api`](src/api/README.md)), the same `IntentClient` and the same `RulesReader`, so a dashboard with ten widgets still opens one socket. `DeckProvider` takes `stream` options, an `intents` client and a `rules` reader, which is how tests and the site's demo mode feed it fake data.

## The Rules widget

`rules` starts in the tray. It edits the machine layer, `~/.quarterdeck/rules.local.<file>`, of any rule in place:

- **Validation as you type.** The draft is parsed, merged over the shipped defaults and checked with the same zod schemas and merge code the loader uses (`@quarterdeck/rules/schemas` and `@quarterdeck/rules/merge`). A refusal names the machine file, like the loader's error. The server checks it again on save.
- **A diff before every write.** _Review changes_ shows the line diff against the file on disk; only _Save_ in that panel sends `rules.write`. _Remove file_ shows what goes and sends `rules.reset`. Both use `scope: "machine"`; the widget never writes the shipped defaults or a repo layer.
- **Where each value comes from.** The _In effect after saving_ table lists every key with its value and its layer: `defaults`, `machine` or `repo`. Arrays are one value, since a layer replaces them; a Markdown rule is one value from its highest layer.
- **The repo layer, read-only.** Pick a project and its `<repo>/.quarterdeck/rules.local.<file>` is shown, read-only, and applied on top. The widget says plainly that the repo layer can only tighten permissions (decided on their own, `deny` or `ask` only), `mergeGate` (a flag can only turn a gate on) and `autoEndSettleSeconds` (only lengthened); those keys carry a `tighten-only` tag, and a repo value that tightened nothing is not credited to the repo.

## The Board widget

The Board shows whether things are alive across projects:

- **Projects** are sorted by name. The first `BOARD_PROJECT_CAP` (4) are shown until the user picks; after that only picked projects are shown, and unpicked boxes are disabled while the cap is full. Picks hidden by the archived toggle are kept, but a pick made at the cap drops them rather than save more than 4.
- **Archived projects** (`archivedAt` set) stay out of the picker and the strip unless _Show archived_ is on.
- **The liveness strip** gives the stream status, then each shown project with its live agents (not ended, killed or retired) by role then name, tagged paused or archived.
- **Pause all / Resume all** send `pause.all`, report how many projects were reached and name any that were not (`failed`). The machine-wide pause is read from `stream.machine.pausedAt`: while it is set the Board says _Paused everywhere_ and offers only Resume all.

## The Driver widget

The Driver widget shows one round at a time: the active round, or the newest if none is active, until another is picked in the Round picker. It lists the turns of the round's Driver agents from the stream, newest first, so it holds each Driver's latest 20. Selecting a turn sends `turn.read` (see [the API](../server/src/api/README.md)) for its input, output and result, and reads it again when the turn ends. The replay command is `replayCommand({ round, through: n, project })` from `@quarterdeck/server/replay-command`, with `round` and `n` from `turn.read`, and a Copy button puts it on the clipboard. The turn field next to it starts at the selected turn's `n` and takes any whole number from 1 to it, so a round longer than the 20 listed turns can still be replayed through an earlier turn. A turn whose session a later Driver session replaced gets no command, since `quarterdeck replay` runs only the latest.

## The Usage widget

`usage` starts in the tray. It shows the budget window that holds launches (`lifecycle.budget.window`, see [budget](../server/src/budget/README.md)): it sends `usage.read` for the stream's project and renders the reply, so the widget and the hold always read the same meter. The count is per project, so the readout says _this project_. It never sums the stream's `turns` table, which keeps only each agent's latest 20 turns.

It reads on mount, every 15 seconds so old turns leave the window, and whenever a turn in the stream ends. With a cap it shows the percent of the cap, amber from 60% and red from 80%. Without one it shows the token total and _No cap set_. A failed read shows the error and keeps the last reading. It only displays usage: the hold is the budget module's.

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

`src/layouts/` keeps the grid in step with the server. The layout lives in the project's `layouts` table under the name `dashboard`, and the stream already carries that table, so the dashboard reads it from `useDeck().stream` and writes it with intents:

- Layouts are saved per project under the name `dashboard`, so every tab open on a project shares one layout.
- On load the grid shows the saved layout, or the `default` preset until the snapshot brings one. A stored spec the grid cannot parse is ignored.
- Each edit is sent as `layout.save` once edits pause for 300 ms. One write is in flight at a time and only the newest queued one follows it. The change the server streams back for our own write is recognised and dropped, so a slow echo never undoes a newer edit. A change made anywhere else (another tab, the CLI) loads into the grid.
- The bar above the grid picks a preset and resets to it: the grid switches at once and `layout.reset` writes the same preset on the server. A refused write shows its error under the bar.
- Nothing is written before the snapshot names the project.

The presets ship in the server (`LAYOUT_PRESETS` in `packages/server/src/layouts/presets.ts`) and name widgets by their registered `type`, so a preset slot for a widget that has not landed yet stays empty until it does:

| Preset    | Layout                                                                                        |
| --------- | --------------------------------------------------------------------------------------------- |
| `default` | `board` (7×8) beside one slot of `planner` with `driver` and `notebook` (5×8); `events` below |
| `ops`     | `board` and `agents` on top; `cards`, `events` and `usage` below                              |
| `minimal` | `board` (8×12) and `cards` (4×12)                                                             |
