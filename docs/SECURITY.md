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

## Known limitations

- Any process running as the same OS user can call the API. A per-launch bearer token (for Electron, passed through the
  preload bridge) is planned for Phase 7.
- Redaction is pattern-based and cannot catch every secret format.
- The context-window size is an estimate (about 3.5 characters per token) unless the user configures it.
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
