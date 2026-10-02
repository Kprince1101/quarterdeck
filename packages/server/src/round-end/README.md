# round-end

A round ends itself once it has settled. The Driver gets one wrap-up turn to propose what the next Driver should be born with, then the round's agents are retired and the round is marked `ended`. Nothing the Driver proposes takes effect until the human approves it.

```
settled ─▶ settle timer (autoEndSettleSeconds) ─▶ round.settled ─▶ wrap-up turn ─▶ proposals ─▶ cleanup ─▶ round.ended
   ▲            │                                                                   │
   │            ├─ work comes back: disarmed                                         └─ notebook.decide / charter.decide ─▶ next Driver's birth
   └────────────┴─ late merge (ticket.merged): re-armed from zero
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

`cleanUpRound({ store, lifecycle, roundId, reason })` retires every agent of the round whose role is `driver` or `builder` (`ROUND_AGENT_ROLES`) and is not retired yet, oldest first, through `lifecycle.retire`: the session closes, the worktree is removed, the name is freed. The project's reviewer and Planner are not round agents and stay. A worktree with unsaved work is not discarded: a `worktree.discard` card is raised for it (`requestWorktreeDiscard`) and the agent stays unretired. Then the round becomes `ended` (`ended_at` set) and `round.ended` is recorded with `{ roundId, round, reason, retired, discardCards }`, in one transaction. Any other error is thrown before the round is ended; calling it again carries on where it stopped and never ends a round twice (`ended: false`).

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

| Export                                                    | What it does                                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `startRoundAutoEnd(options)`                              | `startAutoEnd` whose `end` is `endRound` for the Driver round. `onEnded(ended)` is called with its result.     |
| `startAutoEnd(options)`, `timerScheduler`, `Scheduler`    | The settle timer alone, with any `end`.                                                                        |
| `endRound({ store, round, charter, lifecycle, reason? })` | `wrapUpRound`, then `cleanUpRound` (`reason` defaults to `SETTLED_REASON`). Resolves to `{ wrapUp, cleanup }`. |
| `wrapUpRound(options)`                                    | The wrap-up turn and its proposals, on their own.                                                              |
| `cleanUpRound(options)`                                   | Retire the round's agents and end the round, on its own.                                                       |
| `readSettleState`, `isSettled`                            | Whether a round is settled.                                                                                    |
| `buildWrapUpPrompt`, `wrapUpFormat`, `wrapUpResultSchema` | The wrap-up prompt and the shape of its result.                                                                |
| `AUTO_END_EVENTS`, `WRAP_UP_EVENTS`, `ROUND_ENDED_EVENT`  | `round.settling`, `round.settled`; `round.wrapped_up`, `round.wrap_up_missed`; `round.ended`.                  |
