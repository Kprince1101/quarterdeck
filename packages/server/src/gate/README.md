# gate

The reviewer gate and the merge: what happens to a ticket between a builder's `report` and its pull request being merged. It runs on the `ticket.reported` and `ticket.verdict` events the [bus](../bus/README.md#reportticket-pr-notes-head) records and needs no table of its own; the events are its state, so a restarted gate picks up where the last one stopped.

```
report ─▶ in_review ─▶ reviewer session ─▶ verdict
                                           ├─ changes ─▶ bounced (back to the builder)
                                           └─ approve ─▶ merge gate
                                                         ├─ autoMerge on  ─▶ squash merge ─▶ done
                                                         └─ autoMerge off ─▶ merge card ─▶ merge ─▶ squash merge ─▶ done
                                                                                         └─ hold ─▶ stays in review
```

## Rules

The gate reads `mergeGate` from `rules/lifecycle.json` (`loadRule('lifecycle')`), overridable in `rules.local.lifecycle.json`:

| Key                       | Default | What it does                                                                                                                                           |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `requireReviewerApproval` | `true`  | Hand each report to the reviewer and merge only on its `approve`. Off: the report itself is the approval and no reviewer is asked.                     |
| `requireChecksPassing`    | `true`  | Merge only when the pull request's checks pass. Pending checks wait; failing checks bounce. A pull request with no checks at all counts as passing.    |
| `requireCopilotReview`    | `false` | Also wait for a Copilot review, and bounce while any thread Copilot opened is unresolved.                                                              |
| `autoMerge`               | `false` | Squash merge as soon as the gate passes. Off: raise a merge card and wait for a human. Merging publishes to GitHub, so it is off until you turn it on. |

## One ticket, step by step

`evaluate(ticketId)` reads the ticket and its events since the latest `ticket.reported`, and does at most one thing. Calling it again with nothing changed does nothing, so every trigger can simply call it.

1. **Not `in_review`, or never reported**: nothing.
2. **No verdict yet**: hand the report to the reviewer, once per report. The reviewer is the one the report named (`reviewerId`) if it is still live, else the project's oldest live reviewer. The `ReviewerHost` delivers the request to its session; then `ticket.review_requested` is recorded with `{ reviewerId, pr, head }`. If delivery throws, nothing is recorded and the next evaluation tries again. With no live reviewer the gate waits, and hands it over when a reviewer goes `idle`.
3. **`changes` verdict**: nothing; the ticket is already `bounced`.
4. **`approve` verdict**: the approval is the head the verdict saw. A report with no head cannot be checked against GitHub, so it bounces asking for one. Otherwise the gate reads the pull request from GitHub and, in this order:
   - merged on GitHub (by anyone): the ticket is `done`, `ticket.merged` with `by: 'github'`;
   - closed without merging: bounce;
   - its head is no longer the approved head: bounce, so the new commits are reported and reviewed;
   - the merge card was answered anything but `merge`, declined or expired: wait (a human merging on GitHub still completes the ticket);
   - a draft: wait;
   - checks (when required): failing bounces naming them, pending waits;
   - conflicts with its base: bounce; mergeability not yet known: wait;
   - Copilot (when required): open Copilot threads bounce, no Copilot review yet waits;
   - then merge if `autoMerge` is on or the merge card was answered `merge`, wait if a merge card is open, and raise a merge card otherwise.

A **merge** is `gh pr merge <pr> --squash --match-head-commit <approved head>`, so GitHub refuses it if anything was pushed after the approval. On success the ticket is `done` and `ticket.merged` is recorded with `{ pr, head, by: 'gate' }`. On failure the gate raises a merge card carrying the error, so a human decides whether to retry; it does not retry by itself.

A **merge card** is a `cards` row of kind `ticket.merge` (`MERGE_CARD`) for the ticket, with options `merge` and `hold`, and a `ticket.merge_requested` event `{ cardId, pr, head, error }`. Answering it (`card.answer`) wakes the gate. A card raised before a newer approval no longer counts.

A **bounce** sets the ticket `bounced`, back to its builder, and records `ticket.gate_bounced` with `{ reason, pr, head }`; the reason says what to fix. The builder fixes it and reports again, which withdraws the old approval.

A **wait** records `ticket.gate_waiting` with `{ reason, pr, head }`, once: a wait with the same reason as the ticket's latest gate event is not recorded again. The reasons are in `WAITING`.

Every write (`review_requested`, wait, bounce, merge card) happens in one transaction that locks the ticket and first checks it is still `in_review` with the same latest report, so a report that lands mid-evaluation is never answered with a stale step. Evaluations of one ticket run one at a time.

## Triggers

`startReviewGate` evaluates a ticket when:

- a `ticket.reported` or `ticket.verdict` event for it arrives (`store.subscribe`);
- its merge card is answered, declined or expired (`store.watch` on `cards`);

and sweeps every `in_review` ticket when it starts, every `pollMs` (default `GATE_POLL_MS`, 60 s) to follow checks, Copilot and merges done on GitHub, and when a reviewer goes `idle`. A failed evaluation is passed to `onError` (default: logged) and retried by the next trigger.

The gate does not prompt the builder after a bounce or the reviewer outside a review; the Driver does that from the ticket's status and events.

## API

```ts
import { loadRule } from '@quarterdeck/rules';
import { ghCli, reviewPrompt, startReviewGate } from '@quarterdeck/server';

const gate = await startReviewGate({
  store,
  rules: (await loadRule('lifecycle', { repoDir })).mergeGate,
  github: ghCli(),
  reviewers: {
    requestReview: (request) =>
      sessions.prompt(request.reviewer.id, reviewPrompt(request)),
  },
});
await gate.close();
```

| Export                                                                          | What it does                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startReviewGate({ store, rules, github, reviewers, pollMs?, onError? })`       | Subscribes, watches, sweeps once, and resolves to `{ evaluate, sweep, close }`. `sweep()` returns the sweep in flight if there is one. `close()` stops the triggers and waits for running evaluations.           |
| `ReviewerHost`, `ReviewRequest`                                                 | `{ requestReview(request) }`: deliver a review to the reviewer's session and resolve once it is delivered, not when the review is done. The request has the ticket, reviewer, builder, `pr`, `head` and `notes`. |
| `reviewPrompt(request)`                                                         | The prompt text for a review request.                                                                                                                                                                            |
| `GitHubHost`, `PullRequest`                                                     | `{ pullRequest(url), squashMerge(url, head) }`: the seam GitHub sits behind. `PullRequest` is `{ state, head, draft, mergeable, checks: { state, failing }, copilot: { reviewed, openThreads } }`.               |
| `ghCli(run?)`                                                                   | The `GitHubHost` on the `gh` CLI. `pullRequest` runs one `gh api graphql` (`PULL_REQUEST_QUERY`, variables bound with `-f`/`-F`); it reads the first 100 check contexts, reviews and threads.                    |
| `parsePullRequestUrl`, `parsePullRequest`, `pullRequestArgs`, `squashMergeArgs` | The pieces `ghCli` is built from.                                                                                                                                                                                |
| `reviewStep`, `mergeStep`, `WAITING`                                            | The pure decisions: what to do with a ticket's facts, and with an approval given the pull request and its merge card.                                                                                            |
| `GATE_EVENTS`, `MERGE_CARD`, `MERGE_ANSWER`, `HOLD_ANSWER`                      | The event kinds the gate reads and records, and the merge card's kind and options.                                                                                                                               |
