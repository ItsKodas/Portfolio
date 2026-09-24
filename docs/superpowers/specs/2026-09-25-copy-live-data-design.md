# Copy live's data into an environment

Date: 2026-09-25
Status: approved design, not yet implemented
Extends: `docs/superpowers/specs/2026-09-24-named-environments-design.md` (piece 2, merged in PR #125)

This is piece 3 of 3. Piece 2 lets a site have named environments (uat1, staging), each with its own
compose project `<id>-<env>`, its own database container and an empty database named `<id>-<env>`. This
piece lets an admin fill an environment with a fresh copy of live's databases and storage, at creation or
any time later as a refresh.

## Context

- Each environment runs its own compose project, so its database is its own container with its own
  volumes. `services` (which service is a database, and which engine) is declared once per project and
  applies to every environment.
- Creating an environment copies live's env files and rewrites the database name `<id>` to `<id>-<env>`
  in database keys (`provision.ts rewriteEnvText`). The environment's app therefore expects a database
  named `<id>-<env>` on its own server.
- hostd can dump every engine online for backups (`backup-dumps.ts dumpPlan`): `pg_dumpall`,
  `mysqldump`/`mariadb-dump --all-databases --single-transaction`, `mongodump --archive --gzip`,
  `redis-cli --rdb`, `sqlite3 .backup`. `generic` is backed up only by stopping the service and copying
  its bind mounts. Dumps run through `DockerApi.exec` inside the container and stream into a file.
  Credentials are env var names expanded by the container's own shell; hostd never reads them.
- There is no restore code. `DockerApi.exec` has no stdin.
- Registered storage folders live inside each environment's tree and are carried across deploys (PR
  #126, `storagePathsOf`, `carryStorage`).
- A new environment is not started at creation.

## Scope

### In scope

- A "copy data from live" run for any non-live environment, admin only: every registered database and
  every registered storage folder, overwriting the environment's own
- A checkbox on the Add environment form that starts a copy once the environment is added
- Run status the portal can poll, and a record of the last runs
- Runbook updates

### Not in scope

- Copying from a backup snapshot. The source is always a fresh dump of live.
- `generic` databases. A copy is refused while any registered database is `generic`.
- Scrubbing personal data. The copy is live's data as it is.
- Copying between two non-live environments, or into live.
- Undoing a copy. The environment's previous data is replaced.

## Refusals (before anything changes)

- The environment is `live`, unknown, or on a flat site.
- A registered database service is `generic`: "<service> uses the generic engine, which cannot be copied
  while live runs; give it a real engine in the registry".
- The environment is deploying, changing port, being deleted or restored, or already copying.
- A backup of the project is running (and a backup is refused while a copy runs).
- Any registered database service has no running container in live's compose project.
- Free space on the site's filesystem is below 10 GiB plus the total size of live's registered storage
  folders plus a best-effort estimate of live's database sizes (checked as the run's first step, `space`).

## The run

A copy starts, answers at once with a run id, and runs in the background, like a backup. Steps:

1. **Block.** The environment's deploy block (the one delete and restore take) is held for the whole
   run, so deploys, port changes, domain and configure writes, deletes and restores of that environment
   are refused with `busy`.
2. **Dump live.** For each registered database, the backup dump command runs in live's container, and
   its output streams into `<site>/.copy/<run>/<service>/<file>`. sqlite is not dumped here (step 5).
   Live keeps serving.
3. **Prepare the environment.** Read its service names from its own compose config and record which are
   running. Stop every one that is not a registered database (`compose stop <those services>`): its site
   services and anything else its compose file runs. Start its database services if they are not running
   (`compose up -d --no-build --pull never <database services>`), which also covers an environment that
   has never been deployed. Wait until each database container is running, then until it answers a
   readiness probe over TCP to 127.0.0.1 (the official images' first-init server listens on the unix
   socket only; mongodb, whose first-init server takes localhost TCP too, must answer three times in a
   row).
4. **Load each dump** into the environment's own container, renaming live's database `<id>` to
   `<id>-<env>` and nothing else:
   - **postgres:** `psql` reads the dump from stdin. Before it, `DROP DATABASE IF EXISTS "<id>-<env>"
     WITH (FORCE)` runs, so the dump's `CREATE DATABASE` makes it fresh. The dump is filtered line by
     line: only `CREATE DATABASE`, `ALTER DATABASE`, `COMMENT ON DATABASE` and `\connect` lines that name
     `<id>` exactly are rewritten to `<id>-<env>`. Role and database "already exists" errors are
     tolerated; any other `ERROR:` line fails the step.
   - **mysql / mariadb:** `mysql` (or `mariadb`) reads the dump from stdin, using the same credential env
     vars as the dump. Only `CREATE DATABASE` and `USE` lines naming `` `<id>` `` exactly are rewritten.
     The dump's own `DROP`/`CREATE TABLE` statements replace existing tables. Before it, `DROP DATABASE IF
     EXISTS \`<id>-<env>\`` runs.
   - **mongodb:** `mongorestore --archive --gzip --drop --nsFrom '<id>.*' --nsTo '<id>-<env>.*'` reads the
     archive from stdin, with the same credential env vars as the dump.
   - **redis:** read the environment's redis data directory and data file name (`CONFIG GET dir` and
     `CONFIG GET dbfilename` in its container), stop that service, `docker cp` the rdb file to
     `<dir>/<dbfilename>` in the environment's container, start the service.
   - Databases whose name is not `<id>` are loaded under their own name, unchanged. That matches the
     environment's env files, which only had `<id>` rewritten.
