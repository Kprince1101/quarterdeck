# signin

A runtime may answer `session/new` or `session/prompt` with ACP's auth-required error (`isAuthRequiredError`). Quarterdeck then starts the runtime's own browser sign-in itself, shows its URL and code on a "Sign in to <runtime>" card while it runs, and sends the same request again once it succeeds. Only if that sign-in fails does the card turn into the command for the person to run, saying why. Quarterdeck never sees or stores a token; the runtime keeps its credentials where it always does.

```ts
import { withSignIn } from '@quarterdeck/server';

const gate = {
  store,
  agentId: agent.id,
  runtime: agent.runtime,
  authMethods: () => client.agent.authMethods,
  signIn: () => client.signIn,
};
const { sessionId } = await withSignIn(gate, 'session/new', async () =>
  client.newSession({ cwd, mcpServers: [await bus.launch(agent.id)] }),
);
```

`signIn` returns the [sign-in driver](../acp/runtimes/README.md#signing-in) for the runtime. Clients from `PLANNER_ADAPTERS` carry one as `client.signIn` (`withRuntimeSignIn`), and every gate below passes it. A gate without a driver (a test's adapter, for instance) skips straight to the command card, as before.

## The automated sign-in

1. The gate raises the card, or joins the open one (see [One card per runtime](#one-card-per-runtime)). A joining agent only waits on it.
2. The agent that raised it runs the driver with no terminal (`tty: false`). Each step the driver reports is written to the card's `sign_in` column: `starting`, then `waiting` with the `url` and `code` the runtime printed, then `signed_in` or `failed` with `message`. The URL is opened in the server's default browser (`openInBrowser`, or the gate's `openUrl`) unless the runtime opens it itself.
3. On success the gate answers the card `Signed in` itself, records `agent.auth_resumed` with `via` (how it signed in), and sends the request again. Every agent waiting on the card resumes too.
4. On failure the card becomes the [command card](#the-card), with `checked` set to `Automatic sign-in failed: <why>` and the options `Retry` and `Signed in`. Either answer sends the request again; if the runtime still needs sign-in, the driver runs again.
5. If the runtime still answers auth required right after a successful sign-in, the gate does not run the driver again in a loop. It shows the command card at once, with why: `<runtime> signed in but still answered auth required`.

Declining the card while the sign-in runs ("Cancel sign-in" on the dashboard), or the card expiring, stops the driver and its process, and the request fails with `SignInRequiredError`. Aborting the gate's `signal` stops the driver too; the card then stays open as before.

Every session Quarterdeck opens and every prompt it sends goes through the gate:

- `openDriverVoyage` wraps its `session/new`. It launches the bus inside the retried call, because a relay token is spent on its first connection.
- `runPrompt` wraps every `session/prompt`, so every turn built on `runTurn` is covered.
- The Planner wraps its whole connect and `session/new`. After a sign-in, a fresh process and a fresh bus launch replace the old ones, because Kiro writes the bus token into its agent config when it connects. The Planner also wraps every prompt of the conversation. A `planner.new`, or closing the Planner, stops any wait. The message being handled is then refused, and the card stays open.

## The command

The command is the fallback: it is on the card from the start (hidden by the dashboard while the automated sign-in runs) and is what the person runs when that sign-in fails or there is no driver. `signInCommand(runtime, authMethods?)` picks it:

1. The agent's own `authMethods` (from its `initialize` reply) come first. The first method with `type: 'terminal'` gives the command: the runtime's invocation, then the method's `args`, with its `env` set in front. Words a shell would split are single-quoted. Any other terminal methods are listed on the card as alternatives.
2. Otherwise each runtime falls back to its own CLI sign-in.

| Runtime  | Invocation for terminal methods                          | Fallback            | What the person does                                                 |
| -------- | -------------------------------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `kiro`   | `kiro-cli acp`                                           | `kiro-cli login`    | Runs it in a terminal and finishes the sign-in.                      |
| `claude` | `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0` | `claude auth login` | Runs it in a terminal and finishes the sign-in.                      |
| `gemini` | `gemini --acp`                                           | `gemini`            | Runs it, picks a sign-in method, finishes it, then quits Gemini CLI. |

claude-agent-acp advertises `--cli auth login --claudeai` and `--cli auth login --console`, because the client advertises `clientCapabilities.auth.terminal`. The card for claude therefore reads `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli auth login --claudeai`, which works whether or not a standalone `claude` is installed. `SIGN_IN_RUNTIMES` holds the invocations and fallbacks.

## The card

The card is a `cards` row for the agent and its active ticket, inserted with `insertCard` from the `ask` plumbing (see [../bus/README.md](../bus/README.md)):

| Column           | While the automated sign-in runs                                                           | After it fails, or with no driver                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `kind`           | `auth.sign_in` (`SIGN_IN_CARD`)                                                            | the same                                                                                                                |
| `question`       | `Sign in to <runtime>`                                                                     | Which runtime needs sign-in, the steps with the command, any alternatives, and to answer `Signed in` (or `Retry`) after |
| `options`        | `[]`                                                                                       | `["Retry", "Signed in"]` (`RETRY_SIGN_IN`, `SIGNED_IN`) after a failure; `["Signed in"]` with no driver                 |
| `checked`        | The ACP method that failed, the agent's error, and that Quarterdeck is running the sign-in | `Automatic sign-in failed: <why>` after a failure; the ACP method and error with no driver                              |
| `recommendation` | The command, exactly as it is run                                                          | the same                                                                                                                |
| `sign_in`        | `{ status, url?, code?, message? }`, updated live                                          | `{ status: 'failed', message }` after a failure; `null` with no driver                                                  |
| `expires_at`     | `SIGN_IN_EXPIRY_MS` (one day) from now, unless the gate sets `expiryMs`                    | the same                                                                                                                |

`sign_in` is the one column sign-in cards add (migration `0027_card_sign_in`). It reaches the dashboard on the card's row as `signIn` (`signInStateSchema` in the stream schema), and the [Cards widget](../../../dashboard/README.md#the-cards-widget-sign-in) renders it: the status, the code to type, the URL as a link, and a "Cancel sign-in" button while it runs; the command with `Retry` and `Signed in` once it has failed. It holds only the URL, the code and Quarterdeck's own status text, never the tool's raw output.

### One card per runtime

A sign-in is per machine, not per agent. If the project already has an open, unexpired `auth.sign_in` card for the same runtime, a second agent does not raise another. It records its own `agent.auth_required` with that card's id and waits on that card until the card's own `expires_at`, so the person answers once. Looking for an open card and inserting a new one happen in one transaction under an advisory lock keyed on the project and runtime. Two agents that hit auth-required together therefore still share one card.

## What happens next

| The person                     | Result                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Answers `Signed in` or `Retry` | Each waiting agent records `agent.auth_resumed` and sends its request again. If the runtime still needs sign-in, a new card is raised and the automated sign-in runs again.     |
| Declines, or the card expires  | `SignInRequiredError` (`runtime`, `command`, `cardId`, `status`), whose message names the command. A turn records it as `turn.failed`; the Planner refuses the message with it. |
| Nothing, and `signal` aborts   | The wait stops with an error and the card stays open.                                                                                                                           |

A request that fails for any other reason is rethrown untouched and raises no card.

## Events

| `kind`                | Payload                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `card.asked`          | `{ cardId }`, only when a card is inserted                                                                                                          |
| `agent.auth_required` | `{ cardId, runtime, command, operation, error }`                                                                                                    |
| `agent.auth_resumed`  | `{ cardId, runtime, operation, via? }`; `via` says how the automated sign-in signed in (`ACP authenticate kiro-login`, the terminal command it ran) |

`operation` is `session/new` or `session/prompt`. Each event carries the agent's id and, when the agent has an active ticket, the ticket's id. The `card.asked` and `agent.auth_required` events are recorded in the same transaction that inserts the card or joins it.
