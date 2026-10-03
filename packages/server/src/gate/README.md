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

| Key                       | Default | What it does                                                                                                                                                                                                                                |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requireReviewerApproval` | `true`  | Hand each report to the reviewer and merge only on its `approve`. **`false` merges on the builder's report alone**: no reviewer is asked and nobody reads the diff before it merges (with `autoMerge` off, a human still answers the card). |
| `requireChecksPassing`    | `true`  | Merge only when the pull request's checks pass. Pending checks wait; failing checks bounce. A pull request with no checks at all counts as passing.                                                                                         |
| `requireCopilotReview`    | `false` | Also wait for a Copilot review, and bounce while any thread Copilot opened is unresolved. Copilot is known by its exact bot logins (`COPILOT_LOGINS`), never by a user account.                                                             |
| `autoMerge`               | `false` | Squash merge as soon as the gate passes. Off: raise a merge card and wait for a human. Merging publishes to the forge, so it is off until you turn it on.                                                                                   |
| `base`                    | unset   | The branch pull requests must merge into. Unset: the repository's default branch, as the forge reports it.                                                                                                                                  |

The repo layer, `<repo>/.quarterdeck/rules.local.lifecycle.json`, can only tighten `mergeGate`, so a file committed to the project cannot switch off a human gate: a `require*` flag is on if any layer turns it on, `autoMerge` is on only if no layer turns it off, and `base` may not be set there at all. Anything else in the repo layer is an error naming the file. The home layer, `~/.quarterdeck/rules.local.lifecycle.json`, sets them freely.

## Which pull requests it will merge

Only pull requests in the project's own repository, into its base. The repository comes from the project's `repo_path`: `git -C <repo_path> remote get-url origin`, parsed to host, owner and name (`https://`, `ssh://` and `git@host:owner/name` remotes; a nested namespace such as `group/subgroup` is the owner), and resolved once per gate. A project with no `repo_path` or no `origin` cannot be checked, so its approvals stay in review and each evaluation fails with the reason until it is set.

1. Before calling the forge at all, the gate parses the reported URL with the host's `pullRequestRef` and checks its host, owner and name against the project's repository (ignoring case). A URL anywhere else, or one that is not a pull request URL, bounces without being fetched.
2. The forge's own answer is checked again: the pull request's repository must be the project's, and the branch it merges into must be `mergeGate.base` or the repository's default branch. Otherwise it bounces, even if it has been merged already. On GitHub those are the pull request's `repository`, `baseRefName` and `defaultBranchRef`; on GitLab they are the target project's `path_with_namespace` and `web_url` host (read by the `project_id` GitLab gives for the merge request, not from the URL), the merge request's `target_branch`, and the project's `default_branch`.

## One ticket, step by step

`evaluate(ticketId)` reads the ticket and its events since the latest `ticket.reported`, and does at most one thing. Calling it again with nothing changed does nothing, so every trigger can simply call it.

1. **Not `in_review`, or never reported**: nothing.
2. **No verdict yet**: hand the report to the reviewer, once per report. The reviewer is the one the report named (`reviewerId`) if it is still live, else the project's oldest live reviewer. The `ReviewerHost` delivers the request to its session; then `ticket.review_requested` is recorded with `{ reviewerId, pr, head }`. If delivery throws, nothing is recorded and the next evaluation tries again. With no live reviewer the gate waits, and hands it over when a reviewer goes `idle`.
3. **`changes` verdict**: nothing; the ticket is already `bounced`.
4. **`approve` verdict**: the approval is the head the verdict saw. A report with no head cannot be checked against GitHub, so it bounces asking for one. A pull request outside the project's repository bounces before anything is fetched (see [above](#which-pull-requests-it-will-merge)). Otherwise the gate reads the pull request from the forge and, in this order:
   - in another repository, or into a branch other than the base: bounce;
   - merged on the forge (by anyone): the ticket is `done`, `ticket.merged` with `by` the forge (`'github'` or `'gitlab'`);
   - closed without merging: bounce;
   - its head is no longer the approved head: bounce, so the new commits are reported and reviewed;
   - the merge card was answered anything but `merge`, declined or expired: wait (a human merging on the forge still completes the ticket);
   - a draft: wait;
   - checks (when required): failing bounces naming them, pending waits;
   - conflicts with its base: bounce; mergeability not yet known: wait;
   - Copilot (when required): open Copilot threads bounce, no Copilot review yet waits;
   - then merge if `autoMerge` is on or the merge card was answered `merge`, wait if a merge card is open, and raise a merge card otherwise.

