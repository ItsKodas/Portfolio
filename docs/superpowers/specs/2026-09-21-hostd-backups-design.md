# hostd backups design

Date: 2026-09-21
Status: implemented on claude/portal-backups-system-4a738e, local backups only (offsite remains out of scope, see below)
Extends: `docs/superpowers/specs/2026-09-20-hostd-design.md` (phase 1, deployed) and
`docs/superpowers/specs/2026-09-20-hostd-provisioning-design.md` (provisioning and deploys, deployed).
The portal screens that put a UI on this are designed in
`docs/superpowers/specs/2026-09-20-client-portal-screens-design.md` and built separately.

## Context

hostd phase 1 named backups as phase 2 and described them in full: one restic repository per project, a
dump per database engine, manual and scheduled runs, an offsite copy on Cloudflare R2, and downloads
streamed as a tar.gz. None of it was built yet when this design was written. `hostd/src` had no backup
code, and the only parts phase 1 had left in place were the registry's `backups.maxKeep` key, the
`backups` capability and the `offsite.keep` block. It is built now, on `claude/portal-backups-system-4a738e`,
except for the offsite copy, which this revision narrows out of scope (see below and the Status line
above).

The portal's Backups tab is a placeholder that says the page comes after the deploys work. The deploys
work has landed, so this is next.

This design narrows phase 2 to what can be built and verified now, and records why.

## Scope

### In scope

- One local restic repository per project, created on first use
- A dump per database engine: postgres, mysql, mariadb, mongodb, sqlite, redis, and a generic fallback
- Manual runs, capped and rate limited, and scheduled runs with client-chosen retention
- A run history that records failures, which produce no snapshot
- Listing, deleting and downloading snapshots
- The seven endpoints phase 1 named, their policy, and the `backup` agent verb
- Docker exec in the agent's Docker adapter, which the dumps need and which does not exist yet
- The health signals phase 1 deferred to here: backup disk under 10% free, and a failed scheduled backup
- A written restore procedure in the runbook

### Out of scope

- **The offsite copy to R2**, and with it `restic copy`, offsite retention, deletion tombstones and
  offsite prunes. See "Why offsite is not here" below.
- **Restore from the portal.** Phase 1 ruled it out and nothing here changes that: a restore overwrites a
  live database on a mis-click. It stays a runbook procedure.
- The portal's Backups tab, which is its own slice on top of these endpoints.
- Backing up the test environment, the compose file, env files or source code.

## Why offsite is not here

The agent runs `network_mode: none`, deliberately, because it holds the Docker socket. Phase 1 puts the R2
credentials and `restic copy` inside the agent, which cannot work: the agent has no network namespace to
reach R2 from.

Three ways out were considered: route the copy through the fetcher, which already has the hostd network;
add a fourth container that does nothing but copy, forget and prune offsite; or put the agent on a network
and follow phase 1 literally. Each is a real change to the service's security posture, and the last one is
a change for the worse.

So offsite becomes its own design and its own slice, decided on its merits rather than as a detail of this
one. Until it lands, hostd's backups are local to the dedi, and the operator should know that: a dedi that
is gone takes the backups with it. The runbook says so.

Nothing here blocks offsite later. A snapshot copied to R2 afterwards is the same snapshot, because restic
repositories copy between each other, and the tombstone rule that delays client deletions by seven days is
only needed once there is an offsite copy to delay against.

## Decisions

**A run is started, not awaited.** `POST /projects/:id/backups` replies 202 with a run id, as phase 1 says.
A large database and a large uploads directory take minutes, and api's call timeout is 150 seconds. This
matches deploys exactly.

**The agent owns the run history.** It sits in the agent's existing state volume, in `backups.json` beside
`deploys.json`, written atomically per change. The agent is what performs a run, and a failed run leaves no
snapshot for restic to remember, so a store that only restic feeds would silently forget failures.
`restic snapshots` stays the source of truth for what exists; the history is the source of truth for what
happened.

