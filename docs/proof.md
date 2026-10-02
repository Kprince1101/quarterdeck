# Proof: a self-round over claude (QD14a)

Quarterdeck ran one round on its own repository, end to end, over the claude runtime, on 2026-10-02:

1. `quarterdeck init` created the project; `quarterdeck up` started its crew.
2. The Planner read the repository and proposed one tiny ticket.
3. The ticket was approved and a round started. The Driver birthed a claude builder that opened a pull request and reported it.
4. The reviewer approved. The merge gate waited for CI, then squash-merged [pull request #72](https://github.com/<owner>/quarterdeck/pull/72) into `main`.
5. The round settled and ended itself. The Driver's wrap-up proposed three notebook entries, and one was accepted.
6. The Data widget's reads showed the project's rows. Wipe removed the project and its folder.

Every agent (Planner, Driver, builder, reviewer) ran on claude through `@agentclientprotocol/claude-agent-acp`. The whole round took 6 minutes 22 seconds, most of it CI.

## How it was run

[`scripts/proof/self-round.ts`](../scripts/proof/self-round.ts) drives the round the way a person at the dashboard would. It runs the CLI's own `init` and `up` in process, with `homeDir` pointing at a fresh `/tmp/qdp-*`, so nothing touches `~/.quarterdeck`. It then sends the dashboard's intents over HTTP with the printed token.

```sh
npm run build
node scripts/proof/self-round.ts .
```

It needs a signed-in claude and gh (`quarterdeck doctor`). The round's pull request merges into the real default branch. It refuses to start while `DATABASE_URL` is set, since the store would then live in that database instead of the temp home. It fails, rather than reporting success, if:

- the round ends for any reason but `settled`;
- nothing merged;
- the wipe does not name the project;
- `data.summary` still answers, or the project folder is still there.

**Rerunning the script means auto-approving arbitrary commands inside the repository and the temp home.** The agents run `npm`, `npx`, `node`, `git` and anything else they choose there. The script's policy (below) allows any of it except pushes outside its allowlist and what is on its deny list. Run it only on a machine and an account you are willing to let a coding agent use that way, and watch it.

**Before anyone reruns the proof, turn on branch protection for `main`:**

- require a pull request with an approving review;
- require the status checks (`validate`, `store-postgres`, `clean-machine`);
- allow no direct pushes or force pushes.

The card policy is a text check written for one supervised run. It is not a security boundary, and GitHub's protection is what keeps an agent's push off `main` if the policy misses one.

Before `init`, the script writes two machine-layer rules into the temp home:

- `rules.local.lifecycle.json`: `mergeGate.autoMerge: true` (the gate merges on its own once the reviewer approves and checks pass) and `autoEndSettleSeconds: 60`.
- `rules.local.permissions.json`: `rules/examples/hardened.permissions.json`, plus these allows:
  - `edit`;
  - `git add` and `git commit`;
  - `gh pr create`, `gh pr view` and `gh pr diff`.

  It also sets `* --force*` to ask and denies `gh pr merge*`. The rules allow no `git push`, `git switch` or `git checkout`, so every push and branch change becomes a card.

Anything the rules leave at `ask` becomes an `agent.permission` card. The script answers those cards from the card's text, the way the operator would.

A `git push` is allowed only if all of these hold:

- its text has no quotes, backslashes, `$` or backticks;
- its options are only `-u`, `-q`, `-v`, `-n`, `--set-upstream`, `--quiet`, `--verbose`, `--dry-run` or `--porcelain`;
- it names a remote and at least one refspec;
- every refspec is a plain branch name matching `^[A-Za-z0-9._/-]+$`, or `<src>:<dst>` with both sides matching it;
- neither side is `HEAD`, `main` or `master`, after `refs/heads/` is stripped.

So `+`, `:`, `@`, `*`, `~` and `^` refspecs, redirections and any other option all mean a deny.

The script also denies:

- a request whose working directory is outside the repository or the temp home. The policy's canonical `cwd` comes from the card's recommendation, and a card without one is denied;
- any `git` call whose subcommand is quoted or escaped;
- `git switch`, `git checkout`, `git branch` or `git update-ref` that names `main` or `master` (bare or as `refs/heads/…`), or whose text is quoted or escaped;
- any `git -c …` or `git --config-env …` before the subcommand, and any `git config` that sets an `alias.`, since an alias can hide a push;
- `gh pr merge` however it is spaced or flagged, and `gh api` calls to a pull request's `merge` endpoint;
- `--force` anywhere, recursive `rm` in any flag form (`-r`, `-R`, `-rf`, `-fr`, `--recursive`, or `-r` after other flags), `sudo`, `curl`/`wget` and `reset --hard`;
- any absolute path outside the repository or the temp home (including `/` itself), and anything it cannot resolve from the text: a `..` segment, `~`, a `$` variable or substitution, or a backtick.

It allows everything else, and logs every answer. Any other kind of card waits for a person. None came up.

The run below used the first version of this setup. The permission rules allowed `git push *`, and the card policy had only the absolute-path check and the first deny list. The builder's one push was part of a `cd … && …` chain, so it reached a card anyway, and it pushed a feature branch. Under the current policy, that card would have been denied because its PR body quoted code in backticks.

The event excerpts below went through the server's secret redaction (`redactValue`). In the recorded run, the script's own log lines (the `[+Ns]` lines) did not, and were checked by hand for secrets; the script now passes them through `redactSecrets` as well. The proof script then replaced the temp home with `$QD_HOME`, the repository path with `$REPO`, the remote's owner with `<owner>`, email addresses with `<email>` and the API token with `[redacted]`.

## What broke first, and the fix in this PR

The first attempt stopped at step 2. The Planner read the repository and wrote a ticket, but its call to the bus tool `propose` was refused:

```text
planner.reply  "The ticket isn't on the board. Quarterdeck refused permission for my
               `propose` call. It also refused `read` on `tickets` earlier, so I couldn't
               check for a duplicate. …"
```

Claude asks permission for MCP tool calls, and they reach the policy as kind `other`. Under the shipped `rules/permissions.json`, `other` is `ask`. The crew gave every agent it births an `agent.permission` card for `ask`, but it started the Planner without one. So the Planner's `ask`s fell to `refuseCards`, and a live Planner could never put a ticket on the board.

The crew now passes `permissionCards` to `startPlanner`, so the Planner's `ask`s raise cards like every other agent's. Separately, Planner and crew sessions loaded permission layers from the process's home instead of the crew's `homeDir`, so a server started with another `homeDir` (as here) ignored its machine permissions. Both now read the layers from `homeDir`. `packages/server/test/quarterdeck/crew.test.ts` covers both:

- a fake claude-style Planner that asks before `propose` raises a card, and proposes once the card is allowed;
- with `other` allowed in the temp home's machine layer, it proposes with no card.

## Event excerpts

From the second, complete run. Each line is `kind  payload`, in order.

### init and up

```text
[+0s] $ quarterdeck init $REPO --project quarterdeck --name Quarterdeck --runtime claude --no-folder
[+1s] cli: Created project quarterdeck (Quarterdeck) for $REPO
[+1s] cli: Runtime: claude, saved in $QD_HOME/.quarterdeck/rules.local.models.json
[+1s] $ quarterdeck up --port 0
[+1s] cli: Quarterdeck is running at http://127.0.0.1:51612/#token=[redacted]
```

### The Planner proposes one tiny ticket

```text
agent.born       {"name":"stoat","role":"planner","runtime":"claude"}
planner.human    {"seq":1,"text":"Propose exactly one ticket, and nothing else: a one-line documentation fix you find in one of this repository’s README files, …"}
ticket.proposed  {"title":"rules/README: say the hardened layer also allows `think`"}
planner.reply    {"seq":1,"text":"I've proposed one ticket, `ab684187-…`. It's waiting on the board for you to approve, edit or reject. …
                  - **Where:** `rules/README.md`, line 35, under \"A hardened layer\".
                  - **What's wrong:** the line lists what `examples/hardened.permissions.json` allows as \"reads, searches and the bus tools\". The file also allows `think`, and the README leaves it out. …","stopReason":"end_turn"}
ticket.approve   {"status":"applied"}
```

### The round starts; the Driver births a claude builder

```text
round.start            {"status":"pending"}
round.started          {"goal":"Ship the one approved documentation ticket.","round":1}
agent.born             {"name":"gecko","role":"reviewer","runtime":"claude"}
agent.born             {"name":"ferret","role":"driver","runtime":"claude"}
driver.round_started   {"round":1,"notebook":[]}
turn.result            {"seq":1,"result":{"actions":[{"kind":"assign","ticket":"ab684187-…"}],
                        "summary":"Read the board: one open docs ticket (the rules/README `think` fix) with no dependencies, no builders yet and no cards. Assigning it to a new builder."}}
agent.born             {"name":"heron","role":"builder","runtime":"claude"}
agent.worktree_added   {"name":"heron","worktreePath":"$QD_HOME/.quarterdeck/quarterdeck/worktrees/heron-ab684187"}
ticket.assigned        {"born":true,"name":"heron","worktreePath":"$QD_HOME/.quarterdeck/quarterdeck/worktrees/heron-ab684187"}
```

### Permission cards along the way

Seven `agent.permission` cards were raised: three for the builder, three for the reviewer and one for the Driver. Six were allowed. One was denied because it wrote to `/tmp` outside the allowed roots. The reviewer carried on without it and said so in its verdict.

```text
[+61s]  heron asks to run cd $QD_HOME/…/worktrees/heron-ab684187 && git checkout -b docs/hardened-allows-think && sed -i '' '35s/…/' rules/README.md && git diff --stat … -> allow
[+64s]  heron asks to run cd $QD_HOME/…/worktrees/heron-ab684187 && npm ci --silent … && npm run format:check … && npm test … -> allow
[+100s] heron asks to run … git commit -qam "rules/README: say the hardened layer also allows think …" && git push -q -u origin docs/hardened-allows-think … && gh pr create --base main … -> allow
[+113s] ferret asks to run gh pr view 72 --json title,state,files,statusCheckRollup,body && gh pr diff 72 -> allow
[+125s] gecko asks to run git show c393f26:rules/README.md > /tmp/README-pr72.md && npx prettier --check … -> deny
```

### Report, review, gate, merge

```text
ticket.reported         {"pr":"https://github.com/<owner>/quarterdeck/pull/72","head":"c393f26dd5f8a4156c08348062b6a4dbef0f7d61",
                         "notes":"Changes one line in rules/README.md (line 35): … Tested: the diff is 1 line in 1 file; `npm run format:check` passes across the whole repo with Prettier; `npm test` passes (163 test files passed and 4 skipped; 1956 tests passed and 17 skipped)."}
ticket.review_requested {"pr":"https://github.com/<owner>/quarterdeck/pull/72","head":"c393f26…"}
ticket.verdict          {"decision":"approve","head":"c393f26…",
                         "notes":"PR #72 at c393f26 changes one line in one file: rules/README.md line 35. … The new wording matches the ticket word for word, and the rest of the line is unchanged. … I did not run the checks myself. My Prettier run on the file was declined, so I'm relying on heron's report … The merge gate should confirm it is green."}
ticket.gate_waiting     {"reason":"waiting for checks to finish","head":"c393f26…"}
ticket.merged           {"by":"gate","pr":"https://github.com/<owner>/quarterdeck/pull/72","head":"c393f26dd5f8a4156c08348062b6a4dbef0f7d61"}
```

GitHub shows #72 as `MERGED` at 2026-10-02T21:12:00Z, as merge commit `c3de075` on `main`.

### Auto-end and wrap-up

```text
round.settling     {"rearmed":false,"settleSeconds":60}
round.settling     {"rearmed":true,"settleSeconds":60}
agent.status       {"text":"Round 1 goal shipped: PR #72 (rules/README `think`) merged. Nothing else open."}
round.settled      {"settleSeconds":60}
agent.worktree_removed {"name":"heron","discarded":false}
agent.retired      {"name":"heron"}
turn.result        {"seq":7,"result":{"charter":null,
                    "summary":"Shipped the round's one ticket: PR #72 adds `think` to the hardened-layer list in rules/README.md. It was reviewed and merged with no rework and no cards.",
                    "notebook":[
                      {"op":"add","body":"Turn-result actions are only `assign` and `continue`; there is no `end`. Quarterdeck ends a builder itself once its PR merges, so don't look for an end action.", …},
                      {"op":"add","body":"PR checks are three CI jobs: validate, clean-machine and store-postgres. Builders run `prettier --check` on the whole repo and `npm test` (round 1 baseline: 1956 passed, 17 skipped).", …},
                      {"op":"add","body":"A docs-only ticket counts as tested when the ticket says no new tests are needed and Prettier and the existing suite still pass. …", …}]}}
round.wrapped_up   {"round":1,"charterProposal":null,"notebookProposals":["ec2fe282-…","13930db1-…","bda06fdc-…"]}
agent.retired      {"name":"ferret"}
round.ended        {"round":1,"reason":"settled","reopened":[],"closedCards":[],"discardCards":[]}
notebook.decide    {"status":"applied"}   → proposal 13930db1 accepted as notebook entry 6cf7552f
```

### The Data widget shows rows

`data.summary` for the project, right after the round. These are the counts the Data widget lists:

```text
projects 1   rounds 1   agents 4   tickets 1   cards 7   turns 10   events 55
notebook 1   notebook_proposals 3   charter_proposals 0   budget 0   layouts 0   intents 12
```

### Wipe removes them

```text
before wipe: $QD_HOME/.quarterdeck/quarterdeck exists = true
intent wipe.project -> 200 {"result":{"wiped":["quarterdeck"],"stopped":[{"project":"quarterdeck","agent":"stoat"},{"project":"quarterdeck","agent":"gecko"}]}}
intent data.summary -> 404 {"error":"project quarterdeck does not exist"}
after wipe: $QD_HOME/.quarterdeck/quarterdeck exists = false
cli: Stopped.
```

The wipe stopped the two agents still live (the Planner and the reviewer, which outlive a round). Then it deleted the project's rows and folder.

## Seen along the way, not fixed here

- **No `end` action for the Driver.** The charter tells the Driver to end a builder once its PR merges, but its actions are only `assign` and `continue`. The Driver noticed and proposed a notebook entry about it. The builder was retired by the round's cleanup.
- **Seven cards for a one-line change.** The hardened layer allows plain `git status`-style commands, but claude chains commands with `cd … && …`. A command with `&&`, `|` or `>` is never pinned to the repo, so each chain becomes a card.
- **claude.ai connectors reach the agents.** The Planner's reply ended with a note that the account's Gmail, Calendar and Drive connectors were not authorized. `settingSources: []` keeps local settings out, but not the account's connectors.
- **The claude runtime folder ignores `homeDir`.** `CLAUDE_ADAPTER` is built when the module loads, with `~/.quarterdeck/runtimes/claude` as its process folder, so this run used that folder rather than the temp home's. Wipe does not touch runtime folders either way.
- **`repo_path` was a working checkout.** The project pointed at the checkout this PR was written in, and the Planner noticed its uncommitted README changes. Builders still work in their own worktrees from `origin/main`.
