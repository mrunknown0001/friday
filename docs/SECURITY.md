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

## Known limitations

- `run_command` is **not sandboxed**: an approved command runs as the current user with full filesystem and network
  access. The approval card says so. Container isolation for untrusted code is still to come.
- Risk notes on commands are heuristics for the reviewer; they never relax the approval requirement.

- Any process running as the same OS user can call the API. A per-launch bearer token (for Electron, passed through the
  preload bridge) is planned for Phase 7.
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
