# round-end

A round ends itself once it has settled, or when the human presses End or Kill. Ending closes the round's cards and retires its builders, gives the Driver one wrap-up turn to propose what the next Driver should be born with, then retires the Driver and marks the round `ended`. Nothing the Driver proposes takes effect until the human approves it. Killing does the same cleanup with no wrap-up and puts the round's tickets back to `open`.

```
settled ─▶ settle timer (autoEndSettleSeconds) ─▶ round.settled ─┐
   ▲            │                                                 ├─▶ release ─▶ wrap-up turn ─▶ proposals ─▶ cleanup ─▶ round.ended
   │            ├─ work comes back: disarmed       round.end ─────┘                 │
   └────────────┴─ late merge: re-armed from zero                                   └─ notebook.decide / charter.decide ─▶ next Driver's birth

round.kill ─▶ cleanup + tickets reopened ─▶ round.ended (reason: killed)
```

## When a round is settled

`readSettleState(db, projectId, roundId)` counts what keeps it going, and `isSettled(state)` is true when all of these hold:

| Check             | What counts                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| round not ended   | The round exists in the project and its `status` is not `ended`.                                                                                                       |
| no open tickets   | No ticket of the project is `open`, `assigned`, `in_progress`, `in_review` or `bounced` (`OPEN_TICKET_STATUSES`). `proposed` tickets wait for the human, not the crew. |
| no running agents | No agent of the project is `starting`, `working` or `stuck` (`RUNNING_AGENT_STATUSES`). A turn in flight, the Driver's own included, keeps the round going.            |
| no open cards     | No card of the project is `open`.                                                                                                                                      |

## The settle timer

`startAutoEnd({ store, roundId, settleSeconds, end, schedule?, onError? })` checks the round when it starts and on every change to `rounds`, `tickets`, `agents` and `cards` (`store.watch`).

- Settled and no timer: arm one for `settleSeconds` and record `round.settling` with `{ roundId, settleSeconds, rearmed: false }`.
- Not settled: disarm the timer, if any. The next time it settles the timer starts from zero.
- A `ticket.merged` event (the [merge gate](../gate/README.md), or a merge on GitHub the gate noticed) while settled re-arms the timer from zero and records `round.settling` with `rearmed: true`. Other changes leave a running timer alone.
- When the timer fires the round is checked once more. Still settled: `round.settled` is recorded with `{ roundId, settleSeconds }` and `end(roundId)` runs, once. Anything after that is ignored; `close()` stops the triggers and cancels the timer.

`settleSeconds` is `autoEndSettleSeconds` from `rules/lifecycle.json` (default 120). The home layer, `~/.quarterdeck/rules.local.lifecycle.json`, sets it freely. The repo layer, `<repo>/.quarterdeck/rules.local.lifecycle.json`, can only lengthen it: the larger of the two wins, so a file committed to the project cannot make rounds end sooner than the machine allows.