A **merge** is a squash merge guarded by the approved head, so the forge refuses it if anything was pushed after the approval: on GitHub `gh pr merge <pr> --squash --match-head-commit <approved head>`, on GitLab `glab api --hostname <host> --method PUT projects/<path>/merge_requests/<iid>/merge -F squash=true -f sha=<approved head>` (GitLab answers 409 when `sha` is no longer the head). On success the ticket is `done` and `ticket.merged` is recorded with `{ pr, head, by: 'gate' }`. On failure the gate raises a merge card carrying the error, so a human decides whether to retry; it does not retry by itself.

A **merge card** is a `cards` row of kind `ticket.merge` (`MERGE_CARD`) for the ticket, with options `merge` and `hold`, and a `ticket.merge_requested` event `{ cardId, pr, head, error }`. Answering it (`card.answer`) wakes the gate. A card raised before a newer approval no longer counts.

A **bounce** sets the ticket `bounced`, back to its builder, and records `ticket.gate_bounced` with `{ reason, pr, head }`; the reason says what to fix. The builder fixes it and reports again, which withdraws the old approval.

A **wait** records `ticket.gate_waiting` with `{ reason, pr, head }`, once: a wait with the same reason as the ticket's latest gate event is not recorded again. The reasons are `waitingReasons(terms)`.

Every write (`review_requested`, wait, bounce, merge card) happens in one transaction that locks the ticket and first checks it is still `in_review` with the same latest report, so a report that lands mid-evaluation is never answered with a stale step. Evaluations of one ticket run one at a time.

## Triggers

`startReviewGate` evaluates a ticket when:

- a `ticket.reported` or `ticket.verdict` event for it arrives (`store.subscribe`);
- its merge card is answered, declined or expired (`store.watch` on `cards`);

and sweeps every `in_review` ticket when it starts, every `pollMs` (default `GATE_POLL_MS`, 60 s) to follow checks, bot reviews and merges done on the forge, and when a reviewer goes `idle`. A failed evaluation is passed to `onError` (default: logged) and retried by the next trigger.

The gate does not prompt the builder after a bounce or the reviewer outside a review; the Driver does that from the ticket's status and events.

## Forges

The gate talks to the project's forge through a `ForgeHost`, never to GitHub or GitLab directly. `forgeHost(forge)` returns the host for a forge: `ghCli()` on the `gh` CLI for `github`, `glabCli()` on the `glab` CLI for `gitlab`.

