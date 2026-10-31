# Architecture

## Overview

```
Browser (React UI)                 Local server (Node, 127.0.0.1 only)                NoTokenLimit
┌───────────────────┐  fetch/SSE  ┌──────────────────────────────────────────┐  HTTPS  ┌────────────┐
│ Sidebar / Chat /  │ ──────────▶ │ http/   guards → routes → zod validation │ ──────▶ │ /models    │
│ Settings          │ ◀────────── │ chat/   RunManager, context, prompt      │ ◀────── │ /chat/...  │
└───────────────────┘   events    │ providers/ LLMProvider ← NoTokenLimit    │         └────────────┘
                                  │ repositories/ → SQLite (.data/friday.db) │
                                  └──────────────────────────────────────────┘
```

The browser never talks to the provider and never sees the API key. All model traffic, persistence, and (from Phase 2)
tool execution happen in the server process.

## Server modules (`apps/server/src`)

| Module                      | Responsibility                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                 | Validates the environment with zod. Fails fast with variable names only, never values.                                                                          |
| `db/`                       | Opens SQLite via Node's built-in `node:sqlite` (WAL, foreign keys), applies append-only migrations each in its own transaction, and holds the data-folder lock. |
| `repositories/`             | Narrow data-access classes: sessions, messages, runs, settings, capabilities, provider calls, usage, audit.                                                     |
| `providers/types.ts`        | The provider-neutral `LLMProvider` interface and message, tool, and stream-event types.                                                                         |
| `providers/notokenlimit.ts` | OpenAI SDK adapter: request mapping, streaming, tool-call reassembly, idle timeout, response validation, telemetry.                                             |
| `providers/errors.ts`       | Maps any SDK or network failure to a `ProviderError` with a `kind` and a `retryable` flag.                                                                      |
| `providers/retry.ts`        | Bounded exponential backoff with jitter. Retries only transient kinds and honours `Retry-After` (capped).                                                       |
| `providers/capabilities.ts` | Conservative context-window defaults and a live probe for streaming and tool calling.                                                                           |
| `providers/tokens.ts`       | Rough token estimates, for context fitting and for usage the provider does not report.                                                                          |
| `chat/context.ts`           | Token estimation, history fitting (keeps tool-call groups intact), and summarization of history that no longer fits.                                            |
| `chat/runManager.ts`        | Owns run lifecycles: event buffering for SSE replay, cancellation, checkpointing, persistence, one active run per session.                                      |
| `http/`                     | Local-only guards, routes, SSE, and error mapping.                                                                                                              |
| `services.ts`               | Composition root that wires everything together. Tests replace the provider or `fetch` here.                                                                    |

### Provider abstraction

Agent code depends only on `LLMProvider`:

- `streamChat(request)` yields `text`, `tool_call` (complete, with raw JSON arguments), and `finish` events.
- `complete(request)` is non-streaming. It is used for summaries, probes, and models where streaming is unsupported.
- `listModels()`

Errors are classified into kinds (`providers/errors.ts`); rate limits, timeouts, network, server and `upstream`
errors are retried with jittered backoff (`providers/retry.ts`). `upstream` covers NoTokenLimit failing to get an
answer from the model's own provider: a 502/504, or an error such as "Upstream provider failed" sent inside an
already-open stream. Such a stream is sent again only while nothing has reached the caller yet, waiting at least 2 s
between tries, and the final message says the outage is on NoTokenLimit's side and suggests another model.

Switching models changes nothing outside the request's `model` field. Adding another OpenAI-compatible provider means
implementing this interface. Nothing else should change.

Capabilities are **not assumed**. `model_capabilities` stores probe results (`unknown`, `supported`, or `unsupported`).
The run manager falls back to `complete()` when streaming is known to be unsupported. Context windows start as
deliberately low guesses, marked `assumed`, until the user configures a value.

### Runs and streaming

1. `POST /api/sessions/:id/messages` validates configuration first, then stores the user message, creates a `runs` row
   with status `running`, and returns `202` with the run ID.
2. The run executes in the background. Events are numbered (`seq`), buffered in memory, and pushed to subscribers.
3. `GET /api/runs/:id/events` is SSE. It replays buffered events after `Last-Event-ID` or `?after=` and then streams live
   events. For runs no longer in memory it emits the persisted final state.
4. Partial assistant text is checkpointed to `messages` as status `partial` every 2 s. The final status is one of
   `complete`, `cancelled`, or `error`.
5. On startup, any run still marked `running` becomes `interrupted` and can be retried.

### Context management