**The schedule lives in api, and api runs the tick.** Schedules are client-set configuration, not operator
configuration, so they do not belong in the registry. They live in api's `/state` volume, next to the audit
log. The tick is one minute; a run that fell due while api was down runs once at startup. The agent
re-checks the capability, the locks and the disk on every run, so a compromised api can trigger a backup
but cannot bypass any of them.

**Owners act on their own backups.** Unlike deploys, which are admin-only to start, the client may run,
delete, download and schedule backups of their own project. Phase 1's backups section is written from the
client's side, and the portal screens design shows clients doing exactly this. Both `backup` and
`backup-read` require the project's `backups` capability, which the operator controls per project.

**Live only.** For a project with environments, a run reads the live environment's directory, its storage
and its database services. Test is not backed up, and the portal will say so.

## The run

### Order

1. Take the project lock and the global lock. Refuse if either is held.
2. Refuse if the backup disk has less than 10% free, and raise it to the operator as well as the caller.
3. Refuse a manual run if the project already has five manual snapshots, or if a manual run finished less
   than 10 minutes ago.
4. Create the repository if it does not exist yet.
5. Dump each database service into `/backups/.staging/<id>/<run>/db/<service>/`.
6. One `restic backup` over the staging directory and the storage directories, tagged `manual` or
   `scheduled`.
7. Clear the staging directory, whatever happened.
8. For a scheduled run, apply the client's retention with `restic forget`.
9. Record the run.

**A failed dump fails the whole run and records no snapshot.** A snapshot silently missing its database is
worse than none, because it looks like protection. Earlier snapshots are untouched.

### Locks

Phase 1's three locks stand: one lifecycle action per project, one backup per project, one backup across
the dedi. The global lock is what stops a scheduled sweep saturating the disk or, later, the uplink.

A run also refuses while a deploy is in flight for that project, because a deploy renames the whole
directory and a backup started mid-swap would read a tree that is moving. The reverse is not enforced: a
deploy that starts mid-backup is not blocked, and restic captures the storage directories as they are at
the moment it walks them. The database dump is already in staging by then, so the dump is never torn.

### Contents of a snapshot

```
db/<service>/...        a dump of each database service
storage/<dir>/...       every storage directory, whatever its mode, including hidden
```

**As built, corrected 2026-09-21:** this is not the layout a snapshot actually has. restic stores the
paths it is given, not a curated tree copied into place first, and `backup-run.ts` gives it the staging
directory (`<HOSTD_BACKUP_DIR>/.staging/<id>/<run>`, holding the dumps under `db/<service>/...`) plus each
storage directory's own absolute path, unchanged. A real snapshot therefore contains
`/backups/.staging/<id>/<run>/db/<service>/...` and each storage directory at its real path, for example
`/var/www/<id>/live/<storage>/...`, not a clean `db/` and `storage/` split at the snapshot root. This was
a deliberate choice, not an oversight: producing the layout above would mean copying every storage
directory into staging before capturing it, doubling disk usage for the run, which is exactly what
capturing storage in place avoids. A downloaded archive (`GET .../backups/:snapshot/download`) carries
these same real paths, which means it exposes the dedi's own directory layout, including the project id
and the run id that produced the dump. The offsite phase and the portal's Backups tab should both read
this correction, not the block above, as what a snapshot and a download actually contain.

The compose file, env files and source code are excluded. They are the operator's deployment, not the
client's data, and a downloaded backup must not carry the operator's secrets.

### Dumps per engine

Every dump runs through `docker exec` in the database container with a fixed command string, using
credentials from that container's own environment. No value from a request reaches a command. A service may
override the variable names with `dump: { userEnv, passwordEnv }`.