| Member                   | What it does                                                                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge`                  | `'github'` or `'gitlab'`.                                                                                                                                                                                                              |
| `pullRequestRef(url)`    | Parses a reported URL into `{ hostname, owner, name, number }` the forge's way, throwing for anything that is not one of its pull or merge request URLs. The gate checks it against the project's repository before fetching anything. |
| `pullRequest(url)`       | Reads one pull or merge request as a forge-neutral `PullRequest`: `{ repository, base, defaultBranch, state, head, draft, mergeable, checks: { state, failing }, botReview: { reviewed, openThreads } }`.                              |
| `squashMerge(url, head)` | Squash merges it, refusing if its head is no longer `head`.                                                                                                                                                                            |
| `listOpen(repository)`   | The repository's open ones, newest first as the forge lists them, as `OpenPullRequest` `{ url, number, title, branch, head, draft, author }`. The gate does not call it; it is for the dashboard.                                      |

`botReview` is the review a bot gives on the forge. On GitHub it is Copilot (`isCopilot`); on GitLab it is GitLab Duo (`isGitLabReviewBot`, the exact usernames in `GITLAB_REVIEW_BOTS`): `reviewed` once Duo has opened any discussion, `openThreads` the unresolved ones it opened. `requireCopilotReview` gates on it.

**Which forge a project is on** comes from its `origin` remote's host: `github.com` is GitHub and `gitlab.com` is GitLab. Any other host must be mapped in the machine layer, `~/.quarterdeck/rules.local.forges.json` (`loadRule('forges')`):

```json
{ "forges": { "git.example.org": "gitlab" } }
```

An unmapped host is an `UnknownForgeError` naming the host and that file. The repo layer may not set `forges`; a `<repo>/.quarterdeck/rules.local.forges.json` is an error naming it, checked even before the `origin` is read. A project with no `repo_path`, or whose `origin` cannot be read, keeps GitHub wording; its merge gate still refuses to merge until the repository is known. `repoForge(repoPath, { homeDir })` and `projectForge(store, { homeDir })` resolve it for wording, with that GitHub fallback. `mergeForge(store, { homeDir })` resolves it for the gate and has no fallback: it throws until `repo_path` and `origin` can be read, so the gate retries and picks up a forge set later instead of caching GitHub. `repositoryForge(repository, rules)` does it for a parsed remote.

**Terms.** `forgeTerms(forge)` (from `@quarterdeck/rules`, re-exported here and importable alone from `@quarterdeck/rules/forges` in the browser) returns `{ short, long, cli, name }`: `PR`, `pull request`, `gh`, `GitHub` or `MR`, `merge request`, `glab`, `GitLab`. Every gate reason, merge card and review prompt is built from them, so an agent in a GitLab project only ever reads merge request terms. Text written for GitHub that Quarterdeck does not build itself (the charter, the reviewer brief, the bus tool descriptions) goes through `forgeWording(text, terms)`, which turns `pull request(s)` and `PR(s)` into the forge's words.

**Tests.** Neither CLI runs in the tests. `test/gate/github.test.ts` and `test/gate/gitlab.test.ts` hand `ghCli` and `glabCli` a fake runner that records the arguments and answers with recorded `gh api graphql` and `glab api` JSON (`github-fixtures.ts`, `gitlab-fixtures.ts`). `test/gate/gate.test.ts` runs every gate case once per forge, through the real host on such a runner (`forge-fixtures.ts`), so each decision is made from what that forge's CLI returns.

### GitHub

| Pull request field            | Read from (`gh api graphql`, `PULL_REQUEST_QUERY`)                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`, `defaultBranch` | `repository { nameWithOwner url defaultBranchRef }`                                                                                                         |
| `base`, `state`, `draft`      | `baseRefName`, `state` (`OPEN`, `MERGED`, `CLOSED`), `isDraft`                                                                                              |
| `head`, `mergeable`           | `headRefOid`, `mergeable` (`MERGEABLE`, `CONFLICTING`, `UNKNOWN`)                                                                                           |
| `checks`                      | the last commit's `statusCheckRollup`: `SUCCESS` passes, `FAILURE`/`ERROR` fails naming the failed runs and statuses, none is `none`, anything else pending |
| `botReview`                   | Copilot's `reviews` and the unresolved `reviewThreads` its first comment opened                                                                             |

### GitLab

`glabCli()` reads a merge request URL, `https://<host>/<group>/<subgroups…>/<project>/-/merge_requests/<iid>` (`parseMergeRequestUrl`; nested groups are the owner, as in a remote), through `glab api`. Every call passes `--hostname` with the merge request's host, which the gate has already checked is the host of the project's `origin`, so a self-hosted GitLab mapped in `forges.json` is asked directly whatever `glab` defaults to. The project in a path is URL-encoded (`example-group%2Fplatform%2Fdeck`).

