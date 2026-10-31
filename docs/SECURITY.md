# Security model

Friday will eventually read code, edit files, and run commands on the user's machine. The server is therefore treated
as a privileged local service from day one, even though Phase 1 has no tools.

## Threats addressed in Phase 1

| Threat                                            | Mitigation                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Other machines reaching the API                   | The server binds to `127.0.0.1` only. The bind address is not configurable.                                                                                                                                                                          |
| A malicious website calling the local API (CSRF)  | Mutating requests require the `x-friday-client: 1` header. Browsers cannot send it cross-origin without a CORS preflight, and the server never answers CORS.                                                                                         |
| DNS rebinding (`evil.com` resolving to 127.0.0.1) | The `Host` header must be `localhost`, `127.0.0.1`, or `[::1]`.                                                                                                                                                                                      |
| Cross-origin reads                                | `Origin`, when present, must be the app itself or the configured dev origin. `Sec-Fetch-Site: cross-site` is rejected.                                                                                                                               |
| Clickjacking and injected scripts in the UI       | `X-Frame-Options: DENY`, a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`, `connect-src 'self'`), and `nosniff`. Model output is rendered as Markdown without raw HTML.                                                                   |
| API key exposure                                  | The key comes only from the server environment. It is never stored in SQLite, returned by the API, or logged (request logs record method and URL only). Provider errors pass through a redactor that removes the key and common credential patterns. |
| Secrets in conversation summaries                 | Summaries are redacted before storage, and the summarizer is told not to include credentials. This is best effort.                                                                                                                                   |
| Prompt injection through pasted content           | The system prompt tells the model to treat pasted files, logs, and pages as data. In Phase 1 the model has no tools, so injection cannot cause actions.                                                                                              |
| Insecure provider transport                       | `NTL_BASE_URL` must be HTTPS. Plain HTTP is allowed only for localhost.                                                                                                                                                                              |
| Runaway requests                                  | Bounded retries for transient errors only, per-request header timeout, stream idle timeout, cancellation, 200 000-character message limit, 1 MB default body limit.                                                                                  |
| Local data disclosure                             | The data directory is created `0700` and the database file `0600`.                                                                                                                                                                                   |

## Threats addressed in Phase 2 (read-only tools)

| Threat                                   | Mitigation                                                                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model reads outside the project          | Every path goes through `resolveInside`: lexical check, then `realpath` check against the canonical root, so `../`, absolute paths, and symlinks pointing out are refused.                                           |
| Over-broad authorization                 | Project roots must be absolute, existing directories. `/`, the home directory, its ancestors, system directories, and whole drives are refused, both as typed and after resolving symlinks.                          |
| Project root swapped after authorization | Each tool call re-verifies that the root still resolves to the same canonical directory.                                                                                                                             |
| Secrets sent to the model provider       | Credential files and `.git` internals are never read, including via symlink, by tools or the UI viewer. Search drops their matches and reports only the file name. All tool output also passes through the redactor. |
| Cross-project leakage                    | A session's project is fixed at creation. Tools receive only that project's root, and context comes only from that session.                                                                                          |
| Model invoking mutating or unknown tools | `policy.decide` runs on the server for every call. Phase 2 allows only `read_only` and `agent_state`; everything else returns `denied` and is never advertised.                                                      |
| Malformed or hostile tool arguments      | JSON parse plus zod validation before execution; ripgrep runs with an argv array (no shell), `-e` for the query and `--` before paths; the built-in fallback has no regex mode (ReDoS).                              |
| Runaway agent                            | Iteration, tool-call, duplicate-call, consecutive-failure, output-size, and per-tool timeout limits; cancellation between and during tools.                                                                          |
| Prompt injection via file contents       | The system prompt labels file contents, search results, and file names as data. Tools are read-only, so injected instructions cannot cause changes.                                                                  |

## Threats addressed in Phase 3 (approvals and execution)

| Threat                                   | Mitigation                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model performing changes without consent | Policy maps file and shell categories to `require_approval`. The registry rejects protected tools with a direct `execute`; only `apply()` after approval performs side effects.                                                                                                |
| Model approving its own action           | Decisions only arrive through `POST /api/approvals/:id/decision` (browser client header required). No tool can reach it.                                                                                                                                                       |
| Approving one thing, executing another   | The approval stores a hash over the approval id, session, project root, tool, canonical args, and observed preconditions. The client must echo the reviewed hash, and the hash is recomputed from fresh state right before execution; any difference marks the approval stale. |
| Replay or double execution               | Compare-and-set status transitions; `approved` can only move to a terminal state. Approval ids are part of the hash.                                                                                                                                                           |
| Stale or abandoned approvals             | Expiry (default 15 min), run cancellation, and server restart all close pending approvals; none can execute later.                                                                                                                                                             |
| Overwriting user edits                   | Edits fingerprint the file; changes made after review make the action stale. Undo refuses if the file differs from what Friday wrote, or if later changes exist.                                                                                                               |
| Secret leakage via commands              | Child processes get an allowlisted environment (PATH, HOME, USER, locale, …) plus `CI=1`; API keys and tokens in the server environment are not inherited. Output is redacted before reaching the model.                                                                       |
| Hidden shell semantics                   | argv runs without a shell. Shell mode is explicit, the script is shown verbatim, and the card lists the shell features used (pipes, redirection, chaining, substitution).                                                                                                      |
| Runaway processes                        | Per-command timeout (max 600 s), closed stdin, and process-group SIGTERM then SIGKILL on timeout or cancel.                                                                                                                                                                    |
| Misleading success reports               | The UI shows a run record built from approval outcomes (exit codes, stale and rejected actions) next to the model's answer.                                                                                                                                                    |

## Threats addressed in Phase 4 (git and coding workflow)

| Threat                                                           | Mitigation                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious repository config executing programs during inspection | Every git call except push passes `-c core.fsmonitor=false`, `core.pager=cat`, `core.sshCommand=false`, empty `credential.helper`, `core.hooksPath=/dev/null` (inspection), and `--no-ext-diff --no-textconv` for diffs. Tested against a repo with all of these booby-trapped. |
| Option injection through refs or paths                           | Refs must match a strict pattern and never start with `-`; `--end-of-options` and `--` separate them; pathspecs starting with `:` are refused.                                                                                                                                  |
| Git exposing or committing files outside the project             | Git tools require the project root to be the repository top level.                                                                                                                                                                                                              |
| Committing secrets                                               | `git_commit` refuses when any in-scope path is a credential file; diffs of credential files are hidden.                                                                                                                                                                         |
| Committing more than was reviewed                                | `git commit --only -- <paths>` commits exactly the approved paths; the fingerprint covers HEAD, branch, and the per-file diffs.                                                                                                                                                 |
| Destructive git operations                                       | No reset/checkout/clean tools; via `run_command` they are flagged high risk and need approval like any command. Pushing has its own tools (see Push and pull requests).                                                                                                         |
| Partial multi-file application                                   | `edit_files` restores already-written files if any write fails and records changes only after all succeed.                                                                                                                                                                      |
| Rollback clobbering newer work                                   | Rollback validates every file first and refuses if any was edited since, or changed again by a later task.                                                                                                                                                                      |
| Lost progress or double execution after a crash                  | Checkpoints after every action; pending approvals are cancelled at startup; resume context tells the model what already ran.                                                                                                                                                    |

## Threats addressed in Phase 5 (DevOps and remote access)

| Threat                                    | Mitigation                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Credentials pasted into Friday            | Host configuration accepts only a key _path_ (strict schema rejects extra fields such as `password`); `.pub` files refused; keys are read by ssh, never by Friday.                                     |
| Man-in-the-middle on SSH                  | No trust on first use: the user scans, compares the fingerprint out-of-band, and trusts it explicitly. Per-host known_hosts and `StrictHostKeyChecking=yes`; a changed key fails with a clear warning. |
| Surprising ssh behaviour from user config | `-F /dev/null`, `BatchMode`, password/keyboard-interactive disabled, agent/X11/port forwarding disabled, `--` before the host.                                                                         |
| Injection through diagnostic parameters   | `remote_diagnose` uses fixed command templates; service names and log paths are pattern-validated and shell-quoted.                                                                                    |
| Accidental production changes             | Production commands need a recorded deployment plan, a server-checked typed host name, and a fresh approval that expires in 5 minutes.                                                                 |
| Destructive data changes without backup   | Plans whose steps touch data (migrations, database clients, DROP/ALTER/TRUNCATE) are rejected unless a backup pre-check is listed.                                                                     |
| Secrets in logs and container metadata    | Log tails and container logs are redacted; `docker inspect` output keeps only env variable names; `inspect_environment` never reads env.                                                               |
| Reading arbitrary system files as "logs"  | Log sources must be added by the user; `/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/root` and credential files are refused.                                                                             |
| Provider altering model output            | NoTokenLimit rewrites `/home/...` paths in model text. Approvals, run records and reports use Friday's own records, never model prose.                                                                 |

## Threats addressed in Phase 6 (memory)

| Threat                                       | Mitigation                                                                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets persisted and replayed to the model  | Server-side rejection of credential patterns, "secret is <value>" statements, credential URLs and random tokens, for agent and user writes alike.               |
| Cross-project leakage                        | One visibility predicate for all model-facing reads; tested with two projects in unit tests and live.                                                           |
| Memory poisoning (wrong facts reused later)  | Evidence-ordering rule for "confirmed" facts, confidence labels, "verify before relying" framing, user review/edit/delete, replacement instead of accumulation. |
| Prompt injection via memory or repo guidance | Memories and guidance files are placed in sections labelled as information, not instructions; guidance is explicitly untrusted.                                 |
| Unwanted personal profiling                  | User-scope memories proposed by the agent stay pending until approved; memory can be disabled globally or per project; deleting is permanent.                   |
| FTS query injection                          | Search text is reduced to quoted word tokens before reaching FTS5.                                                                                              |

## Threats addressed in Phase 7 (desktop app and hardening)

| Threat                                                       | Mitigation                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Other local programs or users driving the agent (desktop)    | A 256-bit token generated at each launch is required on every request (compared as fixed-length digests). Electron adds it at the network layer to the app's own requests only; page JavaScript never sees it, and it is never logged or stored.                        |
| Another program taking the desktop server's port             | The server binds port 0 itself and reports the port over the utility-process channel, so there is no gap between choosing a port and binding it.                                                                                                                        |
| Renderer compromise reaching the OS                          | `contextIsolation`, `sandbox`, no `nodeIntegration`. The preload exposes four calls (folder picker, restart, show config file, focus window); IPC is honoured only from the app window's top frame on the server's origin.                                              |
| Navigation, pop-ups and permission prompts                   | Navigation and redirects off the app origin are blocked (http/https links open in the system browser), `window.open` and webviews are denied, and every permission except clipboard writes for the app is refused.                                                      |
| Repurposing the packaged binary                              | Electron fuses: `RunAsNode`, `NODE_OPTIONS` and inspector flags disabled; asar integrity validation and app-from-asar-only enabled.                                                                                                                                     |
| Two servers on one database                                  | A PID lock file in the data folder; a stale lock from a crash is replaced.                                                                                                                                                                                              |
| API key storage (desktop)                                    | `friday.env` is created `0600` in the user's config folder and read only by the server process. Settings shows its path, never its contents.                                                                                                                            |
| Committed credential files via git (`HEAD:.env`, blob ids)   | Revisions may not contain `:`; `git_show` resolves the revision to a commit first, so blobs and trees are refused.                                                                                                                                                      |
| Repository-defined programs in read-only git commands        | Before every git call, program-running keys in the repository's own config (filter, diff, merge, gpg, editor, askpass, proxy, …) are read and blanked with `-c key=`. User and system config stay trusted.                                                              |
| Guessing secrets through search results                      | Credential files and `.git` are never searched, and nothing in the result depends on their contents (previously "matched in .env" was reported, which allowed character-by-character guessing). Every ripgrep result is re-checked, so a glob cannot re-include `.git`. |
| Credential diffs with quoted file names                      | Diff sections are matched on decoded paths from the header, `---`/`+++` and rename lines, so C-quoted names are hidden too.                                                                                                                                             |
| Case-insensitive filesystems (`/mnt/c` under WSL)            | `.git` and credential-folder checks compare lower-cased path segments.                                                                                                                                                                                                  |
| Env-style secrets (`DB_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=`) | Redaction matches secret words inside variable names and `user:password@` in URLs; the memory policy also refuses `login user:password` pairs.                                                                                                                          |
| Folder swapped for a symlink between approval and write      | The target folder is resolved again right before writing, and the write goes through the resolved path.                                                                                                                                                                 |

An independent review (2026-10-29) of the HTTP guards, approval engine, path confinement, command and git execution,
SSH, renderer, Electron shell and memory policy found the issues listed above; all are fixed and covered by tests.
Not reviewed in depth: the deployment-plan module beyond its remote tools.

## Task permissions and notifications

| Threat                                       | Mitigation                                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model granting itself a permission       | A permission exists only after the user approves a `request_task_permissions` card (hash-bound like any approval) or ticks "allow similar" on an action they approve. Decisions still arrive only through the HTTP decision route. |
| A permission covering more than the user saw | Coverage is judged on the prepared proposal (normalized paths from the file tools, the exact argv), not on raw model arguments. Files are exact paths or explicit folders; commands match exactly, in the project root.            |
| Dangerous actions slipping in                | Never covered: deletes and moves, git, remote, deployment, shell scripts, network or high-risk commands, typed confirmations. Credential files and `.git` stay refused by the tools themselves. Requests listing them are refused. |
| Unbounded or forgotten permissions           | In-memory on the active run only (gone when the run ends or the server restarts), action and time limits (max 40, 60 min), visible banner with **Revoke**.                                                                         |
| Losing review or undo                        | Covered actions are still re-checked before running (stale if changed), recorded as approvals with `granted_by`, shown with their diff, undoable, in the report, and audited (`approval_approved_by_task_permission`).             |
| Notifications leaking content                | Notices carry ids, status and the approval title only; no diffs, command output or model text. The `/api/events` stream is behind the same local-only guards and, in the desktop app, the launch token.                            |

## Command sandbox

| Threat                                                    | Mitigation                                                                                                                                                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untrusted project code (tests, scripts) reaching the host | Optional per-project Docker container: only the project folder is mounted; no Docker socket; capabilities dropped, `no-new-privileges`, read-only root, private `/tmp`, CPU/memory/PID limits, `--rm`.                  |
| Secrets in the project read by that code                  | Credential files and folders (found by a scan that ignores `.gitignore`) are covered by an empty file or an empty tmpfs; no host environment variables are passed; no network unless the user allows it.                |
| Persistence through git hooks                             | `.git` is mounted read-only inside the container.                                                                                                                                                                       |
| The model escaping the sandbox                            | Where commands run is a project setting only the user changes; it is part of the approval fingerprint, so changing it after review makes the approval stale. No fallback to the host if Docker or the image is missing. |
| Unwanted downloads                                        | Images are only pulled on the user's click in Project settings; image names are validated (no options, lowercase reference).                                                                                            |
| Leftover or foreign containers                            | Containers carry a per-instance label; timeouts and cancels remove the container; startup removes only this instance's leftovers.                                                                                       |

## Background processes

| Threat                                     | Mitigation                                                                                                                                                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting long-running code without consent | `start_process` is in the `shell` category: always a per-action approval, never covered by a task permission or "allow similar". The card says it keeps running. Duplicates and over-limit starts are refused. |
| Forgotten or orphaned processes            | Listed in the Processes panel with **Stop**; stopped (whole process group, or the container) when Friday quits. After a crash, startup kills only processes whose environment carries this instance's marker.  |
| Secrets in process output                  | Same environment allowlist as `run_command` (no API key); output is redacted before it reaches the model or the UI.                                                                                            |
| Exposing a sandboxed dev server            | Ports are published on `127.0.0.1` only, only for a sandbox with network, and are part of the approval fingerprint.                                                                                            |
| The model stopping other programs          | `stop_process` (category `process_control`, no approval) only accepts ids of processes Friday started in the same project.                                                                                     |

## Documents

| Threat                                    | Mitigation                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Writing files without consent             | `create_document`, `create_spreadsheet` and `create_presentation` are `file_create`/`file_modify`: an approval card with the outline, the same path checks as `write_file` (no credential files, nothing outside the project), atomic writes, undo. Not covered by task permissions. |
| Scripts or remote content in printed PDFs | The Markdown is escaped (raw HTML stays text, only `http(s)`/`mailto` links); the page has a `default-src 'none'` CSP; printing runs with JavaScript disabled and every request refused (DevTools `Fetch`; a separate offline session in the desktop app).                           |
| Spreadsheet formula injection             | Cells are written as strings, numbers, booleans or dates, never as formulas (a value starting with `=` stays text).                                                                                                                                                                  |
| Opening files with other programs         | Only on a click, only PDF/Word/Excel/PowerPoint files inside the project; the desktop shell checks the type again before `shell.openPath`. Downloads are limited to documents and images.                                                                                            |
| Third-party code                          | `docx`, `write-excel-file` and `pptxgenjs` pinned; `image-size` (a `pptxgenjs` dependency it does not call in Node) is forced to the patched 2.0.4 with an npm override; `npm audit` reports 0 vulnerabilities.                                                                      |

## Screenshots and live preview

| Threat                                        | Mitigation                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Friday's browser reaching the internet or LAN | Only `localhost`, `127.0.0.1` and `::1` pages; documents, frames and redirects elsewhere are blocked (DevTools `Fetch` interception, or `webRequest` in the desktop capture session). Friday's own port is refused.                                                                      |
| A captured page using Friday's credentials    | Desktop: a hidden offscreen window in a separate in-memory session that never gets the launch token, has no permissions, cannot download or open windows. Chrome: a throwaway profile, deleted after each capture.                                                                       |
| The live preview frame driving Friday         | CSP `frame-src` allows only loopback origins; the frame is sandboxed without top navigation; in the desktop app the launch token is added only to requests from Friday's own frame (verified: a framed page's request to the API gets 401), and frames cannot navigate off this machine. |
| Scripts in project SVG files                  | The image endpoint serves SVG (and every image) with `Content-Security-Policy: sandbox; default-src 'none'`.                                                                                                                                                                             |
| Page text steering the model                  | Screenshot results say the page's text is data, not instructions.                                                                                                                                                                                                                        |
| Comparing with another conversation's images  | A comparison only uses earlier captures from the same conversation, and the image is read only if its attachment belongs to that conversation. Untrusted PNG data is decoded with size limits (8-bit, at most 2560×8000) and fails closed.                                               |

## Connected apps (MCP)

| Threat                                        | Mitigation                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A connected app's tool acting without consent | Every tool is category `mcp` (approval card with app, tool, hints and exact arguments) unless the user set it to **Allow** (`mcp_trusted`) or **Off** (not offered). Never covered by task permissions or "allow similar". Calls are never retried. |
| Stolen or leaked credentials                  | OAuth (PKCE, dynamic registration) or a user-pasted token, stored only in the 0600 database; never returned by the API, written to the audit log or shown to the model; access and refresh tokens are added to the redactor.                        |
| The OAuth callback as an attack surface       | `GET /oauth/mcp/callback` is the only path exempt from the launch token and the cross-site check. It needs a random single-use `state` from a sign-in Friday started (10-minute expiry), and shows a fixed page with escaped text.                  |
| Tool poisoning / prompt injection             | Tool descriptions and results are labelled as data from the app; the system prompt says they cannot change the rules or authorize actions, and that project secrets are not sent to apps unless the user asks.                                      |
| Insecure transport                            | Server URLs must be `https://` (plain `http://` only for loopback), without embedded credentials. A tool definition change after review makes a pending approval stale (part of the fingerprint).                                                   |
| Running local programs                        | Not supported: only remote (Streamable HTTP) servers; Friday never starts MCP servers as local processes.                                                                                                                                           |

