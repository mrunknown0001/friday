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
- ✅ Command sandbox: per-project Docker container for `run_command` (project folder only, credentials hidden, `.git`
  read-only, no network by default, no host env, dropped capabilities, read-only root, limits); user-controlled image
  pulls; refuses instead of falling back to the host. Verified live on 2026-10-30 with `claude-sonnet-4.6`: failing
  test, fix and passing test all ran in `node:22-alpine` with the card saying so, the project's `.env` value never
  appeared, and no containers were left behind
- ✅ Background processes: `start_process` (approved), `read_process_output`, `list_processes`, `stop_process`;
  Processes panel with live output, local links and **Stop**; stopped when Friday quits and reaped after a crash.
  Verified live on 2026-10-30 with `claude-sonnet-4.6`: the dev server started after one approval and served
  requests; Friday read only the new log lines through the cursor and stopped the server on request. The UI's
  Output and Stop worked, axe found 0 violations, and after a `kill -9` of Friday the next start stopped the
  orphaned server
- ✅ Image attachments: paste screenshots from the clipboard, drop or pick images (up to 4 per message, downsized in
  the app), thumbnails with a full-size view; `view_image` for project image files; image-input capability probe.
  Verified live on 2026-10-30 with `claude-sonnet-4.6`: a pasted 2560×1440 checkout screenshot (stored as 1430×804)
  was described from what was visible, `view_image` read a mockup's button label, colour and error text correctly,
  the probe reported image input as supported, an existing database migrated, and axe found 0 violations
- ✅ Code map: symbol index (built-in patterns for 9 languages, on demand, cached in SQLite, incremental by size
  and mtime) with `code_map` (outline that fits the budget) and `find_symbol` (definitions plus whole-word
  references); status and Rebuild in Project settings. Measured on 10,097 source files: 5.5 s first index, 1.5 s
  no-change check, 11 ms lookups. Verified live on 2026-10-30 with `claude-sonnet-4.6` on Friday's own repository:
  a structure question was answered from `code_map` alone, and a "who calls X" question started with
  `find_symbol`, which returned the exact definition and call sites

### Queued (requested 2026-10-30)

- ✅ **Screenshots for preview.** Done: `screenshot` tool (desktop: built-in Chromium; browser version: installed
  Chrome/Chromium/Edge over DevTools), live preview pane with widths and Screenshot to message, and image files in
  the viewer. Verified live on 2026-10-30 with `claude-sonnet-4.6`: Friday started the dev server, captured it by
  process id and reported the page's HTTP 500 and console error; in the desktop app, a framed page's request to
  Friday's API got no launch token, and the built-in capture worked. Original plan: Friday captures a page itself, for example a dev server started with
  `start_process`, and looks at the result (and shows it in the conversation), so it can check a UI change without
  you pasting screenshots. Local URLs only (`localhost`/`127.0.0.1`); viewport and full-page options. Builds on
  background processes and image input. Open question: which browser engine (the desktop app's built-in Chromium,
  or a separate headless browser for the web app).
- ✅ **Document generation: PDF, Word, Excel and PowerPoint.** Done: `create_document` (PDF via the built-in or
  installed browser, Word via `docx`), `create_spreadsheet` (`write-excel-file`), `create_presentation`
  (`pptxgenjs`), one clean built-in style, saved in the project through approval with an outline, undoable, Open
  (desktop) / Download. Verified live on 2026-10-30 with `claude-sonnet-4.6`: an overview PDF and Word copy, a
  task tracker spreadsheet and a status deck about the test shop, accurate to its code; PDF also printed by the
  desktop app's own Chromium. Original plan: Friday writes documents about the code and the work:
  architecture overviews, plans and roadmaps, run and change reports, test results, estimates. Files are written
  into the project (or an export folder) through the normal approved-change flow, with a preview before saving.
  Open questions: which libraries (each is a new dependency that needs approval), and whether documents follow a
  template or house style.
