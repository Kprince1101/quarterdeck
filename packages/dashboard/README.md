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

The page talks only to its own origin: intents go to `POST /api/intents/<name>` and the stream opens at `ws(s)://<page host>/ws`. Nothing else is fetched.

`npm run dev --workspace packages/dashboard` starts Vite on `http://127.0.0.1:5173` and proxies `/api` and `/ws` to the API on `127.0.0.1:4317`. The proxy keeps the browser's `Origin`, so start the API with `allowedOrigins: ['http://127.0.0.1:5173']` for dev.

## Layout

```
src/main.tsx            mounts <App /> into #root
src/app.tsx             DeckProvider > Shell > WidgetMount
src/deck/deck.tsx       DeckProvider and useDeck(): one stream per tab, plus the intent client
src/shell/shell.tsx     Shell (header + workspace), Panel, StreamStatusBadge
src/widgets/            WidgetMount: where widgets go
src/theme/tokens.css    dark theme tokens (--qd-*) and the page base
src/theme/tokens.ts     the same token names, typed: token('accent') is 'var(--qd-accent)'
```

The page is exactly the viewport's height and never scrolls. The header takes `--qd-header-height`; the workspace takes the rest. Each `Panel` has a fixed header and a body that scrolls on its own.

## Writing a widget

```tsx
import { useDeck } from '../deck/deck.js';
import { Panel } from '../shell/shell.js';

export const NotebookWidget = () => {
  const { stream } = useDeck();
  return (
    <Panel title="Notebook">
      {stream.tables.notebook.map((note) => (
        <p key={note.id}>{note.body}</p>
      ))}
    </Panel>
  );
};
```

`useDeck()` gives every widget the same `StreamState` (see [`src/api`](src/api/README.md)) and the same `IntentClient`, so a dashboard with ten widgets still opens one socket. `DeckProvider` takes `stream` options and an `intents` client, which is how tests and the site's demo mode feed it fake data.

`WidgetMount` (`src/widgets/widget-mount.tsx`) is the one place widgets are placed. It fills the workspace; today it holds two starter panels, Tables and Events. The widget registry and grid replace its contents; nothing above it needs to change.
