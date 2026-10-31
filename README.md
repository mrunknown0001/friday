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
- **Before and after:** around a UI change, Friday takes a screenshot first, makes the change, then takes another
  with `compare`. It compares that with the latest earlier screenshot of the same page at the same size in the
  conversation, and shows what changed: the share of pixels, the changed areas, and an image of the new page with
  the changes tinted red and outlined. The run's verification report then shows **Before and after**: the page
  before, after, and the difference side by side, each opening full size. A run that only compared screenshots
  gets a report too. Pale changes, such as a light background colour, count; anti-aliasing and compression noise
  don't. A screenshot the desktop app had to save as JPEG (over 4 MB) can't be compared.
- **Live preview:** the monitor button in the conversation header (or the screen icon next to a running process's
  URL) opens your dev server next to the conversation. It has full, tablet and phone widths, reload, open in
  browser, and **Screenshot to message**, which adds the current page to the message you're writing. The page runs
  sandboxed in its own origin and can reach neither Friday's UI nor, in the desktop app, Friday's launch token.
  Pages that refuse to be framed show blank; open them in the browser instead.
- **Image files:** PNG, JPEG, WebP, GIF and SVG files in the file tree open as images. SVG is shown with scripts
  disabled.

### Browser flows

Ask Friday to check a UI flow end to end ("sign in, add Green tea to the cart, open the cart") and it clicks through
your running app the way a person would:

- **Look first** (`inspect_page`, no approval): opens a local page and lists its headings, every visible button, link
  and form field with its state (filled, checked, disabled), and a ready-made target for each, plus the start of the
  page's text and console errors.
- **Run the flow** (`run_browser_flow`, approval): a list of steps: go to a page, click, type into a field, choose
  an option, check a box, press a key, wait, and check that the page shows a text, an element, a field value or an
  address (or does not). Elements are named the way you would: `{"role": "button", "name": "Add to cart"}`,
  `{"label": "Email"}`, `{"text": "Order placed"}`. A test id or CSS selector is the last resort.
- **The card** lists every step before it runs, typed values included, and says when a step types a password or
  accepts a confirmation dialog. Tick _Also allow more browser flows on this site_ to let the rest of the task
  re-run flows on the same local site without asking (a task permission can also list sites).
- **Each step** waits for its element (up to 5 s by default) until it is shown, enabled, not covered and no longer
  moving, clicks it with real mouse events, then waits for the page to settle. It records a screenshot, the address,
  and any console errors, uncaught exceptions, failed requests and dialogs. The flow stops at the first failing step;
  the error says why (not found, several matches with where each is, hidden, disabled, covered by another element)
  and lists the elements on the page so the step can be fixed.
- **The result card** shows every step with its screenshot (each opens full size). The model gets every step as text
  and one screenshot: the failing step's, or the last. A flow that passed after the last change counts as the
  task's check in the verification report.
- Every flow starts in a fresh browser with no cookies, so a flow that needs an account signs in with a test account
  from the project (seed data, fixtures, README). Friday never asks you for a password. Only `localhost` /
  `127.0.0.1` pages, never Friday itself; a click that leads to another site fails the step, frames from other sites
  are blocked, and other windows and downloads are refused. It uses the same browser as screenshots (built in to
  the desktop app, an installed Chrome, Chromium or Edge otherwise). At most 30 steps and 3 minutes per flow.

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
  _re-running this exact command_, or _more browser flows on this site_) before **Approve**. That action's files,
  command or site are added to the task's permission.

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

### Exporting a conversation

The download button in the conversation header exports the conversation as **Markdown** or **PDF**:

- **Summary:** your messages and Friday's replies, one line per tool call, every approval with its decision and
  result, and each run's verification report.