- History sent to the model contains only `complete` user and assistant messages after the session's summary watermark.
- `fitHistory` keeps the newest message groups that fit in 80 % of the window, minus reserved output tokens and the
  system prompt.
- If older messages are dropped, they are summarized together with the previous summary. The summary is stored in
  `sessions.summary` with `summary_through_message_id` and injected into the single system message. If summarization
  fails, the run continues with plain trimming and says so in a phase event.

## Agent loop (Phase 2)

`RunManager.execute` runs one request as a loop:

1. Build the system prompt: project name, root, detected stack, capabilities, rules, untrusted-content policy.
2. Build context from the whole session (user, assistant, and tool messages), repair any tool call that lacks a
   result (crash between call and result), clip tool output from earlier turns, and fit the window (minus the
   provider's hidden-prompt overhead). History is trimmed by whole turns, so it always starts with a user message.
3. Stream one model turn with the allowed tool definitions. Persist the assistant message with its tool calls.
4. No tool calls means the final answer: the run is `completed`.
5. Otherwise execute each call through `executeToolCall` (policy → JSON parse → zod validation → execute with
   timeout and cancellation → redact → truncate) and persist a `tool` message plus a `tool_calls` metadata row.
6. Repeat. Safeguards: `maxIterations`, `maxToolCalls`, at most 2 identical calls (same tool and canonicalized
   arguments), and `maxConsecutiveToolFailures`. Hitting one ends the run as `blocked`, which is retryable: the
   model continues from the recorded tool work.

Tool failures are returned to the model as `Error: …` results so it can correct itself. They never throw out of the
loop.

## Tools and workspace (`tools/`, `workspace/`)

| Module                    | Responsibility                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tools/types.ts`          | `ToolSpec`: name, description, permission category, risk, zod schema, executor. zod → JSON Schema.                       |
| `tools/policy.ts`         | The only place that decides allow, deny, or (Phase 3) approval. Phase 2 allows `read_only` and `agent_state`.            |
| `tools/registry.ts`       | Registers tools, advertises only policy-allowed ones, and validates and executes calls.                                  |
| `tools/workspaceTools.ts` | `inspect_project`, `list_directory`, `find_files`, `search_code`, `read_file`, `file_info`.                              |
| `tools/planTool.ts`       | `update_plan`: stores the checklist on the session and emits `plan_updated`.                                             |
| `workspace/paths.ts`      | Canonical resolution inside the root, symlink-escape checks, credential and `.git` blocking, project-root authorization. |
| `workspace/walk.ts`       | Depth-first listing honouring nested `.gitignore` and default exclusions; symlinks not followed.                         |
| `workspace/search.ts`     | ripgrep via argv (no shell) with JSON output, or a literal-only built-in fallback.                                       |
| `workspace/detect.ts`     | Stack, package-manager, manifest, and script detection from top-level files.                                             |

The UI's file explorer (`/api/projects/:id/tree` and `/file`) uses the same `resolveInside` confinement as the agent.

## Approval flow (Phase 3)

```
model tool call ─▶ validateToolCall (policy, JSON, zod)
                    │ allow ──────────────▶ runGuarded(execute) ─▶ result
                    │ require_approval
                    ▼
               spec.prepare(args)  (no side effects: computes diff / command, fingerprint, apply())
                    ▼
               ApprovalService.request ─▶ approvals row (pending, action_hash, expires_at)
               run status = awaiting_approval, SSE approval_requested
                    ▼
               wait: user decision (HTTP, CSRF header, echoed hash) | expiry | run cancel
                    │ rejected/expired/cancelled ─▶ result for the model (not executed)
                    ▼ approved
               spec.prepare(args) again ─▶ recompute hash ─▶ mismatch: stale, not executed
                    ▼ match
               runGuarded(apply) ─▶ approvals: executed | failed; file_changes row (backup); audit
```

| Module                        | Responsibility                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `approvals/stateMachine.ts`   | Allowed transitions and `computeActionHash`.                                                       |
| `approvals/service.ts`        | Creates requests, parks runs until a decision, enforces session/hash/expiry, records outcomes.     |
| `approvals/revert.ts`         | Undo of a recorded file change, refused if the file changed since.                                 |
| `repositories/approvals.ts`   | Compare-and-set transitions (`UPDATE … WHERE status = ?`); startup cancellation of orphans.        |
| `repositories/fileChanges.ts` | Applied changes with previous content, for undo.                                                   |
| `tools/fileTools.ts`          | `edit_file`, `write_file`, `delete_file`, `move_file` (prepare/apply, atomic writes, diffs).       |
| `tools/commandTool.ts`        | `run_command` proposal and result formatting.                                                      |
| `commands/runner.ts`          | Process execution: no shell unless requested, allowlisted env, process-group kill, output capture. |
| `commands/risk.ts`            | Informational risk notes shown on command approvals.                                               |

The registry refuses to register a protected tool that has a direct `execute`, so there is no code path that runs
one without `prepare` and approval.

**Task permissions** (`approvals/taskPermission.ts`) add one branch before the wait: if the run holds an active
permission and `covers(permission, tool, proposal)` matches the prepared proposal (files created/modified within the
listed paths, or an exact listed argv in the project root without shell or network, never high risk or a typed
confirmation), `ApprovalService.approveByPermission` moves the approval to `approved` with `granted_by` pointing at the
user's grant, and execution continues through the same re-check and apply path. A permission is held in memory on the
active run, so it can never outlive it. It is created by approving `request_task_permissions` (scope proposed by the
model) or by approving an action with `allowSimilar` (scope = exactly that action, see `similarScope`), and ends on
revoke, expiry, its action limit, replacement, or the end of the run. `task_permission` run events carry its state to
the UI.

**Notices** (`GET /api/events`): `RunManager.onNotice` broadcasts `approval_requested` (only for approvals waiting on
the user) and `run_finished` for every conversation; the web app turns them into system notifications
(`lib/notifications.ts`, `lib/useAppNotices.ts`).

### Command sandbox (`sandbox/docker.ts`)

When a project's `sandbox` setting is enabled, `run_command.prepare` checks Docker and the image (refusing otherwise),
scans for credentials and records `details.sandbox` for the card; `apply` scans again and runs
`docker run` built by `dockerRunArgs` (a pure function, tested argument by argument) through the same `runProcess`
used for host commands, then removes the container on timeout or cancel. Output paths under `/workspace` are mapped back
to project paths before error locations are extracted. Startup detects Docker (`ToolEnvironment.docker`) and removes
containers labelled with this instance's id (a hash of the data folder). Routes: `GET/PUT /api/projects/:id/sandbox`
and `POST /api/projects/:id/sandbox/pull` (user action).

### Background processes (`processes/manager.ts`, `tools/processTools.ts`)

`ProcessManager` (one per server, in memory) spawns approved `start_process` commands detached in their own process
group. Commands run on the host, or as `docker run` with `--publish 127.0.0.1:p:p` in a sandboxed project. Each gets
the `FRIDAY_BACKGROUND=<instance>:<id>` marker in its environment. The manager keeps the last 256 KB of output
(ANSI stripped) with a cursor for incremental reads, and records the local URLs it sees. `waitFor` resolves on ready
text or URL, exit, timeout or cancel. `stop` sends SIGTERM to the group (or `docker stop`), then SIGKILL. `onChange`
feeds `process_updated` notices on `/api/events`. The routes (`routes/processes.ts`: list, output, stop, dismiss) can
never start a process. The server's `onClose` stops everything. Startup's `reapOrphans` kills leftover processes that
carry the marker. `run_command` and `start_process` share `prepareCommand` (folder, risk, sandbox checks). The system
prompt lists each process's current status, so the model does not trust stale history.

### Documents (`documents/`, `tools/documentTools.ts`)

`documents/markdown.ts` parses the supported Markdown subset into blocks. Both `html.ts` (print HTML with the
built-in style, printed with `CaptureEngine.printPdf`: DevTools `Page.printToPDF` with scripts disabled and `Fetch`
refusing everything, or `webContents.printToPDF` in the desktop shell's offline `friday-print` session) and
`docx.ts` (the `docx` library) render from those blocks. `office.ts` renders Excel (`write-excel-file`) and
PowerPoint (`pptxgenjs`, LAYOUT_WIDE with a title slide and a content master). The tools resolve the target with
`resolveForWrite` and fingerprint only the target's current content: Office files embed timestamps, so they are
rendered in `apply`, which also does the atomic write and `recordFileChange`, keeping undo working. Routes: `GET
/api/projects/:id/download` (documents and images) and `POST /api/projects/:id/open` (desktop: `open_path` over the
utility-process channel).

### Screenshots and preview (`browser/`, `tools/screenshotTool.ts`, `routes/preview.ts`)

`detectCaptureEngine` picks the engine at startup. Under the desktop shell (`FRIDAY_DESKTOP_CAPTURE=1` and a parent
port) it is `DesktopEngine`, which sends `{type: 'capture'}` over the utility-process channel. `apps/desktop/src/capture.ts`
loads the page in an offscreen `BrowserWindow` using the `friday-capture` partition, sizes it for full-page captures
and replies with a PNG (JPEG above 4 MB). Otherwise it is `ChromeEngine`, which spawns an installed browser headless
with a temporary profile and drives it over the DevTools protocol with Node's built-in WebSocket. That uses `Fetch`
interception for document requests, `Emulation` for size, `Page.getLayoutMetrics` for full page, and console,
exception and network events as "problems". `screenshot` returns the image through `ToolOutput.images`. It is
stored as an attachment of the tool message and sent in `tool_finished.attachments`, so the conversation shows it at
once. The preview pane is an iframe (loopback `frame-src`). `POST /api/preview/screenshot` captures a page into a
pending attachment for the composer. `GET /api/projects/:id/raw` serves image files for the file viewer.

### Load tests (`loadtest/`, `tools/loadTestTools.ts`, `routes/loadTargets.ts`)

`script.ts` turns a `LoadPlan` into a k6 script: a `constant-vus` or `ramping-vus` scenario, `maxRedirects: 0`, the
user's thresholds, and always-passing per-request thresholds so that k6 reports each request. Checks named
`status:<request>:<code>` and, once per virtual user, `body:<request>:<code>:<text>` turn k6's check totals into
status-code counts and answer samples. `handleSummary` writes the summary JSON where `--env FRIDAY_SUMMARY` says;
`summary.ts` reads it. `k6.ts` finds the binary and builds the argv. `run_load_test` resolves the target (this
machine, or `LoadTargetRepo`, stored under the `loadTargets` setting) and enforces its limits. It records the
result in `load_tests` (migration 24, emitted as `load_test`) for the Load test card.

### Voice (`voice/`, `routes/voice.ts`)

`models.ts` pins Kokoro 82M and Whisper base (8-bit ONNX) to Hugging Face revisions with each file's size and
SHA-256, and `VoiceModelStore` downloads them on request into `<data>/voice-models/<repo>/` (the layout
transformers.js reads with remote loading off). `engine.ts` runs `kokoro-js` and the transformers.js speech
recognition pipeline in one `eval` worker thread, loaded from the packages' CommonJS entries. Jobs run one at a time,
a job whose request was closed is skipped, and the worker stops after 5 idle minutes. `spoken.ts` writes the spoken
version of a reply (one non-streamed `complete` call, operation `spoken_reply`), cleans it, and splits it into
chunks that grow by 1.3× from 100 characters so synthesis stays ahead of playback. `service.ts` ties these together
with the voice settings (setting `voice`) and `spoken_replies` (migration 25, one row per run). Routes:
`GET /api/voice`, `POST|DELETE /api/voice/models/:id`, `PUT /api/voice/settings`, `POST /api/voice/speak` (WAV out),
`POST /api/voice/transcribe` (16 kHz WAV in), `POST /api/sessions/:id/runs/:runId/spoken`. On the web side,
`lib/voice.ts` holds the player (Web Audio, all chunks requested back to back, abortable), the recorder
(MediaRecorder, decoded and resampled to 16 kHz WAV in the browser) and the status; `VoiceControls.tsx` and
`VoiceSettings.tsx` are the composer buttons and the settings section.

### Databases (`databases/`, `tools/databaseTools.ts`, `routes/databases.ts`)

`db_connections` (migration 23) holds where to connect and the name of the secret variable. `DatabaseService`
picks the connections a conversation may use (any-conversation ones, plus its project's own) and builds a
`DbTarget` when connecting. It reads the variable from the project's `.env`, Friday's config file (`util.parseEnv`,
read fresh each time) or the environment, and resolves the SQLite path. `clients.ts` opens a new connection per call
with `pg` or `mysql2` (both pinned), or a worker thread running `node:sqlite` for SQLite, and closes it afterwards.
Postgres limits rows with a cursor (`DECLARE … CURSOR FOR` then `FETCH n+1`); MySQL streams rows and drops the
connection at the limit. `query_database` runs `classifySql`, then `explain`, then shows the card, then `runQuery`
(resolving the secret again). It formats rows as a table with sensitive column names masked. `database_schema`
queries `pg_catalog` / `information_schema` / `sqlite_schema` and pragmas with parameters. The run loop counts tool
failures once per model turn, and `query_database` refuses to run in the same turn as `database_schema`, so a
batch of guesses written before the schema was seen gets corrected instead of stopping the run.

Tests in `test/databases.test.ts` run against real servers when `FRIDAY_TEST_PG_PORT` / `FRIDAY_TEST_PG_PASSWORD`
(user `postgres`, database `shop`) and `FRIDAY_TEST_MYSQL_PORT` / `FRIDAY_TEST_MYSQL_PASSWORD` (user `reader`) are
set, with a `users` table of 250 rows and an `orders` table.

Browser flows (`browser/flow.ts`, `tools/browserTools.ts`, `repositories/browserFlows.ts`): engines with
`openPage` return a `PageSession` (send a DevTools command, receive its events, close). `ChromeEngine` launches a
headless browser per flow with `Fetch` interception for documents, closes other targets and denies downloads.
`DesktopEngine` relays `page_open` / `page_send` / `page_close` over the utility-process channel. The shell opens an
offscreen window in the capture partition, loads `about:blank`, attaches `webContents.debugger`, relays an allowlist
of methods and their events, and answers `Page.captureScreenshot` with `capturePage()`. `PageDriver` tracks
requests, loads, console, exceptions and dialogs, and implements the steps. It finds elements with an in-page
script (an accessible-name approximation over the DOM and open shadow roots) and waits until one is unique, shown,
enabled, not covered and stable over two painted frames. It clicks with `Input.dispatchMouseEvent`, checks the press
arrived (input sent before a new page has painted can be dropped) and retries if not, and types with
`Input.insertText`. `runFlow` runs the steps with a JPEG screenshot after each. `run_browser_flow` (category
`browser`) stores every screenshot as a conversation attachment that is not bound to the tool message, records the
flow in `browser_flows` (migration 22) and emits `browser_flow`. Only the failing or last screenshot is bound to the
tool message, so only that one goes to the model. Pending-upload cleanup skips attachments that have a session.
Task permissions gain `sites`, and `buildRunReport` counts flows as checks.

Before and after (`visual/`, `repositories/captures.ts`): each screenshot is stored at once through
`ToolContext.captures`, and recorded in `page_captures` (migration 16) with its URL and size. Its `ToolImage`
carries the `attachmentId`, so the tool message binds the stored image rather than storing it again. With
`compare`, the tool looks up the latest earlier capture of the same page and size in the conversation. It decodes
both images with `visual/png.ts`, a minimal PNG codec on `zlib` (8-bit, non-interlaced). `visual/diff.ts` compares
them by YIQ colour distance (threshold 0.05) and groups changed 8×8 blocks into regions. The tool then stores the
highlighted image and records the comparison. `buildRunReport` adds `visuals` from the task's captures, and runs
that compared screenshots get a report even without approvals.

### Connected apps (`mcp/`, `routes/mcp.ts`)

`McpManager` wraps the official SDK (`@modelcontextprotocol/sdk`, pinned). Each server gets a `Client` over
`StreamableHTTPClientTransport`, with either an `Authorization: Bearer` header (static token) or an
`OAuthClientProvider` backed by `mcp_servers.oauth` (migration 12). The provider stores the client registration
(re-registered when the redirect URL's port changes), tokens, PKCE verifier and discovery state. A connection
attempt that needs sign-in captures the authorization URL and returns it to Settings, which opens it in the browser
(the desktop app hands it to the system browser). The app redirects to `/oauth/mcp/callback`, which matches the
single-use `state` to a pending sign-in, exchanges the code with the SDK's `auth()`, connects and lists tools (all
pages, at most 200). Tool lists are stored, so runs never wait on the network for them. Each run's registry is the
built-in tools plus `mcpToolSpecs()` (`registry.withExtra`): tools named `mcp__<app>__<tool>` carry the server's
`inputSchema` as their parameters (`ToolSpec.parameters`). Their category is `mcp` (prepare and approval card) or
`mcp_trusted` (execute). Results become text, plus images through the `view_image` path; `isError` becomes a tool
error. Changes are broadcast as `mcp_updated` notices.

### Code map (`codemap/`, `tools/codeMapTools.ts`)

`codemap/extract.ts` finds definitions with per-language line patterns. A stack of open containers, tracked by
indentation, attributes members to their class, impl or module, and skips everything inside function bodies.
Multi-line signatures (`): T {`, `}> {`), Allman braces and block comments are handled. `CodeMap` (migration 11:
`code_files`, `code_symbols`, cascading with the project) refreshes on demand. It walks like the file tree (one
`stat` per file via `walk`), re-reads only files whose size or mtime changed, deletes removed ones, and writes in
batched transactions. Limits are 30,000 files and 512 KB per file. A refresh is reused for 15 s. Any approved action
(and an undo) invalidates it, so line numbers follow Friday's own edits. `renderOutline` picks the most detailed
level that fits the output budget: signatures, then names per file, then a per-folder summary. `find` ranks exact,
then case-insensitive, then prefix, then substring matches, exported definitions first. `find_symbol` references
come from the existing search (ripgrep or built-in), filtered to whole words, with definition lines excluded.
Routes: `GET /api/projects/:id/codemap` and `POST /api/projects/:id/codemap/rebuild`.

### Images (`attachments/`, `routes/attachments.ts`, `tools/imageTools.ts`)

`POST /api/attachments` takes a raw image body. `attachments/image.ts` derives the type and size from the bytes and
applies the limits. The `attachments` table (migration 10) stores the bytes with `message_id` NULL until
`POST /api/sessions/:id/messages` sends them with `attachmentIds`. Then `RunManager.startMessage` checks that they are
unsent, belong to this conversation, number at most 4, and that the model is not known to refuse images, and binds
them to the user message. `MessageDto.attachments` carries metadata only; the bytes are served by
`GET /api/attachments/:id`. When building context, `withImages` attaches images (`ChatMessage.images`, sent as
OpenAI `image_url` data URLs) to the 3 most recent messages that have any and replaces older ones with a note.
`view_image` results carry `ToolOutput.images`; they are stored as attachments of the tool message and sent in a
synthetic user message right after the tool results, since chat APIs only accept images from the user. A provider
`bad_request` or `unsupported` error on a request with images marks the model's `imageInput` capability unsupported.
The probe sends a 16×16 red PNG. The web app downsizes images (`lib/images.ts`) and uploads them as soon as they are
pasted, dropped or picked.

## Coding agent (Phase 4)

| Module                      | Responsibility                                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git/git.ts`                | Single entry point for git: hardened `-c` overrides, scrubbed env, `GIT_OPTIONAL_LOCKS=0`, porcelain v2 parsing, secret-diff hiding, repo-root check.                                                                                                                         |
| `tools/gitTools.ts`         | Read-only git tools plus approval-gated `git_commit` and `git_create_branch`.                                                                                                                                                                                                 |
| `ci/logs.ts`                | GitHub Actions job logs: timestamps and colours stripped, steps split, the first real error found, runner paths made relative.                                                                                                                                                |
| `tools/ciTools.ts`          | Read-only `ci_runs` and `ci_failure` over GitHub's REST API through `gh api` (GET only).                                                                                                                                                                                      |
| `git/github.ts`             | Remote URL parsing (credentials stripped for display) and the `gh` runner (neutral folder, explicit `--repo`, no prompts).                                                                                                                                                    |
| `tools/remoteGitTools.ts`   | Approval-gated `git_push` and `create_pull_request`: default-branch and force guards, push plan from local refs, report section from records.                                                                                                                                 |
| `tools/fileTools.ts`        | Shared write/edit planners; `edit_files` applies a set of plans and restores them all if one fails.                                                                                                                                                                           |
| `commands/locations.ts`     | `file:line` extraction from tool output; verification-command classification.                                                                                                                                                                                                 |
| `reports/runReport.ts`      | Checkpoints, verification reports, task chains (`taskRunIds`), and resumption context.                                                                                                                                                                                        |
| `tools/reviewTools.ts`      | `review_changes` (diff and changed line ranges per target) and `report_findings` (location and suggestion checks, refusals, `ReviewRepo`).                                                                                                                                    |
| `tools/savedActionTools.ts` | `list_saved_actions` and approval-gated `run_saved_action` (each step via `runPrepared` locally or `ssh.run`); actions are edited only through `routes/savedActions.ts` (`SavedActionRepo`).                                                                                  |
| `compose/compose.ts`        | Compose file resolution (default file + override), `config` parsing (no env values), ownership by config-file label, health verdicts, port probes.                                                                                                                            |
| `tools/composeTools.ts`     | Read-only `compose_status` (status, logs) and approval-gated `compose_control` (up/start/stop/restart/down; pull, build, volume removal).                                                                                                                                     |
| `monitors/checks.ts`        | Health monitor checks: HTTP GET (same-host redirects, capped body), fixed SSH script, background process and compose service state.                                                                                                                                           |
| `monitors/service.ts`       | `MonitorService`: timer, due monitors four at a time, one check per monitor at a time, change listeners (`monitor_updated` notices).                                                                                                                                          |
| `repositories/monitors.ts`  | `MonitorRepo`: monitors, bounded check history and status changes; up/down transitions after N failures in a row.                                                                                                                                                             |
| `tools/monitorTools.ts`     | Read-only `monitor_status`; monitors are edited only through `routes/monitors.ts`.                                                                                                                                                                                            |
| `deps/`                     | Dependency upgrades: versions and advisory ranges (`versions.ts`), manifests and lockfiles incl. npm workspaces (`manifests.ts`), npm view / Packagist (`registry.ts`), audits (`audit.ts`), targets under the age rule (`report.ts`), GitHub release notes (`changelog.ts`). |
| `tools/dependencyTools.ts`  | Read-only `dependency_report` and `dependency_changelog`; approval-gated `upgrade_dependencies` (commands via `prepareCommand`/`runPrepared`, file changes recorded).                                                                                                         |
| `browser/flow.ts`           | Browser flows: step types and descriptions, in-page element finding and page outline, `PageDriver` (waits, clicks, typing, dialogs, problems), `runFlow`.                                                                                                                     |
| `loadtest/`                 | k6 load tests: script generation from a plan (`script.ts`), summary parsing incl. status counts and answer samples (`summary.ts`), finding k6 and its argv (`k6.ts`).                                                                                                         |
| `voice/`                    | Voice: pinned model downloads (`models.ts`), Kokoro and Whisper in a worker (`engine.ts`), the spoken version and its chunks (`spoken.ts`), WAV in and out (`wav.ts`), `VoiceService` (`service.ts`).                                                                         |
| `tools/loadTestTools.ts`    | Approval-gated `run_load_test`: target resolution (this machine or listed targets), limits, risk, the card, running k6 and recording the result.                                                                                                                              |
| `databases/`                | Read-only databases: statement check (`sql.ts`), Postgres/MySQL/SQLite clients with read-only sessions, row and time limits, `EXPLAIN` and connection tests (`clients.ts`), connections and secrets by variable name (`service.ts`).                                          |
| `tools/databaseTools.ts`    | Read-only `database_schema` (catalog queries); approval-gated `query_database` (category `database`, production confirmation, masked columns).                                                                                                                                |
| `tools/browserTools.ts`     | Read-only `inspect_page`; approval-gated `run_browser_flow` (flat step schema, local-only checks, screenshots stored per step, `BrowserFlowRepo`).                                                                                                                            |
| `refactor/`                 | Rename and move: comment/string-aware scanner (`lexer.ts`), imports per language (`modules.ts`), reference split (`references.ts`), TS/JS move planner (`move.ts`).                                                                                                           |
| `tools/refactorTools.ts`    | `find_references`, and approval-gated `rename_symbol` and `move_symbol` (one all-or-nothing multi-file change, `applyAll`).                                                                                                                                                   |
| `testing/`                  | Test insights: suite detection incl. Playwright beside unit tests (`suites.ts`), changed lines and the code fingerprint (`changes.ts`), report parsers incl. Playwright JSON (`results.ts`).                                                                                  |
| `tools/testTools.ts`        | `detect_tests` and approval-gated `run_tests`: builds the command, re-runs failures once (Playwright retries itself), history (`TestRunRepo`), changed-line coverage, Playwright screenshots, traces and page snapshots.                                                      |
| `worktree/manager.ts`       | Task worktrees: `git worktree add` from the parent's HEAD, dependency links, accept (commit, then merge/squash/keep) and discard.                                                                                                                                             |
| `reports/export.ts`         | A conversation as Markdown (summary or full); `routes/export.ts` serves it, or prints it to PDF through the document renderer.                                                                                                                                                |

A _task_ is a run plus the unfinished runs (interrupted, failed, blocked, cancelled) it directly continues. Reports
and rollback operate on the task. Checkpoints are written after every executed approval, not only at the end of a
model turn, so a crash between two actions in one turn loses nothing.

## DevOps agent (Phase 5)

| Module                   | Responsibility                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools/devopsTools.ts`   | `inspect_environment`, `search_logs`, `inspect_docker`, `validate_config`, `prepare_deployment_plan`, `remote_diagnose`, `remote_command`. |
| `ssh/ssh.ts`             | ssh option set, host-key scanning and trust, per-host known_hosts, remote execution via `runProcess`.                                      |
| `repositories/devops.ts` | SSH hosts (with trusted key lines), authorized log sources, deployment plans.                                                              |
| `http/routes/devops.ts`  | The only way to add hosts, trust keys, test connections, and authorize log sources.                                                        |
| `workspace/jsonCheck.ts` | JSON syntax errors with line/column (engine messages vary).                                                                                |

Production safeguards live in three places: `remote_command.prepare` (plan required, `deployment` category, risk
floor, `confirmationRequired`, short TTL), `ApprovalService.decide` (rejects approval without the exact typed text),
and the approval card (Approve disabled until it matches). Tool schemas are counted against the context budget.

## Memory (Phase 6)

| Module                     | Responsibility                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `repositories/memories.ts` | Memories table, FTS5 index (kept in sync by triggers), visibility filter, usage records.                     |
| `memory/service.ts`        | Write policy (`rejectReason`, dedup, replacement, pending preferences), settings, retrieval, prompt section. |
| `tools/memoryTools.ts`     | `remember` (with the evidence-ordering rule) and `search_memory`.                                            |
| `workspace/guidance.ts`    | Reads AGENTS.md / CLAUDE.md / .friday/memory.md through `resolveInside` for an untrusted prompt section.     |
| `http/routes/memory.ts`    | Browse/search/create/edit/pin/approve/delete, settings, export.                                              |

Visibility is a single SQL predicate (`VISIBLE` in `memories.ts`) used by every read path the model can reach, so a
session can only ever see user memories, its own project's, its own session notes, and operational notes for its
project or with no project.

## Web (`apps/web/src`)

- `lib/api.ts` is a typed fetch client. It adds the `x-friday-client` header on mutating requests.
- `lib/useRunStream.ts` wraps `EventSource` with automatic reconnect and de-duplication by `seq`.
- `components/` contains Sidebar (project switcher), ChatView (messages, tool activity groups, live run, approval cards, run records, error/retry/continue card, composer), SidePanel (plan, changes with undo, file explorer), ApprovalCard and DiffView, RunSummary (verification report and rollback), DeploymentPlanCard, DevopsSettings (SSH hosts, log sources), MemoryDialog, MemoriesUsed, AddProjectDialog, SettingsDialog, and
  small shadcn-style primitives (`ui/`) built on native elements such as `<dialog>`.
- Markdown is rendered with react-markdown, GFM, and highlight.js. Raw HTML in model output is not rendered. The
  renderer and the file viewer's highlighter are separate chunks loaded on demand (the renderer is prefetched when the
  app is idle), which keeps the initial bundle at about a third of its former size.
- `lib/desktop.ts` describes the optional desktop bridge (`window.fridayDesktop`); it is `null` in the browser.

## Desktop (`apps/desktop`, Phase 7)

```
Electron main process                     utilityProcess                       Renderer (sandboxed)
┌─────────────────────────────┐  fork   ┌───────────────────────────┐  HTTP   ┌──────────────────────┐
│ launch token, paths, menu;  │ ──────▶ │ server bundle (index.mjs) │ ◀────── │ same React UI as the │
│ server reports its port     │         │ FRIDAY_LAUNCH_TOKEN set:  │  + SSE  │ web app; preload adds│
│ webRequest adds x-friday-   │         │ every request must carry  │         │ fridayDesktop bridge │
│ token to app requests only  │         │ the token                 │         │ (4 IPC calls)        │
└─────────────────────────────┘         └───────────────────────────┘         └──────────────────────┘
```

- The server is the same code as the web version, bundled by esbuild into one ESM file
  (`apps/desktop/scripts/bundle-server.mjs`) that runs on Electron's bundled Node. The only `node_modules` shipped
  are the voice packages, which the server loads at runtime: the script copies `kokoro-js` and what it needs at
  runtime (transformers.js, ONNX Runtime and sharp, both N-API, for this platform only, and the English voices).
- `main.ts` resolves paths (packaged: `~/.config/Friday/{friday.env,data,logs}`, resources for the server and UI;
  from a checkout: the repository's `.env` and `.data`), starts the server with `FRIDAY_PORT=0`, waits for the server to report the port it bound (over the
  utility-process message channel, so no other program can take the port in between), and loads the UI
  from the server's origin. Server output goes to `logs/server.log`; a crash shows the log tail with a restart option.
- Quitting sends SIGTERM and waits (up to 8 s) for the server to finish in-flight work and close the database.
- `electron-builder.yml` produces an AppImage and a deb, with Electron fuses set (no `ELECTRON_RUN_AS_NODE`, no
  `NODE_OPTIONS` or inspector flags, asar integrity checks, app loaded only from the asar).

## Testing

- `apps/server/test/*.test.ts` covers provider behaviour through the **real OpenAI SDK** with an injected `fetch` that
  serves canned JSON and SSE responses, the run manager with a scripted provider, migrations and recovery against real
  SQLite files, and HTTP routes through `fastify.inject`.
- `apps/web/src/**/*.test.tsx` covers the approval card, diff parsing, the live event reducer, and run records
  with Testing Library in jsdom.
- `apps/server/test/integration/` holds the opt-in live tests, excluded unless `NTL_INTEGRATION=1`:
  `notokenlimit.int.test.ts` (models, streaming, capabilities) and `e2e.int.test.ts`, the full coding cycle over real
  HTTP and SSE on a throwaway sample project (inspect → plan → approval with diff → apply → approval to run tests →
  execute → output → verified report, then an independent `npm test` outside Friday).
