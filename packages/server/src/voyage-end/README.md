# voyage-end

A voyage ends itself once it has settled, or when the human presses End or Kill. Ending closes the voyage's cards and retires its builders, gives the Driver one wrap-up turn to propose what the next Driver should be born with, then retires the Driver and marks the voyage `ended`. Nothing the Driver proposes takes effect until the human approves it. Killing does the same cleanup with no wrap-up and puts the voyage's tickets back to `open`.

```
settled ─▶ settle timer (autoEndSettleSeconds) ─▶ voyage.settled ─┐
   ▲            │                                                 ├─▶ release ─▶ wrap-up turn ─▶ proposals ─▶ cleanup ─▶ voyage.ended
   │            ├─ work comes back: disarmed       voyage.end ─────┘                 │
   └────────────┴─ late merge: re-armed from zero                                   └─ notebook.decide / charter.decide ─▶ next Driver's birth

voyage.kill ─▶ cleanup + tickets reopened ─▶ voyage.ended (reason: killed)
```

## When a voyage is settled

`readSettleState(db, projectId, voyageId)` counts what keeps it going, and `isSettled(state)` is true when all of these hold:

| Check             | What counts                                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| voyage not ended  | The voyage exists in the project and its `status` is not `ended`.                                                                                                                 |
| no open tickets   | No ticket of the project is `open`, `assigned`, `in_progress`, `in_review`, `bounced` or `blocked` (`OPEN_TICKET_STATUSES`). `proposed` tickets wait for the human, not the crew. |
| no running agents | No agent of the project is `starting`, `working` or `stuck` (`RUNNING_AGENT_STATUSES`). A turn in flight, the Driver's own included, keeps the voyage going.                      |
| no open cards     | No card of the project is `open`.                                                                                                                                                 |
| not paused        | Neither the project nor everything is [paused](../pause/README.md) (`pausedScopes`, read under `home`, the 4th argument, default `~/.quarterdeck`).                               |

## The settle timer

`startAutoEnd({ store, voyageId, settleSeconds, end, schedule?, home?, onError? })` checks the voyage when it starts, on every change to `voyages`, `tickets`, `agents` and `cards` (`store.watch`), and on every `pause.set` and `pause.all` event.

- Settled and no timer: arm one for `settleSeconds` and record `voyage.settling` with `{ voyageId, settleSeconds, rearmed: false }`.
- Not settled: disarm the timer, if any. The next time it settles the timer starts from zero.
- A `ticket.merged` event (the [merge gate](../gate/README.md), or a merge on GitHub the gate noticed) while settled re-arms the timer from zero and records `voyage.settling` with `rearmed: true`. Other changes leave a running timer alone.
- When the timer fires the voyage is checked once more. Still settled: `voyage.settled` is recorded with `{ voyageId, settleSeconds }` and `end(voyageId)` runs, once. Anything after that is ignored; `close()` stops the triggers and cancels the timer.

`settleSeconds` is `autoEndSettleSeconds` from `rules/lifecycle.json` (default 120). The home layer, `~/.quarterdeck/rules.local.lifecycle.json`, sets it freely. The repo layer, `<repo>/.quarterdeck/rules.local.lifecycle.json`, can only lengthen it: the larger of the two wins, so a file committed to the project cannot make voyages end sooner than the machine allows.

