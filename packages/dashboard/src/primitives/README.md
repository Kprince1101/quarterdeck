# primitives

Shared pieces every widget builds on, so a chat box or a tab bar behaves the same wherever it appears. Import them from `src/primitives/index.js`. Each component brings its own stylesheet, built from the theme tokens.

## ChatInput

```tsx
<ChatInput label="Message the Planner" onSubmit={view.handleSend} />
```

| Key              | Does                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| Enter            | Sends the trimmed draft. A blank draft sends nothing.                        |
| Shift+Enter      | Adds a new line, or the next list item on a list line.                       |
| Tab / Shift+Tab  | On a list line, indents / outdents it by two spaces. Elsewhere, moves focus. |
| Cmd/Ctrl+Z       | The browser's own undo, which also undoes list edits and pastes.             |
| Enter, Tab (IME) | Nothing while an input method is composing.                                  |

Composing means `isComposing` is set, or `keyCode` is 229: Safari sends the Enter that confirms a conversion with `isComposing` false and `keyCode` 229.

The Send button sends the same way. `onSubmit` may return a promise: until it settles the box is read-only (focus stays put) and a second Enter is ignored. On success the box clears; on failure the draft stays and the error shows under the box (`role="alert"`). `disabled` turns the box and the button off. `placeholder` defaults to `CHAT_INPUT_HINT`.

### Lists

A line is a list item when it starts (after any indent) with one of these markers and a space. Shift+Enter at or after the marker starts the next item at the same indent; text after the caret moves into it.

| Line               | Next item       |
| ------------------ | --------------- |
| `3. ` / `3) `      | `4. ` / `4) `   |
| `- `, `* `, `• `   | the same bullet |
| `- [ ] `, `- [x] ` | `- [ ] `        |

Shift+Enter on an item with nothing after its marker removes the marker and ends the list, as in Slack and GitHub. Shift+Tab on an item with no indent left does nothing to it and moves focus back, so Tab never traps the keyboard. The rules are pure functions in `chat-input-lists.ts` (`continueList`, `indentList`, `listMarker`); `chatKeyEffect` maps a key and the field's text and selection to send, edit, or leave to the browser.

### Edits keep the undo stack

Every edit the box makes itself (a list item, an indent, a paste) goes through `applyEdit`, which selects the range and runs `document.execCommand('insertText')` (or `'delete'`), so it lands on the browser's undo stack like typing does. Where that command is missing it falls back to `setRangeText` and an `input` event, which edits correctly but cannot be undone.

### Size

The box starts one line tall and grows with its content (`useChatInputAutosize` sets its height from `scrollHeight` on every draft change) until the stylesheet's `max-height` (12rem), then scrolls. It shrinks back when the draft clears after a send.

### Paste and copy

A paste always lands as plain text. The clipboard's `text/plain` is used when there is one (line endings normalised to `\n`); otherwise its `text/html` is stripped to text by `htmlToText`, keeping paragraph, block and `<br>` breaks. Copy is the browser's own, in the box and in transcripts; the Planner adds a Copy button to each message.

### Attachments

The box has two extension points for attachments, both unused today:

- `handlePaste` in `useChatInput` only takes a paste that has text (`pastedText` returns `null` otherwise). A paste of only files, such as a screenshot, is left alone, for an attachment handler to take before it.
- `ChatInput` renders the field inside `.qd-chat-input-compose`, a column next to the Send button, so an attachment tray can sit above or below the field without changing the form's grid.

## TabBar

```tsx
const PlannerTabs = () => {
  const view = usePlannerTabs();
  return (
    <>
      <TabBar label="Planner" tabs={view.tabs} onKeyDown={view.handleKeyDown} />
      <TabPanel panel={view.panel}>
        <Feed tab={view.activeId} />
        <NewestMarker {...view.marker} />
      </TabPanel>
    </>
  );
};
```

`useTabs({ tabs, initial?, ready? })` takes one `TabSpec` per tab: `{ id, label, newest }`, where `newest` is the key of that tab's newest item (`null` when it has none). It returns the tab views for `TabBar`, the panel ids for `TabPanel`, the `activeId`, and `marker`, the props for `NewestMarker`: `{ scope, newest, onSeen }`, where `scope` is the active tab's id and `newest` its newest key.

- Click, or ArrowLeft / ArrowRight / Home / End on a focused tab, selects a tab and moves focus to it. Only the active tab is in the tab order.
- Only the active panel is rendered, so only the active tab carries `aria-controls`.
- `initial` picks the first tab shown. If the active tab goes away, the first tab is shown.

### Unread

A tab is unread when its `newest` key differs from the last one seen there. The dot (`data-unread="true"` on the tab, with hidden text "unread") clears when the newest item comes into view:

- Render `NewestMarker` right next to the newest item of the active tab: after it in an oldest-first feed, before it in a newest-first one. It watches itself with an `IntersectionObserver` and calls `onSeen` with the key it was given once it is on screen. A new `scope` or a new key starts a fresh observer, so an item that lands already in view clears straight away, and one that lands below the fold stays unread until it is scrolled to. The observer is scoped to the tab, so switching to a tab whose newest key happens to equal the previous tab's (a Planner message 3 and a Driver turn 3) still watches the new tab's item; always pass `marker` whole rather than `newest` alone.
- The active tab can be unread too, while its newest item is scrolled out of view.
- Whatever is there when the tab bar becomes `ready` counts as read, so history does not light every tab on load. Pass `ready: stream.status === 'live'` (from the hook, not inline) so the first snapshot is the baseline; `ready` defaults to `true`, which baselines on mount.
- Without `IntersectionObserver`, the active tab's newest item counts as seen.