- **Full:** also each tool's result (up to 20,000 characters each), the reason given for each approval, and the
  exact action (diffs, commands, pull request text, a connected app's arguments).

Times are in your time zone. Headings inside replies are nested under the conversation's, and images are listed by
name, not included. Secrets Friday recognizes are redacted in both formats, as everywhere else. The PDF is printed
in the same style as the documents Friday writes, so it needs a browser engine: the desktop app, or
`FRIDAY_CHROME`. Markdown works everywhere. Exporting is your action, not a tool the model can call, and it's
recorded in the audit log.

## DevOps

Read-only, no approval needed:

- `inspect_environment`: OS, CPU, memory, disk space, and versions of Node, PHP, Composer, Python, Git, Docker, Nginx,
  database clients, PM2, Supervisor and Certbot. Environment variables are never included.
- `search_logs`: the tail (last 4 MB) of a project log or of a log file you authorized in **Settings → Log sources**,
  optionally filtered, with secrets redacted.
- `inspect_docker`: containers, images, compose services (see also Docker Compose below), container logs, and a reduced `docker inspect` that never
  shows environment variable values.
- `validate_config`: YAML/JSON syntax with line numbers, plus checks for GitHub Actions (missing `runs-on`, unpinned
  actions, script injection, `pull_request_target` checkouts, missing `permissions`) and Docker Compose (privileged
  containers, Docker socket mounts, databases published on all interfaces, hard-coded secrets).
- `ci_runs` and `ci_failure`: the project's GitHub Actions runs, and why one failed (see below).

### CI diagnosis

Ask about a failing build ("CI is red", "why did run 41016901901 fail?") and Friday reads the project's GitHub
Actions runs through the GitHub CLI (`gh`), signed in as you; Friday never reads the token. Both tools only make GET
requests: nothing can re-run, cancel or change anything on GitHub.

- `ci_runs` lists recent runs (current branch by default): workflow, result, branch and commit, and which run
  tested your current commit.
- `ci_failure` takes a run (by default the latest failed one on your branch) and reports:
  - the failed jobs and steps;
  - the **first real error** from the job log, not the runner's closing "Process completed with exit code 1": the
    first test failure, compiler or linter error, or stack trace, with a few lines of context;
  - the run's annotations, and the **project files** the error points at. Runner paths such as
    `/home/runner/work/app/app/src/x.ts` become `src/x.ts`, and paths relative to a package folder are matched to
    the project's files;
  - whether the run tested your current commit, an older one, or one you don't have locally.

Friday then reads those files and proposes a fix as normal approved edits, and runs the same check locally when the
project allows. Only a new run after you push shows CI passing again. Logs are redacted like any tool output, and
GitHub keeps them for a limited time.

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
Committing, creating branches, pushing and opening pull requests need approval, every time: none of them can be
covered by a task permission. Merge, rebase and reset are not tools: if you ask for one, the agent proposes it
through `run_command`, where it is flagged as high risk (a force push there is flagged critical).

### Code review

**Review…** in the conversation header (or just asking, e.g. "review my changes" or "review PR #12") reviews
**uncommitted changes**, **this branch** against its base (the remote's default branch unless you name one), or a
**GitHub pull request**, read through `gh` with your sign-in. An optional focus ("security", "error handling")
narrows it.

- `review_changes` gives the model the diff (new files included, credential files hidden) and records which lines
  changed. `report_findings` finishes the review, and the findings appear as a **Code review** card, most severe
  first.
- Each finding has a severity (critical, high, medium, low, nit), `file:line` (opens the file at that line), the
  reason (the concrete failure, not a vague concern), and usually an exact suggested change shown as a diff.
- **Friday checks each location**: whether the line is in the changed lines, elsewhere in the file, or doesn't exist,
  and whether the suggested text to replace is really in the file. Findings that point at nothing are flagged.
  Friday refuses to record a review the model wrote before it saw the diff, or one where most findings don't match
  the code. Both happened in testing; the model then re-read the diff and reported correctly.
- **Fix this** asks Friday to make exactly that change, as a normal edit you approve; **Dismiss** hides a finding
  (**Restore** brings it back). Nothing is changed during the review itself.
- For a pull request that isn't checked out, line numbers come from the pull request's diff, and the review says
  when your local files differ.

### Saved actions

Define a procedure once in **Project settings › Saved actions**, such as "deploy staging" or "restart queue". An
action has a name, a description, the risk you assign it, and ordered steps. Each step is an exact command that
runs either **in the project on this machine** (in its folder, through the project sandbox if it has one) or **on a
configured SSH host**. A step can be marked to continue when it fails; otherwise the run stops there.

- Ask Friday to run one by name, or use **Actions…** in the conversation header. One approval shows every step:
  the exact command, where it runs, its timeout and anything risky about it. Steps run in order, with their output
  streamed, and the result lists each step's outcome.
- **Commands are fixed:** the model can list actions and ask to run one, but it can't change a step or pass
  arguments, and there is no tool to create or edit actions. Changing an action after its card was shown makes
  the approval stale.
- **Risk:** Friday rates a run at least as high as the risk you set, and higher when a command or host calls for
  it.
- **Production:** an action that touches a production host needs the host name typed to approve, like a remote
  command. The action counts as the reviewed plan, so no separate deployment plan is needed.
- A task worktree uses its project's actions. Changes are recorded in the audit log.

### Docker Compose

Ask Friday about the project's compose services, or to bring them up, restart or take them down. It uses the
project root's `compose.yaml` / `docker-compose.yml` (with its override file), or another compose file in the
project when you name it.

- **Status and logs** (`compose_status`) run freely: each service's state, health check result, restarts, and
  whether its published ports accept connections.
- **Changes** (`compose_control`: up, start, stop, restart, down) need approval. The card lists the services
  (dependencies `up` starts are marked), the exact `docker compose` command, and anything risky in the compose
  file. Afterwards Friday waits for the services to be running and healthy and reports each one.
- **Only this project's containers:** the files and project name are pinned on every command. If containers with
  the same project name came from another compose file, Friday refuses to act.
- **Images** are never pulled or built unless you ask for it; a missing image is reported instead.
- **Volumes** are deleted only when you ask, with `down`, at critical risk: the card lists the volumes, and you
  type the project name to approve.

### Dependency upgrades

Ask Friday to check or upgrade the project's dependencies (npm with `package-lock.json`, including workspaces, and
Composer with `composer.lock`):

- **Report** (`dependency_report`, no approval): each direct dependency's locked version, the newest release on the
  same major line and on any line, and known advisories (`npm audit` / `composer audit` on the lockfile), with
  whether the recommended version fixes them. Recommended versions are **at least 14 days old**; newer releases are
  listed as too recent. Only package names and versions go to the registries; nothing is installed.
- **Release notes** (`dependency_changelog`, no approval): GitHub releases between two versions, or the
  `CHANGELOG.md` where releases are missing, with breaking-change lines first. Fetched through `gh`.
- **Upgrade** (`upgrade_dependencies`, approval): exact versions only. The card shows each package's version
  change (patch, minor, major), its age, the advisories it fixes or still has, breaking-change lines from the
  notes, and the exact `npm install` / `composer require` commands. They run like `run_command` (in the project
  container if it has one), and install scripts may run. The manifest keeps its style (`^`, `~` or exact). The
  manifest and lockfile changes are recorded, so you can undo them in the Changes panel. Friday then runs the tests.
- A release younger than 14 days is refused unless you ask for it, and is marked on the card. pnpm, Yarn and Bun
  projects are reported as not supported yet.

### Health monitors

Open **Monitors** in the sidebar to watch things while Friday runs. Each monitor checks every few minutes (1 to
1440):

- **URL**: a plain `GET` (no cookies or credentials); healthy on any 2xx/3xx or the status you set, optionally only
  when the response contains a text. Redirects are followed on the same host only.
- **SSH host** (trusted hosts only): the host answers, and optionally a systemd service is active and a disk stays
  under a usage limit. Only fixed read-only commands run (`systemctl is-active`, `df`).
- **Background process**: a project's background process (started with `start_process`) with that name is
  running.
- **Compose service**: a service of the project's compose file is running, and healthy if it has a health check.

A monitor counts as **down** after the number of failed checks in a row you set (2 by default), and as up again
after one passing check. Both changes send a system notification (when notifications are on), and the sidebar
shows how many are down. Each monitor keeps its latest checks and status changes. **Investigate** on a monitor
that is down opens a conversation (in its project, if it has one) asking Friday to find out why, read-only first.

Only you add, change, pause or delete monitors. Friday's `monitor_status` tool can read their status and history
but not change them. A URL's query string is not shown to the model. Deleting a project deletes its monitors.

### Load tests (k6)

Ask Friday how a page or API holds up under load ("10 signed-in users for 30 seconds, p95 under 200 ms") and it
runs `run_load_test` with the k6 installed on this machine (`k6` on PATH or `FRIDAY_K6`; Friday never installs it).

- **Friday writes the script** from the model's description: the requests each virtual user makes in order, think
  time, constant load or ramp stages, and thresholds (p95, p99, error rate, per-request p95). The approval card shows
  the target, the load, every request with its body, the thresholds and the full script. Redirects are not followed,
  so the test can't reach another site, and k6's usage report is off.
- **Targets:** this machine without any setup (up to 100 virtual users for 10 minutes, never Friday itself). Other
  sites only when listed in **Settings → Load-test targets**, each with its own most users and minutes. Production
  targets need the name typed for each test. Anything else is refused before a card appears.
- **Results:** the **Load test** card and the model get the request rate, failed share, latency (median, p90, p95,
  p99, max), each threshold with the measured value, and, per request, its numbers, the status codes it got and the
  start of the first unexpected answer, so a failing login shows why.
- Each virtual user keeps its cookies, so a login request first signs that user in for the rest. Requests that
  change data are called out on the card.

### Voice

Friday can speak its replies and take dictation. Both run on this machine: Kokoro (82M, 8-bit) speaks and Whisper
base (8-bit) transcribes, through `kokoro-js` and ONNX Runtime on the CPU. Audio never leaves the machine and is
never stored.

- **Set up once:** **Settings → Voice** lists the two models (about 92 MB and 80 MB) with their source and license.
  Nothing downloads until you click **Download**. Each file is pinned to a Hugging Face revision and checked against
  its SHA-256. There you also pick the voice (27 American and British English voices), the speed and the
  microphone language.
- **Speak replies:** the speaker button in the composer. When a reply finishes, Friday speaks it. Every reply also
  has a play/stop button under it. What is spoken is a short spoken version, written by one extra model call the
  first time a reply is played and then kept: prose is said, while code, logs, diffs, tables, paths, links and
  hashes are described, never read out ("the fix is the comparison on line 12, which now uses
  less-than-or-equal"). Redacted values stay hidden. When an approval card appears, Friday says what it needs
  ("Friday needs your approval to run a command"), never what is on it.
- **Dictate:** the microphone button records while it is on, with a red indicator, the elapsed time and the level
  (2 minutes at most). Click it again and the transcript goes into the message box to edit and send. Nothing is
  sent by itself, and voice never approves anything: saying "approve" is just a message.
- On Linux, `npm install` skips ONNX Runtime's CUDA download (`.npmrc`); speech runs on the CPU. The models load on
  first use and are unloaded after 5 idle minutes.

### Web search and research

Friday can search the web, read public pages and research a bigger question. Use it for documentation, changelogs,
release notes and error messages that aren't in the project.

- **Tools:**
  - `web_search` returns titles, links and snippets from [Tavily](https://tavily.com). It needs `TAVILY_API_KEY` in
    `.env` (desktop: `friday.env`).
  - `read_web_page` fetches one page and returns its readable text: the main content as Markdown, with headings, code
    blocks, lists, links and tables. It works without a key.
  - `deep_research` does a whole investigation, described below.
  - All three run without approval and show in the tool activity. **Settings → Web** turns them off.
- **Deep research** ("which PDF library fits this project", "what breaks if we upgrade to Vite 6"):
  - Friday plans sub-questions and searches for each one.
  - It reads the most relevant pages, three at a time, and notes what each sub-question's sources say and where they
    disagree.
  - It writes a report: a direct answer, details, disagreements, how the findings apply to this project, and what
    is still uncertain.
  - Every claim links to its numbered source. Citations that point at no source are removed and counted, and the
    sources are listed at the end.
  - The **Research** card shows progress live (sub-questions, each query sent, each page read or skipped and why).
    Then it shows the report, which you can save as Markdown, Word or PDF.
  - Limits per research are set in **Settings → Web**: 12 searches, 15 pages and 5 minutes by default (at most 30,
    40 and 15). Near a limit, Friday stops searching or reading and still writes the report from what it has, and the
    card says so. **Stop** in the composer ends a research without a report. The card keeps the searches and pages.
- **What leaves the machine:** only search queries (to Tavily) and page addresses (to those sites).
  - Queries must be public terms, such as library names, versions and error text.
  - Friday refuses queries that contain secrets, code, file paths, private IP addresses, local host names or the
    names of your SSH and database hosts, and the refusal shows on the card.
- **What is fetched:**
  - Only public http(s) pages, by plain GET with no cookies or credentials.
  - At most 3 MB, 15 seconds and 5 redirects, each redirect checked again.
  - Addresses on this machine, your local network or a cloud metadata service are refused, including when a public
    name resolves to one.
  - HTML, text and JSON pages are read. PDFs and other files are not.
- Page text is untrusted: Friday treats it as data, never as instructions, and secrets in it are redacted.

### Databases (read-only)

Add a database in **Settings → Databases** (Postgres, MySQL/MariaDB or SQLite), for any conversation or for one
project, marked development, staging or production. Then ask Friday about the data.

- **No passwords in Friday.** A connection stores the host, port, database and user, plus the _name_ of a variable
  that holds the password (`DB_PASSWORD`) or the whole connection URL (`DATABASE_URL`). Friday reads the value when it
  connects: from the project's `.env` (project connections), then Friday's config file, then its environment. The
  value is never stored, logged or shown to the model. SQLite takes a file path (absolute, or inside the project).
  **Test** connects and warns when the database user could write; a read-only user is safest.
- **Schema** (`database_schema`, no approval): the connections available here, a database's tables and views with
  row estimates, and a table's columns, keys, foreign keys and indexes. No table data is read.
- **Queries** (`query_database`, approval every time): one read statement (SELECT, WITH … SELECT, VALUES,
  EXPLAIN, SHOW, SQLite PRAGMA reads). Friday refuses writes, locking reads, `SELECT INTO` and several statements
  before asking, and checks the statement with `EXPLAIN` so mistakes come back without a card. The card shows the
  exact SQL, the connection, where the password comes from, the row and time limits (100 rows and 15 s by default,
  at most 1,000 and 120 s) and the planner's row estimate. Production connections need the name typed.
- **Read-only in the database too.** Postgres and MySQL run the statement in a read-only transaction in a read-only
  session, so the database refuses any write even from a user who could write; SQLite files are opened read-only.
  Every query uses a new connection that is closed afterwards.
- **Results:** the rows go to the model as a table. Values of columns named like passwords, tokens or keys are hidden
  and anything that looks like a secret is redacted. If you want data changed, Friday gives you the SQL to run
  yourself.

### Rename and move code

Ask Friday to rename a function, class, type, constant or method, or to move a top-level TypeScript/JavaScript
definition into another file. The change is one multi-file diff you approve as a whole (and can undo per file):

- `find_references` first finds the definition through the code map and every whole-word match of the name. It then
  splits the matches into **the same symbol**: the definition's own file, files that import it (named imports,
  re-exports through index files, namespace imports, `require`), `this`/`self` for members, the same Go package, and
  the PHP namespace or `use`. Everything else is **may be something else**, with the reason: a comment, a string, a
  file that doesn't import it, or a method call on a value whose type Friday can't check.
- `rename_symbol` changes only the first group. The others are listed on the approval card and left alone, unless
  the model checked one and named it. A new name that already appears in a file being changed is refused, and so
  are reserved words and, in Go, a change of exported-ness.
- `move_symbol` moves the definition with its doc comment. It brings the imports the definition needs (re-pointed
  from the new file) and imports, from the old file, names it uses there (exporting them when they weren't). The old
  file imports it back if it still uses it, and every file importing it from the old file, index re-exports
  included, is updated. Namespace imports and `require` of the old file are listed to fix by hand, and a circular
  import is pointed out.

It reads code by patterns, not with a compiler, so it is careful rather than complete: imports are followed for
TypeScript/JavaScript, Python, Go and PHP. In other languages, matches outside the definition's file are listed
rather than changed. Run the tests or type checker afterwards; Friday suggests it.

### Test insights

Ask Friday to run the tests (or it does so after a change). For **Vitest, Jest, `node --test`, pytest and Go** it
uses `run_tests`, which it builds itself rather than running whatever the model asks for:

- `detect_tests` finds each suite (a folder with a package.json, a pytest setup or a go.mod), its runner, and
  whether coverage is available, without installing anything. A monorepo has one suite per package.
- `run_tests` first runs the tests **related to your uncommitted changes**. Vitest and Jest find them from the
  imports. For `node --test` and pytest, Friday picks the changed test files, the tests that import a changed file,
  and the tests named after one. Go runs the changed packages. When those pass, it can run the whole suite or
  chosen files.
- You approve it like any command. The approval card shows the exact command, what is tested, and that the report
  goes to a temporary folder outside the project.
- **Failures:** the result is a **Tests** card listing each failure's first error and its `file:line` (opening the
  file at that line). It also says when the same test failed in earlier runs.
- **Flaky tests:** failed tests are **re-run once**. A test that then passes is reported as flaky, not broken, and
  so is one that has passed and failed on the same code (HEAD plus the same uncommitted changes) in earlier runs.
- **Slowest tests:** tests of 100 ms or more, and ones much slower than usual, compared with their earlier runs.
- **Coverage of the lines you changed** (optional): which changed lines ran and which never did. It needs the
  coverage tool the suite uses: built in for Jest, `node --test` and Go; `@vitest/coverage-v8` or `pytest-cov`
  otherwise. Friday says so when it is missing, and doesn't install it.
- A passing `run_tests` after the last change counts as verification in the run report, like a test command.

Each test's outcome is kept per project and suite (the last 50 runs), which is how slow and flaky tests are
recognised over time. Other test commands still work through `run_command`.

**Playwright** (end-to-end) suites are found from a `playwright.config.*` and `@playwright/test` in package.json,
beside any unit tests in the same folder. `run_tests` runs them only when asked (`framework: "playwright"`), with
Playwright's JSON reporter and its own retry for flaky tests. The card says which web server the config starts first.

- **Failures** show the first error and `file:line`, the screenshot Playwright saved (opening full size; the model
  sees the first one), and the trace with the command to open it (`npx playwright show-trace …`). The model also
  gets the page's accessibility snapshot at the failure, without the instructions Playwright adds to that file.
- **Related to the changes:** changed specs and specs named after or importing a changed file. End-to-end specs
  rarely import app code, so when none relate Friday says so and asks for the specs to run.
- New or changed specs are normal approved edits; Friday writes them with the role and label locators that
  `inspect_page` reports.
- Friday never installs Playwright, its browsers or system libraries. When they are missing, the run is reported
  as an error with the command for you to run. With the command sandbox it runs in the project's container, whose
  image needs browsers (for example `mcr.microsoft.com/playwright`). A busy port for the config's web server is
  explained too.

### Task worktrees

Start a task in its own git worktree with the branch-plus button next to **New conversation**. Friday makes a
separate folder (in its data folder, `worktrees/`) on a new branch `friday/task-…`, from your project's last commit.
The conversation works only there, so your own checkout, including uncommitted work, stays untouched while the task
runs. The header shows the branch, with **Accept…** and **Discard…**.

- Your uncommitted changes are not in the worktree; it starts from your last commit.
- Dependency folders git ignores in your checkout (`node_modules`, `vendor`, `.venv`, up to three levels deep) are
  **linked** into the worktree, so tests run immediately. They're shared, so installing packages inside the
  worktree changes your checkout's copy too; Friday says so before proposing an install. The links are kept out of
  git through the repository's local exclude file (`.git/info/exclude`); for your checkout that changes nothing,
  because the same folders are already ignored there.
- **Accept** first commits whatever the task left uncommitted (credential files are refused), then:
  - **Merge into your branch** (a merge commit, keeping the task's commits), or **Squash** it into one commit. Both
    land on the branch your checkout is on, and are refused if your checkout has uncommitted changes to tracked
    files: commit or stash them first, Friday never touches them. A conflict undoes the attempt completely and
    keeps the worktree, so you can ask Friday to bring it up to date there.
  - **Keep the branch**, without touching your branch, to push it or open a pull request later.
- **Discard** removes the worktree folder and its branch. Your checkout isn't touched.
- Both remove only a folder Friday made inside its data folder and registered with git. They wait while a task is
  still running, and stop the worktree's background processes. A project with a worktree in progress can't be
  removed from Friday until you accept or discard it.
- The conversation stays in the project's list with a branch icon, and its header says how it ended.

### Push and pull requests

- `git_push` pushes the current branch to the remote branch of the same name (usually `origin`) and sets it as the
  upstream. `create_pull_request` opens a GitHub pull request for the current branch and pushes it first if the
  remote doesn't have every commit yet.
- **Never the default branch, never forced.** Friday refuses to push the remote's default branch, `main` or
  `master`; ask it to create a feature branch first (it does this on its own). Pushes use an explicit refspec with
  no `+` and no `--force`, so a push that would overwrite remote commits fails, and Friday tells you to pull or
  rebase first. Commits that contain credential files (`.env`, keys, …) are not pushed.
- **Your own sign-in.** Pushes use your git credential helper or ssh key; pull requests use the GitHub CLI (`gh`),
  signed in with `gh auth login`. Friday never reads either credential. The repository's own config can't swap in a
  credential helper or pack program, and only https, ssh and local remotes are allowed. ssh runs with
  `BatchMode=yes`, so it fails rather than asking for a password.
- **The approval card shows** the remote and its URL (without any embedded password), whether the branch is new
  on the remote, the commits to push, any `pre-push` hooks that will run, and for a pull request the repository,
  base branch, draft status, and the exact title and description.
- **The description ends with a verification section** that Friday writes from its own records: whether tests,
  builds or linters passed after the last change, and the files changed. It comes from the run in this
  conversation that made the branch's commits, so "fix it and push" followed by "open a PR" still includes it. The
  model's own claims are not used for it.
- Pull requests need a GitHub remote (github.com, or a GitHub Enterprise host `gh` is signed in to). `FRIDAY_GH`
  sets the path to `gh` if it isn't on `PATH`. Git tools only work when the project folder
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
| `TAVILY_API_KEY`              | none                              | Web search and deep research; reading pages works without it    |
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
| `FRIDAY_GH`                   | `gh` on `PATH`                    | GitHub CLI used to open pull requests                           |

## Layout

```
apps/server     Fastify API, agent orchestration, provider adapter, SQLite
apps/web        React + Vite + Tailwind UI
apps/desktop    Electron shell (main process, preload bridge, packaging)
packages/shared Type-only API contract shared by server and web
docs/           Architecture, security model, roadmap
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/ROADMAP.md](docs/ROADMAP.md)
