# Workspace

The workspace is the one folder a teammate points Quarterdeck at. It decides whether Quarterdeck is a single-repository tool for them or works several repositories as projects.

- **single**: the folder is itself a git repository. Nothing anywhere mentions projects, other repositories, cross-project dependencies or publishing; prompts and the dashboard say "repository".
- **multi**: the folder holds git repositories one level down, and each one is a project. One voyage may touch several. This is how Quarterdeck worked before QD35, and it is unchanged.

## The record

`~/.quarterdeck/workspace.json`, mode `0600`, next to `layout.json` and `pause.json`. There is no global database, so it is a file, not a table.

```json
{
  "root": "/home/me/Developer/Repos",
  "mode": "multi",
  "projects": [
    {
      "slug": "ui-kit",
      "name": "ui-kit",
      "repoPath": "/home/me/Developer/Repos/ui-kit",
      "repository": "github.com/acme/ui-kit"
    }
  ],
  "updatedAt": "2026-10-10T12:00:00.000Z"
}
```

`repository` is the `origin` remote as `host/owner/name`, or `null` when there is none. A file that is missing or does not parse reads as no workspace, which every reader treats as `multi`, the behaviour before QD35.

## Detection

`detectWorkspace(path, { run? })` answers `{ root, mode, repositories }`: a path with a `.git` is `single` with that one repository; otherwise every child folder with a `.git` (one level down, hidden folders skipped, sorted by name) is a repository and the mode is `multi`. A path that is neither is a 400 `HttpError`. Each repository's slug and name come from its folder (`slugFromFolder`), and `repository` from `originRepository` / `parseRemoteUrl`. `confirmationList(detection)` gives the numbered lines `init` prints for the user to untick. Both are exported from `@quarterdeck/server` so a server-side setup screen can call them.

## Changes

`mergeWorkspace(current, { root, mode, projects })` adds repositories, skipping any already there by path or slug. A `single` workspace that gains a second repository, or a folder of repositories, becomes `multi` and the change carries `notice`, the one line both `init` and the dashboard show: `Workspace switched to multi mode: it now has N repositories, and each one is a project.` It never switches back by itself.

`createWorkspaces(home)` is what the server holds: `read()` (read once, then kept in memory), `mode()`, `seed(projects)`, `add(addition)`, `remove(slugs)` and `subscribe(listener)`. Writes run one at a time and go through a temporary file renamed over `workspace.json`; `add` and `remove` re-read the file first, so a repository an `init` added while the server was up is kept. The server's mode itself is read once: an `init` that switches the workspace while the server is up takes effect in prompts at the next `up`.

- `quarterdeck init` adds what it detected (see [the CLI](../../../cli/README.md#init)).
- `project.create` through the API adds its repository as a single one, so a dashboard action that adds a second repository switches the workspace with the notice in its result (`{ workspace: { mode, notice } }`) and on the stream.
- `wipe.project` and `wipe.all` drop the wiped projects; the mode stays.
- `startApiServer({ openProjects: true })` seeds the file once when it does not exist, from the open projects with a repository: one is `single`, more are `multi` under their common parent folder.

The API answers `workspace.read` with `{ workspace }`, and every stream sends it in its snapshot and as a `workspace` message after each change (see [stream](../stream/README.md#protocol)).

## Prompts

The mode reaches every prompt through `CrewRules.mode()` / `MachineRules.mode()` (the `mode` option of `startCoordinator` and `startCrew`; `startQuarterdeck` passes `workspaces.mode`). The single and multi variants come from the same source, so they cannot drift:

- `workspaceWording(text, mode)` resolves line tags and, in `single`, says repository where the text says project. A line ending in `<!-- multi -->` is kept only in multi mode and one ending in `<!-- single -->` only in single mode; the tag is removed either way. Identifiers are left alone: `project_id`, `` `project` ``, `"project"`, `projects(`, `--project`. It runs over `charter.md` and `reviewer.md` as they load, the Planner brief, the wrap-up instructions and every bus tool description.
- Code-built sections branch on the mode in place: the Driver's birth input (`# Repository` instead of `# Projects`, "the Driver of this repository"), its turn instructions (no `block` or `published` action in single mode), the `[project]` prefix on Driver notes and stuck flags, dependency labels, the reviewer's bus line and the Planner's projects section, decisions and reprompt.
- In single mode the Planner's `propose` needs no `project`: the one active project is implied.

`test/workspace/prompts.test.ts` snapshots every prompt in both modes under `test/workspace/__snapshots__/prompts/` and checks that no single-mode prompt says project.
