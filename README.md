# Friday

A local-first AI coding and DevOps assistant that uses [NoTokenLimit](https://notokenlimit.com) as its model provider.

**Current status: Phase 1 (foundation).** Friday is a persistent, streaming chat assistant with a hardened local
server, a NoTokenLimit provider adapter (streaming, tool-call parsing, retries, error classification, capability probing),
and context-window management. It **cannot yet read files, run commands, or modify anything**. Those tools arrive in
Phases 2–4, behind the approval engine. See [docs/ROADMAP.md](docs/ROADMAP.md).

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

| Variable          | Default                           | Notes                                                          |
| ----------------- | --------------------------------- | -------------------------------------------------------------- |
| `NTL_API_KEY`     | none                              | Required for any model call                                    |
| `NTL_MODEL`       | none                              | Default model; a model chosen in Settings takes precedence     |
| `NTL_BASE_URL`    | `https://notokenlimit.com/api/v1` | Must be HTTPS (plain HTTP is allowed only for localhost)       |
| `NTL_TIMEOUT_MS`  | `120000`                          | Response-header timeout and stream idle timeout                |
| `NTL_MAX_RETRIES` | `2`                               | Retries for transient errors only (429, 5xx, network, timeout) |
| `FRIDAY_PORT`     | `4317`                            | The server always binds to `127.0.0.1`                         |
| `FRIDAY_WEB_PORT` | `5173`                            | Vite dev server port (`npm run dev` only)                      |
| `FRIDAY_DATA_DIR` | `./.data`                         | SQLite location                                                |

## Layout

```
apps/server     Fastify API, agent orchestration, provider adapter, SQLite
apps/web        React + Vite + Tailwind UI
packages/shared Type-only API contract shared by server and web
docs/           Architecture, security model, roadmap
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/ROADMAP.md](docs/ROADMAP.md)
