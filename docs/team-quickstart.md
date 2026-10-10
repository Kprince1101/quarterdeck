# Team quickstart

Quarterdeck runs a crew of coding agents from one board on your own machine. You describe the work to a **Planner**, approve the tickets it proposes, and press **Start Voyage**: a **Driver** hands each ticket to a **builder**, the builder opens a pull request (a merge request on GitLab), a **reviewer** reads it, and Quarterdeck merges it once you say so. It stops and asks you, with a **card** on the dashboard, whenever an agent wants to do something your rules do not already allow.

This page takes you from nothing to a first voyage. Pick the track for your setup; you do not need any other document.

- [Track A: Claude Code](#track-a-claude-code), on a Claude subscription or on Google Vertex AI, with repositories on GitHub.
- [Track B: Kiro on GitLab](#track-b-kiro-on-gitlab), with repositories on gitlab.com or your own GitLab host.

Both tracks have the same four steps: install, up, the Setup screen, a first voyage. In the commands below, `https://github.com/<owner>/quarterdeck.git` is this repository: copy the clone URL from its GitHub page.

## Track A: Claude Code

### 1. Install

You need Node.js 22 or later, git, and the GitHub CLI, `gh` (`brew install gh` on macOS; elsewhere see the [gh install docs](https://github.com/cli/cli#installation)). Setup signs `gh` in; use the account that can push to your repositories.

```sh
git clone https://github.com/<owner>/quarterdeck.git && cd quarterdeck
npm install
npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli --version
```

`npm install` installs and builds Quarterdeck. The third line fetches the Claude Code agent Quarterdeck runs (about 240 MB, once); you do not need a separate `claude` install. Quarterdeck is not on npm: the `quarterdeck` package there is someone else's, so never install it or run Quarterdeck through `npx quarterdeck`.

Then choose how Claude signs in. This is per machine, never per project.

- **Subscription** (Claude Pro or Max, the default): nothing to set. Setup signs you in with Claude Code's own claude.ai login in your browser.
- **Vertex AI**: Claude must be enabled for your Google Cloud project in Vertex AI. Sign gcloud in once, then set these in the shell you start Quarterdeck from (put them in your shell profile to keep them):

  ```sh
  gcloud auth application-default login
  export QUARTERDECK_CLAUDE_AUTH=vertex
  export ANTHROPIC_VERTEX_PROJECT_ID=<your-gcp-project-id>
  export CLOUD_ML_REGION=<region, for example us-east5>
  ```

  Instead of `QUARTERDECK_CLAUDE_AUTH`, you can write `{ "auth": "vertex" }` to `~/.quarterdeck/claude.json`; the two `export`s are still needed. If you use them, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUDSDK_CONFIG` and `ANTHROPIC_VERTEX_BASE_URL` are passed to the agents too. Nothing else from your environment is. There is no claude.ai sign-in in this mode.

### 2. Up

From the clone:

```sh
npm run quarterdeck -- up
```

It prints `Quarterdeck is running at http://127.0.0.1:4317/#token=…`. Open that URL exactly as printed. The `#token=` part is new on every start, and nothing gets in without it. Leave `up` running; Ctrl+C stops it and every agent it started.

### 3. The Setup screen

The first time, the dashboard opens on Setup, five steps on one page:

1. **Workspace.** Paste the full path of the folder you want to work in (`~/` works). A git repository is used on its own. For a folder of repositories, each one becomes a project; untick any you do not want.
2. **Runtime.** Pick **Claude Code**. If it says not installed, run the `npx` line from step 1 and check again.
3. **Profile.** Keep `default` unless your team has made its own (see [Rules profiles](rules-profiles.md)).
4. **Sign in.** Press **Sign in to Claude Code** (subscription only) and **Sign in to GitHub (gh)** for anything not signed in yet. Each opens your browser; the step shows the code to enter and turns green when it is done.
5. **Go.** It lists the files it writes, all under `~/.quarterdeck/`, then opens the board.

### 4. A first voyage

See [A first voyage](#a-first-voyage), the same on both tracks.

## Track B: Kiro on GitLab

### 1. Install

You need Node.js 22 or later, git, the Kiro CLI and the GitLab CLI:

```sh
curl -fsSL https://cli.kiro.dev/install | bash   # kiro-cli
brew install glab                                  # on macOS; elsewhere see https://gitlab.com/gitlab-org/cli#installation
git clone https://github.com/<owner>/quarterdeck.git && cd quarterdeck
npm install
```

`npm install` installs and builds Quarterdeck. Quarterdeck is not on npm: the `quarterdeck` package there is someone else's, so never install it or run Quarterdeck through `npx quarterdeck`.

**On a self-hosted GitLab**, tell Quarterdeck your host is GitLab before you start it. This is the one line it needs; use your host name as it appears in your repositories' `origin` URLs:

```sh
mkdir -p ~/.quarterdeck && echo '{ "forges": { "gitlab.example.com": "gitlab" } }' > ~/.quarterdeck/rules.local.forges.json
```

Repositories on `gitlab.com` need nothing; an unmapped host is an error that names it.

### 2. Up

From the clone:

```sh
npm run quarterdeck -- up
```

It prints `Quarterdeck is running at http://127.0.0.1:4317/#token=…`. Open that URL exactly as printed. The `#token=` part is new on every start, and nothing gets in without it. Leave `up` running; Ctrl+C stops it and every agent it started.

### 3. The Setup screen

The first time, the dashboard opens on Setup, five steps on one page:

1. **Workspace.** Paste the full path of the folder you want to work in (`~/` works). A git repository is used on its own. For a folder of repositories, each one becomes a project; untick any you do not want.
2. **Runtime.** Pick **Kiro** (it is the default, and picked for you when it is the only runtime installed).
3. **Profile.** Keep `default` unless your team has made its own (see [Rules profiles](rules-profiles.md)).
4. **Sign in.** Press **Sign in to Kiro** and **Sign in to GitLab on `<your host>` (glab)** for anything not signed in yet. Each opens your browser; the step shows the code to enter and turns green when it is done. If Kiro's sign-in does not open a browser, run `kiro-cli login` in a terminal and come back.
5. **Go.** It lists the files it writes, all under `~/.quarterdeck/`, then opens the board.

Everything on GitLab says merge request, and agents use `glab`.

### 4. A first voyage

See [A first voyage](#a-first-voyage) below.

## A first voyage

The board opens with a **What to do first** panel:

1. **Describe the work** in the **Planner** widget, in a sentence or two: "Add a health check endpoint that returns the build version."
2. The Planner asks to propose tickets: a card appears in **Cards**. Allow it. Its proposals appear on the **Board**, each a short spec with requirements, design, tasks and how it will be proven. **Approve** the ones you want (edit or reject the rest).
3. Press **Start Voyage**. The Driver assigns each approved ticket to a builder, which works in its own git worktree, never in your checkout.
4. **Answer cards as they come.** Out of the box, agents may read and search freely, and everything else (editing a file, running a command) asks you first. When you trust a command, allow it for good: in the **Rules** widget, open `permissions.json` and add `{ "kind": "execute", "pattern": "npm test", "decision": "allow" }` to its `rules`. It saves to `~/.quarterdeck/rules.local.permissions.json`, and the list you save replaces the shipped one whole, so keep the shipped rules in it.
5. The builder opens the pull or merge request, the reviewer reads it, and when your checks pass Quarterdeck asks once more with a **merge** card. Answer **merge** and it squash merges. The voyage ends by itself two minutes after nothing is left open, or press **End voyage** on the Board.

The **Agents**, **Events** and **Pull and merge requests** widgets show what each agent is doing. Start small: one ticket on a branch you do not mind.

## Your data and security

Quarterdeck runs only on your machine and sends nothing anywhere: no account, no hosted service, no telemetry. It holds no API keys: Claude Code, Kiro, gh and glab keep their own sign-ins where they always do, and on Vertex the agents use your gcloud credentials. What your agents send to their model and what they push goes through those tools, signed in as you. The dashboard listens on `127.0.0.1` only and needs the token from the URL, which is new on every start. Anything shaped like a secret (Anthropic and GitHub keys and tokens, cloud access keys, private keys, bearer tokens, passwords in URLs) is replaced with `[redacted]` before Quarterdeck stores it. Everything it stores is in one folder, `~/.quarterdeck/`: to remove it all, stop `up`, delete that folder, and run `git worktree prune` in each repository you used. The dashboard's **Data** widget lists every file and table, and wipes one project or all of them.

## If something is wrong

1. **Run `npm run quarterdeck -- doctor`** from the clone. It checks each runtime, gh and glab (for each GitLab host you use) and the Claude auth mode, signs in what it can, and prints the exact command for anything left.
2. **Setup says Claude Code is not installed:** run `npx --yes @agentclientprotocol/claude-agent-acp@0.85.0 --cli --version`, then check again.
3. **A sign-in card on the dashboard:** an agent found its runtime signed out. Press its button, or run the command the card names, then continue.
4. **Vertex launches fail:** `doctor`'s `claude auth` line names the variable that is missing. Set it in the shell and start `up` again from there.
5. **"Unknown forge" naming a host:** add that host to `~/.quarterdeck/rules.local.forges.json` as in Track B, then start `up` again.
6. **The dashboard shows nothing or every request fails:** open the URL from the latest `up` again; an old tab has an old token.
7. **"Quarterdeck is not built":** run `npm install` in the clone. Do the same after every `git pull`.
8. **Start over:** stop `up` and run `npm run quarterdeck -- wipe --all`, which deletes every project and keeps your rules files; or delete `~/.quarterdeck/` to forget everything. Either way, Setup opens again on the next `up`.
