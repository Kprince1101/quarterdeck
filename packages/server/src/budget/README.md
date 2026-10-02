# budget

A rolling token meter over the project's `turns` rows, and the hold every launch checks before it starts an agent.

## The window

`lifecycle.json` sets it under `budget.window`:

```json
{ "hours": 5, "capTokens": null, "holdAtFraction": 0.8 }
```

| Field            | Meaning                                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `hours`          | How far back the meter sums. A positive whole number of hours.                  |
| `capTokens`      | The cap on tokens spent inside the window. `null` (the default) is no cap.      |
| `holdAtFraction` | Launches are held once the window's spend reaches this fraction of `capTokens`. |

Set a cap per machine or per repo with a `rules.local.lifecycle.json` layer, for example `{ "budget": { "window": { "capTokens": 4000000 } } }`. The repo layer (`<repo>/.quarterdeck/`) can only tighten the window, never loosen what the machine set. Across the machine and repo layers the loader takes the smaller non-null `capTokens`, the lower `holdAtFraction` and the longer `hours`.

## The meter

```ts
import { loadRule } from '@quarterdeck/rules';
import { readBudgetMeter } from '@quarterdeck/server';

const { budget } = await loadRule('lifecycle', { repoDir });
const meter = await readBudgetMeter(store.db, store.projectId, budget.window);
```

`usedTokens` is `input_tokens + output_tokens` of every turn of the project's agents that ended inside the window (`ended_at` after `since`, which is now minus `hours`). A turn still running has no `ended_at` and counts once it ends. The `turns_ended_at` index (migration `0012_turns_ended_at`) keeps the read to the window's turns.

| Field          | Meaning                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `windowHours`  | The window's length.                                                                                                      |
| `since`        | The window's start.                                                                                                       |
| `usedTokens`   | Tokens spent inside the window.                                                                                           |
| `capTokens`    | The cap, or `null`.                                                                                                       |
| `holdAtTokens` | `ceil(capTokens * holdAtFraction)`, or `null` with no cap.                                                                |
| `held`         | `usedTokens >= holdAtTokens`. Never true with no cap.                                                                     |
| `releaseAt`    | While held: when enough of the oldest spend leaves the window to bring `usedTokens` under the line, if nothing else runs. |

## The hold

Every launch checks the budget first. `createAgentLifecycle().birth` checks before it claims a name (with the request's `ticketId`), and `openDriverRound` checks before it launches the bus (with the Driver's id). Both use `assertLaunchBudget`, which throws `BudgetHeldError` on a hold. The error carries `meter` and `releaseAt`. A held launch creates no agent row, name or session. Any other launch path (a continue on an existing agent) calls the same check:

```ts
import { BudgetHeldError, assertLaunchBudget } from '@quarterdeck/server';

try {
  await assertLaunchBudget(store, budget.window, { agentId, ticketId });
} catch (err) {
  if (!(err instanceof BudgetHeldError)) throw err;
  // wait until err.releaseAt, then try again
}
```

A caller holding a launch waits until `releaseAt` before trying again. It does not retry in a loop: every held check records a `budget.held` event.

`checkLaunchBudget(store, window, { agentId?, ticketId?, now? })` returns the decision instead of throwing. It takes a per-project transaction advisory lock (`pg_advisory_xact_lock(hashtext('quarterdeck_budget'), hashtext(project_id))`, not a row lock, so it cannot deadlock with the event lock), reads the meter and:

- **held**: records `budget.held` (with the launch's `agentId` and `ticketId`) and returns `{ status: 'held', meter, event }`. Every held launch records its own event.
- **clear**: if the last `budget.held` / `budget.released` event of the project is `budget.held`, records `budget.released` once and returns it as `released`; otherwise `released` is `null`. Returns `{ status: 'clear', meter, released }`.

The release is recorded by the first check that finds the project under the line, so a caller holding launches retries at `releaseAt`. Lifting the cap (`capTokens: null`) releases on the next check too. Checks run one at a time per project, so launches checked together record one release.

## Events

| `kind`            | Payload                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `budget.held`     | `{ windowHours, usedTokens, capTokens, holdAtTokens, releaseAt }` |
| `budget.released` | `{ windowHours, usedTokens, capTokens, holdAtTokens, releaseAt }` |

`releaseAt` is an ISO timestamp on `budget.held` and `null` on `budget.released`.
