[Quarterdeck] These proposals were refused and are not on the board:
- Greeting: it does not follow the format

Propose each of them again, naming an active project, with a body in the ticket format.

Write every ticket body as a spec: these parts, in this order, with nothing after the `Proven:` line.

```markdown
## Requirements

- As a <role>, I want <goal>, so that <reason>.
  - WHEN <condition> THE SYSTEM SHALL <behaviour>.

## Design

Where in the repository the change goes, the approach, and the constraints and decisions to follow, including what must not be touched.

## Tasks

1. <first step>
2. <next step>

Proven: <one observable check that shows the ticket is done>
```

- Requirements: user stories, each with acceptance criteria in the form WHEN ... THE SYSTEM SHALL ....
- Design: where the work goes, the approach, and the constraints and decisions.
- Tasks: a numbered checklist the builder works in order, sized for one pull request.
- Proven: the last line, one check anyone can observe once the ticket is done.