- ✅ **MCP client: connect Friday to MCP servers, as Claude does.** Done: remote (Streamable HTTP) servers
  with OAuth sign-in (or a static token) through the official SDK; tools only; per-tool Ask, Allow or Off.
  Verified live on 2026-10-30 with `claude-sonnet-4.6` against a local test app: signed in through the real UI
  and browser, a note was created after one approval, an allowed search ran without asking, and a destructive
  "delete all" was asked at high risk and, rejected, not run. Original plan: You register MCP servers in Settings
  (local `stdio` commands or remote HTTP endpoints), and their tools become available to Friday, so it can work
  with your other apps. Each server's tools get a permission level (ask every time by default; read-only tools
  can be allowed), secrets stay in Friday's config, never in chat, and tool results are treated as untrusted data
  like file contents. Open questions: the transports and auth your servers use (stdio, Streamable HTTP, OAuth or
  API key), and whether Friday should also expose its own tools as an MCP server later.

### Queued (approved 2026-10-30)

Effort: S = small, M = medium, L = large. Every item keeps the existing rules: nothing that changes files, runs
commands, or reaches another system happens without an approval card (or a task permission or saved action the user
approved), credentials never reach the model, and results from other systems are data, not instructions.

**Coding workflow**

- ✅ **Push and pull requests** (M). Done: `git_push` and `create_pull_request` (pushes first when needed), each
  approved on a card with the destination, commits, hooks and exact text; the description ends with a verification
  section from Friday's records of the run that made the commits. Never the default branch, `main` or `master`;
  never forced; credential files never pushed; the user's own git credential helper/ssh and `gh` sign-in, which
  Friday does not read. Verified live on 2026-10-30 with `claude-sonnet-4.6` against a local bare remote and a
  stand-in `gh`: starting on `main`, Friday created a feature branch itself, committed, pushed and opened the pull
  request. Original plan: Friday pushes a branch and opens a GitHub pull request (title, description, the run
  report as the body) after approval. It never pushes to the default branch and never force-pushes; it uses the
  user's own `gh`/git credentials, which Friday does not read.
