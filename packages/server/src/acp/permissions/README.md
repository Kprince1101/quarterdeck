# ACP permission policy

Answers every `session/request_permission` from the project's permission rules. Pass it to the ACP client as `onPermissionRequest`:

```ts
import { createPermissionPolicy, spawnAcpClient } from '@quarterdeck/server';

const client = await spawnAcpClient(command, {
  clientName: 'quarterdeck',
  clientVersion,
  onPermissionRequest: createPermissionPolicy({
    repoDir: worktree,
    cardHuman: (card) => raisePermissionCard(card),
    onRulesError: (err) => surfaceRulesError(err),
  }),
});
```

The rules are read again for every request through `loadPermissionLayers({ repoDir })` from `@quarterdeck/rules`, so an edit in the Rules widget applies to the next tool call. Tests pass their own `loadLayers`.

## Answers

Each request ends in one of three decisions:

- `allow` selects the agent's `allow_once` option.
- `deny` selects `reject_once`, or `reject_always` if that is the only rejection offered.
- `ask` calls `cardHuman` with the session, the tool call and the request as the policy read it. An `allow` answer selects `allow_once`; a `deny` answer, or a card that fails, selects a rejection. A card that is never answered waits until the turn is cancelled.

The policy never selects `allow_always`, so an agent is never told to trust a tool from then on. If the agent offers no `allow_once`, an allow becomes a rejection. If it offers no rejection, the answer is `cancelled`.

## Failing closed

If loading the rules throws, or the request cannot be read, the answer is a rejection (or `cancelled` when no rejection is offered). The error goes to `onRulesError`. A rules error never reaches the agent as an allow and never cards the human.

## Matching

A rule is `{ kind, pattern?, decision }`. The tool call's `kind` picks the rules; a missing or unknown kind is `other`. The pattern is matched against the request's subjects:

| Kind            | Subjects                                                                                                   | Pattern                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| `execute`       | each command the shell would run, split on `&&`, `\|\|`, `;`, `\|`, `&` and newlines                       | `*` and `?` match any char |
| `fetch`         | the `url` from the raw input                                                                               | path glob                  |
| everything else | every path in `locations`, diff content and the raw input, relative to the repo, or absolute if outside it | path glob                  |

In a path glob `*` and `?` stay inside one path segment, `**` matches across segments, and `**/` matches zero or more leading directories. On macOS and Windows path globs ignore case, as those filesystems do. Shell patterns are always case-sensitive.

A tool call that carries a `command` in its raw input is decided twice, once as its declared kind and once as `execute`, and the stricter answer wins. A tool labelled `read` cannot run a shell command under a read allow.

## Canonical paths

Before subjects or pinning are worked out, every path is resolved to its real location: the repo, each request path, the shell working directory and every shell argument. A leading `~`, `~/` or `~user` is expanded first. The longest prefix that exists on disk goes through `realpath`, and the missing tail is kept, so a new file still resolves. A dangling symlink is followed to its target. A symlink therefore cannot hide a denied file (`innocent.txt -> .env` is decided as `.env`), and it cannot carry a path out of the repo while looking like it is inside. A symlink loop, or any error other than a missing file, fails closed.

For each subject, the strictest matching pattern rule wins. With no matching pattern, the strictest rule for the kind without a pattern applies, then the layer's `default`. The request takes the strictest answer across its subjects. Strictness is `deny`, then `ask`, then `allow`. The order rules are written in does not matter.

If the policy cannot see any subject and a non-allow pattern rule exists for the kind, the answer is at least `ask`.

A `search` that names no path (Claude's Grep or Glob without `path`, for example) searches its working directory, so it is decided with the canonical `cwd` as its one path. A `read` that names no path still has no subject.

Path rules also guard shell commands. When an `execute` is decided, each argument's real path is checked against the `deny` and `ask` pattern rules for `read`, `edit`, `delete` and `move`, in both layers, and the stricter answer wins. With `cat *` allowed and `.env` denied for `read`, `cat .env` is denied, and so is `cat innocent.txt` when it is a link to `.env`.

## Layers

`machine` is `rules/permissions.json` merged with `~/.quarterdeck/rules.local.permissions.json`. The repo layer `<repo>/.quarterdeck/rules.local.permissions.json` is decided separately and the stricter answer wins, so it can only tighten. Its schema accepts only `deny` and `ask`; an `allow` in it is a rules error naming the file.

## Pinned to the repo

An `allow` from the rules becomes `ask` when the request is not pinned to the repo:

- `execute` is pinned only when the command is known, its working directory (`cwd`, `working_dir`, `workdir` or `directory` in the raw input, otherwise the repo) is inside the repo, it has none of `; & | < > $` backticks or newlines, no argument starting with `~` or containing `/` or `..` resolves outside the repo, and no argument's real path is outside the repo.
- `read` and `search` are pinned only when they show at least one path (for a path-less `search`, its working directory) and every path is inside the repo or is named by an `allow` rule of the same kind whose pattern is absolute, such as `{ "kind": "read", "pattern": "/usr/share/**", "decision": "allow" }`. A relative pattern such as `**` can deny or card an outside path but never allow one.
- `edit`, `delete` and `move` are pinned only when they show at least one path and every path is inside the repo. No rule can allow a write outside it.
