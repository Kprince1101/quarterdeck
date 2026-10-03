# services

What a project's agents use to reach the outside world: its forge and its tracker. Quarterdeck tells agents which tools to use; it never calls the tracker itself. This replaces the [ticket-source plugins](../tickets/README.md#plugins).

## The settings

| Setting     | Where it comes from                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forge`     | Read-only. The [forge](../gate/README.md#forges) detected from the project's `origin` remote, and that remote's host (`detectProjectForge`). No origin reads as GitHub with no host.          |
| `tracker`   | `{ kind, how?, command?, server?, notes? }`. `kind` is free text (`jira`, `github-issues`, `none`). `how` is `cli` (needs `command`) or `mcp` (needs `server`); only `none` may leave it out. |
| `publishes` | `true` for a library whose merged tickets must be published before dependents unblock. Defined here; the Driver does not act on it yet.                                                       |

`tracker` and `publishes` are stored on the project (`projects.tracker` jsonb and `projects.publishes`, from `0025_project_services`) and edited in the dashboard's Project widget. Either can also come from the machine rules layer, `~/.quarterdeck/rules.local.services.json`, keyed by project slug:

```json
{
  "projects": {
    "example": {
      "tracker": {
        "kind": "tracker-mcp",
        "how": "mcp",
        "server": "tracker-mcp",
        "notes": "tickets are stories in the Example board"
      }
    },
    "sample": {
      "tracker": { "kind": "tracker-cli", "how": "cli", "command": "tracker" },
      "publishes": true
    }
  }
}
```

`resolveServices` takes each value from the project row when it is set, then from that project's entry in the rules, then the default (no tracker, `publishes` false), and says which (`project`, `rules` or `default`). A repo layer for `services.json` is an error naming the file: a tracker names a command agents run, so only the machine may set it.

## Intents

| Intent          | Input                               | Result                                                                                          |
| --------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `services.read` | `{ project }`                       | `{ forge, forgeError, tracker, trackerFrom, publishes, publishesFrom, rulesPath }`. Unrecorded. |
| `services.set`  | `{ project, tracker?, publishes? }` | The stored `{ tracker, publishes }`. `null` clears a value so the rules or the default apply.   |

`forge` is `{ forge, host, cli, name }`, or `null` with `forgeError` when the origin's host is not a forge Quarterdeck knows. A bad rules layer answers 409 naming the file.

## The Services section

`promptServices(store, { homeDir, forge? })` joins the detected forge with the resolved tracker (`forge` overrides the detected forge, keeping the host; the crew passes its injected forge), and `servicesSection(services, externalRef)` renders it for a prompt:

```text
# Services

- Forge: GitHub at github.com. Use the `gh` CLI for pull requests, reviews and checks.
- Tracker: tracker-mcp, reached through the `tracker-mcp` MCP server. Notes: tickets are stories in the Example board
- This ticket in the tracker: EX-42
Use these tools yourself. Quarterdeck never calls the tracker for you.
```

A GitLab project reads merge requests and `glab`. A tracker of `none`, or none set, reads `- Tracker: none.` The ticket line appears only when the ticket has an `external_ref`, which the Planner sets with `propose`'s `externalRef`.

Every agent that works a ticket gets it, for that ticket's project. The crew reads it through `CrewRules.services()` each time it builds a prompt, so a setting saved in the Project widget reaches the next prompt without a restart:

| Prompt                                                  | What it shows                                                                                                                                        |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Driver's birth input                                | Under each project in `# Projects`, a `Services:` list (`servicesLines`) with that project's forge and tracker. No ticket line: a voyage spans many. |
| A builder's assignment prompt (`buildAssignmentPrompt`) | `# Services` after `# Where to work`, with the ticket's `external_ref`.                                                                              |
| The reviewer's prompt (`reviewerInput` in the crew)     | `# Services` after `# Review`, with the ticket's `external_ref` (`ticketExternalRef`).                                                               |
