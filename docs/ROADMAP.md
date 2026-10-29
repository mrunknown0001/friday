# Roadmap and checklist

Status key: ✅ done and tested · 🟡 partial · ⬜ not started

**Current phase: 7 (polish and hardening).**

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

- ✅ Permission policy: read-only and plan tools run directly; file create/modify/delete/move and commands require
  per-action approval; git, network, remote, database, and deployment are denied; unknown tools are denied
- ✅ Approval state machine (pending → approved | rejected | expired | cancelled; approved → executed | failed |
  stale) with compare-and-set transitions, so decisions cannot be replayed
- ✅ Approvals bound to a SHA-256 action hash (approval id, session, project root, tool, canonical args, observed
  preconditions); the client must echo the reviewed hash; preconditions re-checked before execution (stale detection)
- ✅ Expiry, cancellation, and server-restart handling (orphaned approvals cancelled at startup)
- ✅ File tools: `edit_file` (exact replacement), `write_file`, `delete_file`, `move_file`; atomic writes; credential
  files and symlink escapes refused; previous content kept; user-initiated **Undo** that refuses to clobber later edits
- ✅ `run_command`: argv-first, explicit `/bin/sh` mode, closed stdin, allowlisted environment, per-command timeout,
  process-group kill on timeout or cancel, head+tail output capture, live output streaming, risk assessment
- ✅ Approval UI: line-numbered diff viewer, command card, countdown, approve once / reject with note / cancel run;
  pending approvals survive a page reload; changes panel with Undo; run record built from logs
- ✅ Audit trail: requested, approved, rejected, expired, executed, failed, stale, reverted
- ✅ Tests: 124 server (19 new approval tests plus HTTP approval/undo tests) and 11 frontend (approval card, diff
  parser, live event reducer, run record)
- ✅ Verified live on 2026-10-29 with `claude-haiku-4.5` in a browser: edit approved and applied, `npm test`
  approved (real exit 1), corrected test command approved (exit 0), a deletion rejected with a note, edit undone

## Phase 4: Coding agent

- ✅ Git inspection tools: `git_status` (porcelain v2), `git_diff` (working tree, staged, against a ref, stat), `git_log`,
  `git_show`, `git_branches`; credential-file diffs hidden; refs validated and `--end-of-options` used
- ✅ Git hardening: `core.fsmonitor`, external diff and textconv drivers, pager, credential helper and hooks
  neutralised for inspection; the project root must be the repository top level
- ✅ `git_commit` (exact paths only via `git commit --only`; other staged work untouched; credential files refused;
  hooks disclosed) and `git_create_branch`, both approval-gated with stale detection
- ✅ Multi-file edits: `edit_files` with a single approval and all-or-nothing application
- ✅ Error interpretation: failing commands list the project `file:line` locations referenced in their output
- ✅ Task checkpoints after every executed action; resumption context for the next attempt; tasks spanning several
  attempts are reported and rolled back as one
- ✅ Verification reports from records (verified / failed / unverified / no changes, drift detection, commits) and
  whole-run rollback
- ✅ Tests: 145 server (21 new in `phase4.test.ts`, including a malicious-repository test) and 15 frontend
- ✅ Verified live on 2026-10-29 with `claude-haiku-4.5`: branch → edit → `npm test` (exit 0) → commit in a real git
  repo with a "verified" report; and a `kill -9` mid-task followed by a restart and resume that did not redo the edit

## Phase 5: DevOps agent

- ✅ Environment diagnostics (`inspect_environment`): OS, CPU, memory, disk, 16 runtime/service probes, no env vars
- ✅ Logs (`search_logs`): project logs and user-authorized log sources, tail-only reads, filtering, redaction
- ✅ Docker (`inspect_docker`): containers, images, compose, logs, sanitized inspect (no env values)
- ✅ CI/CD and config validation (`validate_config`): YAML/JSON with line numbers, GitHub Actions and Compose security
  checks; generation uses the approval-gated file tools
- ✅ Deployment planning (`prepare_deployment_plan`): validated plans (backups for data changes, rollback and
  verification for staging/production, host/environment consistency), shown live as a plan card
- ✅ SSH configuration: hosts added only via the UI/API (no passwords or key material accepted), host-key scan with
  fingerprint verification and explicit trust, per-host strict known_hosts, isolated ssh options, connection test
- ✅ Remote tools: `remote_diagnose` (templated read-only checks with validated targets) and `remote_command`, both
  approval-gated