| Engine | Method |
| --- | --- |
| postgres | `pg_dumpall -U "$POSTGRES_USER"` |
| mysql, mariadb | `mysqldump` or `mariadb-dump`, `--all-databases --single-transaction --routines --events`, password via `MYSQL_PWD` so it never reaches a process list |
| mongodb | `mongodump --archive --gzip`, authenticated when `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` are set |
| sqlite | the agent runs `sqlite3 <file> ".backup <staging file>"` itself against the file the registry names, which is safe against a concurrent writer |
| redis | `redis-cli --rdb` to a temporary file in the container, then streamed out |
| generic | stop the service, copy its bind-mounted data, start it again; the run is recorded as briefly disruptive |

The generic method exists so that an unknown engine never blocks backups entirely. It becomes unnecessary
for an engine once that engine has a dump method.

### Docker exec

`src/agent/docker.ts` speaks the Docker Engine API over its socket and has no exec today. This design adds
it: create an exec, start it, and stream its multiplexed output, reusing the frame splitting already
written for logs. Exec is the only new Docker capability here, and it is the agent's alone.

## Manual and scheduled runs

**Manual**, tagged `manual`: kept until the client deletes them, at most five per project. A sixth is
refused until one is deleted. At most one manual run per project per 10 minutes. Retention never forgets a
manual snapshot.

**Scheduled**, tagged `scheduled`: off, daily or weekly, at a time of day in Australia/Brisbane, which has
no daylight saving and therefore no skipped or doubled runs. The client chooses keep-daily, keep-weekly and
keep-monthly, each capped by the project's `backups.maxKeep` in the registry. A schedule that asks for more
than the cap is clamped and the reply says so.

Retention runs after each scheduled run, over `scheduled` snapshots only. Prunes, which are expensive, run
weekly rather than per run.

## Deleting

A delete is `restic forget` on that snapshot in the local repository, after checking the snapshot id is hex
and belongs to that project's repository. There is no tombstone, because there is no offsite copy for one
to delay. The offsite slice adds tombstones and the seven-day purge, and the portal copy that explains it.

## Downloads

`restic dump --archive tar <snapshot> /`, gzipped as it streams, relayed through api as
`<id>-<date>.tar.gz`. Never buffered in memory, never written to disk. api relays the agent's stream the
way it already relays logs.

## Endpoints

```
GET    /projects/:id/backups                      snapshots and recent runs
POST   /projects/:id/backups                      start a manual run, 202 with a run id
GET    /projects/:id/backups/runs/:run
DELETE /projects/:id/backups/:snapshot
GET    /projects/:id/backups/:snapshot/download
GET    /projects/:id/backups/schedule
PUT    /projects/:id/backups/schedule
```

Two policy verbs, both requiring the `backups` capability:

- `backup-read`: the snapshot list, a run, and reading the schedule
- `backup`: starting a run, deleting, downloading, and writing the schedule

Admin bypasses ownership only, as everywhere else. A project that is not the caller's, and a project with
the capability switched off, return the same 404, so the API never confirms that a project exists to
someone who may not see it.

Every mutation and every download is audited, as phase 1 requires.

## The agent verb

One verb, `backup`, with actions `run`, `list`, `get-run`, `delete` and `download`. The schedule is not an
agent action: api holds the schedule and turns a due schedule into a `run`. The agent independently
enforces that the project exists, is valid, and has the `backups` capability.

## Files

| Path | Responsibility |
| --- | --- |
| `src/shared/backups.ts` (new) | The run record, the snapshot type, and the pure rules: the manual cap, the rate limit, retention clamped to `maxKeep` |
| `src/agent/restic.ts` (new) | The restic adapter: init, backup, snapshots, forget, prune, dump |
| `src/agent/backup-dumps.ts` (new) | One dump per engine into staging |
| `src/agent/backup-run.ts` (new) | One run end to end |
| `src/agent/backup-runner.ts` (new) | Starts a run without awaiting it, and holds the locks |
| `src/agent/backup-state.ts` (new) | The run history on disk |
| `src/agent/docker.ts` (modify) | exec |
| `src/shared/protocol.ts` (modify) | The `backup` verb, its actions and replies |
| `src/agent/agent.ts` (modify) | The verb handler |
| `src/agent/index.ts` (modify) | Wiring, and the weekly prune |
| `src/api/schedule.ts` (new) | Schedules in `/state`, the one-minute tick, catch-up at startup |
| `src/api/policy.ts` (modify) | `backup` and `backup-read` |
| `src/api/routes.ts` (modify) | The seven endpoints and the download relay |
| `src/shared/status.ts` (modify) | The two new health signals |
| `docker-compose.yml`, `Dockerfile`, `example.env.agent`, `RUNBOOK.md` (modify or new) | The backup mount, restic and sqlite in the image, `RESTIC_PASSWORD`, and how to operate and restore |

