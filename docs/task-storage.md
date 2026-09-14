# Task Storage And Production Processes

Runtime requires Node.js with `node:sqlite` (22.13+); production was verified on
Node.js 24.18.0.

Task state lives in `data/providers/tasks.sqlite`. SQLite uses WAL and full
synchronous commits. Queue reads use indexed daily summaries; complete prompts,
provider responses and inline outputs remain in the task detail table.

## First Migration From JSON

1. Build and test without changing the running `.next` directory.
2. Stop new submissions and let requests without a supplier task ID finish.
3. Flush the old process's pending task writes, verify them, and stop it.
4. Run `npm run tasks:migrate` with the production `WORKSPACE_DATA_ROOT`.
5. Require `verified: true` before starting the new build with `npm run start`.

Migration keeps the original JSON and creates a timestamped JSON backup. It
checks every hydrated task against its original fields and checks the source
digest before commit. A changed source, duplicate ID or field mismatch aborts
the transaction. Do not migrate while the old JSON service is still writing.

`scripts/legacy-task-drain.mjs` is a one-time bridge for the previous compiled
JSON store. It requires the exact PID and a loopback Node inspector; it refuses
unknown compiled exports. Inspection is the default. `--stop` temporarily blocks
mutations, waits for unaccepted requests, flushes and verifies disk state, then
exits the old process. On timeout it restores normal request handling.

## Routine Operation

- `npm run start`: starts the web server and ensures a healthy independent worker.
- `npm run worker:restart`: drains and replaces the worker while web stays available.
- `npm run start:deploy`: starts web and deliberately replaces the worker first.
- `node scripts/deploy-restart.mjs`: builds separately, drains/replaces worker, then swaps the web build.

Worker drain never force-kills an in-flight supplier request. Timeout aborts the
replacement. Already accepted jobs keep their supplier task IDs; ambiguous
interrupted submissions require supplier verification instead of an automatic
duplicate POST. Confirmed supplier failures retain their attempt history before
following the configured retry policy.

## Backup And Recovery

Use `backupProviderTaskStore(destination)` for a consistent SQLite backup. Do not
copy only `tasks.sqlite` while a writer is active, because committed data can be
in `tasks.sqlite-wal`. Keep generated files and uploads with the database backup.

The preserved JSON is the migration-time snapshot, not a live mirror. Once new
tasks have been accepted into SQLite, do not roll production back to a JSON-era
build or restore the old JSON over current task state.

Worker logs are in `logs/provider-worker.out.log` and `.err.log`. The supervisor
state and nonce-protected drain requests are under `data/providers`. Production
tests must use an isolated `WORKSPACE_DATA_ROOT` and
`WORKSPACE_ENABLE_LIVE_PROVIDERS=false`.