- ✅ **Worktree per task** (M). Done: "New task in a worktree" makes a worktree project (a child of the project, in
  Friday's data folder, branch `friday/task-…`) bound to its conversation, with ignored dependency folders linked.
  **Accept** commits pending changes, then merges, squashes or keeps the branch. Merge and squash are refused when
  the user's checkout has uncommitted changes, and a conflict is fully undone. **Discard** removes the folder and
  branch. Verified live on 2026-10-30 with `claude-sonnet-4.6`: the fix and test ran in the worktree with linked
  `node_modules`, the user's checkout stayed untouched, and Accept → Merge from the UI landed it on `main`.
  Original plan: each task can run in its own git worktree and branch, so the user's working tree stays untouched
  until they accept (merge) or discard the result. Uncommitted user changes are never discarded.
- ✅ **Code review mode** (M). Done: **Review…** (or asking) runs `review_changes` (uncommitted, branch against base,
  or a GitHub pull request via `gh`) and `report_findings`. The findings card shows severity, `file:line`
  (opening the file at the line), the reason and an exact suggested change. Friday checks every location and
  suggestion, and refuses reviews written before the diff was seen or mostly not matching the code. **Fix this**
  sends exactly that fix as a normal approved edit; **Dismiss**/**Restore**. Verified live on 2026-10-30 with
  `claude-sonnet-4.6`: the first attempt invented findings (report in the same turn as the diff request), and the
  guard refused it. The retry found the SQL injection, the off-by-one and the percent bug, and **Fix this** →
  Approve applied the one-line fix. Original plan: review uncommitted changes, a branch or a pull request.
  Findings come with severity, `file:line` and a reason, plus suggested fixes the user applies one at a time (each
  a normal approved edit).
- ✅ **Safe rename and refactor** (M). Done: `find_references` splits a symbol's matches into the same symbol (same
  file, imports and re-exports, `this`/self, Go packages, PHP namespaces) and text matches that may be something else,
  with reasons. `rename_symbol` and `move_symbol` (TS/JS) are one multi-file diff to approve. Uncertain matches are
  listed and left alone unless the model names them. A move brings the imports along, re-points importers and
  index re-exports, and flags namespace imports and circular imports. Verified live on 2026-10-30 with
  `claude-sonnet-4.6` on a TypeScript project:
  - it renamed `cartTotal` through a re-export and a namespace import, leaving a same-named function in another file,
    a comment, a string and the README;
  - it moved the function to a new file, then fixed the circular import and namespace import the card pointed out;
  - `tsc` passed, and a second rename went through the new re-export.

  Original plan: rename a symbol, or move a function, across the project using the code map and references, shown
  as one multi-file diff to approve. Text matches that may not be the same symbol are listed separately.

**Testing and UI**

- ✅ **Browser flows** (L). Done: `inspect_page` (no approval) lists a local page's headings, buttons, links and
  fields with ready-made targets. `run_browser_flow` (approval, new `browser` category) runs steps: go to, click,
  type, choose, check, press a key, wait, and expect a text, element, value or address. Elements are named by role
  and name, label or text, and each step waits until its element is unique, shown, enabled, not covered and stable.
  Every step records a screenshot, the address, console errors, failed requests and dialogs. The card lists every
  step with typed values. _Allow more browser flows on this site_ (and `sites` in task permissions) covers re-runs.
  The model sees one screenshot per flow; the user sees all of them on the result card. A passing flow after the last
  change verifies the run. Both engines are supported: Chrome over DevTools, and the desktop app's own Chromium
  through `webContents.debugger`. Verified live on 2026-10-31 with `claude-sonnet-4.6` on a scratch shop with a
  planted add-to-cart bug: it fixed the bug, a flow with guessed selectors failed and listed the page's elements,
  and the corrected flow passed (run report verified via the flow). A 12-step flow approved by clicking in the UI
  then passed. Found and fixed in the live runs:
  - clicks dropped by a just-loaded page (now waits for painted frames and checks the press arrived);
  - `{role, label}` targets refused (now read as the name);
  - the redactor treating a local URL followed by an e-mail in JSON as a URL with a password.

  The desktop engine was checked with an Electron harness (same results, screenshots verified). Original plan:
  Friday drives a local page (navigate, click, type, wait for text) to test a UI flow end to end, with a
  screenshot and console errors at each step. Local pages only, on the existing capture engines; a flow is a list
  of steps the user sees before it runs.

- ✅ **Before/after visuals** (S–M). Done: `screenshot` with `compare` diffs against the latest earlier capture of
  the same page and size (built-in PNG codec and YIQ diff, no new packages), returns the changed share, the areas,
  and a highlighted image, and the run report shows before, after and difference side by side. Verified live on
  2026-10-30 with `claude-sonnet-4.6` restyling a cart total. That run showed pixelmatch's default threshold missing a
  pale background (now 0.05) and solid red hiding the changed text (now a tint). Original plan: around a UI
  change, capture the page before and after, and show them side by side (with a highlighted difference) in the
  run report.
- ✅ **Test insights** (M). Done: `detect_tests` (Vitest, Jest, `node --test`, pytest, Go suites, per package) and
  `run_tests`, which builds the command itself and is approved like any command. It runs the tests related to the
  uncommitted changes first. The **Tests** card shows the first error and `file:line` of each failure, flaky tests
  (passed on a re-run, or passed and failed on the same code in earlier runs), the slowest tests against their usual
  time, and coverage of the changed lines. Results are kept per suite. Verified live on 2026-10-30 with
  `claude-sonnet-4.6`:
  - It ran the tests related to a coupon change and found the percent bug at `test/cart.test.js:11`, with the
    fixed-coupon lines never run.
  - The model fixed the bug and added tests until every changed line ran.
  - A whole-suite run reported a planted flaky test (passed on re-run) and a 150 ms test as slowest.

  Pytest, Go and Jest are checked against fixture files only, since none is installed here. Original plan: detect
  the test framework, run the tests related to the changed files first, and summarise failures (first error,
  `file:line`), slow and flaky tests, with optional coverage for the changed lines.

- ✅ **Dependency upgrades** (M). Done for npm (package-lock.json, workspaces) and Composer (composer.lock):
  `dependency_report` (outdated and vulnerable direct dependencies, targets at least 14 days old, advisories and
  whether a target fixes them), `dependency_changelog` (GitHub releases, or CHANGELOG.md where releases are
  missing, with breaking-change lines), and approval-gated `upgrade_dependencies`. The card shows each version
  change, age, advisories fixed and breaking-change lines, plus the exact commands. They run like `run_command`,
  keep the manifest's `^`/`~`/exact style, and the file changes are recorded for undo. Verified live on 2026-10-31
  with `claude-sonnet-4.6` on a scratch npm project: a security patch (semver 5.7.1 → 5.7.2), and then "upgrade to
  the latest", where it read the changelog and checked the API the tests use before going to 7.8.5. Tests passed
  both times. The live run found two bugs, now fixed: an exact pin turning into `^`, and link noise in the
  breaking-change lines. Composer upgrades are covered by tests and a live report; the install itself was not run
  live. Original plan: a report of outdated and vulnerable packages, an upgrade plan with changelog highlights and
  breaking changes, then the upgrade and a test run, each step approved. It follows the "releases at least two
  weeks old" rule by default.
- ✅ **Playwright tests** (M, added 2026-10-31). Done: `detect_tests` finds Playwright suites (config plus
  `@playwright/test`) beside unit tests. `run_tests` with `framework: "playwright"` uses its JSON reporter
  (`PLAYWRIGHT_JSON_OUTPUT_FILE`, also in the sandbox) and `--retries=1` for flaky detection. The card shows the
  config's web server. Failures carry the first error, `file:line`, the screenshot (stored; the first goes to the
  model), the trace with its `show-trace` command and the page snapshot (cut from error-context.md, without
  Playwright's AI instructions). Missing browsers or libraries and a busy web-server port make the run an error with
  the command to run; nothing is installed. Verified on 2026-10-31 with `@playwright/test` 1.63.0 in a scratch
  project (real Chromium): a real failure with screenshot, trace and snapshot, and missing browsers reported as
  such. Live with `claude-sonnet-4.6`: it ran the failing spec, fixed the app's off-by-one, wrote a spec for the
  $15.00 cart total, and the final run passed 4 of 4, marking the run report verified. On the way it dropped the
  sign-in steps once; the page snapshot showed the login page and it corrected the spec. Original plan: Friday
  detects a project's `@playwright/test` setup and writes and runs its specs: `run_tests` supports Playwright with its JSON reporter. Each failing test shows its first error
  and `file:line`, plus the screenshot and trace Playwright saved, in the **Tests** card. It runs the specs related to
  the changes first, and new or changed specs are normal approved edits. Browsers and `@playwright/test` are never
  installed by Friday: it says what is missing. Separate from Browser flows, which stays the ad-hoc "click through
  this page" check.
- ⬜ **k6 load tests** (M, added 2026-10-31). Friday writes k6 scripts (virtual users, duration, thresholds) and runs
  them with the installed `k6` binary. The approval card shows the target URL, virtual users, duration and
  thresholds. The result summarises request rate, p95/p99 latency, error rate and which thresholds failed.
  - Targets: localhost and the project's dev server freely. Other hosts only when the user listed them as load-test
    targets in Settings. Production is refused unless it is listed and its name is typed to confirm.
  - Never more than the virtual users and duration the approval showed.

**DevOps**

- ✅ **CI diagnosis** (S–M). Done: `ci_runs` and `ci_failure` (GET requests through the user's `gh` sign-in): the
  failed jobs and steps, the first real error from the job log, annotations, the project files it points at
  (runner paths made relative, package-relative paths matched by suffix), and how the run's commit relates to the
  checkout. Verified live on 2026-10-30 with `claude-sonnet-4.6` on a real failed run of `vitest-dev/vitest`: it
  found the off-by-one column in the failing snapshot and read the right test file first. Original plan: read the
  project's GitHub Actions runs and logs (read-only), find the first real failure, relate it to the code, and
  propose a fix as a normal approved change.
- ✅ **Docker Compose control** (M). Done: `compose_status` (each service's state, health check result, restarts
  and whether its published ports accept connections; logs) runs freely, and `compose_control` (up, start, stop,
  restart, down) needs approval. The compose file is the project root's default file with its override, or any
  compose file inside the project. Files and project name are pinned on every call, and the containers'
  config-file labels must match, so another project or checkout with the same project name is refused. Images
  are never pulled or built unless asked (`--pull never --no-build`), and a missing image is reported before the
  card. Deleting volumes is critical risk and needs the project name typed. The card lists the services
  (dependencies marked), the exact command and the volumes that would be deleted. After up/start/restart, Friday
  waits for the services to be running and healthy and reports each one. Verified live on 2026-10-31 with
  `claude-sonnet-4.6` on a throwaway nginx + redis stack: status, `up web` (with its dependency), a refusal to
  restart another project's container, `down` keeping the volume, then `down` deleting it after the typed name.
  The `.env` secret never reached the conversation. Original plan: for the project's compose file only: bring
  services up or down, restart them, tail logs and run health checks, each change with approval. It never
  touches other containers, and never removes volumes unless the user explicitly asks, at high risk.
- ✅ **Database, read-only** (M–L). Done: connections in **Settings → Databases** (Postgres and MySQL via `pg` 8.23.1
  and `mysql2` 3.24.6, SQLite built in), per project or for any conversation, with the password or URL read from a
  named variable (project `.env`, Friday's config file or environment), never stored or shown. **Test** warns when
  the user could write. `database_schema` (no approval) lists connections, tables and table details.
  `query_database` (approval every time, the name typed on production) runs one read statement. The safeguards are
  Friday's statement check, then a read-only transaction and session with row and time limits; columns named like
  secrets are masked. Verified on 2026-10-31 against Postgres 17 and MySQL 8.4 containers: writes and DDL sent past
  Friday's check were refused by both databases, also for a user with write privileges. Live with
  `claude-sonnet-4.6`: the model at first batched guessed queries before seeing the schema, which stopped the run.
  Friday now refuses a query in the same turn as `database_schema` and counts tool failures once per turn. Then it
  read the schema, answered top customers and the refund share from Postgres, and cross-checked the production
  MySQL copy after the name was typed (142 refunded orders on both). Original plan: connections the user adds in
  Settings (Postgres, MySQL, SQLite), with credentials kept like SSH keys and never shown to the model. Schema
  browsing, and read-only queries with approval, row and time limits, and a read-only session or transaction.
  Writes stay disabled; the `database` category is enabled only for these tools.
- ✅ **Health monitors** (M). Done: the user defines monitors in the **Monitors** panel (URL, SSH host, background
  process, compose service), each checked every 1 to 1440 minutes while Friday runs. After N failed checks in a
  row it is down, and after one passing check up again. Both send a notification, and the sidebar counts the ones
  down. The panel shows recent checks, status changes, **Check now**, pause and **Investigate**, which opens a
  conversation asking Friday to diagnose it. The model reads monitors with `monitor_status` only. SSH checks run
  a fixed script on trusted hosts. Verified live on 2026-10-31: a local site going down (connection refused, down
  after two failures, notice sent), a compose service, and a missing background process, all checked on
  schedule; the panel was checked in Chromium. Investigate with `claude-sonnet-4.6` read the history with
  `monitor_status`, ran read-only checks and asked before any change. Its guessed cause was wrong, because the
  stopped test server was outside what Friday's tools can see. The URL's query string never reached the model. SSH
  monitors are covered by tests only (no SSH server here). Original plan: scheduled checks of URLs, SSH hosts and background
  processes every N minutes. When something breaks or recovers, a notification and a status panel show it.
  Checks are read-only and use authorized hosts only.

**Platform**

- ✅ **Saved actions (runbooks)** (M). Done: defined per project in Project settings: name, description, declared
  risk, and ordered steps, each an exact command run in the project (sandbox respected) or on an SSH host, with a
  timeout and continue-on-failure. The model can only `list_saved_actions` and `run_saved_action` by name. One
  approval shows every step; production hosts need the host name typed; editing the action makes a shown card
  stale. **Actions…** in the conversation header picks one. Verified live on 2026-10-30 with `claude-sonnet-4.6`:
  an action created in the editor (tests, a build stamp, a count) ran from **Actions…** after approval, and each
  step's result was reported. SSH steps are covered by tests with a stand-in `ssh` only, since there is no SSH
  server here. Original plan: the user defines a named procedure once (exact commands or steps, where it runs, its
  risk), such as "deploy staging". Friday runs it on request with one approval per run that shows every step. The
  model cannot edit saved actions.
- ✅ **Usage and cost view** (S). Done: Settings → Usage, with totals, tokens per day (hover or table), the top
  conversations and a by-model table, over 7, 30 or 90 days. Provider calls now record their conversation, and
  earlier calls were linked to theirs by run time. NoTokenLimit sends no usage on streamed replies (checked
  2026-10-30 for opus-5.5, sonnet-4.6 and haiku-4.5), so Friday records its own estimate and marks it `~`. Cost is
  an estimate from per-model prices the user enters, because NoTokenLimit publishes none. Original plan: tokens,
  calls and time per conversation, model and day, from Friday's own provider records (no prompt content), as a
  small chart in Settings.
- ✅ **Export conversations** (S). Done: a download button in the conversation header, Markdown or PDF, summary
  or full detail (tool results, approval reasons, diffs and commands), redacted, recorded in the audit log. Verified
  live on 2026-10-30 by exporting the push-and-PR test conversation through the UI as a full PDF. Original plan:
  export a conversation (messages, tool results, approvals and the run report) as Markdown or PDF with the
  document generator; secrets are redacted as everywhere else.
- ⬜ **Voice replies and voice input** (M–L, added 2026-10-31).
  - **Spoken replies.** A **Voice** toggle in the composer makes Friday also speak its replies. The text reply
    still appears as usual, and each spoken reply gets play and stop controls inline.
  - **What is spoken.** Friday speaks the prose and a description of the technical parts, not the parts
    themselves. Code, logs, diffs, command output, tables, paths and hashes are never read out. A code block is
    described in a sentence or two: what it is, what it does and its significant line, for example "the fix is
    the comparison on line 12, which now uses less-than-or-equal, so the last item is counted". Approval cards are
    announced ("Friday needs your approval to run the tests"), and redacted values stay redacted.
  - **Voice input.** A microphone button in the composer records while it is on, with a visible recording
    indicator. The transcript goes into the message box to edit and send. The microphone is used only while the
    button is on: nothing listens in the background, there is no wake word, and the audio is not stored.
  - **Voice never approves anything.** Saying "yes" or "approve" is just a message. Approvals still need a click
    on the card, as now.
  - Open questions:
    - Which speech engines. Options are the browser's built-in speech (free, local, quality varies, and
      recognition does not work in Electron), NoTokenLimit audio models if it offers any, or a local engine such
      as Piper or whisper.cpp (a new dependency that needs approval).
    - How the spoken version is written: a second short model call after each reply (costs tokens), or the
      model writing it alongside the reply.
    - Whether a transcript should send itself after a pause or always wait for **Send**.
- ⬜ **Web search and deep research** (L, added 2026-10-31). Friday has no web access today, apart from tools an
  MCP server provides.
  - **Search and read.** `web_search` runs a query and returns titles, links and snippets. `read_web_page` fetches a
    public page and returns its readable text. Both are read-only GET requests, with no cookies or credentials,
    time and size limits, and http(s) only. Local and private network addresses are refused.
  - **Deep research.** For a bigger question ("which PDF library fits this project", "why does this error appear
    after the upgrade", "what changed in the API between the version we use and the latest"), Friday:
    - plans sub-questions;
    - runs several searches and reads the sources;
    - compares what they say and notes where they disagree;
    - writes a report with every claim linked to its source, and lists the sources it read.

    Progress shows live and can be stopped. Each research has limits on searches, pages and time. The report can be
    saved with the document generator.

  - **Combined with the code.** Answers are checked against the project: the installed version, how the code
    actually calls the API, and the lockfile, so advice matches what is in use.
  - **What leaves the machine.** Only search queries and page addresses. Never file contents or secrets, and
    queries are checked for secrets the same way memory writes are. Every query and page is shown in the tool
    activity. Page text is untrusted data: it can inform an answer but cannot trigger an action, and any change it
    suggests is a normal approved change.
  - Open questions:
    - Which search provider. NoTokenLimit may offer none. Options are Brave Search or Tavily (an API key kept in
      Friday's config, never in chat) or a self-hosted SearXNG.
    - Whether searches run freely (queries visible), need one approval per research, or one approval per query.
    - Whether queries may include project details such as an error message or a package name.

Suggested order (quick wins first, then the ones that build on each other): usage and cost view, export
conversations, CI diagnosis, before/after visuals, then push and pull requests, worktree per task, code review mode,
test insights, safe rename, then saved actions, Docker Compose, health monitors, dependency upgrades, browser flows
and the read-only database, then (added 2026-10-31) Playwright tests, k6 load tests, voice replies and voice input,
and web search and deep research.
