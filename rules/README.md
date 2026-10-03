# Rules

The shipped defaults: `charter.md`, `reviewer.md`, `permissions.json`, `naming.json`, `lifecycle.json`, `models.json`, `env.json` and `kiro.json`. Override any of them with `~/.quarterdeck/rules.local.<file>` (this machine) or `<repo>/.quarterdeck/rules.local.<file>` (one project). The layers, the schemas and the tighten-only rules are described in the [rules docs](../site/public/docs/rules.html); how a permission request is decided is in [the permission policy](../packages/server/src/acp/permissions/README.md).

`examples/` holds layers you can copy into place. They are not loaded unless you copy them.

## Kiro base agents

`kiro.json` names, in `baseAgents`, the Kiro agent the `driver`, `reviewer` and `builder` start from. Each is `null` (no base) by default. The repo layer may set only `baseAgents.builder`, so one project (a component library, say) can give its builders a different agent; anything else there is an error naming the file. How a base is found and merged is in [the runtime adapters README](../packages/server/src/acp/runtimes/README.md#base-agents).

## Shell permissions

Any `execute` allow can amount to arbitrary code. Many programs run other programs when given the right flag, config value or alias (`git -c`, `npm run`, `make`, `find -exec`), and an interpreter (`sh`, `bash`, `zsh`, `node`, `python`, `npx` and the like) runs whatever it is handed. Allowing one of them without a card is allowing anything it can be made to run.

An `execute` pattern is matched against the whole of each command the shell would run. `*` matches any run of characters, spaces and dashes included, and `?` matches any one character. So a pattern is a prefix match: `git *` allows git with any arguments, including `git -c alias.x='!sh' x`, which runs a shell. A command that chains several (`&&`, `||`, `;`, `|`, `&`, newlines) is split, and every part must be allowed on its own.

Allow the subcommands you mean instead: `git status *`, `git diff *`. A pattern ending in ` *` needs something after the space, so list the bare command too (`git status`). Prefer `ask` for the rest, which is the default.

| Pattern        | Command                         | Allowed without a card |
| -------------- | ------------------------------- | ---------------------- |
| `git *`        | `git status`                    | yes                    |
| `git *`        | `git -c alias.x='!sh' x`        | yes                    |
| `git *`        | `git -c core.pager=less push`   | yes                    |
| `git status *` | `git status --short`            | yes                    |
| `git status *` | `git status`                    | no                     |
| `git status`   | `git status`                    | yes                    |
| `git status *` | `git -c core.pager=less status` | no                     |
| `git status *` | `git status && git push`        | no                     |
| `git diff *`   | `git diff --stat`               | yes                    |
| `npm test`     | `npm test -- --watch`           | no                     |
| `bash *`       | `bash -c 'echo anything'`       | yes                    |

Each row is a machine layer holding only that one `execute` allow, with the shipped `default` of `ask`; "no" means you get a card.

The Rules widget and `quarterdeck doctor` warn about every `execute` allow that is a bare command plus a wildcard (`git *`, `*`), names an interpreter (`bash -c *`, `node build.js`) or has no pattern at all, and about a `default` of `allow`.

### A hardened layer

[`examples/hardened.permissions.json`](examples/hardened.permissions.json) allows reads, searches, thinking and the bus tools (`status`, `read`, `ask`, `report`, `verdict`, which reach the policy as kind `other`), plus a short list of read-only commands: `git status`, `git diff`, `git log`, `git show`, `git rev-parse`, `git branch --show-current`, `ls` and `pwd`. It denies `git -c` and `git --config-env`, cards any command that passes `--output`, `--ext-diff` or `--textconv`, and cards everything else. Copy it to `~/.quarterdeck/rules.local.permissions.json` to use it. Allowing `other` also allows any other tool the runtime does not give a kind.
