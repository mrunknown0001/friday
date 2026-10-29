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

| Module                      | Responsibility                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `config.ts`                 | Validates the environment with zod. Fails fast with variable names only, never values.                                     |
| `db/`                       | Opens SQLite (WAL, foreign keys) and applies append-only migrations, each in its own transaction.                          |
| `repositories/`             | Narrow data-access classes: sessions, messages, runs, settings, capabilities, provider calls, audit.                       |
| `providers/types.ts`        | The provider-neutral `LLMProvider` interface and message, tool, and stream-event types.                                    |
| `providers/notokenlimit.ts` | OpenAI SDK adapter: request mapping, streaming, tool-call reassembly, idle timeout, response validation, telemetry.        |
| `providers/errors.ts`       | Maps any SDK or network failure to a `ProviderError` with a `kind` and a `retryable` flag.                                 |
| `providers/retry.ts`        | Bounded exponential backoff with jitter. Retries only transient kinds and honours `Retry-After` (capped).                  |
| `providers/capabilities.ts` | Conservative context-window defaults and a live probe for streaming and tool calling.                                      |
| `chat/context.ts`           | Token estimation, history fitting (keeps tool-call groups intact), and summarization of history that no longer fits.       |
| `chat/runManager.ts`        | Owns run lifecycles: event buffering for SSE replay, cancellation, checkpointing, persistence, one active run per session. |
| `http/`                     | Local-only guards, routes, SSE, and error mapping.                                                                         |
| `services.ts`               | Composition root that wires everything together. Tests replace the provider or `fetch` here.                               |

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

## Web (`apps/web/src`)

- `lib/api.ts` is a typed fetch client. It adds the `x-friday-client` header on mutating requests.
- `lib/useRunStream.ts` wraps `EventSource` with automatic reconnect and de-duplication by `seq`.
- `components/` contains Sidebar (project switcher), ChatView (messages, tool activity groups, live run, error/retry/continue card, composer), SidePanel (plan and file explorer), AddProjectDialog, SettingsDialog, and
  small shadcn-style primitives (`ui/`) built on native elements such as `<dialog>`.
- Markdown is rendered with react-markdown, GFM, and highlight.js. Raw HTML in model output is not rendered.

## Testing

- `apps/server/test/*.test.ts` covers provider behaviour through the **real OpenAI SDK** with an injected `fetch` that
  serves canned JSON and SSE responses, the run manager with a scripted provider, migrations and recovery against real
  SQLite files, and HTTP routes through `fastify.inject`.
- `apps/server/test/integration/` holds the opt-in live NoTokenLimit test. It is excluded unless `NTL_INTEGRATION=1`.
