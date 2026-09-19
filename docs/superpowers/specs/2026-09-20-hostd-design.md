# Client site-control service (hostd) design

Date: 2026-09-20
Status: approved design, not yet implemented

## Context

The portfolio site is growing a client portal, decomposed into seven parts. Part 1 (Postgres, Prisma, admin
sign-in, the quote form and an admin quote inbox) is being built separately. Part 2 adds client accounts. The
goal of the portal as a whole, in the operator's words: existing clients manage the sites the operator built
for them. Concretely, a client should be able to start and stop their site, set its domain, watch live logs,
browse the files in its persistent storage, create, manage and download backups, and schedule automated
backups.

This document designs the backend that actually does those things: a service on the dedicated server that
the portal will call. The portal pages are a later part and are not designed here.

### The environment, as it stands

| Property | Finding |
| --- | --- |
| Host | The operator's dedicated server on their home network, the same machine that runs the site and `mail/` |
| Connection | Telstra residential, Queensland, dynamic IP, behind Cloudflare |
| Ingress | Apache2 on the host, 443 forwarded on the modem, hand-written vhosts in `sites-enabled` |
| TLS to origin | A Cloudflare Origin CA certificate on Apache, Cloudflare SSL mode Full (strict) for the operator's zones |
| Client sites | One directory per site at `/var/www/<site>`, each with its own `docker-compose.yml`: the site container plus a database sidecar |
| Persistent data | Bind mounts inside each site's directory, not named volumes |
| Databases in use | Mostly MongoDB and PostgreSQL; MySQL, MariaDB, SQLite and Redis are likely in future |
| Client domains | Mostly in the client's own registrar or Cloudflare account, CNAMEd to a hostname the operator keeps pointed at the dedi. Some are zones in the operator's Cloudflare account. |
| Deployment | Code reaches the dedi only through PRs merged to `Master` and a `git pull` there. Sessions on the dev machine cannot run Docker commands on the dedi. |

Three findings from the design discussion shape everything below.

**A Docker socket proxy does not bound privilege here.** Proxies such as `tecnativa/docker-socket-proxy`
filter by API section. Starting a container and creating a privileged container that mounts `/` are both
POSTs in the `containers` section, and database dumps need `exec`, whose API accepts `Privileged: true`. Any
grant that makes lifecycle and backups work is root. The restricted API therefore has to be code of our own,
with a fixed verb set.

**Write access to anything compose reads is root.** Each site's directory holds its compose file, its `.env`
and possibly a build context. A client who can edit any of those, then press start, can add
`privileged: true` or bind-mount `/`. File access must be confined to declared data directories that
provably contain none of those things.

**Apache runs on the host.** No container can reload it without host root. The seam is a directory of
hostd-owned vhost files that Apache includes, and a host systemd unit that tests and reloads.

## Scope

### In scope

- A service in `hostd/` with its own compose file, deployed independently of the site and the mail stack
- A registry of client projects, maintained by the operator
- A permission model enforced in two independent layers
- Project status, start, stop and restart
- Live and historical container logs
- File browsing, download, upload, rename and delete, confined to declared storage directories
- Backups: database dumps per engine, storage directories, a local restic repository, an offsite copy on
  Cloudflare R2, manual and scheduled runs, retention, downloads
- Client domains: Apache vhosts, verification, and ongoing checks
- An audit log
- Health reporting in the style of `mailops`

### Not in scope

- The portal pages, and any change to the Next.js app or the root `docker-compose.yml`
- Client accounts and sign-in (Part 2 owns them; hostd receives an already-authenticated actor)
- Restoring a backup from the portal. A restore overwrites a live database; v1 documents a manual procedure
  in the runbook instead.
- Holding any Cloudflare API token. Domains are verified, never created.
- Per-hostname certificates for client-owned domains (see **Known risks**)
- Editing the registry, compose files, `.env` files or source code through the service
- Downloading a whole storage directory as an archive (backups cover it)
- Operating the operator's own stacks: the portfolio, `mail/` and hostd itself

