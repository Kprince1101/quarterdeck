# voyage-end

A voyage ends itself once it has settled, or when the human presses End or Kill all on the Board. A voyage spans every project, with a `voyages` row in each (see [crew](../crew/README.md#voyages)); each step below runs per project's row, and the voyage settles only once every project has. Ending closes the voyage's cards and retires its builders, gives the Driver one wrap-up turn to propose what the next Driver should be born with, then retires the Driver and marks the voyage `ended`. Nothing the Driver proposes takes effect until the human approves it. Killing does the same cleanup with no wrap-up and puts the voyage's tickets back to `open`.

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

`startAutoEnd({ legs, settleSeconds, end, schedule?, home?, onError? })` takes the voyage's row in each project (`legs`, each `{ store, voyageId }`). The voyage is settled when every leg is. It checks when it starts, on every change to `voyages`, `tickets`, `agents` and `cards` in any leg's store (`store.watch`), and on every `pause.set` and `pause.all` event in any of them.

- Settled and no timer: arm one for `settleSeconds` and record `voyage.settling` with `{ voyageId, settleSeconds, rearmed: false }` in every leg, each with its own `voyageId`.
- Not settled: disarm the timer, if any. The next time it settles the timer starts from zero.
- A `ticket.merged` event (the [merge gate](../gate/README.md), or a merge on GitHub the gate noticed) in any leg while settled re-arms the timer from zero and records `voyage.settling` with `rearmed: true`. Other changes leave a running timer alone.
- When the timer fires the voyage is checked once more. Still settled: `voyage.settled` is recorded with `{ voyageId, settleSeconds }` in every leg and `end()` runs, once. Anything after that is ignored; `close()` stops the triggers and cancels the timer.

`settleSeconds` is `autoEndSettleSeconds` from `rules/lifecycle.json` (default 120). The coordinator reads it from the home layer, `~/.quarterdeck/rules.local.lifecycle.json`, since a voyage belongs to no one project. Read with a repo, the repo layer, `<repo>/.quarterdeck/rules.local.lifecycle.json`, can only lengthen it: the larger of the two wins, so a file committed to the project cannot make voyages end sooner than the machine allows.

`schedule(ms, fire)` returns a cancel function; it defaults to `timerScheduler` (`setTimeout`, unref'd). Checks, arming and firing run one at a time. A failed check goes to `onError` (default: logged) and the next change checks again.

## Wrap-up

`wrapUpVoyage({ store, voyage, charter, legs? })` sends the Driver one more turn in its voyage session (`voyage.turnAs`, queued behind any turn still running) and waits for it. `legs` are the voyage's projects, each `{ project, store, voyageId, agentId }` with the Driver's seat there, the lead first; without them the voyage is `store`'s alone. The prompt (`buildWrapUpPrompt`) says the voyage settled, lists the active notebook of every leg with each entry's id and its project (or `every project`), gives the charter as it is, and asks for a wrap-up result (`WRAP_UP_INSTRUCTIONS`):

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

An `add` may name a `project`, one of the voyage's projects, to file the entry under; on a voyage with `legs`, an `add` without one is an entry for every project. `wrapUpFormat(notebook, projects?)` checks it: `entry` must be the id of an active entry, `project` one of `projects`, each entry is changed at most once, and there are at most `MAX_NOTEBOOK_PROPOSALS` changes. `charter` is `null` or `{ body, rationale }` with the whole charter, not a diff. A reply that does not match is re-prompted once, as for any Driver turn.

On a result, in one transaction per leg:

- each notebook change becomes an `open` `notebook_proposals` row (`op`, `entry_id`, `body`, `pinned` for adds, `rationale`, `voyage_id`, `agent_id`) in the project it belongs to: an `add`'s named project, or the project whose notebook holds the entry. An `add` for every project goes to the lead with `global` set. An `update` whose body is the entry's current body is dropped.
- a charter change becomes an `open` `charter_proposals` row in the lead with `voyage_id` and `agent_id`, unless its body is the current charter.
- `voyage.wrapped_up` is recorded with `{ voyageId, voyage, summary, notebookProposals, charterProposal }`, each leg listing its own proposals.

It resolves to `{ status: 'proposed', summary, notebookProposalIds, charterProposalId }`. If the turn misses, stops or throws, `voyage.wrap_up_missed` is recorded with `{ voyageId, voyage, reason }` and it resolves to `{ status: 'missed', reason }`; the voyage still ends.

## Approving

The human decides each proposal on the dashboard (see [api](../api/README.md#intents)):

- `notebook.decide` `{ proposalId, decision, body? }`: accepting an `add` inserts a notebook entry (with the proposal's voyage, author and `pinned`, and no project when the proposal is `global`); an `update` replaces the entry's body; a `retire` sets the entry's `retired_at`. `body` edits an add or update before it is applied. An update or retire of an entry already retired is refused (409) and the proposal stays open.
- `charter.decide` `{ proposalId, decision }`: accepting writes the body to `<repo>/.quarterdeck/rules.local.charter.md`.

The next Driver's birth (`openDriverVoyage`) reads the active notebook of every project (`retired_at` null), entries for every project included, and the charter as loaded then, so it is born with exactly what was approved.

## Cleanup

Cleanup runs per project, on that project's row. The voyage's agents there are its `driver` seat and `builder` agents (`VOYAGE_AGENT_ROLES`, matched on `agents.voyage_id`). The reviewer and the Planner are not voyage agents: they are never retired, and the reviewer is free for the next voyage as soon as this one ends.

`releaseVoyage({ store, lifecycle, voyageId, reason })` is the part that runs before the wrap-up:

1. **Close cards.** Every `open` card raised by a voyage agent (an `ask`, a sign-in card) becomes `expired`, and `card.expired` is recorded for each with `{ cardId, voyageId, reason }`, in one transaction. A turn waiting on one sees it expired, as it would on a timeout. `worktree.discard` cards stay open: they are the human's to answer. Cards nobody in the voyage raised (the gate's merge cards, the reviewer's own) are left alone.
2. **Retire builders.** Every builder of the voyage that is not retired yet, oldest first, through `lifecycle.retire` (`agents/retire.ts`): the session closes, the worktree is removed, the name is freed. A worktree with unsaved work is not discarded: a `worktree.discard` card is raised for it (`requestWorktreeDiscard`) and the builder stays unretired. A builder that already has an open discard card is skipped, so running it again never raises a second one.

It resolves to `{ closedCards, retired, discardCards }`.

`cleanUpVoyage({ store, lifecycle, voyageId, reason, reopen? })` runs `releaseVoyage` again (cards or builders that appeared since), retires the Driver the same way, then, in one transaction, marks the voyage `ended` (`ended_at` set), reopens its tickets if `reopen` is set (see [Kill](#kill)), and records `voyage.ended` with `{ voyageId, voyage, reason, closedCards, retired, discardCards, reopened }`. Any other error is thrown before the voyage is ended; calling it again carries on where it stopped and never ends a voyage twice (`ended: false`, nothing reopened).

## End

`endVoyage({ store, voyage, charter, lifecycle, reason?, legs?, closeDriver? })` is `releaseVoyage` in every leg, then `wrapUpVoyage`, then `closeDriver()`, then `cleanUpVoyage` in every leg: the builders are gone and the voyage's cards closed before the Driver's wrap-up turn, and the Driver's process is closed and its seats retired after it. `legs` add each project's `lifecycle` to the wrap-up's; without them the voyage is `store`'s alone. It resolves to `{ wrapUp, cleanup, cleanups }`: `cleanups` lists, per project, what all three steps closed and retired, and `cleanup` is the first. Auto-end runs it with `reason: 'settled'` (`SETTLED_REASON`); End from the Board with `'ended'` (`ENDED_REASON`).

`endVoyageWithoutDriver({ store, lifecycle, voyageId })` is the same when there is no live Driver session to wrap up in (the server restarted, the Driver died): the wrap-up is recorded as missed with `NO_DRIVER_SESSION` (`missWrapUp`) and the voyage still ends.

## Kill

`killVoyage({ store, lifecycle, voyageId })` is `cleanUpVoyage` with `reason: 'killed'` (`KILLED_REASON`) and `reopen: true`. There is no wrap-up turn and no proposals. Inside the transaction that ends the voyage, every ticket held by one of the voyage's builders (retired or not) and still `assigned`, `in_progress`, `in_review`, `bounced` or `blocked` goes back to `open` with no assignee; `pr_url` and `head_sha` stay so the next builder can pick up an open pull request. `ticket.reopened` is recorded for each with `{ voyageId, previousStatus, previousAssigneeId }`, and any card still open on those tickets (a merge card) is expired. Tickets other voyages assigned, tickets never assigned, and `done` tickets are not touched. The reviewer gate only evaluates `in_review` tickets, so a review it was waiting on for a reopened ticket is dropped, and a verdict on it is refused.

## End and Kill all from the Board

The Board sends `voyage.end` or `voyage.kill` `{ voyage }` (see [api](../api/README.md#intents)), and the coordinator applies them at once (see [crew](../crew/README.md#voyages)): End runs `endVoyage` over every project with the live Driver, or `endVoyageWithoutDriver` in each project when its Driver never opened; Kill all closes the Driver and runs `killVoyage` in each project.

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
| `startAutoEnd(options)`, `timerScheduler`, `Scheduler`      | The settle timer alone, over any legs, with any `end`.                                                                            |
| `endVoyage({ store, voyage, charter, lifecycle, reason? })` | `releaseVoyage`, `wrapUpVoyage`, then `cleanUpVoyage` (`reason` defaults to `SETTLED_REASON`), per leg with `legs`.               |
| `endVoyageWithoutDriver({ store, lifecycle, voyageId })`    | End with the wrap-up recorded as missed (`NO_DRIVER_SESSION`).                                                                    |
| `killVoyage({ store, lifecycle, voyageId })`                | `cleanUpVoyage` with `reason: 'killed'` and the voyage's tickets reopened.                                                        |
| `wrapUpVoyage(options)`, `missWrapUp`                       | The wrap-up turn and its proposals, on their own; record a wrap-up that could not run.                                            |
| `releaseVoyage(options)`, `closeVoyageCards`                | Close the voyage's cards and retire its builders; close its cards only.                                                           |
| `cleanUpVoyage(options)`                                    | Release, retire the Driver and end the voyage, on its own.                                                                        |
| `readSettleState`, `isSettled`                              | Whether a voyage is settled.                                                                                                      |
| `buildWrapUpPrompt`, `wrapUpFormat`, `wrapUpResultSchema`   | The wrap-up prompt and the shape of its result.                                                                                   |
| `AUTO_END_EVENTS`, `WRAP_UP_EVENTS`, `VOYAGE_ENDED_EVENT`   | `voyage.settling`, `voyage.settled`; `voyage.wrapped_up`, `voyage.wrap_up_missed`; `voyage.ended`.                                |
| `CARD_EXPIRED_EVENT`, `TICKET_REOPENED_EVENT`               | `card.expired` for a card the cleanup closed; `ticket.reopened` for a ticket a Kill put back.                                     |
