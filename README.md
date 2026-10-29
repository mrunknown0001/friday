# Friday

A local-first AI coding and DevOps assistant that uses [NoTokenLimit](https://notokenlimit.com) as its model provider.

**Current status: Phase 2 (read-only coding agent).** Friday can open an authorized project and investigate it with
read-only tools: it inspects the stack, lists and searches files, reads specific line ranges, publishes a plan, and
answers with `path:line` evidence. Every tool call is visible in an activity timeline. It **cannot modify files, run
commands, or use git yet**; those arrive with the approval engine in Phases 3–4. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Requirements

- Node.js ≥ 22.12 (tested on 22.23) and npm
- Linux, macOS, or WSL2. `better-sqlite3` ships prebuilt binaries for common platforms.
- A NoTokenLimit API key

## Setup

```bash
npm install
```

```bash
cp .env.example .env
```

Edit `.env` and set `NTL_API_KEY`. You can also set `NTL_MODEL` to a model ID, or choose a model later in **Settings**.
The key is read only by the local server process. It is never stored in the database, sent to the browser, or logged.

## Run

Development (API on `127.0.0.1:4317`, UI on `http://localhost:5173` with hot reload):

```bash
npm run dev
```

Production-style (the server serves the built UI at `http://127.0.0.1:4317`):

```bash
npm run build
```

```bash
npm start
```

### First run

1. Open **Settings**. It shows whether `NTL_API_KEY` is configured.
2. Pick a model from the list and click **Use selected model**.
3. Click **Test connection**. This sends one tiny completion and is the only check that confirms both your key and your
   plan's access to the model. NoTokenLimit's `/models` endpoint returns its public catalog and does not validate the key.
4. Optionally click **Probe capabilities** to verify streaming and tool calling for that model (two tiny requests).

## Projects

1. In the sidebar, click the **Add project** icon and enter the absolute path of a project folder.
   Adding it authorizes Friday to **read** inside that folder only. Broad locations (`/`, your home folder, system
   directories, whole drives) are refused.
2. Conversations started while a project is selected are bound to it permanently; tools can only see that project.
   "No project (chat only)" conversations have no file access.
3. The side panel shows the agent's plan and a read-only file explorer.

What Friday will not read, even inside a project: credential files (`.env`, `.env.*` except templates such as
`.env.example`, private keys, `.npmrc`, `auth.json`, `*.tfstate`, `.ssh/`, `.aws/`, …) and `.git` internals.
Search still reports _that_ a credential file matched, by name only, so the model does not wrongly conclude a value
is absent. Everything Friday does read is sent to your NoTokenLimit model.

### Choosing a model

Tool calling has been verified live on `claude-haiku-4.5`. In testing through NoTokenLimit, haiku sometimes opens
replies with a self-introduction (NoTokenLimit appears to add its own hidden prompt of roughly 1,100 tokens), while
`claude-sonnet-4.6` and `gemini-3-flash` answered cleanly. Use **Settings → Probe capabilities** before relying on a
new model for tool use.

## Data

- SQLite database: `./.data/friday.db` (override with `FRIDAY_DATA_DIR`). The file is created with `0600` permissions.
- Stored: conversations, run state, settings, model capabilities, provider-call metadata (no prompt text), and an audit log.
- Back up by copying the `.data` directory while the server is stopped.
- Reset by stopping the server and deleting `.data/`.

### Recovery

- If the server stops mid-response, the run is marked **interrupted** on the next start. Any partial text that was
  checkpointed stays visible, and **Retry** re-runs the request.
- Partial, cancelled, and failed responses are kept for display but are never fed back to the model as context.

## Scripts

| Command                    | What it does                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------ |
| `npm run dev`              | API server (tsx watch) and Vite dev server together                                  |
| `npm run build`            | Type-check and build the web UI and server                                           |
| `npm start`                | Run the compiled server, which also serves the built UI                              |
| `npm test`                 | Unit and integration tests (mocked HTTP; no API key needed)                          |
| `npm run test:integration` | **Live** NoTokenLimit test; needs `NTL_API_KEY` and `NTL_MODEL`, uses a little quota |
| `npm run typecheck`        | Strict TypeScript across all workspaces                                              |
| `npm run lint`             | ESLint                                                                               |
| `npm run format`           | Prettier                                                                             |

## Configuration

| Variable                      | Default                           | Notes                                                          |
| ----------------------------- | --------------------------------- | -------------------------------------------------------------- |
| `NTL_API_KEY`                 | none                              | Required for any model call                                    |
| `NTL_MODEL`                   | none                              | Default model; a model chosen in Settings takes precedence     |
| `NTL_BASE_URL`                | `https://notokenlimit.com/api/v1` | Must be HTTPS (plain HTTP is allowed only for localhost)       |
| `NTL_TIMEOUT_MS`              | `120000`                          | Response-header timeout and stream idle timeout                |
| `NTL_MAX_RETRIES`             | `2`                               | Retries for transient errors only (429, 5xx, network, timeout) |
| `FRIDAY_PORT`                 | `4317`                            | The server always binds to `127.0.0.1`                         |
| `FRIDAY_WEB_PORT`             | `5173`                            | Vite dev server port (`npm run dev` only)                      |
| `FRIDAY_DATA_DIR`             | `./.data`                         | SQLite location                                                |
| `FRIDAY_AGENT_MAX_ITERATIONS` | `20`                              | Model turns per request before the run pauses as `blocked`     |
| `FRIDAY_AGENT_MAX_TOOL_CALLS` | `40`                              | Tool calls per request before the run pauses as `blocked`      |
| `FRIDAY_TOOL_TIMEOUT_MS`      | `30000`                           | Per-tool-call timeout                                          |
| `FRIDAY_TOOL_OUTPUT_CHARS`    | `20000`                           | Maximum characters of one tool result sent to the model        |

## Layout

```
apps/server     Fastify API, agent orchestration, provider adapter, SQLite
apps/web        React + Vite + Tailwind UI
packages/shared Type-only API contract shared by server and web
docs/           Architecture, security model, roadmap
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/ROADMAP.md](docs/ROADMAP.md)