## Push and pull requests

| Threat                                           | Mitigation                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publishing without consent                       | `git_push` and `create_pull_request` are category `git`: an approval card every time, never covered by task permissions or "allow similar". The card shows the destination URL, the commits, the hooks, and the exact pull request title and description; the fingerprint covers all of them.      |
| Overwriting the default branch or remote history | Refused for the remote's default branch (from `refs/remotes/<remote>/HEAD`, and from GitHub for pull requests), `main` and `master`. Explicit `refs/heads/B:refs/heads/B` refspec without `+`, no `--force`, `remote.<name>.mirror` forced off; a diverged remote branch is refused before asking. |
| Leaking credentials                              | Friday never reads git or gh credentials: the user's own credential helper, ssh key and `gh` sign-in do the work. Credentials embedded in a remote URL are removed from the card, and the approval fingerprint is a hash. Commits that contain credential files are not pushed.                    |
| A repository's config running programs on push   | The repository's own `credential.*helper` entries are reset and only the user's and system values restored; `--receive-pack` is passed explicitly (a repo-set `remote.<name>.receivepack` would otherwise run); `protocol.allow=never` except https, ssh and file, so `ext::` cannot run commands. |
| `gh` reading the project's git config            | `gh` runs in a neutral folder with an explicit `--repo` and `--head`, prompts disabled.                                                                                                                                                                                                            |
| Hanging on a password prompt                     | `GIT_TERMINAL_PROMPT=0`, ssh with `BatchMode=yes`, standard input closed; push times out after 110 seconds.                                                                                                                                                                                        |
| Force pushes through `run_command`               | Flagged critical (`--force`, `-f`, `--force-with-lease`, `--mirror`, `--delete`, `+refspec`), with a pointer to `git_push`.                                                                                                                                                                        |