- ✅ Production safeguards: recorded plan required, typed host-name confirmation enforced by the server, 5-minute
  approval TTL, `deployment` category with risk floor; staging risk floor; audit trail
- ✅ Tests: 167 server (22 new in `devops.test.ts`) and 20 frontend
- ✅ Verified live on 2026-10-29 against a disposable OpenSSH container: scan/trust/test, three remote diagnostics,
  a production plan, and a typed-confirmation production command (file created on the server), with
  `claude-sonnet-4.6`. `claude-haiku-4.5` stopped after its first tool call in both attempts.

## Phase 6: Memory

- ✅ User, project, session and operational memory in SQLite with an FTS5 index (BM25 ranking)
- ✅ Backend write policy: secrets (patterns, natural-language "password is…", credential URLs, random tokens), code
  and junk refused; deduplication with confidence upgrade; explicit replacement (`replaces_id`); user preferences
  pending until approved; per-scope caps; evidence ordering (no "confirmed" facts from unseen results)
- ✅ Retrieval: pinned, approved preferences, session notes, and relevant memories within a token budget, marked as
  possibly outdated; usage recorded per run and disclosed in the UI ("Used N saved memories")
- ✅ Isolation: project memories only in that project's sessions, session notes only in that session; project removal
  deletes its memories
- ✅ Memory manager: search, filter, edit, pin, delete, approve/reject, add, global and per-project disable, export to
  `.friday/memory.md`; repository guidance files read as untrusted context
- ✅ Session recovery (from Phases 1–4): persisted history, summaries, checkpoints and resume context
- ✅ Tests: 190 server (14 in `memory.test.ts`, 9 in `suggestions.test.ts`) and 26 frontend
- ✅ Verified live on 2026-10-29 with `claude-sonnet-4.6` across two projects: memory saved, preference approved,
  reused and disclosed in a new conversation, and not visible in the other project
- ✅ Suggested next steps: record-based chips (failing check, unverified changes, drifted files, uncommitted work,
  next plan step, pending memories) plus up to three model chips via `suggest_next_steps`, redacted and deduplicated
  by intent; no extra model call. Verified live on 2026-10-29: the "Review & commit" chip led to an approved commit

## Phase 7: Polish and hardening

- ✅ SQLite moved to Node's built-in `node:sqlite` (FTS5 included): no native modules, same code under Node and Electron
- ✅ Electron shell (Electron 44): sandboxed renderer with context isolation and no Node, three-call preload bridge
  with sender checks, per-launch token added at the network layer, navigation/pop-up/permission lockdown, fuses,
  server in a utility process that binds its own port, crash and startup dialogs, graceful shutdown
- ✅ Desktop configuration: `~/.config/Friday/friday.env` (0600), Settings shows the path with **Show config file**
  and **Restart server**; native folder picker for projects; data-folder lock
- ✅ Linux installers: AppImage and deb via electron-builder (`npm run dist:desktop`)
- ✅ Independent security review; all 9 findings fixed with regression tests (see SECURITY.md, Phase 7)
- ✅ Accessibility: axe-core audit of five screens down to 0 violations (contrast, labels, headings, landmarks, focus,
  target size)
- ✅ Performance: Markdown renderer and highlighter load on demand; initial bundle 840 KB → 357 KB
- ✅ Live end-to-end test of the full coding cycle on a throwaway project (`e2e.int.test.ts`)
- ✅ Docs: desktop install and configuration, backup and restore, recovery table
- ✅ Verified live on 2026-10-29: packaged app and AppImage launch with fuses on; key setup → restart → real
  connection test from the desktop app; end-to-end test passed with `claude-sonnet-4.6`

## After the MVP

- ✅ Scroll-to-latest button in the conversation (with a "new activity" hint)
- ✅ Task permissions: approve a bounded scope (exact files, exact commands, action and time limits) once per task,
  requested by Friday or granted by the user while approving an action; covered actions are still re-checked,
  recorded, undoable and revocable
- ✅ System notifications for approvals waiting and longer tasks finishing, across conversations, via an app-wide
  notice stream; on by default in the desktop app
- ✅ Verified live on 2026-10-30 with `claude-sonnet-4.6`: one approval for the task permission, then the edit and the
  test run were approved automatically and the report was verified; notification raised for a conversation in the
  background and opened it on click; notifications granted and the notice stream connected in the desktop app
- ⬜ Run commands in a container (sandbox), long-running processes, code map for large repos (see the suggestion list)
