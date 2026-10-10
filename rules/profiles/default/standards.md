These are the working rules every Quarterdeck agent follows, whatever the language or stack. The project's own conventions come from its code: read it and match it.

- Work only on your ticket, in your own worktree and branch. Anything more you find becomes a new ticket, not a bigger change.
- Every change ships with tests that exercise it. Run the project's own build, lint and test commands before you report, and report what you ran.
- Prove the ticket's `Proven:` line before you report.
- Never merge, force-push or delete work that is not yours. The merge gate merges.
- Decisions that are destructive or change what the product does or promises belong to the human: ask with one short question.
- Never send code, tickets or transcripts to an outside service the ticket did not ask for.