`pre-push` hooks are the repository's own code and run during an approved push (the card lists them), like commit
hooks during `git_commit`. Only the environment variables credential helpers need (ssh agent, WSL interop, desktop
keyring, `GH_*`/`GITHUB_TOKEN`, proxies) are passed to push and `gh`.

## CI diagnosis

`ci_runs` and `ci_failure` are read-only tools: they call `gh api --method GET` on the project's own repository
(from its git remote), with no request body, so they cannot re-run, cancel or change anything. `gh` runs in a
neutral folder with prompts disabled and uses the user's own sign-in; Friday never reads the token. Job logs are
untrusted text (anyone who can push a branch controls what a log says). They are clipped and redacted like other
tool output, and the system prompt treats them as data. GitHub masks repository secrets in logs.

## Code review

Reviewing is read-only: `review_changes` reads local git diffs, or a pull request through `gh api --method GET`.
`report_findings` only records. Credential files are hidden from the diff and never reported. Pull request
titles, descriptions and diffs come from whoever wrote them and are labelled as data, not instructions. A fix is
applied only after the user clicks **Fix this**, which sends a message whose edit still goes through the normal
approval card. The finding status (dismissed, fix requested) is the user's choice, via a local-only route.

## Saved actions

Only the user creates, changes or deletes saved actions, through local routes that need the browser client header.
Each change is audit-logged. The model's tools can list them and request a run by name; the steps, commands,
targets and timeouts come from the stored action, never from the model. Every run needs a fresh approval showing
all steps. Saved actions can't be "allowed for similar actions", and task permissions don't cover them. The
approval is bound to the action's stored version, the project sandbox settings and each SSH host's identity and
trusted keys, so editing any of them makes a shown card stale. Local steps go through the same runner as
`run_command` (filtered environment, sandbox when configured). Remote steps use the configured host only after its
key is trusted. Production hosts need their name typed and get the short approval lifetime. The run's risk is at
least the declared risk and is raised by what the commands and hosts imply.