`pullRequest(url)` makes three calls, and a fourth when the pipeline failed:

1. `projects/<path>/merge_requests/<iid>`: the merge request;
2. `projects/<project_id>`: its target project, for the repository and default branch;
3. `projects/<project_id>/merge_requests/<iid>/discussions?per_page=100`: the first 100 discussions, for `botReview`;
4. `projects/<pipeline project_id>/pipelines/<id>/jobs?scope[]=failed&scope[]=canceled&per_page=100`: the failed and canceled jobs of the head pipeline, named unless `allow_failure`.

| Pull request field            | Read from                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repository`, `defaultBranch` | the project's `path_with_namespace` (owner is everything before the last `/`), its `web_url` host, and `default_branch`                                                                                                                                                                                                                                                        |
| `base`, `head`                | `target_branch`, `sha`                                                                                                                                                                                                                                                                                                                                                         |
| `state`                       | `opened` and `locked` are `open`, `merged` is `merged`, `closed` is `closed`                                                                                                                                                                                                                                                                                                   |
| `draft`                       | `draft`, or `work_in_progress` on an older GitLab                                                                                                                                                                                                                                                                                                                              |
| `mergeable`                   | `detailed_merge_status` (or `merge_status` on an older GitLab): `unchecked`, `checking`, `preparing`, `approvals_syncing`, a recheck, or a `locked` merge request is `unknown`; `conflict`, `need_rebase`, `cannot_be_merged` or `has_conflicts` is `conflicting`; anything else, including a status that only waits on the pipeline, discussions or approvals, is `mergeable` |
| `checks`                      | `head_pipeline.status`: none is `none`, `success` and `skipped` pass, `failed` and `canceled` fail, anything else (`running`, `pending`, `manual`, …) is pending                                                                                                                                                                                                               |
| `botReview`                   | the discussions, without system notes: a discussion's author is its first note's, and it is open while any resolvable note is unresolved (`readThreads`, `openThreadsByAuthor`)                                                                                                                                                                                                |

`squashMerge` is the guarded `PUT …/merge` [above](#one-ticket-step-by-step). `listOpen` runs `projects/<path>/merge_requests?state=opened&per_page=100`, newest first, and maps `web_url`, `iid`, `title`, `source_branch`, `sha`, `draft` and the author's `username`. `quarterdeck doctor` checks `glab` is installed and signed in to each GitLab host in use (see the [CLI README](../../../cli/README.md#doctor)).

## API

```ts
import { loadRule } from '@quarterdeck/rules';
import {
  forgeHost,
  mergeForge,
  reviewPrompt,
  startReviewGate,
} from '@quarterdeck/server';

