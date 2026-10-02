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

Set a cap per machine or per repo with a `rules.local.lifecycle.json` layer, for example `{ "budget": { "window": { "capTokens": 4000000 } } }`.

## The meter

```ts
import { loadRule } from '@quarterdeck/rules';
import { readBudgetMeter } from '@quarterdeck/server';

const { budget } = await loadRule('lifecycle', { repoDir });
const meter = await readBudgetMeter(store.db, store.projectId, budget.window);
```

`usedTokens` is `input_tokens + output_tokens` of every turn of the project's agents that ended inside the window (`ended_at` after `since`, which is now minus `hours`). A turn still running has no `ended_at` and counts once it ends.

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

Whatever launches an agent (a birth, or a continue on an existing one) calls the check first and does not launch on `held`:

```ts
import { checkLaunchBudget } from '@quarterdeck/server';

const decision = await checkLaunchBudget(store, budget.window, { ticketId });
if (decision.status === 'held') {
  // retry at decision.meter.releaseAt
}
```

`checkLaunchBudget(store, window, { agentId?, ticketId?, now? })` locks the project row, reads the meter and:

- **held**: records `budget.held` (with the launch's `agentId` and `ticketId`) and returns `{ status: 'held', meter, event }`. Every held launch records its own event.
- **clear**: if the last `budget.held` / `budget.released` event of the project is `budget.held`, records `budget.released` once and returns it as `released`; otherwise `released` is `null`. Returns `{ status: 'clear', meter, released }`.

The release is recorded by the first check that finds the project under the line, so a caller holding launches retries at `releaseAt`. Lifting the cap (`capTokens: null`) releases on the next check too. Checks run one at a time per project, so launches checked together record one release.

## Events

| `kind`            | Payload                                                           |
| ----------------- | ----------------------------------------------------------------- |
| `budget.held`     | `{ windowHours, usedTokens, capTokens, holdAtTokens, releaseAt }` |
| `budget.released` | `{ windowHours, usedTokens, capTokens, holdAtTokens, releaseAt }` |

`releaseAt` is an ISO timestamp on `budget.held` and `null` on `budget.released`.