5. **sqlite and storage.** For each sqlite service, `sqlite3 <live>/<file> ".backup <env>/<file>.hostd-copy"`
   then rename over the environment's file. For each registered storage folder, `cp -a` live's folder to
   `<env>/<path>.hostd-copy`, move the environment's current folder to `<site>/.copy/<run>/old/<path>`,
   move the copy into place. The copy keeps the owners `cp -a` preserved from live (a deploy's storage carry
   never changes ownership either); only folders the copy itself creates are owned like the environment's tree.
   Before either touches a target, every existing folder on the way to it is resolved with `realpath` and
   must be inside the environment's folder and not inside live's, so a symlink in the checkout cannot aim
   the step at live. Live's folder having gone by then fails the step.
6. **Restore the environment's state.** Start the services step 3 stopped that were running before it. Stop the
   database services step 3 started, so the environment ends in the state it began in.
7. **Clean up.** Remove `<site>/.copy/<run>/` (staging dumps and old storage) whatever the outcome.
   Release the block. Record the run.

A failure stops at that step. Steps 6 and 7 still run. The record says which step failed and why, and
that the environment may be partly copied and a new copy will overwrite it.

## Records

`/var/lib/hostd/copies.json`, the last 20 runs per environment, written via temp file and rename:
`{ project, environment, run, actor, startedAt, durationMs, outcome: 'ok' | 'failed' | 'running', step,
reason, services: [...], storage: [...] }`. A run still marked `running` when the agent starts is marked
failed with "the agent restarted during the copy", and its staging folder is removed.

## hostd pieces

- `hostd/src/agent/copy-plans.ts` (new, pure): the per-engine load plans and the rename filter
  (a line transform that sees one line at a time, so dumps of any size stream through it).
- `hostd/src/agent/copy-run.ts` (new): runs one copy, given injected docker, runner, fs and store deps.
- `hostd/src/agent/copy-store.ts` (new): the records.
- `DockerApi.exec` gains an optional stdin stream (`AttachStdin`, hijacked connection) used to feed dumps
  into `psql`, `mysql` and `mongorestore`.
- Agent verb `copy` with actions `start { environment }`, `get-run { environment, run }` and
  `list { environment }`. The block is the existing deploy-runner block plus the agent's `trashing`-style
  set, extended to copies.
- api routes, admin only (policy verb `provision`):
  - `POST /projects/:id/:env/copy-from-live` answers `{ ok, run }`
  - `GET /projects/:id/:env/copy-runs` answers `{ runs, running }`
  - `GET /projects/:id/:env/copy-runs/:run` answers one record
- `POST /projects/:id/environments` accepts `copyFromLive: boolean` (default false); when true and the add
  succeeds, the api starts a copy and includes `copy: { run } | { refused: message }` in the reply.

## Portal

- Settings, each non-live environment row: **Copy data from live**. A confirm explains that the
  environment's databases and storage are replaced with live's current data, that this is client data,
  and asks for the environment's name typed back. While a run is going, the row shows it and polls every
  few seconds; when it ends it shows done, or failed with the step and reason.
- Add environment form: a checkbox "Start with a copy of live's data". The result message says the copy
  started, or why it could not.
- Deploys tab: while a copy of the viewed environment runs, a note says deploys wait until it ends.
- Admin only, on the server and in the UI.

## Runbook

- What a copy does, step by step, and what it refuses.
- That it copies real client data into a non-live environment, which may be on a public hostname.
- Where staging goes, the record file, and how to clean up after an agent crash by hand.
- How to copy by hand for a generic database.

## Testing

- `copy-plans.ts`: each engine's load plan; the rename filter rewrites exactly the named statements and
  leaves data lines containing `<id>` untouched; names that only contain `<id>` as a substring are not
  rewritten.
- `copy-run.ts` with fakes: step order; each refusal; the block held and released; a failure at each step
  still runs steps 6 and 7; site services restored to their previous state; a never-started environment
  left stopped; staging removed.
- `DockerApi.exec` stdin: the stream reaches the container (fake socket).
- Routes and policy (client refused); the add-environment `copyFromLive` path.
- Portal: the confirm, polling states, the add form checkbox, admin-only actions.
