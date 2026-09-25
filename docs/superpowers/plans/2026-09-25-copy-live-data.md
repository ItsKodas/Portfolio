# Copy Live Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can fill any non-live environment with a fresh copy of live's databases and storage, from Settings or when adding the environment.

**Architecture:** Wave 1 builds the pure load plans and the rename filter, plus stdin on `DockerApi.exec`. Wave 2 runs two tracks in parallel worktrees: hostd (the copy run, its records, the agent verb, locks and api routes) and the portal (against the api contract). Wave 3 merges them, writes the runbook, and runs the whole-branch review.

**Tech Stack:** TypeScript, Node 22 (`node --import tsx --test`) for hostd; Next.js with vitest for the portal. Docker Engine API over the socket, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-25-copy-live-data-design.md`

## Global Constraints

- Admin only (policy verb `provision`). Never into `live`.
- Refuse, before anything changes: a `generic` database (name the service), a busy environment (deploying, port change, deleting, restoring, copying), a running backup of the project, a registered database with no running live container, free space below 10 GiB plus live's storage size, a flat site.
- Only statements that name live's database `<id>` exactly are rewritten to `<id>-<env>`. Data lines are never rewritten.
- Staging goes under `<site>/.copy/<run>/` and is always removed. Records go to `/var/lib/hostd/copies.json`, the last 20 per environment, written via temp file and rename.
- The environment ends in the state it began in: site services running only if they were, databases stopped again if the copy started them.
- Live is never stopped by a copy.
- No em dashes (U+2014) in docs, UI copy, messages or commit messages. Check with a Python script file using `chr(0x2014)`, never a literal or an escape in a heredoc.
- Commit messages: subject, blank line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, via `git commit -F <file>`.
- hostd: `cd hostd && npm test`, `npm run typecheck`. Portal: `npx vitest run`, `npx tsc --noEmit` at the repo root (the baseline has 12 image-import errors; add none).
- Tests use fakes; no Docker, network or real filesystem.

## Planning decision

- As in piece 2, tasks are specified by interface, behaviour and required tests, not full code, because the implementers work against a large existing codebase. Each task names its files, exact signatures and the tests that must exist.

---

## Wave 1

### Task 1: Load plans, rename filter, and exec stdin

**Files:** Create `hostd/src/agent/copy-plans.ts` and its test. Modify `hostd/src/agent/docker.ts` (`DockerApi.exec` and its implementation) and its test.

**Produces:**
- `renameDatabaseLine(engine: 'postgres' | 'mysql' | 'mariadb', line: string, from: string, to: string): string`. It rewrites only these statements when they name `from` exactly:
  - postgres: `CREATE DATABASE`, `ALTER DATABASE`, `COMMENT ON DATABASE`, `\connect` (quoted or bare identifier).
  - mysql and mariadb: `CREATE DATABASE` and `USE` with the backquoted identifier, including the `/*!32312 IF NOT EXISTS*/` form.

  Every other line comes back unchanged.
- `renameStream(engine, from, to): Transform`: a line-splitting stream transform that applies `renameDatabaseLine` and keeps line endings and a final line without a newline. It handles lines split across chunks.
- `loadPlan(service: string, entry: ServiceEntry, from: string, to: string): LoadPlan | { problem: string } | null` where
  `LoadPlan = { kind: 'exec', service, before: string[] | null, argv: string[], rename: boolean, errorFilter: 'postgres' | null } | { kind: 'redis', service } | { kind: 'sqlite', service, file: string }`.
  - postgres:
    - `before` is `sh -c 'psql -U "$${user}" -d postgres -c "DROP DATABASE IF EXISTS \"<to>\" WITH (FORCE)"'`.
    - `argv` is `sh -c 'psql -U "$${user}" -d postgres'`, fed the dump on stdin.
    - `rename: true`, `errorFilter: 'postgres'`.
    - The user env var is the same as the dump's (default `POSTGRES_USER`).
  - mysql and mariadb: `before` runs `DROP DATABASE IF EXISTS \`<to>\``, and `argv` is the `mysql`/`mariadb` client fed on stdin. Both use the same credentials as the dump (`MYSQL_PWD` from the password env, and the user env or root). `rename: true`.
  - mongodb: no `before`. `argv` is `sh -c 'mongorestore --archive --gzip --drop --nsFrom "<from>.*" --nsTo "<to>.*" ${U:+...}'` with the dump's credential envs. `rename: false`.
  - redis: `{ kind: 'redis' }`. sqlite: `{ kind: 'sqlite', file }`.
  - generic: `{ problem: '<service> uses the generic engine, which cannot be copied while live runs; give it a real engine in the registry' }`. A non-database service gives null.
