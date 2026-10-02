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
src/app.tsx                  DeckProvider > Shell > WidgetMount
src/deck/deck.tsx            DeckProvider and useDeck(): one stream per tab, plus the intent client
src/shell/shell.tsx          Shell (header + workspace), Panel, StreamStatusBadge
src/widgets/registry.ts      defineWidget, WidgetDefinition, createRegistry
src/widgets/widgets.ts       WIDGETS: every src/widgets/**/*.widget.tsx, found at build time
src/widgets/widget-mount.tsx WidgetMount: the grid over WIDGETS
src/widgets/starter/         the Tables starter widget
src/widgets/events/          Events: the feed, filtered by project and kind
src/widgets/rules/           Rules: edit rules.local.* with validation, a diff and provenance
src/grid/                    the grid: layout JSON, actions, drag, resize, keyboard, tray
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
- **The repo layer, read-only.** Pick a project and its `<repo>/.quarterdeck/rules.local.<file>` is shown, read-only, and applied on top. The widget says plainly that the repo layer can only tighten permissions (decided on their own, `deny` or `ask` only) and `mergeGate` (a flag can only turn a gate on); those keys carry a `tighten-only` tag, and a repo value that tightened nothing is not credited to the repo.

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

`x`/`y` are zero-based cells, `w`/`h` are spans. `parseGridLayout` (`src/grid/layout.ts`) validates it: unique ids, every item inside the grid, no visible overlaps. `<WidgetMount initialLayout={layout} />` starts from a given layout; without one, `defaultLayout(registry)` places every registered widget once, hiding any that do not fit. Items whose `widget` is not registered are skipped. `applyGridAction(layout, action, registry)` (`src/grid/actions.ts`) is the pure state transition behind every control.
