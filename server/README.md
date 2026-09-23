# Powerhouse coordinator (`server/`)

Always-on workflow coordinator: an authenticated TypeScript service that runs
durable two-script workflows through [DBOS](https://docs.dbos.dev) on
Postgres, executing scripts on boxd microVMs via the existing
`powerhouse-runner` (protocol v3). This is Increment 0b of
[the workflows plan](../docs/workflows-plan.md).

## What it proves

- One workflow run per idempotency key, no matter how many times it is submitted.
- Stable machine and job identities persisted **before** external actions;
  coordinator restarts and lost responses recover the original VM and runner
  job instead of creating duplicates.
- `script-1 → script-2` with fail-fast: a nonzero exit blocks script 2.
- Cancellation delivers runner cancellation and waits for
  `unit_active == false` before releasing the VM.
- DBOS is the execution authority; `workflow_runs`, `workflow_node_runs` and
  `workflow_run_events` are query projections kept apart from DBOS's schema.

## API

All routes except `/health` require `Authorization: Bearer <token>`.

| Route | Purpose |
| --- | --- |
| `POST /v1/workflows` | Create a workflow and publish version 1: name, repository, snapshot, 1–10 named script nodes. |
| `GET /v1/workflows` / `GET /v1/workflows/:id` | List workflows / inspect one with all published versions. |
| `POST /v1/workflows/:id/versions` | Publish the next immutable version. Existing runs keep the version they pinned. |
| `POST /v1/workflows/:id/runs` | Admit a run of a published version (default: latest) with a pinned commit SHA and idempotency key. |
| `POST /v1/runs` | Admit an ad-hoc run: exactly two scripts, repository, pinned SHA, snapshot identity, caller idempotency key. |
| `GET /v1/runs/:id` | Run, node and event projection (owner-scoped). |
| `POST /v1/runs/:id/cancel` | Durable cancel intent. |
| `GET /health` | Liveness + database check. |

## Configuration

Environment (token material stays outside source control):

- `DATABASE_URL` — application database.
- `DBOS_SYSTEM_DATABASE_URL` — DBOS system database (defaults to `DATABASE_URL`; DBOS keeps its own schema).
- `POWERHOUSE_API_TOKENS` — `owner:token` entries (comma/newline separated), or `POWERHOUSE_TOKENS_FILE` pointing at a file of them. Tokens ≥ 16 chars.
- `PORT` / `HOST` — listen address (default `127.0.0.1:8787`).
- `POWERHOUSE_POLL_INTERVAL_MS`, `POWERHOUSE_SCRIPT_DEADLINE_SECONDS` — tuning.
- `BOXD_API_KEY` — for the real boxd adapter.

## Develop

```bash
npm install
npm run typecheck
npm test          # spins up a disposable Postgres (needs initdb/pg_ctl on PATH)
npm run build && npm start
```

The default test run uses `FakeExecutionAdapter`. The real-infrastructure
acceptance suite (`tests/e2e-boxd.test.ts`) drives `BoxdExecutionAdapter`
against actual boxd microVMs and the published `powerhouse-base` runner
snapshot (`probe.script_protocol_version == 3`); it provisions and destroys
real VMs, so it is opt-in:

```bash
RUN_BOXD_E2E=1 BOXD_API_KEY=... npm test -- tests/e2e-boxd.test.ts
```