## Decisions

**A separate service, not code inside the Next.js app.** The site is internet-facing. Whatever controls
client sites holds, in effect, root on the dedi, and must not live in the process most likely to be
compromised.

**Split into an unprivileged `api` and a privileged `agent`.** Everything that parses untrusted input
(HTTP, request bodies, uploads, the portal's claims) runs without privilege. The process holding root
accepts only a short, fixed set of verbs with strictly formatted arguments over a Unix socket, and never
speaks HTTP. A bug in the larger, more complex half is contained. This follows the reasoning already
recorded for `mailops`, which was refused the Docker socket because the socket should not sit in the
process with the broad job.

Rejected alternatives: a single container holding the socket, where a bug anywhere in HTTP, upload or path
handling is root on the dedi, one network hop from the website; and a systemd service on the host, which is
no isolation at all (membership of the `docker` group is root) and breaks the one-compose-folder-per-stack
pattern the dedi is deployed with.

**The operator owns the registry; clients own only their settings.** What exists, who owns it, where its
data lives and what it is allowed to do is a hand-edited file the service reads and never writes. Domains and
backup schedules, which clients do set, live in the service's own state.

**restic for backups, one repository per project.** It encrypts before anything leaves the dedi,
deduplicates, and implements retention with `forget --prune`. Separate repositories mean no bug in listing or
downloading can show one client another client's snapshots.

**Offsite retention belongs to the operator, not the client.** A compromised portal can delete what clients
can delete. Offsite copies follow a policy only the operator sets, and client deletions reach them seven days
late, so the worst a compromised portal can do to backups is recoverable.

**No Cloudflare token.** Clients add their own CNAME. The service proves the result by fetching through
Cloudflare. Nothing in hostd can edit anyone's DNS.

**Apache is reloaded by the host, with automatic rollback.** A broken vhost file left on disk would stop
Apache after the next reboot, taking down every site on the dedi, the operator's included. The host unit
keeps a last-good copy and restores it whenever a config test fails.

## Architecture

### Layout

```
hostd/
  docker-compose.yml
  RUNBOOK.md
  .gitignore            projects.yaml, .env, .env.agent
  example.env
  example.env.agent
  projects.example.yaml
  shared/               registry schema and validation, agent protocol types
  api/                  unprivileged HTTP service
  agent/                privileged executor
  host/                 systemd units and the reload script, installed by hand
```

Each package is Node 22, ESM, TypeScript run with `tsx`, tested with `node --test`, with side effects behind
injected adapters and failures collected rather than thrown, following `mail/mailops`. The examples are
named `example.env` rather than `.env.example` because the root `.gitignore` ignores `.env*`. The root
`.dockerignore` gains `hostd/`, next to its existing `mail/`, so none of this enters the site image.

### Containers

**`hostd-api`** runs as the `node` user.

- Listens on `:8080` on an external Docker network named `hostd`, created by this compose file. No host port
  is published. The portal joins the network in a later part.
- Authenticates every request with a bearer token, `HOSTD_API_TOKEN`, compared in constant time. That token
  is the only secret `api` holds.
- Owns HTTP, body validation, the permission policy, the backup scheduler, domain verification, the audit
  log, and its own state.
- Mounts: the registry file read-only, the `hostd-state` volume, and the `hostd-sock` volume.

**`hostd-agent`** runs as root.

- Listens only on `/run/hostd/agent.sock` in the `hostd-sock` volume, mode 0660, with a group it shares with
  `api`. No network listener.
- Mounts:
  - `/var/run/docker.sock`
  - `/var/www` at the same path. `docker compose` inside the container passes bind mount paths to the daemon
    as host paths, so they must match.
  - `/etc/apache2/hostd`, read-write: its own vhost directory
  - `/etc/apache2/sites-enabled`, read-only: to detect hostnames the operator's hand-written vhosts claim
  - `/var/lib/hostd-apache`, read-only: the host reload unit's result
  - The host backup directory (`HOSTD_BACKUP_DIR`, default `/srv/backups/hostd`) at `/backups`
  - The registry file, read-only
- Holds `RESTIC_PASSWORD` and the R2 credentials, so a compromised `api` cannot read or delete offsite
  backups.
- Contains the `docker` CLI with the compose plugin, `restic` and `sqlite3`.

Mount flags on the agent are not a security boundary. Anything holding the Docker socket is root, and can
read every container's environment with `docker inspect`. The boundary is the agent's code and the narrow
grammar it accepts. Where secrets are placed matters only for what a compromised `api` can reach.

### The agent protocol

One request per connection. The request is a single JSON line:

```
{ "verb": "lifecycle", "project": "acme-bakery", "args": { "action": "restart" } }
```

The reply is either one JSON line (`{ "ok": true, ... }` or `{ "ok": false, "code": "...", "message": "..." }`)
or, for streaming verbs, one JSON header line followed by raw bytes until the connection closes.

Verbs: `status`, `lifecycle`, `logs`, `fs.list`, `fs.read`, `fs.write`, `fs.mkdir`, `fs.move`, `fs.delete`,
`backup.run`, `backup.list`, `backup.delete`, `backup.download`, `vhost.write`, `vhost.status`, `health`.

The agent validates every request from scratch against its own copy of the registry. It takes nothing from
`api` that it can look up itself: the compose path, the upstream, the services, the database engines and
the storage paths always come from the registry, never from the request. Unknown verbs, unknown fields and
malformed values are refused.

### Host-side pieces

Installed once by hand from `hostd/host/`, documented in the runbook, and the only part of hostd outside a
container:

- `IncludeOptional /etc/apache2/hostd/*.conf` in the Apache configuration
- `mod_proxy`, `mod_proxy_http`, `mod_headers` and `mod_remoteip` enabled, with Cloudflare's ranges as
  trusted proxies
- `hostd-apache.path`, a systemd path unit watching one trigger file, `/etc/apache2/hostd/.reload`, which the
  agent writes last, containing a sequence number, after it has finished writing `*.conf` files. Watching
  the trigger rather than the directory means a half-finished set of writes never triggers a reload, and the
  unit's own output never retriggers it.
- `hostd-apache.service`, which it triggers. The service:
  1. runs `apache2ctl configtest`;
  2. on success, runs `systemctl reload apache2` and replaces `/var/lib/hostd-apache/last-good/` with the
     current `*.conf` files;
  3. on failure, replaces the `*.conf` files with `last-good`, does not reload, and records the failure;
  4. in both cases writes `/var/lib/hostd-apache/result.json` with the sequence number it acted on, the
     outcome, a timestamp and the config test's output.

  Both outputs live outside the watched directory. The agent mounts `/var/lib/hostd-apache` read-only to
  read the result.

### What a compromise reaches

| Compromised | Reaches | Does not reach |
| --- | --- | --- |
| The portal | The verb set on registered projects, for any client | The host, the portfolio, `mail/`, hostd itself, offsite backups |
| `hostd-api` | The same, plus the audit log and client settings | The same |
| `hostd-agent` | Root on the dedi | Nothing. It is the one component that must be right, so it is kept small. |

Ownership checks in hostd cannot stop a compromised portal, because the portal is what decides who the user
is. What hostd guarantees is that a compromised portal gains nothing beyond the verbs on registered projects.
The ownership check still earns its place as a second line of defence against portal bugs.

## Registry and permissions

### The registry

`hostd/projects.yaml` on the dedi, gitignored, with `projects.example.yaml` committed. Mounted read-only into
both containers.

```yaml
reserved: [horizons.gg]         # hostnames at or below these are never accepted as client domains
offsite:
  keep: { daily: 14, weekly: 8, monthly: 6 }
projects:
  acme-bakery:                  # ^[a-z0-9][a-z0-9-]{1,30}$, also the compose project name
    client: cl_8f2k1            # the portal's client id
    name: Acme Bakery
    dir: /var/www/acme-bakery   # exactly one segment below /var/www
    compose: docker-compose.yml # relative to dir
    upstream: 127.0.0.1:5010    # what the vhost proxies to
    services:
      web: { role: site }
      db:  { role: database, engine: postgres }
    storage:
      media:   { path: uploads, mode: rw }
      exports: { path: exports, mode: ro }
      config:  { path: config,  mode: hidden }
    capabilities: [lifecycle, logs, files, backups, domains]
    maxDomains: 3
    backups:
      maxKeep: { daily: 14, weekly: 8, monthly: 12 }
```

Database engines: `postgres`, `mysql`, `mariadb`, `mongodb`, `sqlite`, `redis`, `generic`. A database
service may override the environment variable names its dump uses (`dump: { userEnv, passwordEnv }`). A
`sqlite` entry names a file relative to `dir` (`file: data/app.db`) instead of a service.

Storage modes: `rw` and `ro` are exposed through the file API; `hidden` is backed up but never exposed.

The reserved ids `hostd`, `mail` and `horizons` are refused, so a registry mistake cannot enrol the
operator's own stacks.

### Validation

Performed by shared code in both processes when the file loads.

- The schema and every id and format are valid.
- `dir` is `/var/www/<one segment>` and exists.
- The agent runs `docker compose --project-directory <dir> -f <compose> config --format json` and checks
  the resolved project against the entry:
  - the resolved project `name` equals the registry id, so a start never creates a second, duplicate
    project beside a running one that was started under another name;
  - every registered service exists;
  - **the storage guard**, for each storage directory:
    1. it is the source of a bind mount on a `site` service, which proves it is persistent data;
    2. it is not the source of a bind mount on any `database` service, so database files are never
       exposed;
    3. it does not contain, and is not contained by, anything compose reads: the compose file, any
       `env_file`, any `.env`, or any `build.context`. Checked against the resolved configuration, so
       includes and extends are covered.

A project failing any check is marked `invalid` with the reason, and every verb on it is refused. Other
projects are unaffected. The file is re-read when its modification time changes, polled every 10 seconds. A
new file that fails to parse at all is rejected as a whole: the last good registry stays in force and the
error is raised as a warning.

### The actor

Every `api` request carries:

- `Authorization: Bearer <HOSTD_API_TOKEN>`
- `X-Hostd-Actor: client:<clientId>` or `admin`
- `X-Hostd-User: <portal user id>`, used only for the audit log

### Two layers of enforcement

`api` enforces the policy:

1. the project exists and is valid;
2. the actor is `admin`, or the actor's client equals the project's `client`;
3. the capability for the verb is enabled on the project;
4. the verb fits the target, for example a write needs a storage directory in `rw` mode.

Admin bypasses step 2 only. Capabilities are per-project feature switches that apply to the operator too;
the operator changes them in the registry.

The agent, which has no reliable knowledge of the actor, independently enforces steps 1, 3 and 4 on every
request. A compromised `api` still cannot write to read-only storage, act on a project with a capability
switched off, or touch an invalid or unregistered project.

### Locks

- One lifecycle action per project at a time
- One backup per project at a time
- One backup across the whole dedi at a time, so a scheduled run cannot saturate the disk or the uplink

## Lifecycle and logs

### Endpoints

```
GET    /projects                           projects visible to the actor
GET    /projects/:id                       status per service
POST   /projects/:id/start
POST   /projects/:id/stop
POST   /projects/:id/restart
GET    /projects/:id/logs?service=&tail=&since=&follow=
```

### Status

Read from the Docker API, containers filtered by `com.docker.compose.project=<id>`. For each registered
service: state, health, start time, restart count and image.

### Actions

Fixed argv arrays, spawned without a shell, always with `--project-directory <dir> -f <compose>`:

| Action | Command | Reason |
| --- | --- | --- |
| start | `docker compose up -d --no-build --pull never` | Works after a `down` or a reboot, and never builds or pulls, so a start cannot fetch anything new |
| stop | `docker compose stop` | Keeps the containers so the next start is quick |
| restart | `docker compose restart` | |

Each action has a 120 second timeout. The exit code and the last 4 KB of output are recorded in the audit
log.

### Logs

The agent follows the Docker logs API for the chosen container and demultiplexes Docker's framed
stdout/stderr stream (containers with a TTY are passed through as one stream). `api` relays the lines as
Server-Sent Events, each carrying its stream, timestamp and text.

- `tail` is capped at 5000 lines
- a line is capped at 16 KB, with the remainder dropped and the line marked truncated
- a follow stream closes after one hour; the portal reconnects with `since=<last timestamp>`, which is also
  how it recovers when a container restarts mid-stream
- at most four follow streams per project
- only services named in the registry are accepted

## Files

### Endpoints

```
GET    /projects/:id/storage                     storage directories and their modes (hidden ones omitted)
GET    /projects/:id/storage/:dir/list?path=
GET    /projects/:id/storage/:dir/file?path=     raw download
PUT    /projects/:id/storage/:dir/file?path=     raw upload body
POST   /projects/:id/storage/:dir/mkdir          { path }
POST   /projects/:id/storage/:dir/move           { from, to }
DELETE /projects/:id/storage/:dir/file?path=
```

Uploads are a raw request body, not multipart. The portal handles the browser's form, so hostd never parses
multipart.

### Path safety

The threat is symlinks rather than `..`. Client sites are internet-facing, and a compromised site container
can write into its own upload directory. A symlink planted there and followed by a root process is a
container escape, and so is a directory swapped for a symlink between a check and a use.

**Grammar, before any filesystem access.** Relative only. No `..` segment, no NUL, no backslash, no control
characters. Each segment at most 255 bytes, the whole path at most 4096.

**Resolution, one component at a time.** The agent opens the storage root, then opens each component
through `/proc/self/fd/<parent fd>/<name>` with `O_NOFOLLOW | O_DIRECTORY`, which gives `openat` semantics
from Node. A symlink at any position is refused. The final operation (open, mkdir, rename, unlink) is
performed through the verified parent's descriptor path, so a swap during the operation has nothing to
redirect.

**Rules:**

- Existing symlinks are listed as type `symlink`, and may be deleted. They are never followed, read or
  written through.
- Uploads stream to `.hostd-upload-<random>` in the target directory and are renamed into place, so a
  partial upload never appears as a real file. The cap is 512 MB per file, configurable, and an upload is
  refused if it would leave less than 1 GB free.
- New files and directories are `fchown`ed to the owner of the storage root, so the site can read and
  replace what clients upload.
- `move` stays within one storage directory.
- Recursive delete walks the same way and unlinks symlinks as entries, never following them.

## Backups

### Repositories

One restic repository per project, in two places:

- local: `/backups/<id>` in the agent, `HOSTD_BACKUP_DIR/<id>` on the host
- offsite: `RESTIC_OFFSITE_REPO/<id>` on Cloudflare R2

One `RESTIC_PASSWORD` covers all of them. It must also be kept somewhere off the dedi. Without it the offsite
copies are unreadable, and the situation offsite exists for is the one where the dedi is gone.

### Contents of a snapshot

One snapshot per run:

```
db/<service>/...        a dump of each database service
storage/<dir>/...       every storage directory, whatever its mode
```

The compose file, `.env` and source code are excluded. They are the operator's deployment, not the client's
data, and a downloaded backup must not carry the operator's secrets.

Dumps are written to a staging directory under `/backups/.staging/<id>/<run>`, and then a single
`restic backup` captures the staging directory and the storage directories together.

### Dumps per engine

Run through `docker exec` in the database container with fixed command strings, using credentials from that
container's own environment. No value from a request reaches a command.

| Engine | Method |
| --- | --- |
| postgres | `pg_dumpall -U "$POSTGRES_USER"` |
| mysql, mariadb | `mysqldump` or `mariadb-dump` with `--all-databases --single-transaction --routines --events`, password via `MYSQL_PWD` so it never appears in a process list |
| mongodb | `mongodump --archive --gzip`, authenticated with `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` when they are set |
| sqlite | the agent runs `sqlite3 <file> ".backup <staging file>"` itself, which is safe against a concurrent writer |
| redis | `redis-cli --rdb` to a temporary file inside the container, then streamed out |
| generic | stop that service, copy its bind-mounted data, start it again; the API marks the run as briefly disruptive |

A failed dump fails the whole run and records no snapshot. A snapshot silently missing its database is worse
than none, because it looks like protection. Earlier snapshots are unaffected.

### Manual and scheduled runs

- **Manual**, tagged `manual`: kept until the client deletes them, at most five per project; a sixth is
  refused until one is deleted. At most one manual run per project per 10 minutes.
- **Scheduled**, tagged `scheduled`: the client chooses off, daily or weekly, and a time of day in
  Australia/Brisbane, which has no daylight saving and so no skipped or doubled runs. The client chooses
  retention (keep daily, weekly, monthly) within the project's `backups.maxKeep`. The scheduler runs in
  `api` on a one-minute tick; a run that fell due while `api` was down runs once at startup.
- After each scheduled run, the agent applies the client's retention to the local repository's `scheduled`
  snapshots with `restic forget`. Manual snapshots are never forgotten by retention. Local prunes run weekly.
- Every run goes through the global backup lock.
- A run is refused if the backup disk has less than 10% free, and that is reported to the operator as well
  as the client.

### Offsite

After a local snapshot succeeds, the agent copies it to R2 with `restic copy`.

- **Offsite retention is the operator's only.** It follows the registry's `offsite.keep`. Clients' retention
  settings apply to the local repository, which is what the portal shows.
- **Client deletions reach offsite seven days late.** A delete forgets the snapshot locally at once and
  records a tombstone. The offsite snapshot is forgotten only once its tombstone is seven days old. Offsite
  prunes run weekly.
- **R2 credentials exist only in the agent**, so nothing short of root on the dedi can shorten that window.

A compromised portal can therefore destroy local copies at worst, and the operator restores from R2. The
portal should tell clients that deleted backups are purged from offsite storage after seven days.

### Downloads

`restic dump --archive tar <snapshot> /`, gzipped as it streams, relayed through `api` as
`<id>-<date>.tar.gz`. Never buffered in memory or written to disk.

### Endpoints

```
GET    /projects/:id/backups                      snapshots and recent runs
POST   /projects/:id/backups                      start a manual run, 202 with a run id
GET    /projects/:id/backups/runs/:run
DELETE /projects/:id/backups/:snapshot
GET    /projects/:id/backups/:snapshot/download
GET    /projects/:id/backups/schedule
PUT    /projects/:id/backups/schedule
```

Snapshot ids are validated as hex and are looked up only in that project's repository.

## Domains

### Endpoints

```
GET    /projects/:id/domains
POST   /projects/:id/domains                      { hostname }
POST   /projects/:id/domains/:hostname/verify     retry verification now
DELETE /projects/:id/domains/:hostname
```

### Hostname rules

Converted to punycode and lowercased, then:

1. valid letter-digit-hyphen labels, at most 253 characters, at least two labels, no wildcard, not an IP
   address;
2. not at or below any `reserved` entry;
3. not held by another hostd project;
4. not claimed by any `ServerName` or `ServerAlias` in `sites-enabled`;
5. within the project's `maxDomains`, default 3.

### The vhost

One file per project, `/etc/apache2/hostd/<id>.conf`, rendered from a fixed template. The only values
substituted are validated hostnames, verification tokens, the registry's `upstream`, and the Origin
certificate paths from the agent's configuration. It contains:

- a `*:443` virtual host with the Origin certificate
- `ProxyPass / http://<upstream>/` and `ProxyPreserveHost On`
- `RemoteIPHeader CF-Connecting-IP`, so sites see the visitor's address
- a `/.well-known/hostd/<token>` location that Apache answers itself, before proxying, with a fixed response
  carrying the token in a response header

After writing the file and then the `.reload` trigger, the agent waits up to 30 seconds for a `result.json`
carrying the sequence number it wrote. A rolled-back change marks the domain `failed` with Apache's output.

### Verification

Performed by `api`. It fetches `https://<hostname>/.well-known/hostd/<token>` with certificate verification
on, a 10 second timeout, and no redirects followed, and checks the token header. This proves Cloudflare
routes the name to Apache and Apache routes it to this project's vhost, independent of whether the client's
application works.

Retries run every minute for the first hour, then every 15 minutes up to 72 hours. Failures are translated
for the client: a TLS error almost always means the CNAME is not proxied and the request met the Origin
certificate directly; NXDOMAIN means no record exists yet; a wrong or missing token means the name points
elsewhere.

### States

`pending` becomes `active`, or `failed` after 72 hours (the client may retry). Active domains are re-verified
daily. A failure marks the domain `broken` and raises it to the operator and the client, and the vhost stays
in place, because a DNS blip must not take a site offline. Removing a domain rewrites the file without it,
or deletes the file when none remain.

### What the client is told

CNAME the hostname to `ORIGIN_HOSTNAME`, proxied, with Cloudflare SSL mode Full. Domains in the operator's own
Cloudflare account follow the same flow; the operator adds the CNAME.

### Existing sites

A site's current domains live in a hand-written vhost, and rule 4 refuses them. To move one across, the
runbook has the operator remove it from the hand-written vhost and add it through hostd as admin.

## Audit log

`api` appends one JSON line per event to `hostd-state/audit/YYYY-MM.jsonl`, keeping 12 months.

- **Logged:** every mutation, every file download, every backup download, every log stream opened, and every
  refusal. Refusals matter most: a run of them is what an attack or a portal bug looks like.
- **Not logged:** plain reads such as status and directory listings.
- **Each line:** time, actor, portal user, project, verb, target (path, hostname or snapshot, never file
  contents), outcome (`ok`, `refused` or `failed`, with the reason) and duration.
- **Endpoints:** `GET /projects/:id/audit` for a project's history, which the portal may show its client, and
  `GET /audit` for everything, admin only.

The agent separately logs every verb it executes to its own stdout, a second record held by Docker that a
compromised `api` cannot reach.

## Health and failure behaviour

Client sites never depend on hostd. Apache and the site containers serve whether or not hostd is running.
While it is down the portal's controls are unavailable and scheduled backups wait, catching up at startup.

### Hard gate at boot

Exit non-zero, naming the check.

- `api`: `HOSTD_API_TOKEN` missing or shorter than 32 characters; the registry unreadable on first load; the
  agent socket not answering after about 75 seconds of retries
- `agent`: the Docker socket not answering after retries; `RESTIC_PASSWORD` missing; `/backups` not writable;
  `/var/www` not mounted

### Degrade and shout

Logged loudly, healthcheck unhealthy, service keeps running. Collected into `status.json`, which the
healthcheck reads, as in `mailops`.

- a project is `invalid`
- the newest offsite snapshot of any project is more than 36 hours old (local backups continue)
- the last Apache change was rolled back
- the backup disk is under 10% free
- a scheduled backup failed
- a domain is `broken`
- the weekly `restic check` of a local or offsite repository failed
- the Origin certificate files are missing, which also disables the `domains` capability everywhere

### Startup cleanup

The agent removes `.hostd-upload-*` files older than a day, clears the backup staging directory, and runs
`restic unlock`, which removes only stale locks.

## Configuration surface

```
hostd/.env          HOSTD_API_TOKEN, ORIGIN_HOSTNAME, TZ=Australia/Brisbane
hostd/.env.agent    RESTIC_PASSWORD, RESTIC_OFFSITE_REPO, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
                    ORIGIN_CERT_FILE, ORIGIN_KEY_FILE
compose variables   HOSTD_BACKUP_DIR (host path, default /srv/backups/hostd)
```

`example.env` and `example.env.agent` are committed. `ORIGIN_CERT_FILE` and `ORIGIN_KEY_FILE` are host paths
as Apache sees them, written into vhosts, never read by the agent beyond checking they exist. The operator
creates the R2 bucket and a token scoped to Object Read and Write on that bucket only, and fills in the env
files on the dedi.

## Testing strategy

**Pure logic, unit tested.** Registry validation including the storage guard; path grammar; hostname rules;
the vhost template against a golden file; the policy table across actor, capability and storage mode;
schedule computation including catch-up; retention caps; the Docker log frame demultiplexer; the audit line
shape.

**Adapters faked.** Docker API, compose runner and restic runner are injected. Compose tests assert the exact
argv and that no shell is ever involved.

**Tests that must exist**, in the spirit of the mail stack's `managed-by` guard test:

1. The agent refuses a write to read-only storage, and any verb on an unregistered project, when `api`
   itself asks.
2. The storage guard rejects a directory that contains the compose file, an `env_file` or a build context,
   and one mounted into a database service.
3. A symlink escape is refused at the first, a middle and the final component, including a directory
   swapped for a symlink between steps, simulated through an injected hook.
4. A hostname claimed by another project, or by `sites-enabled`, is refused.
5. A client's delete does not reach the offsite repository before seven days.

**Linux-only tests.** The descriptor walk depends on `/proc`. Those tests skip with a visible message on
other platforms, and run in the agent image's build stage (`RUN npm test`), so every deploy on the dedi runs
them and a failure stops the build.

**Live verification on the dedi**, in the runbook. A throwaway project at `/var/www/hostd-test` (nginx and
postgres). Calls made with curl from a throwaway container on the `hostd` network, since no portal exists
yet. Each phase adds its own steps, among them planting a symlink by hand, a restore drill from R2, and
deliberately breaking a vhost to watch the rollback. Domain verification needs a spare zone other than
`horizons.gg`.

## Build phases

Each phase is its own PR with its own implementation plan. This document covers all four.

| Phase | Contents |
| --- | --- |
| 1 | Both containers, the shared registry and validation (including the storage guard, which phase 3 relies on), the agent protocol, auth, policy, audit and health, status, lifecycle and logs, and the runbook's base setup |
| 2 | Backups: dumps, the local repository, offsite, schedules, retention, downloads, delayed offsite deletion |
| 3 | Files |
| 4 | Domains, the host systemd units, and the Apache include |

## Known risks and accepted weaknesses

**Client-owned domains use Full, not Full (strict).** The Origin certificate cannot cover a hostname in
someone else's zone, so the hop from Cloudflare to the dedi is encrypted but not authenticated for those
domains. The upgrade path is per-hostname certificates or Cloudflare for SaaS custom hostnames.

**The agent is root.** No arrangement of mounts or proxies changes that while it holds the Docker socket.
Mitigation is structural: it never speaks HTTP, accepts a fixed grammar, and re-derives everything it can
from the registry.

**A compromised portal can act as any client.** Within the verb set only, and without reaching offsite
backups, the host or the operator's own stacks. The audit log and the agent's own log record what it did.

**The generic backup method stops a database briefly.** It exists so that a new engine never blocks
backups entirely, and becomes unnecessary once a dump method is written for that engine.

**Offsite copies depend on one password.** Losing `RESTIC_PASSWORD` makes every offsite copy unreadable. The
runbook requires it to be stored off the dedi.

## Later phases

Recorded so the seams are built in the right shape.

1. **Portal pages.** The portal joins the `hostd` network and calls the API with the actor headers. Part 2's
   client ids are what the registry's `client` fields hold.
2. **Restore from the portal**, once the manual procedure has been exercised enough to trust.
3. **Per-hostname certificates** for client-owned domains.