## Docker Compose

`compose_status` and `compose_control` work only on a compose file inside the project (resolved like any project
path, so no traversal, symlink escape or credential file). Every command pins the files (`-f`), the project
directory and the project name (`-p`), and runs without a shell, with the filtered environment. Before acting,
Friday checks the containers that carry the project name. If any was created from another compose file (another
project or checkout with the same name), it refuses to act or show their logs. The model never sees environment
values, labels, commands or secrets from the resolved configuration (it is parsed for images, ports, dependencies
and volumes only). Its hash goes into the approval fingerprint, together with the exact arguments and the
container ids, so a changed file, `.env` or container set makes a shown card stale. `up` runs with `--pull never
--no-build` unless the model asks for a pull or a build, which raises the risk and shows on the card. Removing
volumes is limited to `down` of the whole project, is rated critical, needs the compose project name typed
(enforced by the server) and gets the short approval lifetime. Settings that give a service broad access to the
machine (privileged, the Docker socket, host networking) are listed and raise starts to high risk. Logs are
redacted like any tool output.

## Dependency upgrades

`dependency_report` and `dependency_changelog` are read-only and run without approval: `npm view` (so the project's
own registry settings apply), Packagist's public metadata API, `npm audit --package-lock-only` and
`composer audit --locked --no-plugins --no-scripts`. Only package names and versions leave the machine, and no
project code runs. Release notes are read through `gh` (GET only) and are labelled as third-party text.
`upgrade_dependencies` needs approval every time. The model gives exact versions only, and they are checked against
the registry: a published stable release, at least 14 days old unless the model sets `allow_recent` (shown on the
card, high risk). The commands are built by Friday (no shell), so package names and versions can't inject
arguments: both are validated, and names must be direct dependencies of the manifest. Installs are rated like any
package install in `run_command` (high: downloads code, may run install scripts) and run in the project sandbox
when it has one. The approval is bound to the hashes of the manifest and lockfiles, the commands and the sandbox
settings. Changes to those files are recorded for undo.

