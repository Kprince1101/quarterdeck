# Team quickstart: rules profiles and the files you steer with

Quarterdeck's agents follow two kinds of instruction: how to work a ticket, and the coding standard of your team. The first ships with Quarterdeck. The second is a **rules profile** you choose. A new workspace gets the `default` profile, which is generic and language-neutral: how an agent works a ticket, with no style opinions. Nothing else reaches an agent unless you choose it.

## The files you may edit

Never edit the shipped files in `rules/` in place; Quarterdeck reads your edits from a `rules.local.<file>` next to them (see [the rules docs](../site/public/docs/rules.html#layers)). Put an edit in `~/.quarterdeck/` for every project on this machine, or in `<repo>/.quarterdeck/` for one project. The Rules widget edits the machine layer and shows the repo layer.

| File                                          | What it controls                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rules/charter.md`                            | How the Driver runs a voyage: the crew, the human gates and the lifecycle. Edit it as `rules.local.charter.md`.                                                                      |
| `rules/reviewer.md`                           | The reviewer's rubric: what it reads, what it checks and how it gives a verdict. Edit it as `rules.local.reviewer.md`.                                                               |
| `rules/permissions.json`                      | Which tool calls agents may make without a card. Edit it as `rules.local.permissions.json`; see [shell permissions](../rules/README.md#shell-permissions) before allowing a command. |
| `rules/profile.json`                          | The active profile and your local rule levels. Edit it as `rules.local.profile.json`, or with the profile picker.                                                                    |
| `~/.quarterdeck/profiles/<name>/profile.json` | The profile you chose, if it is not `default`: the standards docs it reads, its rule levels and its repo setup.                                                                      |

The server lists the same files, with their paths on your machine, in the `profiles.steeringFiles` of `GET /api/rules`.

## What an agent reads at kickoff

Every builder's assignment and the reviewer's brief end with the active profile's:

- **Standards**: the profile's standards docs, in order, verbatim.
- **Steering**: the profile's rule levels as a list, generated between `<!-- quarterdeck-steering:start -->` and `<!-- quarterdeck-steering:end -->`. Level 3 is enforced and locked, 2 is enforced with a scoped disable comment allowed, 1 warns, 0 is off.

The `default` profile has a short standards doc and no levels, so its kickoff has no steering block.

## Choosing a profile

```sh
npm run quarterdeck -- profile list
npm run quarterdeck -- profile use <name>
npm run quarterdeck -- profile use <name> --project <slug>
```

`list` marks the active profile and names every file each one reads. `use` writes `~/.quarterdeck/rules.local.profile.json`, or with `--project` the project's `<repo>/.quarterdeck/rules.local.profile.json`, which wins over the machine. Both print the file they wrote. The Rules widget's profile picker does the same for the machine layer: it says which file it writes, and you review the change before it is saved.

To change a rule level for yourself, pick it in the widget's level list or add it to `levels` in `rules.local.profile.json`. Machine levels apply over the profile's. Levels in a project's `<repo>/.quarterdeck/rules.local.profile.json` can only raise a rule's level, never lower it.

## Making your team's profile

A profile other than `default` lives on your machine, never in the repository. Point it at your team's standards docs by path; they are read, not copied:

```sh
npm run quarterdeck -- profile add team \
  --standards ~/work/STANDARDS.md \
  --philosophy ~/work/PHILOSOPHY.md \
  --levels ~/work/levels.json \
  --reviewer ~/work/review-checks.md \
  --description "Our service standard"
npm run quarterdeck -- profile use team
```

It writes `~/.quarterdeck/profiles/team/profile.json` and, with `--reviewer` or `--lifecycle`, copies those files next to it. `levels.json` is a map of rule name to level, `{ "no-print": 3, "max-function-lines": 2 }`. The rule names are your linter's; Quarterdeck only passes them on.

A profile can also set a project up when you run `init` (or `profile setup` later). Add a `setup` to its `profile.json`:

```json
{
  "description": "Our service standard",
  "standards": ["/Users/me/work/STANDARDS.md"],
  "levels": { "no-print": 3 },
  "setup": {
    "install": ["pip", "install", "our-lint"],
    "levelsFile": "lint-levels.json"
  }
}
```

`init` lists each command it would run and each file it would write, then asks. `--setup` agrees without asking and `--no-setup` skips it. The `default` profile has no setup, so `init` on it writes nothing into the repository. If your lint tool writes its own steering block, name it in `setup.steer` and say where it lands with `"steering": { "file": "AGENTS.md", "start": "<marker>", "end": "<marker>" }`; agents then read that block from the repository instead of the generated one.

## Adapting the reviewer rubric and charter to your stack

The shipped reviewer checks what every change needs: it does what the ticket asks, it ships with tests, it is correct and safe, and it reads like the code around it. It says nothing about your language. Add that in the profile, so it reaches the reviewer only on projects that use it:

1. Write the checks your reviewers make by hand, as a short Markdown file. Name the commands and the failure modes, for example:

   ```md
   ## Our stack

   - Run `go vet ./...` and `go test ./...`; a red result is a request for changes.
   - Errors are wrapped with `%w` and returned, never logged and dropped.
   - A new package has a test file next to it.
   ```

2. Add it with `profile add ... --reviewer <file>`, or copy it to `~/.quarterdeck/profiles/<name>/reviewer.md`. It is added after the shipped `reviewer.md`, so the shipped checks still apply.
3. Do the same for the Driver with a `charter.md` in the profile folder: say how your team sizes a ticket, which checks must pass before a ticket is done, and which changes always need a person.
4. Allow your build, test and lint commands by name in `rules.local.permissions.json`, so builders can run them without a card: `{ "kind": "execute", "pattern": "go test ./...", "decision": "allow" }`.
5. To change the shipped text itself rather than add to it, write a `rules.local.reviewer.md` or `rules.local.charter.md`. It replaces the shipped file and the profile's addition whole.

## Checking what an agent read

Switch profiles, start a voyage and open the first turn of a builder or the reviewer: `~/.quarterdeck/<project>/turns/<agent-id>/0001/input.md` is the prompt it was given. Its `# Standards` and `# Steering` sections are the profile's.