- `postgresLoadErrors(stderr: string): string[]` returns the `ERROR:` lines other than "already exists" for roles and databases.
- `DockerApi.exec(id, argv, onStdout, stdin?: Readable)`. When stdin is given, the exec is created with `AttachStdin: true` and the stream is piped into the hijacked connection, then half-closed, and the call resolves with `{ exitCode, stderr }` as today. Existing callers are unchanged.

**Required tests:**
- `renameDatabaseLine`:
  - Each named statement is rewritten, in both quoted and bare forms for postgres and in the `/*!32312 IF NOT EXISTS*/` form for mysql.
  - Lines naming `acmeold`, `acme_x` or `"acme-live"` are untouched.
  - A data line `INSERT ... 'acme' ...` and a `COPY` data line containing `acme` are untouched.
- `renameStream` with a statement split across two chunks.
- `loadPlan` for every engine, and the generic refusal text.
- `postgresLoadErrors` keeps "relation ... does not exist" and drops "role ... already exists".
- The exec stdin path against a fake socket: bytes written reach it, and it half-closes.

**Commit:** "Plan how hostd loads a live dump into an environment's database"

---

## Wave 2 (two parallel tracks off Task 1)

### Task 2 (track H): The copy run in hostd

**Files:** Create `hostd/src/agent/copy-store.ts`, `hostd/src/agent/copy-run.ts` and their tests. Modify:
- `hostd/src/shared/protocol.ts`: a `copy` verb with actions `start`, `get-run` and `list`.
- `hostd/src/agent/agent.ts`: dispatch; the block extended to copies; backups refused while a copy runs.
- `hostd/src/agent/index.ts`: wiring, and marking a stale `running` record failed at boot.
- `hostd/src/api/routes.ts` and `hostd/src/api/policy.ts`: the three routes, plus `copyFromLive` on add-environment.
- Their tests.

**Produces:**
- `CopyRecord = { project, environment, run, actor, startedAt, durationMs, outcome: 'ok' | 'failed' | 'running', step: string | null, reason: string | null, services: string[], storage: string[] }`.
- `CopyStore` with `list(project, environment)`, `get(project, environment, run)`, `start(record)`, `finish(record)` and `markInterrupted()` (sets `running` records to failed with "the agent restarted during the copy" and returns them, so boot can remove their staging). Keeps 20 per environment, written atomically.
- `copyRefusal(project, environment, deps): Promise<string | null>` for every refusal in the Global Constraints.
- `runCopy(project, environment, run, actor, deps): Promise<CopyRecord>`, with the spec's seven steps and these deps:
  - `dockerApi` (exec with stdin, list containers by compose name)
  - `runner` (compose stop/up, `docker cp`, `sqlite3`, `cp -a`)
  - `fs`: `mkdir`, `move`, `rmdir`, `exists`, `owner`, `own`, `writeStream`, `readStream`, `freeBytes`, `sizeOf`
  - `store`, `log`, `now`

  Step names recorded: `dump`, `prepare`, `load:<service>`, `sqlite:<service>`, `storage:<path>`, `restore-state`, `clean`. The dump uses `dumpPlan` from `backup-dumps.ts` against live's containers (found by live's compose name). The load uses `loadPlan` against the environment's containers (found by `<id>-<env>`), piping the staged file through `renameStream` when `rename` is true.
