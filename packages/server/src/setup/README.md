# setup

What the dashboard's Setup screen calls, and what `quarterdeck init` writes with. The screen opens when `up` starts with no workspace (see [cli](../../../cli/README.md#setup)).

## Intents

All five are ordinary intents on `/api/intents/<name>`, so they need the run's token like every other one. None is recorded.

| Intent          | Input                                                                     | Result                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup.read`    | `{}`                                                                      | `needsSetup` (no project in the workspace and none stored) and `signIns`, every sign-in Setup started with its latest progress.                                                                                                                                                  |
| `setup.detect`  | `path`                                                                    | [`detectWorkspace`](../workspace/README.md) on it: `root`, `mode` and `repositories`. `~/` is the server's home; anything else must be absolute.                                                                                                                                 |
| `setup.tools`   | `root` (optional)                                                         | `runtimes` (all three, installed or not) and `forges` (the forge CLIs the repositories under `root` use), each with `installed`, `signedIn`, doctor's `state` and a `hint`, and `defaultRuntime`.                                                                                |
| `setup.sign_in` | `tool`: `{ kind: 'runtime', runtime }`, `gh`, or `{ kind: 'glab', host }` | Starts `runSignIn(tool)` with no terminal and returns the sign-in at once; `setup.read` reports its progress. One already running for that tool is returned, not started again.                                                                                                  |
| `setup.save`    | `root`, `runtime`, `profile` (optional), `skip` (slugs)                   | Detects `root` again, leaves out `skip`, writes `profile` to `~/.quarterdeck/rules.local.profile.json` (`saveMachineProfile`, through `rules.write`, which refuses a profile not installed), then writes the rest with `applySetup`. Refused with `409` once a workspace exists. |

`setup.tools` needs a `SetupProbe`, which `quarterdeck up` passes to `startQuarterdeck` as `setupProbe`: the CLI's doctor checks (`createSetupProbe`). Without one it answers `501`. `defaultRuntime` is the only installed runtime when there is exactly one, else the Driver's runtime from `models` when that one is installed, else `null`.

Sign-ins live in memory (`createSetupSignIns`), keyed `runtime:<runtime>`, `gh` or `glab:<host>`, and are aborted when the server closes. Each runs with `tty: false` and opens the URL the tool prints in the default browser, as the [sign-in card](../signin/README.md) does.

## Writing a workspace

`applySetup({ stores, homeDir, workspaces }, { root, mode, repos, choice })` is the one place a workspace is written:

1. A runtime other than the default for the machine layer is written first (`rules.write`, `~/.quarterdeck/rules.local.models.json`), so the crew of a project it opens next starts on it.
2. `project.create` for each repository, through the stores it is given: the server's own for Setup, so each project's crew starts at once; fresh ones for `init`, closed after.
3. A repo-layer runtime (`init --folder`) is written after its project exists.
4. `workspaces.add` writes `workspace.json` and tells every open stream.

`setup.save` always saves a non-default runtime on the machine and refuses when a repository's own `rules.local.models.json` would win over it. `init` decides the layer from its flags and prompts, then calls the same function.