`schedule(ms, fire)` returns a cancel function; it defaults to `timerScheduler` (`setTimeout`, unref'd). Checks, arming and firing run one at a time. A failed check goes to `onError` (default: logged) and the next change checks again.

## Wrap-up

`wrapUpRound({ store, round, charter })` sends the Driver one more turn in its round session (`round.turnAs`, queued behind any turn still running) and waits for it. The prompt (`buildWrapUpPrompt`) says the round settled, lists the active notebook with each entry's id, gives the charter as it is, and asks for a wrap-up result (`WRAP_UP_INSTRUCTIONS`):

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

- each notebook change becomes an `open` `notebook_proposals` row (`op`, `entry_id`, `body`, `pinned` for adds, `rationale`, `round_id`, `agent_id`). An `update` whose body is the entry's current body is dropped.
- a charter change becomes an `open` `charter_proposals` row with `round_id` and `agent_id`, unless its body is the current charter.
- `round.wrapped_up` is recorded with `{ roundId, round, summary, notebookProposals, charterProposal }`.

It resolves to `{ status: 'proposed', summary, notebookProposalIds, charterProposalId }`. If the turn misses, stops or throws, `round.wrap_up_missed` is recorded with `{ roundId, round, reason }` and it resolves to `{ status: 'missed', reason }`; the round still ends.

## Approving

The human decides each proposal on the dashboard (see [api](../api/README.md#intents)):

- `notebook.decide` `{ proposalId, decision, body? }`: accepting an `add` inserts a notebook entry (with the proposal's round, author and `pinned`); an `update` replaces the entry's body; a `retire` sets the entry's `retired_at`. `body` edits an add or update before it is applied. An update or retire of an entry already retired is refused (409) and the proposal stays open.
- `charter.decide` `{ proposalId, decision }`: accepting writes the body to `<repo>/.quarterdeck/rules.local.charter.md`.

The next Driver's birth (`openDriverRound`) reads the active notebook (`retired_at` null) and the charter as loaded then, so it is born with exactly what was approved.

## Cleanup

The round's agents are its `driver` and `builder` agents (`ROUND_AGENT_ROLES`, matched on `agents.round_id`). The project's reviewer and Planner are not round agents: they are never retired, and the reviewer is free for the next round as soon as this one ends.

`releaseRound({ store, lifecycle, roundId, reason })` is the part that runs before the wrap-up:

1. **Close cards.** Every `open` card raised by a round agent (an `ask`, a sign-in card) becomes `expired`, and `card.expired` is recorded for each with `{ cardId, roundId, reason }`, in one transaction. A turn waiting on one sees it expired, as it would on a timeout. `worktree.discard` cards stay open: they are the human's to answer. Cards nobody in the round raised (the gate's merge cards, the reviewer's own) are left alone.
2. **Retire builders.** Every builder of the round that is not retired yet, oldest first, through `lifecycle.retire` (`agents/retire.ts`): the session closes, the worktree is removed, the name is freed. A worktree with unsaved work is not discarded: a `worktree.discard` card is raised for it (`requestWorktreeDiscard`) and the builder stays unretired. A builder that already has an open discard card is skipped, so running it again never raises a second one.

It resolves to `{ closedCards, retired, discardCards }`.

`cleanUpRound({ store, lifecycle, roundId, reason, reopen? })` runs `releaseRound` again (cards or builders that appeared since), retires the Driver the same way, then, in one transaction, marks the round `ended` (`ended_at` set), reopens its tickets if `reopen` is set (see [Kill](#kill)), and records `round.ended` with `{ roundId, round, reason, closedCards, retired, discardCards, reopened }`. Any other error is thrown before the round is ended; calling it again carries on where it stopped and never ends a round twice (`ended: false`, nothing reopened).

## End

`endRound({ store, round, charter, lifecycle, reason? })` is `releaseRound`, then `wrapUpRound`, then `cleanUpRound`: the builders are gone and the round's cards closed before the Driver's wrap-up turn, and the Driver is retired after it. Its `cleanup` lists what all three steps closed and retired. Auto-end runs it with `reason: 'settled'` (`SETTLED_REASON`); End from the dashboard with `'ended'` (`ENDED_REASON`).

`endRoundWithoutDriver({ store, lifecycle, roundId })` is the same when there is no live Driver session to wrap up in (the server restarted, the Driver died): the wrap-up is recorded as missed with `NO_DRIVER_SESSION` (`missWrapUp`) and the round still ends.

## Kill

`killRound({ store, lifecycle, roundId })` is `cleanUpRound` with `reason: 'killed'` (`KILLED_REASON`) and `reopen: true`. There is no wrap-up turn and no proposals. Inside the transaction that ends the round, every ticket held by one of the round's builders (retired or not) and still `assigned`, `in_progress`, `in_review` or `bounced` goes back to `open` with no assignee; `pr_url` and `head_sha` stay so the next builder can pick up an open pull request. `ticket.reopened` is recorded for each with `{ roundId, previousStatus, previousAssigneeId }`, and any card still open on those tickets (a merge card) is expired. Tickets other rounds assigned, tickets never assigned, and `done` tickets are not touched. The reviewer gate only evaluates `in_review` tickets, so a review it was waiting on for a reopened ticket is dropped, and a verdict on it is refused.

## End and Kill from the dashboard

The Project widget sends `round.end` or `round.kill` `{ project, roundId }` (see [api](../api/README.md#intents)). Both are recorded `pending` after checking the round exists and has not ended. `startRoundControl` applies them:

```ts
import { startRoundControl } from '@quarterdeck/server';

const control = await startRoundControl({
  store,
  lifecycle, // createAgentLifecycle(...)
  driver: (roundId) => liveRounds.get(roundId), // { round: DriverRound, charter }
});
await control.close();
```

It reads pending `round.end` and `round.kill` intents when it starts and on every new one, oldest first. Each is checked again (a round that ended meanwhile is `rejected` with `round <id> has already ended`), then applied: End runs `endRound` with the live Driver round `driver(roundId)` gives, or `endRoundWithoutDriver` when it gives none; Kill runs `killRound`. The intent becomes `applied` with `{ roundId, round, ended, closedCards, retired, discardCards, reopened }` (plus `wrapUp` for End), or `rejected` with `{ error }` if it throws. Intents for one round run in order, except that a Kill never waits behind an End's wrap-up turn: killing retires the Driver, so the turn ends. `drain()` resolves once everything pending has settled; `close()` stops listening and waits for what is running.

## API

```ts
import { loadRule } from '@quarterdeck/rules';
import { openDriverRound, startRoundAutoEnd } from '@quarterdeck/server';

const round = await openDriverRound({ ...driverOptions });
const auto = await startRoundAutoEnd({
  store,
  round,
  charter,
  lifecycle, // createAgentLifecycle(...)
  settleSeconds: (await loadRule('lifecycle', { repoDir }))
    .autoEndSettleSeconds,
});
await auto.close();
```

| Export                                                    | What it does                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `startRoundAutoEnd(options)`                              | `startAutoEnd` whose `end` is `endRound` for the Driver round. `onEnded(ended)` is called with its result.                     |
| `startAutoEnd(options)`, `timerScheduler`, `Scheduler`    | The settle timer alone, with any `end`.                                                                                        |
| `startRoundControl(options)`, `ROUND_INTENTS`             | Apply the `round.end` and `round.kill` intents.                                                                                |
| `endRound({ store, round, charter, lifecycle, reason? })` | `releaseRound`, `wrapUpRound`, then `cleanUpRound` (`reason` defaults to `SETTLED_REASON`). Resolves to `{ wrapUp, cleanup }`. |
| `endRoundWithoutDriver({ store, lifecycle, roundId })`    | End with the wrap-up recorded as missed (`NO_DRIVER_SESSION`).                                                                 |
| `killRound({ store, lifecycle, roundId })`                | `cleanUpRound` with `reason: 'killed'` and the round's tickets reopened.                                                       |
| `wrapUpRound(options)`, `missWrapUp`                      | The wrap-up turn and its proposals, on their own; record a wrap-up that could not run.                                         |
| `releaseRound(options)`, `closeRoundCards`                | Close the round's cards and retire its builders; close its cards only.                                                         |
| `cleanUpRound(options)`                                   | Release, retire the Driver and end the round, on its own.                                                                      |
| `readSettleState`, `isSettled`                            | Whether a round is settled.                                                                                                    |
| `buildWrapUpPrompt`, `wrapUpFormat`, `wrapUpResultSchema` | The wrap-up prompt and the shape of its result.                                                                                |
| `AUTO_END_EVENTS`, `WRAP_UP_EVENTS`, `ROUND_ENDED_EVENT`  | `round.settling`, `round.settled`; `round.wrapped_up`, `round.wrap_up_missed`; `round.ended`.                                  |
| `CARD_EXPIRED_EVENT`, `TICKET_REOPENED_EVENT`             | `card.expired` for a card the cleanup closed; `ticket.reopened` for a ticket a Kill put back.                                  |
