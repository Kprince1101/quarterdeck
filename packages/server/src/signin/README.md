# signin

Quarterdeck shows sign-in to the person and never signs in for them. A runtime may answer `session/new` or `session/prompt` with ACP's auth-required error (`isAuthRequiredError`). Quarterdeck then raises a card with the exact command the person runs, waits for them, and sends the same request again. It never calls `authenticate`.

```ts
import { withSignIn } from '@quarterdeck/server';

const gate = {
  store,
  agentId: agent.id,
  runtime: agent.runtime,
  authMethods: () => client.agent.authMethods,
};
const { sessionId } = await withSignIn(gate, 'session/new', async () =>
  client.newSession({ cwd, mcpServers: [await bus.launch(agent.id)] }),
);
```

Every session Quarterdeck opens and every prompt it sends goes through the gate:

- `openDriverRound` wraps its `session/new`. It launches the bus inside the retried call, because a relay token is spent on its first connection.
- `runPrompt` wraps every `session/prompt`, so every turn built on `runTurn` is covered.
- The Planner wraps its whole connect and `session/new`. After a sign-in, a fresh process and a fresh bus launch replace the old ones, because Kiro writes the bus token into its agent config when it connects. The Planner also wraps every prompt of the conversation. A `planner.new`, or closing the Planner, stops any wait. The message being handled is then refused, and the card stays open.

## The command

`signInCommand(runtime, authMethods?)` picks the command:

1. The agent's own `authMethods` (from its `initialize` reply) come first. The first method with `type: 'terminal'` gives the command: the runtime's invocation, then the method's `args`, with its `env` set in front. Words a shell would split are single-quoted. Any other terminal methods are listed on the card as alternatives.
2. Otherwise each runtime falls back to its own CLI sign-in.

| Runtime  | Invocation for terminal methods                          | Fallback            | What the person does                                                 |
| -------- | -------------------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `kiro`   | `kiro-cli acp`                                           | `kiro-cli login`    | Runs it in a terminal and finishes the sign-in.                      |
| `claude` | `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0` | `claude auth login` | Runs it in a terminal and finishes the sign-in.                      |
| `gemini` | `gemini --acp`                                           | `gemini`            | Runs it, picks a sign-in method, finishes it, then quits Gemini CLI. |

claude-agent-acp advertises `--cli auth login --claudeai` and `--cli auth login --console`. The card for claude therefore reads `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --claudeai`, which works whether or not a standalone `claude` is installed. `SIGN_IN_RUNTIMES` holds the invocations and fallbacks.

## The card

The card is a `cards` row for the agent and its active ticket, inserted with `insertCard` from the `ask` plumbing (see [../bus/README.md](../bus/README.md)):

| Column           | Value                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `kind`           | `auth.sign_in` (`SIGN_IN_CARD`)                                                                            |
| `question`       | Which runtime needs sign-in, the steps with the command, any alternatives, and to answer `Signed in` after |
| `options`        | `["Signed in"]` (`SIGNED_IN`)                                                                              |
| `checked`        | The ACP method that failed and the agent's error message                                                   |
| `recommendation` | The command, exactly as it is run                                                                          |
| `expires_at`     | `SIGN_IN_EXPIRY_MS` (one day) from now, unless the gate sets `expiryMs`                                    |

No migration: the card uses the columns `ask` cards use.

### One card per runtime

A sign-in is per machine, not per agent. If the project already has an open, unexpired `auth.sign_in` card for the same runtime, a second agent does not raise another. It records its own `agent.auth_required` with that card's id and waits on that card until the card's own `expires_at`, so the person answers once. Looking for an open card and inserting a new one happen in one transaction under an advisory lock keyed on the project and runtime. Two agents that hit auth-required together therefore still share one card.

## What happens next

| The person                    | Result                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answers `Signed in`           | Each waiting agent records `agent.auth_resumed` and sends its request again. If the runtime still needs sign-in, a new card is raised.                                          |
| Declines, or the card expires | `SignInRequiredError` (`runtime`, `command`, `cardId`, `status`), whose message names the command. A turn records it as `turn.failed`; the Planner refuses the message with it. |
| Nothing, and `signal` aborts  | The wait stops with an error and the card stays open.                                                                                                                           |

A request that fails for any other reason is rethrown untouched and raises no card.

## Events

| `kind`                | Payload                                          |
| --------------------- | ------------------------------------------------ |
| `card.asked`          | `{ cardId }`, only when a card is inserted       |
| `agent.auth_required` | `{ cardId, runtime, command, operation, error }` |
| `agent.auth_resumed`  | `{ cardId, runtime, operation }`                 |

`operation` is `session/new` or `session/prompt`. Each event carries the agent's id and, when the agent has an active ticket, the ticket's id. The `card.asked` and `agent.auth_required` events are recorded in the same transaction that inserts the card or joins it.
