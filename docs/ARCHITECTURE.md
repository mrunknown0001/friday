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
| `repositories/`             | Narrow data-access classes: sessions, messages, runs, settings, capabilities, provider calls, audit.                                                            |
| `providers/types.ts`        | The provider-neutral `LLMProvider` interface and message, tool, and stream-event types.                                                                         |
| `providers/notokenlimit.ts` | OpenAI SDK adapter: request mapping, streaming, tool-call reassembly, idle timeout, response validation, telemetry.                                             |
| `providers/errors.ts`       | Maps any SDK or network failure to a `ProviderError` with a `kind` and a `retryable` flag.                                                                      |
| `providers/retry.ts`        | Bounded exponential backoff with jitter. Retries only transient kinds and honours `Retry-After` (capped).                                                       |
| `providers/capabilities.ts` | Conservative context-window defaults and a live probe for streaming and tool calling.                                                                           |
| `chat/context.ts`           | Token estimation, history fitting (keeps tool-call groups intact), and summarization of history that no longer fits.                                            |
| `chat/runManager.ts`        | Owns run lifecycles: event buffering for SSE replay, cancellation, checkpointing, persistence, one active run per session.                                      |
| `http/`                     | Local-only guards, routes, SSE, and error mapping.                                                                                                              |
| `services.ts`               | Composition root that wires everything together. Tests replace the provider or `fetch` here.                                                                    |

### Provider abstraction

Agent code depends only on `LLMProvider`:

- `streamChat(request)` yields `text`, `tool_call` (complete, with raw JSON arguments), and `finish` events.
- `complete(request)` is non-streaming. It is used for summaries, probes, and models where streaming is unsupported.
- `listModels()`

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

## Coding agent (Phase 4)

| Module                  | Responsibility                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git/git.ts`            | Single entry point for git: hardened `-c` overrides, scrubbed env, `GIT_OPTIONAL_LOCKS=0`, porcelain v2 parsing, secret-diff hiding, repo-root check. |
| `tools/gitTools.ts`     | Read-only git tools plus approval-gated `git_commit` and `git_create_branch`.                                                                         |
| `tools/fileTools.ts`    | Shared write/edit planners; `edit_files` applies a set of plans and restores them all if one fails.                                                   |
| `commands/locations.ts` | `file:line` extraction from tool output; verification-command classification.                                                                         |
| `reports/runReport.ts`  | Checkpoints, verification reports, task chains (`taskRunIds`), and resumption context.                                                                |

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
│ token to app requests only  │         │ the token                 │         │ (3 IPC calls)        │
└─────────────────────────────┘         └───────────────────────────┘         └──────────────────────┘
```

- The server is the same code as the web version, bundled by esbuild into one ESM file
  (`apps/desktop/scripts/bundle-server.mjs`). With `node:sqlite` there is no native module, so the package contains no
  `node_modules` and runs on Electron's bundled Node.
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