const gate = await startReviewGate({
  store,
  rules: (await loadRule('lifecycle', { repoDir })).mergeGate,
  forge: async () => forgeHost(await mergeForge(store, { homeDir })),
  reviewers: {
    requestReview: (request) =>
      sessions.prompt(request.reviewer.id, reviewPrompt(request)),
  },
});
await gate.close();
```

| Export                                                                                                                                                                                                                                            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startReviewGate({ store, rules, forge, reviewers, repository?, pollMs?, onError? })`                                                                                                                                                             | Subscribes, watches, sweeps once, and resolves to `{ evaluate, sweep, close }`. `sweep()` returns the sweep in flight if there is one. `close()` stops the triggers and waits for running evaluations. `forge` is a `ForgeHost` or a function resolving one, called on the first evaluation that needs it and again after a failure. `repository` resolves the project's `RepositoryRef`; it defaults to `projectRepository(store)`. |
| `projectRepository(store, run?)`, `originRepository(repoPath, run?)`, `parseRemoteUrl`, `sameRepository`                                                                                                                                          | The project's repository from its `repo_path` origin remote, and how a remote and a pull request are compared to it.                                                                                                                                                                                                                                                                                                                 |
| `isCopilot(author)`, `COPILOT_LOGINS`                                                                                                                                                                                                             | Whether a review or thread author is Copilot: one of the exact bot logins, and not a `User`.                                                                                                                                                                                                                                                                                                                                         |
| `ReviewerHost`, `ReviewRequest`                                                                                                                                                                                                                   | `{ requestReview(request) }`: deliver a review to the reviewer's session and resolve once it is delivered, not when the review is done. The request has the ticket, reviewer, builder, `pr`, `head`, `notes` and the forge's `terms`.                                                                                                                                                                                                |
| `reviewPrompt(request)`                                                                                                                                                                                                                           | The prompt text for a review request, in the request's terms.                                                                                                                                                                                                                                                                                                                                                                        |
| `ForgeHost`, `PullRequest`, `OpenPullRequest`, `BotReview`                                                                                                                                                                                        | The seam every forge sits behind; see [Forges](#forges).                                                                                                                                                                                                                                                                                                                                                                             |
| `forgeHost(forge)`                                                                                                                                                                                                                                | The host for a forge: `ghCli()` or `glabCli()`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `projectForge`, `mergeForge`, `repoForge`, `repositoryForge`                                                                                                                                                                                      | Which forge a project, a checkout or a repository is on.                                                                                                                                                                                                                                                                                                                                                                             |
| `forgeTerms`, `FORGE_TERMS`, `forgeWording`, `Forge`, `ForgeTerms`                                                                                                                                                                                | The terminology helper, re-exported from `@quarterdeck/rules`.                                                                                                                                                                                                                                                                                                                                                                       |
| `ghCli(run?)`                                                                                                                                                                                                                                     | The GitHub `ForgeHost` on the `gh` CLI. `pullRequest` runs one `gh api graphql` (`PULL_REQUEST_QUERY`, variables bound with `-f`/`-F`); it reads the first 100 check contexts, reviews and threads. `listOpen` runs `gh pr list --repo <host>/<owner>/<name> --state open` for up to 100.                                                                                                                                            |
| `parsePullRequestUrl`, `parsePullRequest`, `parseOpenPullRequests`, `pullRequestArgs`, `squashMergeArgs`, `listOpenArgs`                                                                                                                          | The pieces `ghCli` is built from.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `glabCli(run?)`                                                                                                                                                                                                                                   | The GitLab `ForgeHost` on the `glab` CLI; see [GitLab](#gitlab).                                                                                                                                                                                                                                                                                                                                                                     |
| `parseMergeRequestUrl`, `parseMergeRequest`, `parseMergeRequestReply`, `parseOpenMergeRequests`, `mergeRequestArgs`, `projectArgs`, `discussionsArgs`, `failedJobsArgs`, `glabSquashMergeArgs`, `glabListOpenArgs`, `runGlab`, `GITLAB_PAGE_SIZE` | The pieces `glabCli` is built from.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `isGitLabReviewBot(username)`, `GITLAB_REVIEW_BOTS`, `readThreads`, `openThreadsByAuthor`                                                                                                                                                         | Whether a GitLab author is the review bot, a merge request's discussions as `{ author, resolved }` threads, and its open threads counted by the author who opened them.                                                                                                                                                                                                                                                              |
| `reviewStep`, `mergeStep`, `foreignPullRequest`, `waitingReasons`                                                                                                                                                                                 | The pure decisions: what to do with a ticket's facts, with an approval given the pull request, its merge card, the project's repository and the forge's terms, and whether a URL is outside that repository.                                                                                                                                                                                                                         |
| `mergeQuestion(ticket, at, terms, error)`                                                                                                                                                                                                         | The merge card's question.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GATE_EVENTS`, `MERGE_CARD`, `MERGE_ANSWER`, `HOLD_ANSWER`                                                                                                                                                                                        | The event kinds the gate reads and records, and the merge card's kind and options.                                                                                                                                                                                                                                                                                                                                                   |