## Browser flows

`inspect_page` only loads a local page, like `screenshot`. `run_browser_flow` acts on the app (clicks and typing can
change its data), so it needs approval every time, in a new `browser` permission category, unless the user allowed
more flows on that same site for the current task. The card shows every step exactly as it will run, typed values
included; nothing typed is hidden from the user, and the model is told to use the project's test accounts and never
to ask the user for a password. Steps that look like they type a password, and steps that accept confirmation
dialogs, are called out on the card. Dialogs a step does not accept are dismissed.

Each flow runs in a new page with no cookies or storage from earlier flows: a throwaway Chrome profile, or a hidden
offscreen window in the desktop app's `friday-capture` session (no permissions, downloads cancelled). Documents,
redirects and frames may only come from this machine, and never from Friday's own port (checked when the card is
prepared and again when each step opens a page). A step that leads the page elsewhere fails. New windows are closed
(Chrome) or denied (desktop). In the desktop app, the server can use only a fixed list of DevTools methods on these
windows. The approval is bound to a hash of the start address, the steps and the window size. Step labels, errors
and page problems are redacted before they are stored; page text returned to the model is marked as data. Page
scripts run with the page's own rights, as in a normal browser.

## Health monitors

Monitors are created, changed and deleted only through local routes that need the browser client header, and
each change is audit-logged; the model's only monitor tool, `monitor_status`, is read-only. Checks run on the
server's timer without approval because the user configured exactly what runs:

