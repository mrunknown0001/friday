# Roadmap and checklist

Status key: ✅ done and tested · 🟡 partial · ⬜ not started

**Current phase: 3 (approval engine).**

## Phase 1: Foundation

- ✅ npm-workspaces monorepo (server, web, shared contract), strict TypeScript, ESLint, Prettier
- ✅ Environment configuration with validation and `.env.example`; secrets are git-ignored
- ✅ SQLite with transactional, append-only migrations
- ✅ `LLMProvider` interface and `NoTokenLimitProvider` (OpenAI SDK): streaming, non-streaming, multi-turn, tool
  definitions, tool-call reassembly, tool-result messages
- ✅ Error classification (auth, permission, rate limit, quota, timeout, network, bad request, model not found,
  unsupported, server, malformed, cancelled) with secret redaction
- ✅ Bounded retry with backoff for transient errors only; stream idle timeout; cancellation
- ✅ Provider-call telemetry (model, operation, duration, status, attempts, token usage; no prompt content)
- ✅ Model selection (env default, Settings override) validated against the provider model list
- ✅ Connection test (a real completion) and capability probe (streaming and tool calling)
- ✅ Context-window management: history fitting and LLM summarization with a persisted watermark
- ✅ Persistent sessions and messages; SSE streaming with replay; stop, retry, and interrupted-run recovery
- ✅ Local-only HTTP hardening (Host, Origin, Sec-Fetch-Site, CSRF header, CSP)
- ✅ Chat UI: sessions sidebar (new, rename, delete), Markdown and code highlighting with copy, live phases, error and
  retry card, settings
- ✅ 56 automated tests (provider via the real SDK, run manager, context, migrations and recovery, HTTP)
- ✅ Live NoTokenLimit integration test passed on 2026-10-29 with `claude-haiku-4.5`: model listing, streamed
  completion, and capability probe (streaming: supported, tool calling: supported)
- ⬜ Frontend unit tests. These start in Phase 3 alongside approval-card flows. Phase 1 UI was checked manually in
  headless Chromium against a local mock.

## Phase 2: Read-only coding agent

- ✅ Projects: authorize a folder (canonical root, broad/system locations refused), switch projects, sessions
  permanently bound to one project, remove a project without touching files
- ✅ Workspace tools: `inspect_project`, `list_directory`, `find_files`, `search_code` (ripgrep, literal fallback),
  `read_file` (line ranges), `file_info`, plus `update_plan`
- ✅ Path confinement: traversal, absolute-path and symlink escapes blocked; `.gitignore` (nested) and default
  exclusions honoured; binary and oversized files handled; credential files and `.git` internals never read
- ✅ Tool registry: zod schemas → JSON Schema for the model; permission category and risk per tool; backend policy
  check on every call; unknown and non-read-only tools denied
- ✅ Agent loop: tool calls → validate → execute → observe; limits on iterations, tool calls, output size, per-tool
  timeout; duplicate-call and consecutive-failure detection; cancellation between and during tools; `blocked` status
  with Continue
- ✅ Tool history persisted (assistant tool calls, tool results, execution metadata) and repaired if a run died
  mid-tool; older tool output clipped to fit the context window
- ✅ UI: project switcher and authorization dialog, tool activity timeline (expandable output), plan checklist,
  read-only file explorer with syntax-highlighted viewer
- ✅ 102 automated tests (46 new: path security, walking, detection, search on both engines, tool executor, agent loop,
  project routes)
- ✅ Verified live on 2026-10-29 with `claude-haiku-4.5`: the agent used 6 real tool calls to find a planted bug in a
  disposable sample project and cited `src/cart.js:5`; `.env` contents never reached the model or database

## Phase 3: Approval engine

- ⬜ Approval state machine (pending → approved, rejected, expired, or cancelled → executed) bound to an action hash,
  session, and project
- ⬜ Diff generation, approval cards (file edits, commands), backend enforcement, audit trail
- ⬜ File create/modify/delete/move with external-change detection and backups
- ⬜ Command execution: argv-first, explicit shell mode, timeouts, output caps, cancellation, environment scrubbing
- ⬜ Frontend tests for approval flows

## Phase 4: Coding agent

- ⬜ Multi-file edits, test execution, error interpretation, git status/diff/log
- ⬜ Task checkpoints, verification reports, rollback

## Phase 5: DevOps agent

- ⬜ Environment diagnostics, logs, Docker inspection, CI/CD generation, deployment plans
- ⬜ SSH host configuration (keys only), remote diagnostics, production safeguards with fresh approvals

## Phase 6: Memory

- ⬜ User, project, session, and operational memory with a write policy, secret filtering, deduplication, pinning,
  editing, deletion, search, and "memories used" disclosure

## Phase 7: Polish and hardening

- ⬜ Electron shell (context isolation, no renderer Node, preload bridge, per-launch API token)
- ⬜ Security review, accessibility pass, performance (code-split highlight.js), installer and docs