## Deployment changes

- The agent image gains `restic` and `sqlite`.
- The agent mounts `HOSTD_BACKUP_DIR` (default `/srv/backups/hostd` on the host) at `/backups`.
- The agent gains an env file, `.env.agent`, holding `RESTIC_PASSWORD`. It has none today: its environment
  is inline in the compose file, which is committed. `example.env.agent` is committed, the filled copy is
  not.
- **`RESTIC_PASSWORD` must also be kept off the dedi.** Without it the repositories are unreadable, and
  once offsite exists it is the only thing standing between a destroyed dedi and unreadable archives. The
  runbook says this in the place where the password is generated.

## Testing

As everywhere in hostd: `node --test` through tsx, no mocking library, every side effect injected. restic,
Docker, the clock, the filesystem and the disk check are adapters, so the suite runs with no restic binary,
no Docker and no disk. The pure rules in `src/shared/backups.ts` are tested directly, and the command
strings per engine are asserted as strings rather than executed.

## Restore, and the runbook

Restore stays manual, and the runbook gains the procedure: find the snapshot, dump it to a staging
directory, stop the site, restore the storage directories, load the database dump with the engine's own
tool, start the site. It is written out per engine so that it is followed rather than improvised at three
in the morning.

## Risks accepted

| Risk | Why it is accepted, or what limits it |
| --- | --- |
| Backups are local to the dedi until the offsite slice lands | The situation offsite exists for is the one where the dedi is gone, and this does not cover it. Stated in the runbook, and the offsite slice is the next piece of hostd work. |
| The agent gains `docker exec` | It already holds the Docker socket, which is root-equivalent, so this widens what a compromise reaches rather than changing its class. Every command string is fixed and no request value reaches one. |
| The generic engine stops a database briefly | It exists so an unknown engine is still backed up. The run is marked disruptive, and writing a dump method for that engine removes the need. |
| A client can fill the backup disk with manual runs | Five per project, one per 10 minutes, and a run is refused under 10% free. The operator is told when that happens. |
| A restore is a manual procedure at a bad moment | Deliberate: a restore button overwrites a live database on a mis-click. The runbook procedure is the mitigation, and it is written per engine. |
| Retention is the client's, so a client can keep almost nothing | Their data, their choice, bounded above by the operator's `maxKeep`. Once offsite exists, the operator's own retention is independent of theirs. |

## A hazard this work does not fix

Storage directories are paths under a project's `dir`, and a deploy renames `dir` to `dir.prev` and
promotes `dir.next` in its place. For a project that both auto-deploys and declares storage, the live
storage directory is carried out of the running tree by a deploy and removed with the previous copy later.
Nothing in the deploy path treats storage specially.

No project is in that position yet: provisioned projects start with `storage: {}`, and the one real site
declares no storage. This design does not change it, because it belongs to provisioning and deploys, not
backups. It is recorded here because backups are the thing that would otherwise be trusted to have covered
it, and because a backup taken during a deploy is exactly the case where it bites.

## Later

- **Offsite**, its own design: where `restic copy` runs given an agent with no network, R2 credentials,
  offsite retention under `offsite.keep`, deletion tombstones with the seven-day purge, weekly offsite
  prunes, and the portal copy explaining the window.
- **The portal's Backups tab**, on top of these endpoints: the snapshot list, run now, delete, download,
  the schedule editor, the page that says why there is no restore button, and the note that test is not
  backed up.
