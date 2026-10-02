# signin

Sign-in is surfaced, never automated around. When a runtime answers `session/new` or `session/prompt` with ACP's auth-required error (`isAuthRequiredError`), Quarterdeck raises a card with the exact command the person runs, waits for them, and then sends the same request again. It never calls `authenticate`.

```ts
import { withSignIn } from '@quarterdeck/server';

const gate = { store, agentId: agent.id, runtime: agent.runtime };
const { sessionId } = await withSignIn(gate, 'session/new', async () =>
  client.newSession({ cwd, mcpServers: [await bus.launch(agent.id)] }),
);
```

`openDriverRound` wraps its `session/new` this way, and `runPrompt` wraps every `session/prompt`, so every Driver session and every turn built on `runTurn` gets it. The bus is launched inside the retried call because a relay token is spent on its first connection.

## The command

| Runtime  | `command`        | What the person does                                                 |
| -------- | ---------------- | -------------------------------------------------------------------- |
| `kiro`   | `kiro-cli login` | Runs it in a terminal and finishes the sign-in.                      |
| `claude` | `claude /login`  | Runs it in a terminal and finishes the sign-in.                      |
| `gemini` | `gemini`         | Runs it, picks a sign-in method, finishes it, then quits Gemini CLI. |

`SIGN_IN_COMMANDS` holds these; `signInCommand(runtime)` reads one.

## The card

`raiseCard` (see [../bus/README.md](../bus/README.md)) inserts a `cards` row for the agent and its active ticket:

| Column           | Value                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `kind`           | `auth.sign_in` (`SIGN_IN_CARD`)                                                          |
| `question`       | Which runtime needs sign-in, the steps with the command, and to answer `Signed in` after |
| `options`        | `["Signed in"]` (`SIGNED_IN`)                                                            |
| `checked`        | The ACP method that failed and the agent's error message                                 |
| `recommendation` | The command, exactly as it is run                                                        |
| `expires_at`     | `SIGN_IN_EXPIRY_MS` (one day) from now, unless the gate sets `expiryMs`                  |

No migration: the card uses the columns `ask` cards use.

## What happens next

| The person                    | Result                                                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Answers `Signed in`           | `agent.auth_resumed` is recorded and the same request is sent again. If the runtime still needs sign-in, a new card is raised.         |
| Declines, or the card expires | `SignInRequiredError` (`runtime`, `command`, `cardId`, `status`), whose message names the command. A turn records it as `turn.failed`. |
| Nothing, and `signal` aborts  | The wait stops with an error and the card stays open.                                                                                  |

A request that fails for any other reason is rethrown untouched and raises no card.

## Events

| `kind`                | Payload                                          |
| --------------------- | ------------------------------------------------ |
| `card.asked`          | `{ cardId }`                                     |
| `agent.auth_required` | `{ cardId, runtime, command, operation, error }` |
| `agent.auth_resumed`  | `{ cardId, runtime, operation }`                 |

`operation` is `session/new` or `session/prompt`. Each carries the agent's id and, when the agent has an active ticket, its id. `card.asked` and `agent.auth_required` are recorded in the transaction that inserts the card.
