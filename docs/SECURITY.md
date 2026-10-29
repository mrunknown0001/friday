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

| Threat                                                           | Mitigation                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious repository config executing programs during inspection | Every git call passes `-c core.fsmonitor=false`, `core.pager=cat`, `core.sshCommand=false`, empty `credential.helper`, `core.hooksPath=/dev/null` (inspection), and `--no-ext-diff --no-textconv` for diffs. Tested against a repo with all of these booby-trapped. |
| Option injection through refs or paths                           | Refs must match a strict pattern and never start with `-`; `--end-of-options` and `--` separate them; pathspecs starting with `:` are refused.                                                                                                                      |
| Git exposing or committing files outside the project             | Git tools require the project root to be the repository top level.                                                                                                                                                                                                  |
| Committing secrets                                               | `git_commit` refuses when any in-scope path is a credential file; diffs of credential files are hidden.                                                                                                                                                             |
| Committing more than was reviewed                                | `git commit --only -- <paths>` commits exactly the approved paths; the fingerprint covers HEAD, branch, and the per-file diffs.                                                                                                                                     |
| Destructive git operations                                       | No reset/checkout/clean/push tools; via `run_command` they are flagged high risk and need approval like any command.                                                                                                                                                |
| Partial multi-file application                                   | `edit_files` restores already-written files if any write fails and records changes only after all succeed.                                                                                                                                                          |
| Rollback clobbering newer work                                   | Rollback validates every file first and refuses if any was edited since, or changed again by a later task.                                                                                                                                                          |
| Lost progress or double execution after a crash                  | Checkpoints after every action; pending approvals are cancelled at startup; resume context tells the model what already ran.                                                                                                                                        |

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