- Agent `copy` verb: `start { environment }` returns `{ ok: true, run }` at once, or a refusal. `get-run` and `list` return records, plus `running: boolean`. The block uses the same per-environment runner block and `trashing`-style set that delete and restore use, so deploys, port changes, domains, configure, delete and restore of that environment answer `busy` during a copy. A backup of the project is refused while any of its environments is copying, and a copy is refused while a backup of the project runs.
- Routes, all admin:
  - `POST /projects/:id/:env/copy-from-live` returns `{ ok: true, run }`.
  - `GET /projects/:id/:env/copy-runs` returns `{ runs, running }`.
  - `GET /projects/:id/:env/copy-runs/:run` returns one record.
  - `POST /projects/:id/environments` accepts `copyFromLive?: boolean`. After a successful add it starts a copy and adds `copy: { run } | { refused: message }` to the reply.

**Required tests:**
- A full ok run with postgres, redis, sqlite and one storage folder:
  - the call order of the seven steps;
  - the rename applied to the postgres stream only;
  - site services restarted only if they were running;
  - databases the copy started are stopped again;
  - staging removed;
  - the record saved as ok.
- Each refusal, with no side effects.
- A failure at dump, at a load and at storage each still runs restore-state and clean, and records the step.
- Postgres load errors fail the step, while "already exists" does not.
- A deploy start and a delete during a copy are refused `busy`. A backup is refused during a copy, and a copy during a backup.
- `markInterrupted` at boot.
- The routes: admin ok, client refused, a live env refused, `copyFromLive` starting a copy after an add.

**Commits:** coherent steps, for example:
- "Keep a record of copies into hostd environments"
- "Copy live's databases and storage into a hostd environment"
- "Start and watch copies from the hostd api"

### Task 3 (track P): Portal

**Files:**
- `server/hostd/environments.ts`: new `copyFromLive`, `copyRuns` and `copyRun` wrappers, plus `copyFromLive` on add.
- `app/(portal)/portal/sites/[id]/actions.ts`: `copyFromLiveAction(id, env, typedName)`, admin only. It checks the site owns the environment, refuses `live`, and needs the typed name to equal `env`.
- `app/(portal)/portal/sites/[id]/environments.tsx`:
  - a "Copy data from live" button on each non-live row;
  - a confirm dialog explaining what is replaced and that the copy is client data, with the environment name typed back;
  - polling of the run every 3 seconds while `running`, showing running, then done or failed with the step and reason;
  - an Add form checkbox, "Start with a copy of live's data".
- The Deploys tab: a note while a copy of the viewed environment runs, fed from `copyRuns` on the page.
- Tests beside each.

**Consumes (the api contract; it may not exist in this worktree, so mock fetch as the existing wrappers do):**
- `POST /projects/:id/:env/copy-from-live` with no body. The reply is `{ ok: true, run }` or a refusal `{ code, message }`.
- `GET /projects/:id/:env/copy-runs` returns `{ runs: CopyRecord[], running: boolean }`, and `GET .../copy-runs/:run` returns a `CopyRecord` (fields as in Task 2).
- `POST /projects/:id/environments` with `{ name, branch, domain, copyFromLive }`. The reply includes `copy: { run } | { refused: message }` when `copyFromLive` was true.

**Required tests:**
- The wrappers' request shapes.
- The action:
  - refuses a client, `live`, a wrong typed name, and an environment the site lacks;
  - is ok for an admin.
- The confirm flow, polling states (running, then ok; running, then failed with the step), and the add checkbox passing `copyFromLive`.
- The Deploys note shows only while running, and is hidden for clients.

**Commits:** coherent steps.

---

## Wave 3

### Task 4: Merge, runbook, verify

- Merge tracks H and P, and check the reply shapes match what the portal parses.
- `hostd/RUNBOOK.md`:
  - what a copy does, step by step, and its refusals;
  - that it copies real client data, possibly onto a public hostname;
  - where staging and the records live;
  - cleaning up after a crash by hand;
  - copying a generic database by hand.
- Run the full hostd and portal suites and both type checks.
- If Master moved, merge it and retest.

**Commit:** "Document copying live's data in the hostd runbook"
