# Friday

A local-first AI coding and DevOps assistant that uses [NoTokenLimit](https://notokenlimit.com) as its model provider.

**Current status: Phase 7 (desktop app and hardening).** Friday runs as a Linux desktop app or as a local web app. It works on authorized projects (read, edit, test, commit; each change
approved by you) and on servers (diagnostics, logs, Docker, deployment plans, approved SSH commands with production
safeguards). It remembers durable facts across conversations (project commands and decisions, procedures, your
approved preferences), shows which memories informed each answer, and keeps each project's memory isolated. Every
task ends with a verification report built from Friday's own records. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

- **Desktop app:** 64-bit Linux, or WSL2 with WSLg. Nothing else; Node.js is built in.
- **From source / web app:** Node.js ≥ 22.13 (tested on 22.23) and npm, on Linux, macOS or WSL2. Friday uses Node's
  built-in SQLite, so there are no native modules to compile.
- A NoTokenLimit API key

## Desktop app

### Install

Build the packages (or use ones built for you):

```bash
npm install
```

```bash
npm run dist:desktop
```

This writes `apps/desktop/release/Friday-<version>-x86_64.AppImage` and `apps/desktop/release/friday_<version>_amd64.deb`.

- **AppImage:** `chmod +x Friday-*.AppImage`, then run it. It needs FUSE and the usual desktop libraries; on WSL or a
  minimal system install them with `sudo apt install libfuse2t64 libnss3 libasound2t64 libgtk-3-0 libxss1 libxtst6`.
  Without FUSE, run it as `./Friday-*.AppImage --appimage-extract-and-run`.
- **deb (Debian/Ubuntu):** `sudo apt install ./friday_<version>_amd64.deb`, then start **Friday** from the app menu or
  run `friday`.

To try the desktop shell from a source checkout without packaging, run `npm run desktop`.

### Configure

On first launch Friday creates `~/.config/Friday/friday.env`, readable by you only. Use **Friday › Show Config File**
(or **Settings › Show config file**), set `NTL_API_KEY=` to your key, save, then click **Restart server** in Settings
(or **Friday › Restart Server**). Pick a model and test the connection as described in [First run](#first-run).
Never paste a key into the chat.

| What                         | Where                                                             |
| ---------------------------- | ----------------------------------------------------------------- |
| Config (API key, model, …)   | `~/.config/Friday/friday.env`                                     |
| Data (conversations, memory) | `~/.config/Friday/data/` (`FRIDAY_DATA_DIR` overrides it)         |
| Server log                   | `~/.config/Friday/logs/server.log` (**Friday › Open Server Log**) |

`npm run desktop` from a checkout uses the repository's `.env` and `.data/` instead, so it shares history with the web
version. Only one Friday server can use a data folder at a time.

### How it is put together

The window is a sandboxed Chromium page with no Node.js access. It talks to the same local server as the web version,
which the app starts on a random loopback port. Every request carries a secret generated at launch, added outside the
page, so other programs and users on the machine cannot drive the agent. The page can ask the app for exactly four
things: a native folder picker, a server restart, showing the config file, and bringing the window to the front when
you click a notification. Links to other sites open in your
browser. Details: [docs/SECURITY.md](docs/SECURITY.md#threats-addressed-in-phase-7-desktop-app-and-hardening).

## Setup (web app from source)

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env` and set `NTL_API_KEY`. You can also set `NTL_MODEL` to a model ID, or choose a model later in **Settings**.
The key is read only by the local server process. It is never stored in the database, sent to the browser, or logged.

## Run

Development (API on `127.0.0.1:4317`, UI on `http://localhost:5173` with hot reload):

```bash
npm run dev
```

Production-style (the server serves the built UI at `http://127.0.0.1:4317`):

```bash
npm run build
```

```bash
npm start
```

### First run

1. Open **Settings**. It shows whether `NTL_API_KEY` is configured.
2. Pick a model from the list and click **Use selected model**.
3. Click **Test connection**. This sends one tiny completion and is the only check that confirms both your key and your
   plan's access to the model. NoTokenLimit's `/models` endpoint returns its public catalog and does not validate the key.
4. Optionally click **Probe capabilities** to verify streaming and tool calling for that model (two tiny requests).

## Projects

1. In the sidebar, click the **Add project** icon and enter the absolute path of a project folder (in the desktop app,
   **Browse…** opens a folder picker).
   Adding it authorizes Friday to **read** inside that folder only. Broad locations (`/`, your home folder, system
   directories, whole drives) are refused.
2. Conversations started while a project is selected are bound to it permanently; tools can only see that project.
   "No project (chat only)" conversations have no file access.
3. The side panel shows the agent's plan, the files changed in this conversation (each with **Undo**), and a
   read-only file explorer.

## Approvals

Reading is automatic. These need your approval, one action at a time, unless they fall within a
[task permission](#task-permissions) you approved:

| Tool                | What you review                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `edit_file`         | Diff of exact-string replacements in an existing file                                                                                                                    |
| `write_file`        | Diff for a new file or a full rewrite                                                                                                                                    |
| `delete_file`       | The file's contents being removed (a backup is kept)                                                                                                                     |
| `move_file`         | Source and destination (never overwrites)                                                                                                                                |
| `edit_files`        | Several files changed as one all-or-nothing step, one diff per file                                                                                                      |
| `git_commit`        | Branch, HEAD, exact message, the files and diffs being committed, and any hooks that will run. Only the listed paths are committed; nothing is pushed                    |
| `git_create_branch` | New branch name and starting commit                                                                                                                                      |
| `run_command`       | Exact command (argv, or `/bin/sh -c` script when shell features are needed), working directory, timeout, network expectation, environment variable names, and risk notes |

- **Approve once**, **Reject** (optionally with a note telling Friday what to do instead), or **Cancel run**.
  There is no "always allow": the widest approval is a task permission, which ends with the task.
- Requests expire after 15 minutes (`FRIDAY_APPROVAL_TTL_MS`). An expired request never runs.
- Each approval is bound to a hash of the exact action and the file state you reviewed. If the file changes before
  the action runs, it is **not** executed (marked _stale_) and Friday must re-read and propose again.
- By default commands run as your user on this machine. **That is not a sandbox.** stdin is closed, `CI=1` is set,
  and only a small allowlist of environment variables is passed (no API keys or tokens). For untrusted code, turn on
  the [command sandbox](#command-sandbox).
- **Undo** restores a file only if it is still exactly as Friday left it; it never overwrites your later edits.
  **Roll back this run** on a verification report undoes all of a task's file changes, newest first, and does nothing
  if any of them was edited since.

### Command sandbox

Per project (sidebar › **Project settings**, next to the project picker), Friday can run commands in a throwaway Docker
container instead of on your machine. The container:

- sees only the project folder (writable, so tests and builds work), mounted at `/workspace`;
- has credential files and folders hidden (`.env`, keys, `.aws/` …, found even when git-ignored) and `.git` mounted
  read-only, so nothing can plant git hooks that later run on your machine;
- gets no network by default (you can allow outbound network per project), no Docker socket, and none of your
  environment variables;
- runs as your user id with all Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem with a
  private `/tmp`, CPU, memory and process limits, and is removed when the command ends (or times out).

Every command still needs your approval, and the card says where it will run. The setting is yours: Friday cannot
switch it, and changing it after a card was shown makes that card stale. Friday never downloads images itself: the
dialog suggests one for the project's stack (e.g. `node:22-bookworm-slim`), shows whether it is present, and has a
**Pull** button. If Docker or the image is missing, commands are refused with that explanation instead of running on
your machine. Commands can still change files in the project folder, so review them as usual. Requires Docker (checked
at startup and from the dialog).

### Documents: PDF, Word, Excel, PowerPoint

Ask Friday for a report, plan, roadmap, overview or status deck and it writes the file into the project:

| Format     | Tool                  | How Friday writes it                                                                       |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------ |
| PDF / Word | `create_document`     | Markdown: headings, lists, task lists, tables, code, quotes, links, page breaks            |
| Excel      | `create_spreadsheet`  | sheets of typed columns (text, number, currency, percent, date); frozen, styled header     |
| PowerPoint | `create_presentation` | a title slide, then slides with bullets, a small table, speaker notes, or section dividers |

All four share one clean built-in style. Each file is a normal approved change. The card shows the document's
outline (headings, sheets with their size, or slide titles). The file is generated when you approve, can be undone
from the Changes list, and appears in the file tree. There, and on the card, the desktop app offers **Open** (in your
default app) and the browser version **Download**. PDFs are printed by the same browser as screenshots, with
scripts off and no network: the desktop app's built-in Chromium, or an installed Chrome. Without a browser, Friday
writes Word instead. Spreadsheet values are never written as formulas.

### Screenshots and live preview

- **Screenshots:** Friday can open a page on this machine (for example a dev server it started with `start_process`)
  and look at it with the `screenshot` tool, to check how a UI change actually renders. The result includes the page
  title, HTTP status, console errors, uncaught exceptions and failed requests, and the image is shown in the
  conversation. Only `localhost` / `127.0.0.1` pages, never Friday itself; links, redirects and frames to other
  sites are blocked. It needs no approval, like reading files.
  - The desktop app uses its own built-in Chromium, in a hidden window with a separate, empty session.
  - The browser version uses an installed Chrome, Chromium or Edge, run headless with a throwaway profile. Set
    `FRIDAY_CHROME` to choose one; without a browser, the tool is not offered.
- **Live preview:** the monitor button in the conversation header (or the screen icon next to a running process's
  URL) opens your dev server next to the conversation. It has full, tablet and phone widths, reload, open in
  browser, and **Screenshot to message**, which adds the current page to the message you're writing. The page runs
  sandboxed in its own origin and can reach neither Friday's UI nor, in the desktop app, Friday's launch token.
  Pages that refuse to be framed show blank; open them in the browser instead.
- **Image files:** PNG, JPEG, WebP, GIF and SVG files in the file tree open as images. SVG is shown with scripts
  disabled.

### Connected apps (MCP)

Friday can use your other apps through their MCP servers, the way Claude does. In Settings › **Connected apps**,
add an app with a short name and its MCP server URL (`https://`, or `http://` on localhost), then **Add and sign
in**. Your browser opens the app's sign-in page, and the app sends you back to Friday when you're done. Friday
uses the standard MCP flow: discovery, client registration and PKCE. If an app gives you an access token instead,
paste it in the optional field.

The app's tools are offered to Friday as `mcp__<app>__<tool>`. For each tool you choose how it may be used:

- **Ask every time** (default): an approval card shows the app, the tool, its hints (read-only, may delete) and the
  exact arguments.
- **Allow without asking**: for tools you trust, such as read-only searches.
- **Off**: Friday never sees the tool.

You can also turn a whole app off, sign out, or remove it. Sign-ins and tokens are kept only in Friday's local
database. They are never shown in the UI, the audit log or to the model, and tokens are redacted from tool results.
Tool descriptions and results are treated as data from that app, not instructions. Friday connects only to remote
(HTTP) servers; it does not start local MCP programs.

### Code map

To find its way around large projects without reading files blindly, Friday keeps an index of the definitions in
your code: classes, interfaces, types, functions, methods and constants, with their file, line and signature. It
covers TypeScript/JavaScript, Python, PHP, Go, Rust, Ruby, Java, Kotlin and C#. Two read-only tools use it:

- `code_map` outlines the project, a folder or a file. Large scopes are summarised (names per file, or per folder),
  so the model narrows down step by step.
- `find_symbol` finds where a name is defined (`Class.method` works too), and with `references` the lines that use
  it (whole-word text matches).

The index is built the first time Friday needs it and is stored in the local database. After that only files whose
size or modification time changed are re-read, and changes Friday makes itself are picked up immediately. It follows
the same rules as the file tree (`.gitignore` and dependency folders excluded, credential files skipped). Definitions
are found by per-language patterns, not a compiler, so unusual syntax can be missed; `search_code` still covers
everything else. Project settings › **Code map** shows what is indexed and has a **Rebuild** button. For scale:
about 10,000 source files index in roughly 5 seconds the first time, and a check with nothing changed takes about
1.5 seconds.

### Images and screenshots

Paste a screenshot into the message box (Ctrl+V), drop image files on it, or use the image button, up to 4 per
message. Friday can then look at the actual UI, an error dialog, a photo or a diagram. Images are scaled down in the
app to what models actually read (at most 1568 px per side, about 1.15 megapixels) before upload. They are stored
with the conversation in the local database and shown as thumbnails you can open full size. Friday also has a
`view_image` tool for PNG, JPEG, WebP and GIF files in the project (mockups, screenshots in docs), which runs without
approval like `read_file`. Credential files stay off-limits.

Images are sent to the model provider with the message, and text in an image cannot be redacted, so don't attach
screenshots that show secrets. To save context, only the images of the 3 most recent messages that have any are
re-sent to the model; older ones become a short note. Settings › Model capabilities shows whether the model accepts
images (the probe sends a tiny picture), and a model known not to is refused up front with a clear message.

### Background processes

For commands that keep running (dev servers, `tsc --watch`, test watchers), Friday uses `start_process` instead of
`run_command`. It needs your approval like any command; the card says it keeps running in the background. Friday waits
until the process looks ready (a text you named, or a local URL such as `http://localhost:5173`) and reports the
output. It can then read new output (for example to check for compile errors after an edit) and stop the process
without asking, since stopping only ends something you approved.

Running processes appear in the side panel under **Processes**, with their local URL, a live output view and a
**Stop** button. They run until stopped, or until Friday quits. If Friday crashes, the next start stops anything it
left behind; only processes carrying this Friday instance's marker are touched. Limits: 3 running per project and 8
in total, keeping the last 256 KB of output each. In a sandboxed project the process runs in the container. A dev
server there is reachable only through ports Friday publishes on `127.0.0.1`, which needs the project's sandbox
network turned on.

### Task permissions

A fix usually means edit, test, edit again, test again. Instead of approving each step, you can approve a bounded
permission for the current task:

- **Friday asks for one.** For a multi-step task it may propose a _task permission_: its plan, the exact files it may
  create or edit (a folder written as `src/` covers what is inside), and the exact commands it may run (argv, project
  root, no shell). You approve or reject it like any other action.
- **You grant one while approving.** On an edit or a command, tick _Also allow further edits to these files_ (or
  _re-running this exact command_) before **Approve**. That action's files or command are added to the task's
  permission.

While a permission is active, matching actions are approved automatically and shown as such. They still go through
everything else: the re-check right before running (a changed file makes the action stale), the diff in the
conversation, the change list with **Undo**, the verification report, and the audit log. A banner above the message
box shows how much of it is used and has **Revoke**.

Limits: the current task only (it ends when the run ends), at most 40 actions and 60 minutes (20 and 30 by default).
Never covered: deleting or moving files, credential files, git commits and branches, remote/SSH commands,
production confirmations, shell scripts, commands Friday rates high-risk or network-using, and anything not listed.

### Notifications

Friday shows a system notification when it needs your approval, or when a task that took 15 seconds or longer
finishes, while you are in another window, another app, or another conversation. Clicking it opens that conversation.
It is on by default in the desktop app; in a browser, turn it on in **Settings › Notifications** (the browser asks
for permission). Notifications contain the action's title only (e.g. "Run: npm test").

## Verification reports and resuming

- After a task that proposed actions, Friday adds a **verification report** generated from its records, not from the
  model's answer. Its status is _verified_ (a test/build/lint/type-check command passed after the last file change),
  _failed_ (the last such check failed), _not verified_ (files changed but nothing checked them afterwards), or
  _no file changes_. It also lists the files, commands with exit codes, and commits, and flags files edited outside
  Friday since.
- Progress is checkpointed after every executed action. If the server stops mid-task, the run shows as interrupted
  with its checkpoint. **Resume** gives the model a summary of what was already done (files changed, commands and their
  results, plan) so it continues instead of starting over. Approvals that were pending at the time are cancelled.

### Suggested next steps

After a completed task Friday shows up to five one-click follow-ups under the answer:

- **From Friday's records** (clipboard icon, listed first): fix the failing check (pointing at the first project
  location in its output), run the detected test command when changes were not verified, re-check files edited
  outside Friday, review and commit uncommitted changes, continue with the next plan step, or review proposed memories.
  These come from what actually happened, so they stay correct even when the model's summary is not.
- **From the model** (sparkle icon): up to three ideas it offers with `suggest_next_steps` alongside its final answer.
  They are redacted, and dropped if they repeat a record-based chip. Offering them costs no extra model call.

Clicking a chip just sends its prompt as your next message; anything it leads to still goes through approvals.
Cancelled, failed and blocked runs get no chips.

## DevOps

Read-only, no approval needed:

- `inspect_environment`: OS, CPU, memory, disk space, and versions of Node, PHP, Composer, Python, Git, Docker, Nginx,
  database clients, PM2, Supervisor and Certbot. Environment variables are never included.
- `search_logs`: the tail (last 4 MB) of a project log or of a log file you authorized in **Settings → Log sources**,
  optionally filtered, with secrets redacted.
- `inspect_docker`: containers, images, compose services, container logs, and a reduced `docker inspect` that never
  shows environment variable values.
- `validate_config`: YAML/JSON syntax with line numbers, plus checks for GitHub Actions (missing `runs-on`, unpinned
  actions, script injection, `pull_request_target` checkouts, missing `permissions`) and Docker Compose (privileged
  containers, Docker socket mounts, databases published on all interfaces, hard-coded secrets).

Servers (**Settings → SSH hosts**):

1. Add a host: name, address, user, the path to a private key (or none, to use ssh-agent), and environment
   (development, staging or production). Friday stores only the key's _path_, and never accepts passwords.
2. **Scan host key**, compare the fingerprint with the server's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
   on the server), then trust it. Connections are refused until a key is trusted and fail if the key changes.
3. **Test** connects and runs `true`.

Friday's ssh ignores `~/.ssh/config`, disables password and agent forwarding, and checks host keys strictly against
the keys you trusted for that host. The agent can use:

- `remote_diagnose`: predefined read-only checks (uptime, disk, memory, failed services, service status/journal, log
  tail under `/var/log`, listening ports, `docker ps`, `nginx -t`, PHP version, certificates). Each needs approval.
- `prepare_deployment_plan`: records pre-checks, steps (with where they run, risk, downtime, reversibility, rollback),
  verification, rollback plan, data-loss risk and downtime estimate. Plans that change data must include a backup
  pre-check; staging and production plans must include verification and rollback. Recording runs nothing.
- `remote_command`: any command on a host, with an approval card showing the host, environment, exact command,
  expected impact, downtime, rollback and verification. On **production** hosts a plan must be recorded in the
  conversation first, the approval expires after 5 minutes, and **Approve** stays disabled until you type the host
  name (the server checks it too).

## Memory

Friday keeps four kinds of memory in SQLite (with full-text search):

| Scope       | Holds                                                                  | Visible in                                              |
| ----------- | ---------------------------------------------------------------------- | ------------------------------------------------------- |
| user        | Your preferences (only after you approve them)                         | Every conversation                                      |
| project     | Architecture, stack, commands, decisions, known issues                 | That project's conversations only                       |
| session     | This conversation's objective, progress, rejected approaches, blockers | That conversation only                                  |
| operational | Troubleshooting and deployment procedures, lessons learned             | That project (or everywhere if saved without a project) |

- The agent _proposes_ memories with `remember`; the server decides. It refuses secrets (including "the password is…"
  phrasing, credential URLs and random-looking tokens), code, and junk; merges near-duplicates; and replaces outdated
  memories when the agent passes `replaces_id`. A "confirmed" project fact is refused if it was proposed in the same
  step as the reads that would confirm it (the model had not seen those results yet).
- For each request Friday includes pinned memories, approved preferences, this conversation's notes, and the most
  relevant other memories (BM25), within a token budget, marked "may be outdated: verify".
- **Used N saved memories** under an answer lists exactly what was included and why.
- **Memory** in the sidebar: search, filter by scope, edit, pin, delete, approve or reject proposed preferences, add
  your own, turn memory off globally or for one project, and export a project's memory to `.friday/memory.md`.
- Removing a project deletes its memories. `AGENTS.md`, `CLAUDE.md` and `.friday/memory.md` in a project are read as
  _untrusted_ repository guidance (conventions and commands, never permissions).

## Git

Read-only inspection (`git_status`, `git_diff`, `git_log`, `git_show`, `git_branches`) runs without approval.
Committing and creating branches need approval. Push, merge, rebase, and reset are not tools: if you ask for one, the
agent proposes it through `run_command`, where it is flagged as high risk. Git tools only work when the project folder
is the repository's top level, and they run with settings that stop a repository's own config from executing programs
(`core.fsmonitor`, diff drivers, pagers).

What Friday will not read, even inside a project: credential files (`.env`, `.env.*` except templates such as
`.env.example`, private keys, `.npmrc`, `auth.json`, `*.tfstate`, `.ssh/`, `.aws/`, …) and `.git` internals.
Search still reports _that_ a credential file matched, by name only, so the model does not wrongly conclude a value
is absent. Everything Friday does read is sent to your NoTokenLimit model.

### Choosing a model

NoTokenLimit rewrites paths under `/home/…` in the **model's text** to "your workspace" (verified with a direct API
call; tool-call arguments are not affected). Treat paths in Friday's prose with care: approval cards, run records and
verification reports show the real values from Friday's records.

For multi-step DevOps work use `claude-sonnet-4.6` or stronger: in live tests `claude-haiku-4.5` repeatedly stopped
after its first tool call and replied as if it had been given new instructions, while sonnet-4.6 completed the full
diagnose → plan → approve → execute flow. Tool calling has been verified live on both. In testing through NoTokenLimit, haiku sometimes opens
replies with a self-introduction (NoTokenLimit appears to add its own hidden prompt of roughly 1,100 tokens), while
`claude-sonnet-4.6` and `gemini-3-flash` answered cleanly. Use **Settings → Probe capabilities** before relying on a
new model for tool use.

### Usage and cost

**Settings → Usage** shows model calls, tokens and time spent waiting for the model over the last 7, 30 or 90 days:
a bar per day (hover for the numbers, or switch to a table), the conversations that used the most tokens, and a
breakdown by model. It reads Friday's own record of each model call, which holds no prompt or reply content.

- NoTokenLimit reports token usage only on non-streamed replies, and chat replies are streamed. For those, Friday
  records its own estimate of what it sent and received (the same estimate it uses to fit the context window), and
  the view marks such counts with `~`. Calls recorded before this, and failed calls, have no token count and are
  shown as "no count", not zero.
- NoTokenLimit is a flat plan and publishes no per-token prices. To see an estimated cost, enter a price per million
  input and output tokens for each model in the By model table. Prices are stored in Friday's settings, and cost is
  computed only for models with a price.

## Data

- SQLite database: `friday.db` in the data folder (`./.data/` for the web app, `~/.config/Friday/data/` for the desktop
  app; override with `FRIDAY_DATA_DIR`). The folder is created `0700` and the database `0600`.
- Stored: conversations, run state and checkpoints, approvals, file-change backups for undo, settings, model
  capabilities, memories, SSH host records (key paths, never passwords), provider-call metadata (no prompt text), and an
  audit log. API keys are never stored.
- `friday.lock` in the data folder holds the running server's PID, so two servers cannot share one database. A lock
  left by a crash is replaced automatically.

### Backup and restore

1. Quit Friday (or stop `npm start`), so the database is closed cleanly.
2. Copy the whole data folder (it includes `friday.db` and, while running, `friday.db-wal`).
3. To restore, quit Friday and put the copy back in place. To start fresh, delete the folder instead.

### Recovery

| Situation                                  | What happens / what to do                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server or app stopped mid-task             | On the next start the run is marked **interrupted** with its checkpoint, and pending approvals are cancelled (they can never run late). Use **Resume** or **Retry**. |
| Desktop server crashed                     | A dialog shows the end of the server log with **Restart server**. The full log is in `~/.config/Friday/logs/server.log`.                                             |
| "Another Friday server … is already using" | Another Friday (web or desktop) is running on the same data folder. Quit it, or point one of them at a different `FRIDAY_DATA_DIR`.                                  |
| "NoTokenLimit is not configured"           | Set `NTL_API_KEY` in the file shown in Settings, then restart the server.                                                                                            |
| A change Friday made was wrong             | **Undo** in the side panel, or **Roll back this run** on the verification report. Both refuse to overwrite edits you made since.                                     |
| Database damaged                           | Quit Friday, move the data folder aside, start Friday (a new database is created), then restore your last backup.                                                    |

Partial, cancelled, and failed responses are kept for display but are never fed back to the model as context.

## Scripts

| Command                    | What it does                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm run dev`              | API server (tsx watch) and Vite dev server together                                             |
| `npm run build`            | Type-check and build the web UI, server and desktop shell                                       |
| `npm start`                | Run the compiled server, which also serves the built UI                                         |
| `npm test`                 | Unit and integration tests (mocked HTTP; no API key needed)                                     |
| `npm run test:integration` | **Live** tests incl. the end-to-end coding cycle (needs `NTL_API_KEY`, `NTL_MODEL`; uses quota) |
| `npm run desktop`          | Build everything and open the desktop app from the checkout                                     |
| `npm run dist:desktop`     | Build the Linux AppImage and deb into `apps/desktop/release/`                                   |
| `npm run typecheck`        | Strict TypeScript across all workspaces                                                         |
| `npm run lint`             | ESLint                                                                                          |
| `npm run format`           | Prettier                                                                                        |

## Configuration

| Variable                      | Default                           | Notes                                                           |
| ----------------------------- | --------------------------------- | --------------------------------------------------------------- |
| `NTL_API_KEY`                 | none                              | Required for any model call                                     |
| `NTL_MODEL`                   | none                              | Default model; a model chosen in Settings takes precedence      |
| `NTL_BASE_URL`                | `https://notokenlimit.com/api/v1` | Must be HTTPS (plain HTTP is allowed only for localhost)        |
| `NTL_TIMEOUT_MS`              | `120000`                          | Response-header timeout and stream idle timeout                 |
| `NTL_MAX_RETRIES`             | `2`                               | Retries for transient errors only (429, 5xx, network, timeout)  |
| `FRIDAY_PORT`                 | `4317`                            | The server always binds to `127.0.0.1`                          |
| `FRIDAY_WEB_PORT`             | `5173`                            | Vite dev server port (`npm run dev` only)                       |
| `FRIDAY_DATA_DIR`             | `./.data`                         | SQLite location (desktop: `~/.config/Friday/data`)              |
| `FRIDAY_ENV_FILE`             | `./.env`                          | File the `NTL_*` settings are read from (desktop: `friday.env`) |
| `FRIDAY_WEB_DIST`             | `apps/web/dist`                   | Built UI the server serves                                      |
| `FRIDAY_AGENT_MAX_ITERATIONS` | `20`                              | Model turns per request before the run pauses as `blocked`      |
| `FRIDAY_AGENT_MAX_TOOL_CALLS` | `40`                              | Tool calls per request before the run pauses as `blocked`       |
| `FRIDAY_TOOL_TIMEOUT_MS`      | `30000`                           | Per-tool-call timeout                                           |
| `FRIDAY_TOOL_OUTPUT_CHARS`    | `20000`                           | Maximum characters of one tool result sent to the model         |
| SSH known hosts               | `<data dir>/ssh/`                 | Per-host files built from the keys you trusted                  |
| `FRIDAY_APPROVAL_TTL_MS`      | `900000`                          | How long an approval request stays valid (15 minutes)           |

## Layout

```
apps/server     Fastify API, agent orchestration, provider adapter, SQLite
apps/web        React + Vite + Tailwind UI
apps/desktop    Electron shell (main process, preload bridge, packaging)
packages/shared Type-only API contract shared by server and web
docs/           Architecture, security model, roadmap
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/ROADMAP.md](docs/ROADMAP.md)