- URL checks are `GET` requests with Friday's own user agent and no cookies or credentials. URLs with a user name
  or password are refused. Redirects are followed only to the same host (at most five). The body is read only
  when a text must be matched, capped at 256 KB, and never stored.
- SSH checks use only trusted hosts (refused at creation and at each check otherwise) and one fixed script built
  in `monitors/checks.ts`: an echo marker, `systemctl is-active` and `df -P`. The unit name and path are
  validated and shell-quoted.
- Process and compose checks only read Friday's process list and the compose state (same ownership rules as
  `compose_status`).

Check messages are redacted and capped at 500 characters before they are stored or sent. The model sees a URL
without its query string, which can hold tokens.

## Rename and move

`rename_symbol` and `move_symbol` are file changes like `edit_files`: one approval for the whole set, every file's
diff shown, applied all-or-nothing, and each file recorded for undo. They change only files inside the project
that the code map indexes or that mention the name, never credential files. A file that changed after the plan
was made is refused rather than overwritten. Matches Friday can't tie to the definition are shown on the card and
left alone unless the model names them, so a same-named function elsewhere isn't silently renamed. Nothing runs.
Type checks and tests are separate commands, approved as usual.

## Test insights

`run_tests` is a command like any other: it needs approval (or the user's decision on the card), and runs in the
project sandbox when the project uses one. The model cannot supply a command. It picks a suite, a scope, test files
inside the project and a name filter, and Friday builds the argv from the detected runner. Arguments are never put
through a shell, and a file name that starts with `-` is passed as `./name`. A name filter can't start with `-` and
is passed in the option's own argument (`--testNamePattern=…`, `-run=…`), so it can't add runner options. The runner's report goes to an empty
temporary folder outside the project (mounted at `/friday-out` in the sandbox) and is deleted afterwards. Its
contents are untrusted: size-limited, only parsed, and its paths are kept only when they point at existing,
non-credential files in the project. Re-running failed tests uses the same program limited to those tests, as the
approval card says. Error messages are redacted before they are stored or shown. Runners and coverage plugins are
never installed.

## Task worktrees

| Threat                               | Mitigation                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Losing the user's uncommitted work   | Worktrees start from the last commit and never touch the user's checkout while a task runs. Merge and squash are refused while the checkout has uncommitted changes to tracked files; a failed merge is undone with `merge --abort` / `reset --merge`, which is exact on a clean checkout. |
| Deleting the wrong folder            | Accept and discard remove only a folder inside Friday's data folder that `git worktree list` reports for that repository, via `git worktree remove`. Dependency links are unlinked first, so removal never follows them.                                                                   |
| Committing secrets on accept         | The automatic commit is refused when the worktree has credential files.                                                                                                                                                                                                                    |
| The model accepting its own work     | Creating, accepting and discarding are user actions in the UI (HTTP routes behind the usual local-only guards), never model tools. The system prompt tells the model to stay on the task branch.                                                                                           |
| Repository code running during setup | `git worktree add`, the automatic commit and the merge run with hooks disabled and the usual neutralized repository config.                                                                                                                                                                |

## Conversation export

Exports are a user action from the UI (`GET /api/sessions/:id/export`), never a model tool, and are recorded as
`session_exported` in the audit log. The whole document passes through the redactor, both formats. A full export
contains what Friday already stores and shows (tool results, diffs and commands); like a screenshot of the
conversation, treat the file as sensitive as the project. The PDF is printed from escaped HTML with no scripts or
external resources, like generated documents.

## Code map

The index holds definition lines (signatures) from project source files, in the local database only. It applies
the file tree's rules: `.gitignore` and dependency folders are excluded, credential files are never read, and
symlinks are not followed. Its tools are read-only, confined to the project, and their output is redacted like
other tool output. Signatures are untrusted text, like file contents.

## Images

| Threat                                  | Mitigation                                                                                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious files posing as images        | The type comes from the bytes (PNG, JPEG, WebP, GIF signatures), never the name or Content-Type; SVG is never accepted. Images are served with their real type, `nosniff`, and the app's CSP. |
| Oversized uploads                       | 5 MB and 8000 px per side, enforced by the server; 4 images per message. The app downsizes before uploading.                                                                                  |
| Secrets visible in screenshots          | Cannot be redacted. The composer warns that images go to the provider. `view_image` uses the same path checks as `read_file`, so credential files cannot be opened.                           |
| Prompt injection through text in images | The system prompt treats text inside images as data, like file contents.                                                                                                                      |
| Reusing another conversation's upload   | An upload can be sent once, only while unsent, and only in its own conversation (if it has one). Unsent uploads are deleted after 24 hours.                                                   |

## Known limitations

- Without the per-project **command sandbox**, an approved `run_command` runs as the current user with full
  filesystem and network access (the card says so). With it, the command can still modify the project folder (it is
  mounted writable), and isolation is Docker's: a container escape or a vulnerable Docker daemon is outside Friday's
  control. Very large projects (over 20,000 entries scanned) may have credential files the scan did not reach.
- Background processes on the host run as you until stopped. Orphan cleanup after a crash reads `/proc`, so it works
  on Linux only, and it misses a process that deliberately clears its environment.
- Commit hooks are the repository's own code and run during an approved `git_commit` (the approval card lists them).
- `remote_command` runs through the remote user's shell with that user's privileges; Friday cannot sandbox it. Remote
  processes may keep running if ssh is killed on timeout or cancel (the result says so).
- Secret detection is pattern-based; a secret phrased unusually (e.g. a plain dictionary word as a password) can
  slip through. Review saved memories periodically.
- Risk notes on commands are heuristics for the reviewer; they never relax the approval requirement.
- Browser flows find elements with JavaScript in the page itself, so a page can mislead them (for example by
  replacing `querySelectorAll`). This only affects the user's own local app, and the result is treated as data.

- In the **web app**, any process running as the same OS user can call the API on `127.0.0.1:4317`. The desktop app
  closes this with its per-launch token. In both, a process running as you can still read the data folder and the
  config file; Friday cannot defend against malware already running under your account.
- Redaction is pattern-based and cannot catch every secret format.
- The context-window size is an estimate (about 3.5 characters per token) unless the user configures it.
- NoTokenLimit adds its own hidden prompt (~1,100 tokens measured), which Friday cannot see or override. Friday
  reserves 1,500 tokens of context for it.
- The credential-file list is a denylist of common names. A secret stored in an ordinary source file can still be read
  and sent to the model; redaction catches only known patterns.
- NoTokenLimit's `/models` endpoint does not authenticate. Model "availability" checks only prove a model ID exists, not
  that the user's plan can use it. The connection test, which makes a real completion request, is the authoritative check.

## Design rules for later phases (binding)

1. **The model proposes; the backend authorizes.** Every tool declares a permission category and risk level. Unknown
   tools are denied.
2. Approvals are bound to an exact action hash, session, and project. They are single-use, expire, are re-validated
   immediately before execution, and are recorded in `audit_events`. Silence never approves.
3. No arbitrary shell endpoint is ever exposed to the browser. Commands run only through the approval engine. Shell
   interpretation is explicit and shown verbatim.
4. File access goes through canonical path resolution, workspace-root enforcement, and symlink-escape checks.
5. Tool output, repository files, and web content are untrusted data. They cannot change policy or permissions.
6. A local subprocess is not described as a sandbox. Untrusted code runs only in an isolated container without the host
   filesystem or the Docker socket mounted.
