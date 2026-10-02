# primitives

Shared pieces every widget builds on, so a chat box or a tab bar behaves the same wherever it appears. Import them from `src/primitives/index.js`. Each component brings its own stylesheet, built from the theme tokens.

## ChatInput

```tsx
<ChatInput label="Message the Planner" onSubmit={view.handleSend} />
```

| Key         | Does                                                  |
| ----------- | ----------------------------------------------------- |
| Enter       | Sends the trimmed draft. A blank draft sends nothing. |
| Shift+Enter | Adds a new line.                                      |
| Enter (IME) | Nothing while an input method is composing.           |

The Send button sends the same way. `onSubmit` may return a promise: until it settles the box is read-only (focus stays put) and a second Enter is ignored. On success the box clears; on failure the draft stays and the error shows under the box (`role="alert"`). `disabled` turns the box and the button off. `placeholder` defaults to `CHAT_INPUT_HINT`.

## TabBar

```tsx
const PlannerTabs = () => {
  const view = usePlannerTabs();
  return (
    <>
      <TabBar label="Planner" tabs={view.tabs} onKeyDown={view.handleKeyDown} />
      <TabPanel panel={view.panel}>
        <Feed tab={view.activeId} />
        <NewestMarker
          newest={view.activeNewest}
          onSeen={view.handleNewestSeen}
        />
      </TabPanel>
    </>
  );
};
```

`useTabs({ tabs, initial?, ready? })` takes one `TabSpec` per tab: `{ id, label, newest }`, where `newest` is the key of that tab's newest item (`null` when it has none). It returns the tab views for `TabBar`, the panel ids for `TabPanel`, and the active tab's `activeId` and `activeNewest`.

- Click, or ArrowLeft / ArrowRight / Home / End on a focused tab, selects a tab and moves focus to it. Only the active tab is in the tab order.
- `initial` picks the first tab shown. If the active tab goes away, the first tab is shown.

### Unread

A tab is unread when its `newest` key differs from the last one seen there. The dot (`data-unread="true"` on the tab, with hidden text "unread") clears when the newest item comes into view:

- Render `NewestMarker` right next to the newest item of the active tab: after it in an oldest-first feed, before it in a newest-first one. It watches itself with an `IntersectionObserver` and calls `onSeen` with the key it was given once it is on screen. A new key starts a fresh observer, so an item that lands already in view clears straight away, and one that lands below the fold stays unread until it is scrolled to.
- The active tab can be unread too, while its newest item is scrolled out of view.
- Whatever is there when the tab bar becomes `ready` counts as read, so history does not light every tab on load. Pass `ready: stream.status === 'live'` (from the hook, not inline) so the first snapshot is the baseline; `ready` defaults to `true`, which baselines on mount.
- Without `IntersectionObserver`, the active tab's newest item counts as seen.
