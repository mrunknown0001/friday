# Friday

A local-first AI coding and DevOps assistant that uses [NoTokenLimit](https://notokenlimit.com) as its model provider.

**Current status: Phase 5 (DevOps agent).** Friday works on authorized projects (read, edit, test, commit; each
change approved by you) and on servers: it diagnoses this machine, reads logs, inspects Docker, validates CI/CD and
Compose files, records deployment plans, and runs read-only diagnostics or approved commands on SSH hosts you configure.
Production commands require a recorded plan and typing the host name on the approval card. Every task ends with a
verification report built from Friday's own records. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

- Node.js ≥ 22.12 (tested on 22.23) and npm
- Linux, macOS, or WSL2. `better-sqlite3` ships prebuilt binaries for common platforms.
- A NoTokenLimit API key

## Setup

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

1. In the sidebar, click the **Add project** icon and enter the absolute path of a project folder.
   Adding it authorizes Friday to **read** inside that folder only. Broad locations (`/`, your home folder, system
   directories, whole drives) are refused.
2. Conversations started while a project is selected are bound to it permanently; tools can only see that project.
   "No project (chat only)" conversations have no file access.
3. The side panel shows the agent's plan, the files changed in this conversation (each with **Undo**), and a
   read-only file explorer.

## Approvals

Reading is automatic. These always need your approval, one action at a time:

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
  There is no "always allow".
- Requests expire after 15 minutes (`FRIDAY_APPROVAL_TTL_MS`). An expired request never runs.
- Each approval is bound to a hash of the exact action and the file state you reviewed. If the file changes before
  the action runs, it is **not** executed (marked _stale_) and Friday must re-read and propose again.
- Commands run as your user on this machine. **This is not a sandbox.** stdin is closed, `CI=1` is set, and only a
  small allowlist of environment variables is passed (no API keys or tokens).
- **Undo** restores a file only if it is still exactly as Friday left it; it never overwrites your later edits.
  **Roll back this run** on a verification report undoes all of a task's file changes, newest first, and does nothing
  if any of them was edited since.

## Verification reports and resuming

- After a task that proposed actions, Friday adds a **verification report** generated from its records, not from the
  model's answer. Its status is _verified_ (a test/build/lint/type-check command passed after the last file change),
  _failed_ (the last such check failed), _not verified_ (files changed but nothing checked them afterwards), or
  _no file changes_. It also lists the files, commands with exit codes, and commits, and flags files edited outside
  Friday since.
- Progress is checkpointed after every executed action. If the server stops mid-task, the run shows as interrupted
  with its checkpoint. **Resume** gives the model a summary of what was already done (files changed, commands and their
  results, plan) so it continues instead of starting over. Approvals that were pending at the time are cancelled.

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

## Data

- SQLite database: `./.data/friday.db` (override with `FRIDAY_DATA_DIR`). The file is created with `0600` permissions.
- Stored: conversations, run state, settings, model capabilities, provider-call metadata (no prompt text), and an audit log.
- Back up by copying the `.data` directory while the server is stopped.
- Reset by stopping the server and deleting `.data/`.

### Recovery

- If the server stops mid-response, the run is marked **interrupted** on the next start. Any partial text that was
  checkpointed stays visible, and **Retry** re-runs the request.
- Partial, cancelled, and failed responses are kept for display but are never fed back to the model as context.

## Scripts

| Command                    | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`              | API server (tsx watch) and Vite dev server together                                  |
| `npm run build`            | Type-check and build the web UI and server                                           |
| `npm start`                | Run the compiled server, which also serves the built UI                              |
| `npm test`                 | Unit and integration tests (mocked HTTP; no API key needed)                          |
| `npm run test:integration` | **Live** NoTokenLimit test; needs `NTL_API_KEY` and `NTL_MODEL`, uses a little quota |
| `npm run typecheck`        | Strict TypeScript across all workspaces                                              |
| `npm run lint`             | ESLint                                                                               |
| `npm run format`           | Prettier                                                                             |

## Configuration

| Variable                      | Default                           | Notes                                                          |
| ----------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `NTL_API_KEY`                 | none                              | Required for any model call                                    |
| `NTL_MODEL`                   | none                              | Default model; a model chosen in Settings takes precedence     |
| `NTL_BASE_URL`                | `https://notokenlimit.com/api/v1` | Must be HTTPS (plain HTTP is allowed only for localhost)       |
| `NTL_TIMEOUT_MS`              | `120000`                          | Response-header timeout and stream idle timeout                |
| `NTL_MAX_RETRIES`             | `2`                               | Retries for transient errors only (429, 5xx, network, timeout) |
| `FRIDAY_PORT`                 | `4317`                            | The server always binds to `127.0.0.1`                         |
| `FRIDAY_WEB_PORT`             | `5173`                            | Vite dev server port (`npm run dev` only)                      |
| `FRIDAY_DATA_DIR`             | `./.data`                         | SQLite location                                                |
| `FRIDAY_AGENT_MAX_ITERATIONS` | `20`                              | Model turns per request before the run pauses as `blocked`     |
| `FRIDAY_AGENT_MAX_TOOL_CALLS` | `40`                              | Tool calls per request before the run pauses as `blocked`      |
| `FRIDAY_TOOL_TIMEOUT_MS`      | `30000`                           | Per-tool-call timeout                                          |
| `FRIDAY_TOOL_OUTPUT_CHARS`    | `20000`                           | Maximum characters of one tool result sent to the model        |
| SSH known hosts               | `<data dir>/ssh/`                 | Per-host files built from the keys you trusted                 |
| `FRIDAY_APPROVAL_TTL_MS`      | `900000`                          | How long an approval request stays valid (15 minutes)          |

## Layout

```
apps/server     Fastify API, agent orchestration, provider adapter, SQLite
apps/web        React + Vite + Tailwind UI
packages/shared Type-only API contract shared by server and web
docs/           Architecture, security model, roadmap
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/ROADMAP.md](docs/ROADMAP.md)