`schedule(ms, fire)` returns a cancel function; it defaults to `timerScheduler` (`setTimeout`, unref'd). Checks, arming and firing run one at a time. A failed check goes to `onError` (default: logged) and the next change checks again.

## Wrap-up

`wrapUpVoyage({ store, voyage, charter })` sends the Driver one more turn in its voyage session (`voyage.turnAs`, queued behind any turn still running) and waits for it. The prompt (`buildWrapUpPrompt`) says the voyage settled, lists the active notebook with each entry's id, gives the charter as it is, and asks for a wrap-up result (`WRAP_UP_INSTRUCTIONS`):

```json
{
  "summary": "Shipped QD12 and QD13; QD14 waits on a product decision.",
  "notebook": [
    {
      "op": "add",
      "body": "Run the store tests on both backends.",
      "pinned": false,
      "rationale": "QD13 broke Postgres only."
    },
    {
      "op": "update",
      "entry": "<entry id>",
      "body": "The new text.",
      "rationale": "Why."
    },
    {
      "op": "retire",
      "entry": "<entry id>",
      "rationale": "Why it is no longer true."
    }
  ],
  "charter": null
}
```

`wrapUpFormat(notebook)` checks it: `entry` must be the id of an active entry, each entry is changed at most once, and there are at most `MAX_NOTEBOOK_PROPOSALS` changes. `charter` is `null` or `{ body, rationale }` with the whole charter, not a diff. A reply that does not match is re-prompted once, as for any Driver turn.

On a result, in one transaction:

- each notebook change becomes an `open` `notebook_proposals` row (`op`, `entry_id`, `body`, `pinned` for adds, `rationale`, `voyage_id`, `agent_id`). An `update` whose body is the entry's current body is dropped.
- a charter change becomes an `open` `charter_proposals` row with `voyage_id` and `agent_id`, unless its body is the current charter.
- `voyage.wrapped_up` is recorded with `{ voyageId, voyage, summary, notebookProposals, charterProposal }`.

It resolves to `{ status: 'proposed', summary, notebookProposalIds, charterProposalId }`. If the turn misses, stops or throws, `voyage.wrap_up_missed` is recorded with `{ voyageId, voyage, reason }` and it resolves to `{ status: 'missed', reason }`; the voyage still ends.

## Approving

The human decides each proposal on the dashboard (see [api](../api/README.md#intents)):

- `notebook.decide` `{ proposalId, decision, body? }`: accepting an `add` inserts a notebook entry (with the proposal's voyage, author and `pinned`); an `update` replaces the entry's body; a `retire` sets the entry's `retired_at`. `body` edits an add or update before it is applied. An update or retire of an entry already retired is refused (409) and the proposal stays open.
- `charter.decide` `{ proposalId, decision }`: accepting writes the body to `<repo>/.quarterdeck/rules.local.charter.md`.

The next Driver's birth (`openDriverVoyage`) reads the active notebook (`retired_at` null) and the charter as loaded then, so it is born with exactly what was approved.

## Cleanup

The voyage's agents are its `driver` and `builder` agents (`VOYAGE_AGENT_ROLES`, matched on `agents.voyage_id`). The project's reviewer and Planner are not voyage agents: they are never retired, and the reviewer is free for the next voyage as soon as this one ends.

`releaseVoyage({ store, lifecycle, voyageId, reason })` is the part that runs before the wrap-up:

1. **Close cards.** Every `open` card raised by a voyage agent (an `ask`, a sign-in card) becomes `expired`, and `card.expired` is recorded for each with `{ cardId, voyageId, reason }`, in one transaction. A turn waiting on one sees it expired, as it would on a timeout. `worktree.discard` cards stay open: they are the human's to answer. Cards nobody in the voyage raised (the gate's merge cards, the reviewer's own) are left alone.
2. **Retire builders.** Every builder of the voyage that is not retired yet, oldest first, through `lifecycle.retire` (`agents/retire.ts`): the session closes, the worktree is removed, the name is freed. A worktree with unsaved work is not discarded: a `worktree.discard` card is raised for it (`requestWorktreeDiscard`) and the builder stays unretired. A builder that already has an open discard card is skipped, so running it again never raises a second one.

It resolves to `{ closedCards, retired, discardCards }`.

`cleanUpVoyage({ store, lifecycle, voyageId, reason, reopen? })` runs `releaseVoyage` again (cards or builders that appeared since), retires the Driver the same way, then, in one transaction, marks the voyage `ended` (`ended_at` set), reopens its tickets if `reopen` is set (see [Kill](#kill)), and records `voyage.ended` with `{ voyageId, voyage, reason, closedCards, retired, discardCards, reopened }`. Any other error is thrown before the voyage is ended; calling it again carries on where it stopped and never ends a voyage twice (`ended: false`, nothing reopened).

## End

`endVoyage({ store, voyage, charter, lifecycle, reason? })` is `releaseVoyage`, then `wrapUpVoyage`, then `cleanUpVoyage`: the builders are gone and the voyage's cards closed before the Driver's wrap-up turn, and the Driver is retired after it. Its `cleanup` lists what all three steps closed and retired. Auto-end runs it with `reason: 'settled'` (`SETTLED_REASON`); End from the dashboard with `'ended'` (`ENDED_REASON`).

`endVoyageWithoutDriver({ store, lifecycle, voyageId })` is the same when there is no live Driver session to wrap up in (the server restarted, the Driver died): the wrap-up is recorded as missed with `NO_DRIVER_SESSION` (`missWrapUp`) and the voyage still ends.

## Kill

`killVoyage({ store, lifecycle, voyageId })` is `cleanUpVoyage` with `reason: 'killed'` (`KILLED_REASON`) and `reopen: true`. There is no wrap-up turn and no proposals. Inside the transaction that ends the voyage, every ticket held by one of the voyage's builders (retired or not) and still `assigned`, `in_progress`, `in_review`, `bounced` or `blocked` goes back to `open` with no assignee; `pr_url` and `head_sha` stay so the next builder can pick up an open pull request. `ticket.reopened` is recorded for each with `{ voyageId, previousStatus, previousAssigneeId }`, and any card still open on those tickets (a merge card) is expired. Tickets other voyages assigned, tickets never assigned, and `done` tickets are not touched. The reviewer gate only evaluates `in_review` tickets, so a review it was waiting on for a reopened ticket is dropped, and a verdict on it is refused.

## End and Kill from the dashboard

The Project widget sends `voyage.end` or `voyage.kill` `{ project, voyageId }` (see [api](../api/README.md#intents)). Both are recorded `pending` after checking the voyage exists and has not ended. `startVoyageControl` applies them:

```ts
import { startVoyageControl } from '@quarterdeck/server';

const control = await startVoyageControl({
  store,
  lifecycle, // createAgentLifecycle(...)
  driver: (voyageId) => liveVoyages.get(voyageId), // { voyage: DriverVoyage, charter }
});
await control.close();
```

It reads pending `voyage.end` and `voyage.kill` intents when it starts and on every new one, oldest first. Each is checked again (a voyage that ended meanwhile is `rejected` with `voyage <id> has already ended`), then applied: End runs `endVoyage` with the live Driver voyage `driver(voyageId)` gives, or `endVoyageWithoutDriver` when it gives none; Kill runs `killVoyage`. The intent becomes `applied` with `{ voyageId, voyage, ended, closedCards, retired, discardCards, reopened }` (plus `wrapUp` for End), or `rejected` with `{ error }` if it throws. Intents for one voyage run in order, except that a Kill never waits behind an End's wrap-up turn: killing retires the Driver, so the turn ends. `drain()` resolves once everything pending has settled; `close()` stops listening and waits for what is running.

## API

```ts
import { loadRule } from '@quarterdeck/rules';
import { openDriverVoyage, startVoyageAutoEnd } from '@quarterdeck/server';

const voyage = await openDriverVoyage({ ...driverOptions });
const auto = await startVoyageAutoEnd({
  store,
  voyage,
  charter,
  lifecycle, // createAgentLifecycle(...)
  settleSeconds: (await loadRule('lifecycle', { repoDir }))
    .autoEndSettleSeconds,
});
await auto.close();
```

| Export                                                      | What it does                                                                                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `startVoyageAutoEnd(options)`                               | `startAutoEnd` whose `end` is `endVoyage` for the Driver voyage. `onEnded(ended)` is called with its result; `home` is passed on. |
| `startAutoEnd(options)`, `timerScheduler`, `Scheduler`      | The settle timer alone, with any `end`.                                                                                           |
| `startVoyageControl(options)`, `VOYAGE_INTENTS`             | Apply the `voyage.end` and `voyage.kill` intents.                                                                                 |
| `endVoyage({ store, voyage, charter, lifecycle, reason? })` | `releaseVoyage`, `wrapUpVoyage`, then `cleanUpVoyage` (`reason` defaults to `SETTLED_REASON`). Resolves to `{ wrapUp, cleanup }`. |
| `endVoyageWithoutDriver({ store, lifecycle, voyageId })`    | End with the wrap-up recorded as missed (`NO_DRIVER_SESSION`).                                                                    |
| `killVoyage({ store, lifecycle, voyageId })`                | `cleanUpVoyage` with `reason: 'killed'` and the voyage's tickets reopened.                                                        |
| `wrapUpVoyage(options)`, `missWrapUp`                       | The wrap-up turn and its proposals, on their own; record a wrap-up that could not run.                                            |
| `releaseVoyage(options)`, `closeVoyageCards`                | Close the voyage's cards and retire its builders; close its cards only.                                                           |
| `cleanUpVoyage(options)`                                    | Release, retire the Driver and end the voyage, on its own.                                                                        |
| `readSettleState`, `isSettled`                              | Whether a voyage is settled.                                                                                                      |
| `buildWrapUpPrompt`, `wrapUpFormat`, `wrapUpResultSchema`   | The wrap-up prompt and the shape of its result.                                                                                   |
| `AUTO_END_EVENTS`, `WRAP_UP_EVENTS`, `VOYAGE_ENDED_EVENT`   | `voyage.settling`, `voyage.settled`; `voyage.wrapped_up`, `voyage.wrap_up_missed`; `voyage.ended`.                                |
| `CARD_EXPIRED_EVENT`, `TICKET_REOPENED_EVENT`               | `card.expired` for a card the cleanup closed; `ticket.reopened` for a ticket a Kill put back.                                     |
