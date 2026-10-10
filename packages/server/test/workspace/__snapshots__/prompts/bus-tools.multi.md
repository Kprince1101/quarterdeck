## ask

Ask the person a question that only they can decide. Raises a card on the board and waits until they answer, decline, or the card expires.
Give the question, the options to choose from (omit for a free-text answer), what you already checked, and your recommendation (one of the options when there are options).
Returns JSON {cardId, status, answer}: status answered with their answer, or declined or expired with answer null.
Declined or expired is an answer too: carry on without them, or stop and report.
If this call fails or times out, the card is still on the board: do not ask again. Find it with read on cards filtered by your own agent_id (newest first), or on events where kind is card.asked and agent_id is yours (payload.cardId), and take its status and answer; while status is open, nobody has answered yet.

## propose

Planner only. Propose one ticket: the project it belongs to, a title, a body written as a spec (## Requirements, ## Design, ## Tasks, then a final `Proven:` line), and the ids of tickets it depends on, in any open project.
A proposal that names no active project, or whose body does not follow the spec format, is refused and nothing is stored.
The ticket is stored as proposed in its project. The human approves, edits or rejects it; only approved tickets reach the Driver.
Returns the new ticket id, which later proposals in any project can name in dependsOn.
When the work comes from the project's tracker, pass its id there (a Jira key, a story number) as externalRef; agents see it in their prompts.

## read

Read rows from this project's tables. No SQL: pick a table, columns, filters, order and limit.
Filters are ANDed. Ops by column kind: int, numeric, bool and time take the uuid ops; uuid: eq neq lt lte gt gte in is_null not_null; text: eq neq lt lte gt gte in is_null not_null contains; uuids: contains is_null not_null; json: is_null not_null. `in` takes an array, `is_null`/`not_null` take no value.
Returns a JSON array of rows, newest first unless ordered, at most 200 rows and 100000 bytes.
Tables:
projects(id:uuid, slug:text, name:text, repo_path:text, tracker:json, publishes:bool, archived_at:time, created_at:time, updated_at:time)
voyages(id:uuid, number:int, status:text, goal:text, started_at:time, ended_at:time)
agents(id:uuid, voyage_id:uuid, name:text, role:text, runtime:text, status:text, worktree_path:text, created_at:time, updated_at:time, ended_at:time)
tickets(id:uuid, voyage_id:uuid, assignee_id:uuid, title:text, body:text, status:text, depends_on:uuids, source:text, external_id:text, external_ref:text, pr_url:text, head_sha:text, created_at:time, updated_at:time)
cards(id:uuid, agent_id:uuid, ticket_id:uuid, kind:text, question:text, options:json, checked:text, recommendation:text, status:text, answer:text, created_at:time, answered_at:time, expires_at:time)
turns(id:int, agent_id:uuid, ticket_id:uuid, seq:int, prompt:text, stop_reason:text, input_tokens:int, output_tokens:int, transcript_path:text, started_at:time, ended_at:time)
events(id:int, agent_id:uuid, ticket_id:uuid, kind:text, payload:json, created_at:time)
notebook(id:uuid, voyage_id:uuid, author_id:uuid, body:text, pinned:bool, created_at:time, retired_at:time)
notebook_proposals(id:uuid, voyage_id:uuid, agent_id:uuid, op:text, entry_id:uuid, body:text, pinned:bool, rationale:text, status:text, created_at:time, decided_at:time)
charter_proposals(id:uuid, voyage_id:uuid, agent_id:uuid, body:text, rationale:text, status:text, created_at:time, decided_at:time)
budget(id:uuid, voyage_id:uuid, agent_id:uuid, limit_tokens:int, limit_usd:numeric, spent_tokens:int, spent_usd:numeric, updated_at:time)

## report

Report the pull request for a ticket assigned to you. The ticket moves to in_review and is handed to the reviewer. Report again after pushing new commits; that withdraws any verdict given on the earlier ones.

## status

Set your one-line progress note on the board (at most 200 characters).

## verdict

Reviewer only: give your verdict on a ticket in review. `approve` when its pull request is ready to merge as it stands; the ticket stays in review for the merge gate. `changes` bounces the ticket back to its builder with your notes.