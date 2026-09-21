# hostd runbook

hostd lets the client portal control client sites on this dedi. Phase 1 covers status, start, stop,
restart and logs; phase 2 adds provisioning: creating and removing projects and environments, and editing
their env files. It is three containers:

- `hostd-agent` holds the Docker socket. It has no network and listens only on a Unix socket.
- `hostd-api` speaks HTTP on the private `hostd` Docker network. Nothing is published on the host.
- `hostd-fetcher` does Git. It has a network and the GitHub token, and can write under `/var/www`, but
  never gets the Docker socket and never shares a socket with `api` (its own volume is mounted only in it
  and the agent), so a compromise there cannot touch a container, the registry, impersonate the agent to
  `api`, or reach anything outside `/var/www` and its own socket to the agent.

Client sites never depend on hostd. If it is down, every site keeps serving; only the portal's controls
stop working. The fetcher is narrower still: if only it is down, lifecycle and logs (what the deployed
site depends on) keep working, and only provisioning and env editing are unavailable.

## Before the first start

1. Pull the repo on the dedi, then work in `hostd/`.
2. Create `hostd/.env` from `hostd/example.env`. Generate the token here on the dedi, and paste it into
   the file yourself:

   ```bash
   openssl rand -hex 32
   ```

3. Create `hostd/.env.fetcher` from `hostd/example.env.fetcher`, and fill in `GITHUB_TOKEN` with a
   fine-grained personal access token, read-only, limited to the client repositories.

4. Create `hostd/registry/projects.yaml` from `hostd/registry/projects.example.yaml`, and delete the
   example project for now. `registry/` is already there, because the example lives in it, and the
   containers mount that directory rather than the file inside it. **This must exist before the first
   `docker compose up`:** if it does not, Docker creates the missing pieces as directories instead, and
   the agent and api (the two containers that actually read the registry) refuse to start with a message
   saying so; the fetcher never reads it, so it starts regardless. If that happens, remove the directory
   it created in place of the file, create the file, and start again.

## Editing the registry

`hostd/registry/projects.yaml` is hand-edited and read every ten seconds. Any editor will do: the
containers mount the directory, so replacing the file is seen the same as writing it in place.

This was not always true. Before 2026-09-20 the file itself was the bind mount, which pinned each
container to one inode, and an editor that saves by writing a temporary file and renaming it over the
original (which is most of them, and `sed -i`) detached the mount silently. hostd carried on serving the
version it read at startup, reported `healthy`, and no edit ever took effect again. If a registry edit
appears to do nothing, check for that shape first:

```bash
docker exec hostd-agent cat /proc/self/mountinfo | grep registry
```

A `//deleted` in that line means the mount is detached, and the fix is
`docker compose up -d --force-recreate`. On this version hostd says so itself, in both logs, as
`registry reload rejected ... has been replaced on the host`, and goes unhealthy until it is recreated.

## Upgrading from an older install

An existing install may be missing `hostd/.env.fetcher` (added along with provisioning, phase 2), or have
its registry at the old, pre-2026-09-20 location `hostd/projects.yaml`, mounted into each container as a
single file rather than a directory. Bring it up to date:

1. Stop the stack: `docker compose down`.
2. If `hostd/.env.fetcher` does not exist yet, create it from `hostd/example.env.fetcher` (see step 3
   above).
3. If the registry is still at `hostd/projects.yaml`, move it into the folder the containers now mount:

   ```bash
   cd hostd
   mkdir -p registry
   mv projects.yaml registry/projects.yaml
   ```

   (`-p` matters here: if a previous, incomplete `docker compose up` already created `registry` as an
   empty directory, a plain `mkdir` fails and the `mv` never runs.)
4. `docker compose up -d --build --force-recreate`.

`--force-recreate`, not `restart`: a restart keeps a container's existing mounts, so one already running
against the old single-file mount would still be looking at the old, now-detached, path.

The old `hostd/projects.yaml` is not read from its old location any more once the registry mount points at
the `registry/` folder; nothing in phase 2 looks at it. It is safe to delete once `registry/projects.yaml`
is in place and the stack is back up, and safe to leave in place if you would rather keep it as a backup
for a while, since nothing treats its mere presence as meaningful.

## First start

```bash
cd hostd
docker compose up -d --build
docker compose ps
```

The build runs the whole test suite. A failing test stops the build, and whatever was running before
keeps running.

All three containers should report `healthy` within about two minutes. All three logs should show
`listening`:

```bash
docker compose logs agent | tail -20
docker compose logs api | tail -20
docker compose logs fetcher | tail -20
```

If a container exits, its log names the failed check on a `FATAL` line.

## Calling the API from the dedi

The checks below call the API directly, from a throwaway container on the `hostd` network, rather than
through the portal: they are the operator's own way to exercise hostd itself, including things the portal
never asks for (the storage guard, the capability switch, the network boundary), so they stay a hand call
even now that the portal exists. Define this helper in the shell, from `hostd/`. It reads the token from
`.env` inside the throwaway container, so the token never appears in the host's process list:

```bash
hc() {
  docker run --rm --network hostd --env-file .env -e ACTOR="${ACTOR:-admin}" curlimages/curl:8.10.1 \
    sh -c 'curl -sS -N -H "Authorization: Bearer $HOSTD_API_TOKEN" -H "X-Hostd-Actor: $ACTOR" -H "X-Hostd-User: runbook" "$@"' curl "$@"
}
```

`ACTOR` defaults to `admin`. Prefix a call with `ACTOR=client:<id>` to act as a client.

## Live checks with a throwaway project

These prove phase 1 end to end. Do them once after the first deploy, and again after any change to
hostd.

### Set up the test project

```bash
sudo mkdir -p /var/www/hostd-test/html
echo 'hostd test page' | sudo tee /var/www/hostd-test/html/index.html
sudo tee /var/www/hostd-test/docker-compose.yml >/dev/null <<'EOF'
name: hostd-test
services:
  web:
    image: nginx:1.27-alpine
    ports: ["127.0.0.1:5099:80"]
    volumes:
      - ./html:/usr/share/nginx/html
  db:
    image: postgres:16-alpine
    environment:
      # A throwaway value for a throwaway database with no published port.
      POSTGRES_PASSWORD: hostd-test-only
    volumes:
      - ./db:/var/lib/postgresql/data
EOF
cd /var/www/hostd-test && sudo docker compose up -d && cd -
```

Add this entry under `projects:` in `hostd/registry/projects.yaml`:

```yaml
  hostd-test:
    client: cl_test
    name: hostd test
    dir: /var/www/hostd-test
    upstream: 127.0.0.1:5099
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
    storage:
      html: { path: html, mode: rw }
    capabilities: [lifecycle, logs]
```

Wait ten seconds for the reload, then run each check. Each one says what to expect.

| # | Command | Expect |
| --- | --- | --- |
| 1 | `hc http://hostd-api:8080/projects` | `hostd-test` listed with `"valid":true` |
| 2 | `hc http://hostd-api:8080/projects/hostd-test` | `web` and `db` both `"state":"running"` |
| 3 | `hc -X POST http://hostd-api:8080/projects/hostd-test/stop` | `{"ok":true,...}`; check 2 then shows both `exited` |
| 4 | `hc -X POST http://hostd-api:8080/projects/hostd-test/start` | `{"ok":true,...}`; check 2 shows both `running` again |
| 5 | `hc -X POST http://hostd-api:8080/projects/hostd-test/restart` | `{"ok":true,...}`; `startedAt` in check 2 moves forward |
| 6 | `hc 'http://hostd-api:8080/projects/hostd-test/logs?service=web&tail=5'` | up to five `event: line` blocks, then `event: end` |
| 7 | `hc 'http://hostd-api:8080/projects/hostd-test/logs?service=web&tail=0&follow=1'`, then in another shell `curl -s http://127.0.0.1:5099/` | a new `event: line` for that request appears at once; Ctrl-C to stop |
| 8 | `ACTOR=client:cl_test hc http://hostd-api:8080/projects` | only `hostd-test` |
| 9 | `ACTOR=client:someone-else hc http://hostd-api:8080/projects/hostd-test` | `404`, `"code":"not-found"` |
| 10 | `ACTOR=client:someone-else hc -X POST http://hostd-api:8080/projects/hostd-test/stop` | `404`; check 2 shows the site still running |
| 11 | `hc http://hostd-api:8080/projects/hostd-test/audit` | the stop, start, restart, log streams and refusals above, newest first |
| 12 | `docker logs hostd-agent \| tail -20` | the agent's own record of the same verbs |
| 13 | `hc 'http://hostd-api:8080/projects?status=1'` | the same list as check 1, each entry now carrying a `status` holding the services check 2 shows |
| 14 | `hc http://hostd-api:8080/health` | `system` with `memory`, `cpu` and `disk` figures for the dedi and an empty `problems`; `ACTOR=client:cl_test` on the same URL gets `403` |

### The capability switch

Remove `lifecycle` from the test entry's `capabilities` and wait ten seconds. Then:

```bash
hc -X POST http://hostd-api:8080/projects/hostd-test/stop
```

Expect `403` with `"code":"capability-disabled"`. Put `lifecycle` back.

### The storage guard

This proves that a database directory can never be exposed. Add a second storage entry that points at
the database's directory:

```yaml
      dbfiles: { path: db, mode: ro }
```

Wait ten seconds. Then:

```bash
hc http://hostd-api:8080/projects
hc -X POST http://hostd-api:8080/projects/hostd-test/restart
docker compose logs agent | tail -5
```

Expect:
- The listing shows `hostd-test` with `"valid":false` and a reason. The reason says both that `dbfiles`
  is not bind-mounted into a site service and that it overlaps a database service's mount.
- The restart is refused with `409` and `"code":"invalid-project"`.
- The agent log has a `WARN project hostd-test is invalid` line.
- `docker compose ps` shows the agent `unhealthy` after its next healthcheck.

Remove the `dbfiles` line. Within ten seconds the project is valid again, and the agent becomes healthy
at its next healthcheck.

### The boundary itself

```bash
docker port hostd-api
docker inspect hostd-agent --format '{{.HostConfig.NetworkMode}}'
docker exec hostd-agent ls -ln /run/hostd/agent.sock
docker exec hostd-fetcher ls -ln /run/hostd-fetch/fetch.sock
docker exec hostd-api ls /run/hostd-fetch
```

Expect:
- `docker port` prints nothing: no host port is published.
- The network mode is `none`.
- The agent socket is `srw-rw----` owned by `0 1000`: `api`'s own gid, so it and nothing else can connect.
- The fetch socket is `srw-------` owned by `0 0`: it lives in its own volume (`hostd-fetch-sock`), shared
  only with the agent, never with `api`.
- The last command fails with `No such file or directory`: `api` has no mount at `/run/hostd-fetch` at
  all, so it has no way to reach the fetch protocol directly even if it wanted to.

### A registry edit that breaks the file

Add a stray `[` anywhere in `registry/projects.yaml`. Within ten seconds, both logs show `WARN registry
reload rejected, still using the last good version`, and check 2 still works. Remove the `[`, and the
warning clears.

### Clean up

```bash
cd /var/www/hostd-test && sudo docker compose down && cd -
sudo rm -rf /var/www/hostd-test
```

Then remove the `hostd-test` entry from `registry/projects.yaml`.

## Enrolling a real site

1. Find the site's compose project name:

   ```bash
   docker compose ls
   ```

   Use that name as the registry id. If you want a different id, add `name: <id>` at the top of the
   site's compose file and run `docker compose up -d` there once first. Otherwise hostd refuses the
   project with a message that says so. That refusal is deliberate: starting it under a different name
   would create a second copy of the site beside the running one.

2. Note every compose file the site runs with. The `CONFIG FILES` column of `docker compose ls` lists
   them, and a site with host-specific settings usually has a `docker-compose.override.yml` beside its
   base file. Put them all in `compose`, as a list, in that order:

   ```yaml
    compose: [docker-compose.yml, docker-compose.override.yml]
   ```

   Naming only the base file is not a smaller version of the same entry, and the registry cannot catch
   the mistake: hostd passes each file as `-f`, and an explicit `-f` stops compose loading an override
   by itself, so the entry would still validate while describing a different site from the one running.
   A `start` would then recreate the containers from the base file alone, dropping whatever the override
   set, the published port Apache proxies to included. Sites with one compose file need no `compose` key
   at all; it defaults to `docker-compose.yml`.

3. Add the entry. List every service in the merged compose configuration that you want visible, with its
   role, and give each database its engine. `docker compose --project-directory <dir> -f <each file>
   config` prints what the merged configuration actually is, which is what hostd sees.

4. Only add `storage` entries for directories that are bind mounts of the site container, such as
   uploads or media. Never add the site directory itself, and never a directory holding a compose
   file, `.env`, an env file, a Dockerfile or a build context. hostd refuses those anyway, and says why.

5. Wait ten seconds, then run `hc http://hostd-api:8080/projects` and confirm `"valid":true`.

6. The rest of the setup is in the portal now, from the site's Settings tab: capabilities, `repo`, and
   `live`'s `branch`. Nothing there checks that `repo` and a `branch` are both set before `deploy` is
   ticked on; if either is missing the project simply never deploys, the same as one enrolled by hand
   with no repo at all (see **Deploying**).

## Creating a site

`create` only clones the repo and notices which services the compose file resolves: each one is guessed
site or database from its image name (postgres, mysql, mariadb, mongo or redis becomes database; anything
else, including a database run from a renamed or custom image, becomes site). It is a starting point, not
a guarantee, and the result is registered with no capabilities at all. Steps 2 and 3 below must both
happen, in that order, before anything past step 1 does anything useful.

**Who a created site belongs to.** The clone runs as root inside `hostd-fetcher`, so everything it writes
starts out root-owned. `create` fixes that before it registers anything, by giving the whole new tree the
ownership and mode **`/var/www` itself** has; `add-environment` uses the project's own live folder
instead, since the test tree sits beside it. Neither is guessed: both are read off the directory at the
time. So if you want created sites to belong to you rather than to root, `/var/www` has to belong to you
first (`stat -c '%U:%G %a' /var/www` to check). A site left root-owned still runs, but you cannot read or
edit its files without `sudo`, which is the one thing that makes it behave differently from a site
enrolled by hand. Deploys apply the same rule against `<dir>` from then on, so an already-deployed site is
already correct whatever `create` left behind.

1. Create the project:

   ```bash
   hc -X POST http://hostd-api:8080/projects \
     -H 'Content-Type: application/json' \
     -d '{"id":"acme-bakery","client":"cl_8f2k1","name":"Acme Bakery","repo":"git@github.com:ItsKodas/acme-bakery.git","branch":"main","domain":"acmebakery.com","certificate":"letsencrypt"}'
   ```

   Expect `{"ok":true,"project":{"id":"acme-bakery","state":"needs-setup"},"envFiles":[...]}`.

2. Edit `hostd/registry/projects.yaml`: correct any service the guess above got wrong, and add
   `capabilities: [lifecycle, logs, provision, env]` (or whatever subset the client should have) to the
   new entry. If the repo ships more compose files than the one hostd just cloned it with (a
   `docker-compose.override.yml`, a production file), list every one of them in the entry's `compose:` key
   now, in the order they merge (see Enrolling a real site, step 2): `create` only ever resolves the base
   `docker-compose.yml`, since nothing in a fresh clone says which extra files the operator intends, and an
   unnamed override is one hostd cannot see, so the site would run differently under hostd than it does by
   hand until this is corrected. Wait ten seconds for the reload before going on to step 3.

3. Only now, with the roles right, add any `storage` entries the site needs (uploads, media and the
   like). **The storage guard cannot protect a database it believes is a site**: it refuses a storage
   entry that overlaps a service marked `role: database`, so adding storage before correcting a
   wrongly-guessed database lets that entry through unchecked. Wait ten seconds for the reload again.

4. List its env files:

   ```bash
   hc http://hostd-api:8080/projects/acme-bakery/live/env
   ```

5. Fill one in, using a path from that listing:

   ```bash
   hc -X PUT http://hostd-api:8080/projects/acme-bakery/live/env/.env \
     -H 'Content-Type: application/json' \
     -d '{"text":"DATABASE_URL=postgres://...\nWEB_PORT=5008\n"}'
   ```

6. Start it:

   ```bash
   hc -X POST http://hostd-api:8080/projects/acme-bakery/start
   ```

Adding a test environment later is `POST /projects/acme-bakery/environments` with `branch`, `domain` and
`certificate`, then the same review and env steps (2 to 5 above) against the new `test` environment:
correct any wrongly-guessed service role, set its capabilities, add its storage, list and fill its env
files. **Do not run step 6 against it, and do not start it by hand either.** There is no per-environment
lifecycle yet: every lifecycle verb, and the compose argv it builds, only ever resolves the project's
`live` folder. Start it with a deploy instead (see **Deploying**), which pins the compose project name to
the test folder's own name. Starting it by hand is actively dangerous for exactly the repos step 1 above
tells you to pin a `name:` into: running `docker compose up -d` in the test folder then resolves to that
same fixed compose project name, which is also live's, and takes over live's already-running containers
instead of starting a separate test stack.

## Deploying

A project gets deploys by having a `repo`, a `branch` on the environment, and `deploy` in its
`capabilities`. All three are set from the site's Settings tab in the portal now, operator only: the same
save also converts a project still in the live-only shape (`dir` plus `upstream` at the top level, no
`environments` block) into the environments shape the first time a branch is set on it, taking `live`'s
port from `upstream`. A project enrolled by hand with no repo simply never deploys.

The portal's Settings tab still cannot touch `services`, `storage`, `limits`, `compose`, or an
environment's `domain`, `port` and `certificate`: all of those stay hand-edited in
`hostd/registry/projects.yaml`. Nor can it touch `client` or `dir`, and that is permanent rather than a
gap to fill in later: `client` would move a site into a different person's portal, and `dir` would
re-point hostd at another tree while the containers already running stay where they are, so a later stop
or deploy acts on the wrong one.

**How one happens.** Every 2 minutes the agent asks GitHub for the tip of each deploying environment's
branch. A tip different from the entry's `deployed` starts a deploy: fetch, check the commit out into
`<dir>.next`, carry the env files across from the running copy, `docker compose build` there, then the
swap (maintenance flag up, `down`, `<dir>` becomes `<dir>.prev`, `<dir>.next` becomes `<dir>`, `up -d`,
flag down), then the health check, then `deployed` is written to the registry. One deploy per environment
at a time; a commit that lands mid-deploy is picked up by the next poll.

**What the health check actually checks.** Every registered compose service has a running container, and
any container that declares a healthcheck reports `healthy`, within 60 seconds. It is deliberately not an
HTTP request to the site's port: the agent runs `network_mode: none` and has no network namespace to make
one from. A repo that wants the stronger check declares a `healthcheck:` in its compose file.

**When it fails.** A fetch, checkout, env-file copy or build that fails ends the deploy with the running
site untouched, and the build output kept in the history. A failed health check (or a version that will
not start at all) swaps straight back to `<dir>.prev`, confirms that copy is healthy, and records the
deploy as `rolled-back` rather than failed. **Nothing is ever retried automatically**: the same commit
fails the same way.

**Three consecutive failures pause the environment.** Polling then stops until a person deploys, rolls
back or switches branch. Otherwise a repo with a broken build rebuilds every few minutes for ever.

**The trees on disk.** `<dir>` is the running copy, `<dir>.prev` the previous one (only ever one),
`<dir>.git` the Git repository, and `<dir>.next` exists only during a deploy. The repository is moved out
of `<dir>` into `<dir>.git` by the first deploy, once, because a swap renames `<dir>` and would otherwise
carry the repository into `.prev` and delete it on the next deploy. A deploy refuses to start with less
than 10 GB free.

**The maintenance flag.** `/run/hostd/maintenance/<id>-<env>` exists from just before the swap until just
after it. Apache's half of this (serving the holding page while that file exists, and when the upstream
is unreachable) **is not built yet**, so today the flag is written and removed and nothing reads it. The
site is briefly unreachable during a swap either way.

The calls, all admin-only except the last two:

```bash
hc -X POST http://hostd-api:8080/projects/acme-bakery/live/deploy      # deploy the tip now, and resume a paused environment
hc -X POST http://hostd-api:8080/projects/acme-bakery/live/rollback    # back to the last commit recorded healthy
hc -X PUT  http://hostd-api:8080/projects/acme-bakery/live/branch -d '{"branch":"develop"}'
hc http://hostd-api:8080/projects/acme-bakery/live/deploys             # history, and whether it is paused
hc http://hostd-api:8080/projects/acme-bakery/live/commits?limit=20    # the branch's log
```

A deploy answers as soon as it has **started**, not when it finishes: a build is minutes and api's call
timeout is 150 seconds. Read `/deploys` for the outcome. A rollback rebuilds the target commit rather
than reusing the kept image, so it takes about as long as a deploy; only the automatic rollback after a
failed health check uses the kept copy, which is what makes it seconds rather than minutes.

Deploying is the supported way to start a `test` environment: it pins the compose project name to the
environment's own folder name, so a repo whose compose file pins `name:` still gets a separate stack
rather than taking over live's containers. Lifecycle (`start`, `stop`, `restart`) still only ever reaches
`live`.

## Backups

Only `hostd-agent` ever touches a backup: it holds the Docker socket, restic and sqlite3, and the bind
mount at `/backups`. Only a project's `live` environment is backed up, the same rule deploys and lifecycle
follow, because there is no per-environment lifecycle yet.

### Setting backups up

1. Create the backup directory on the host, or point `HOSTD_BACKUP_DIR` at whichever disk you actually
   want backups written to before the first `docker compose up`:

   ```bash
   sudo mkdir -p /srv/backups/hostd
   ```

2. Create `hostd/.env.agent` from `hostd/example.env.agent`, and generate the password on the dedi:

   ```bash
   openssl rand -hex 32
   ```

   Paste it in as `RESTIC_PASSWORD`. **Before you do anything else, copy that value somewhere that is not
   the dedi:** a password manager, a note kept on another machine, anything off this box. Every backup
   repository is encrypted with this one value and nothing else. Without your copy, every repository is
   unreadable, and a lost dedi is exactly the situation backups exist for: you would have kept the backups
   and lost the only key to them.

3. Install `restic` on the dedi itself too, not only in the agent image, while things are calm. An
   ordinary restore never needs this (see **Restoring** below: `docker exec hostd-agent restic` already
   works, because the agent image carries its own copy), but the day `hostd` itself is down, or the dedi
   is being rebuilt, there is no agent container to exec into, and the bind mount at `/backups` exists
   for exactly that day: it lets restic on the bare host reach the repository files directly off
   `/srv/backups/hostd`, with no Docker involved at all. Install it now so it is already there when it is
   needed (`apt-get install restic` on Debian/Ubuntu, or a static binary from restic's own releases).

4. Bring the agent up (or recreate it) so it picks up the new mount and env file:

   ```bash
   cd hostd
   docker compose up -d --build agent
   ```

5. Check that the image actually has both tools the agent needs, rather than assuming the Alpine packages
   provide what the code shells out to:

   ```bash
   docker compose exec agent restic version
   docker compose exec agent sqlite3 --version
   ```

   Both should print a version. If either command is missing, the image needs rebuilding
   (`docker compose build agent`) before any backup, or any sqlite-backed project's backup, can run.

6. Turn backups on for a project by adding `backups` to its `capabilities:` in `registry/projects.yaml`,
   then wait ten seconds for the reload:

   ```yaml
   capabilities: [lifecycle, logs, backups]
   ```

   That alone is enough for manual backups. To schedule them too, `PUT` a schedule: `mode` is `daily` or
   `weekly`, `hour`/`minute`/`weekday` are read in Brisbane time, and `keep` is how many scheduled
   snapshots to hold at each level (the operator's own ceiling in the registry clamps whatever a client
   asks for; a manual snapshot is never touched by retention, only the client deleting it removes one):

   ```bash
   hc -X PUT http://hostd-api:8080/projects/acme-bakery/backups/schedule \
     -H 'Content-Type: application/json' \
     -d '{"mode":"daily","hour":2,"minute":0,"weekday":0,"keep":{"daily":7,"weekly":4,"monthly":3}}'
   ```

   A manual backup, any time, capability allowing:

   ```bash
   hc -X POST http://hostd-api:8080/projects/acme-bakery/backups
   ```

   That call answers as soon as the run has started, the same as a deploy. Read the run back with the
   `run` id it returns:

   ```bash
   hc http://hostd-api:8080/projects/acme-bakery/backups/runs/<run>
   ```

### What is and is not backed up

Every run of a `backups`-capable project captures, from its `live` environment only:

- Each database service's own dump (see the restore table below for exactly how each engine's is taken).
- Every `storage` directory the project declares, whatever its `mode`. A `hidden` directory is backed up
  exactly like a `rw` one; `hidden` only ever means the file API never shows it.

It does **not** capture the `test` environment, the compose file or its overrides, `.env`, `.env.agent`,
`.env.fetcher`, the site's source tree, or any directory the project has not declared under `storage`.

**Backups are local to this dedi until the offsite phase lands.** They live on this machine's own disk,
under `/srv/backups/hostd` (or wherever `HOSTD_BACKUP_DIR` points). A dedi that is lost, destroyed or has
its disk fail loses every backup on it, exactly the way it loses everything else under `/var/www`. Nothing
built so far protects against that. Only the offsite copy, not built in this phase, will.

### Restoring

This is deliberately a runbook procedure, not a portal button. A restore overwrites a live database with
an old one; a control that can do that from one click in a tired 3am moment is a worse design than a
procedure that costs ten minutes and forces you to look at what you are about to overwrite before you do
it.

There are two ways to run the restic commands below, and which one applies depends on whether `hostd`
itself is up:

- **Ordinary case, `hostd` is healthy and only a client's site is broken.** Use `docker exec hostd-agent
  restic ...`. The agent image already carries restic and `RESTIC_PASSWORD`, and the repository is already
  mounted inside it at `/backups`. Nothing extra to install; this is what you will do almost every time.
- **The case the bind mount exists for: `hostd` itself is down, or the dedi is being rebuilt, so there is
  no agent container to exec into.** Use `restic` on the bare host instead, pointed at
  `/srv/backups/hostd/<id>` directly, with no Docker involved. This only works if you installed `restic`
  on the dedi ahead of time (see **Setting backups up**, step 3) and can get `RESTIC_PASSWORD` from
  somewhere: `hostd/.env.agent` on the dedi if it survived, or your own off-dedi copy if it did not.

Both reach the same repository and produce the same result; only how you reach it differs. The steps below
show both, in the order you would try them: `docker exec` first, the host fallback under it.

1. **Find the snapshot.** Each project has its own repository, named by its id.

   Ordinary case:

   ```bash
   docker exec hostd-agent restic -r /backups/acme-bakery snapshots
   ```

   Fallback, `hostd` is down: the repository is root-owned (the agent container writes it as root), so
   read and restore commands need `sudo`, and `sudo` does not carry your own shell's exported variables
   into the command it runs unless you pass them through explicitly:

   ```bash
   export RESTIC_PASSWORD=$(grep ^RESTIC_PASSWORD= hostd/.env.agent | cut -d= -f2)
   sudo env RESTIC_PASSWORD="$RESTIC_PASSWORD" restic -r /srv/backups/hostd/acme-bakery snapshots
   ```

   Either way, note the short id of the snapshot you want. `tags` says `manual` or `scheduled`; `time` is
   when it was taken.

2. **Restore it to a staging path, never straight over the live tree.**

   Ordinary case, restoring inside the agent container (its `/backups` is the same bind mount as the
   host's `/srv/backups/hostd`, so the result appears at the same place on the host either way):

   ```bash
   docker exec hostd-agent restic -r /backups/acme-bakery restore \
     <snapshot-id> --target /backups/restore/acme-bakery
   ```

   Fallback, `hostd` is down:

   ```bash
   sudo env RESTIC_PASSWORD="$RESTIC_PASSWORD" restic -r /srv/backups/hostd/acme-bakery restore \
     <snapshot-id> --target /srv/backups/hostd/restore/acme-bakery
   ```

   Either way, the restored copy lands on the host at `/srv/backups/hostd/restore/acme-bakery/...`. restic
   recreates the absolute paths it captured, and it captured them from the agent container's own point of
   view. A database dump lands under
   `/srv/backups/hostd/restore/acme-bakery/backups/.staging/acme-bakery/<run>/db/<service>/<file>`
   (`<run>` is whichever run produced that snapshot; the snapshot's own `paths` field, or just `ls` the
   restored `db/` directory, will show it). Each `storage` directory lands at its real host path, for
   example `/srv/backups/hostd/restore/acme-bakery/var/www/acme-bakery/live/uploads/`, because `/var/www`
   is the same bind mount on the host and in every container.

   The rest of this procedure is the same either way, and runs on the host regardless of which route you
   used above.

3. **Stop the site:**

   ```bash
   cd /var/www/acme-bakery/live
   sudo docker compose stop
   ```

4. **Put the storage directories back**, from the restored copy over the live one, for every directory the
   project declares under `storage`, not only the one you think changed:

   ```bash
   sudo rsync -a --delete \
     /srv/backups/hostd/restore/acme-bakery/var/www/acme-bakery/live/uploads/ \
     /var/www/acme-bakery/live/uploads/
   ```

5. **Load the database dump, with that engine's own tool.** What restic captured, and how to put it back,
   depend on the engine. Verified against `src/agent/backup-dumps.ts`:

   | engine | file in the snapshot | produced by | restore with |
   | --- | --- | --- | --- |
   | postgres | `dump.sql` | `pg_dumpall` | `psql` reading that file |
   | mysql / mariadb | `dump.sql` | `mysqldump` / `mariadb-dump --all-databases` | `mysql` / `mariadb` reading that file |
   | mongodb | `dump.archive.gz` | `mongodump --archive --gzip` | `mongorestore --archive --gzip` |
   | sqlite | `dump.db` | `sqlite3 .backup` | copy the file back into place |
   | redis | `dump.rdb` | `redis-cli --rdb` | stop the service, put the rdb where the image expects it, start |
   | generic | a copied data directory | stop, copy, start | stop the service, copy it back, start |

   `SERVICE` below is that database's own name, exactly as it appears under the project's `services:` in
   the registry (`db` in every worked example elsewhere in this runbook, but genuinely the operator's own
   to substitute: `backup-run.ts` writes each dump to `db/<service>/`, not to a fixed name, so the path is
   only right once `SERVICE` names the real service). The dump files under `$DUMP` are root-owned too, so
   reading one is `sudo cat` first, same reason `RESTIC_PASSWORD` above needed `sudo env`: a plain
   `< file` redirection, or a bare `$VAR`, runs in your own shell before `sudo` (or `docker compose exec`)
   ever starts, so it either hits the same permission error the raw `restic` call would, or, for a
   variable the *container* sets (`$POSTGRES_USER` and the like), expands to nothing because your shell
   has never heard of it. Every variable below that belongs to the database's own container is kept inside
   the single-quoted `sh -c '...'` for exactly that reason; only `SERVICE` and `DUMP`, which belong to you,
   are expanded outside it.

   ```bash
   SERVICE=<service>   # replace with this project's own database service name
   DUMP=/srv/backups/hostd/restore/acme-bakery/backups/.staging/acme-bakery/<run>/db/$SERVICE
   ```

   `psql`, `mysql`/`mariadb` and `mongorestore` all talk to a running server, so bring just that one
   database service back up first (the site's other services can stay down; nothing else needs to be
   writing to it yet). Each command below reads its credentials from the same variable names
   `backup-dumps.ts` used to take the dump; if this project's registry entry overrides any of them with
   `dump.userEnv` or `dump.passwordEnv`, replace the name shown with the one the registry gives instead,
   in that same command, or the restore reads a variable the container never set:

   ```bash
   sudo docker compose start "$SERVICE"

   # postgres: reads the user from $POSTGRES_USER by default. If this project's registry entry sets
   # dump.userEnv, replace POSTGRES_USER below with that name. $POSTGRES_USER is the container's own, so
   # it stays inside sh -c:
   sudo cat "$DUMP/dump.sql" | sudo docker compose exec -T "$SERVICE" sh -c 'psql -U "$POSTGRES_USER"'

   # mysql (mariadb: swap mysql for mariadb, and MYSQL_ROOT_PASSWORD for MARIADB_ROOT_PASSWORD): reads
   # the password from that variable and connects as root by default. If this project's registry entry
   # sets dump.passwordEnv, replace MYSQL_ROOT_PASSWORD below with that name; if it sets dump.userEnv,
   # replace "-u root" with -u "$<that name>" the same way:
   sudo cat "$DUMP/dump.sql" | sudo docker compose exec -T "$SERVICE" sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -u root'

   # mongodb (the ${VAR:+...} expands only when the image actually sets credentials, same as the dump
   # did): reads MONGO_INITDB_ROOT_USERNAME and MONGO_INITDB_ROOT_PASSWORD by default. If this project's
   # registry entry sets dump.userEnv or dump.passwordEnv, replace those two names below with the ones it
   # gives instead:
   sudo cat "$DUMP/dump.archive.gz" | sudo docker compose exec -T "$SERVICE" sh -c \
     'mongorestore --archive --gzip ${MONGO_INITDB_ROOT_USERNAME:+-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin}'
   ```

   sqlite, redis and generic are filesystem copies instead, and never need their service started first;
   `docker cp` and a plain file copy both work against a stopped container. They still read `$SERVICE` and
   `$DUMP` from just above, so set those first even if you skip the block above. Neither redis nor generic
   reads a `dump.userEnv` or `dump.passwordEnv` at all (redis's own dump needs no login, and generic just
   stops, copies and starts), so nothing in either command below is registry-configurable, and sqlite has
   no credential to begin with:

   ```bash
   # sqlite: copy the file to the path named by that service's file: in the registry, under the live
   # environment's directory.
   sudo cp "$DUMP/dump.db" /var/www/acme-bakery/live/<the service's file: path>

   # redis: the official image reads /data/dump.rdb by default; check the site's own redis command or
   # config if it sets `dir` or `dbfilename` to something else. Compose names the container
   # <project>-<service>-<index>, so this follows $SERVICE too, not a fixed name:
   sudo docker cp "$DUMP/dump.rdb" "acme-bakery-$SERVICE-1:/data/dump.rdb"

   # generic: db/<service>/data/ holds one directory per bind mount the service had, named for that
   # mount's own directory name; copy each one back to where it was mounted from.
   sudo rsync -a --delete "$DUMP/data/<mount-name>/" <the original bind mount source>/
   ```

6. **Start the site:**

   ```bash
   sudo docker compose start
   ```

### The generic engine

An engine with no real dump method falls back to `generic`: the agent stops that one database service,
copies its bind-mounted data directory, and starts it again, every single time it is backed up, whether
manual or scheduled. The record says `disruptive: true` so the portal can show that this backup briefly
took the database down. Writing a real dump method for a new engine (a command that reads a live database
without stopping it, the way postgres, mysql, mariadb, mongodb and redis already do) is worth doing before
a project on that engine gets much traffic, since a project with `generic` and a schedule stops its own
database on a timer.

### When a backup is refused

| Refusal | What to do |
| --- | --- |
| `the backup disk has less than 10% free` | Free space on `/srv/backups/hostd` (or wherever `HOSTD_BACKUP_DIR` points): delete manual snapshots you no longer need (below), and know that deleting a scheduled one only reclaims space once the weekly prune runs. |
| `there are already five manual backups; delete one before taking another` | `hc -X DELETE http://hostd-api:8080/projects/<id>/backups/<snapshot>` on one you no longer need, then try again. |
| `a manual backup was taken less than 10 minutes ago; wait before taking another` | Wait; it clears itself ten minutes after the last manual run started. |
| `another backup is running; only one runs on the dedi at a time` | Wait for it to finish. Only one backup runs across the whole dedi at once, on purpose, so a scheduled sweep across many projects can never saturate the disk together. |
| `<id> already has a backup running` | The same project's own backup is still running; read its run status instead of starting another. |
| `<id> is deploying; a backup waits until that has finished` | A deploy renames the directory storage lives under, so a backup started mid-swap would walk a tree that is moving. Wait for the deploy to finish (or fail) and try again. |

## What is deliberately not automatic

- **The first start waits for the operator.** `create` registers a project with no capabilities at all and
  every service role only guessed from its image, and env files are only ever listed, never filled in:
  nothing runs until the entry is reviewed, `lifecycle` (and whatever else) is enabled, and the env files
  are edited.
- **Removing a whole project stops it first, and refuses if the stop fails.** `provision remove` runs the
  same `stop` a lifecycle call would against the live environment, then edits the registry; it never
  unregisters a project that is still running, since nothing would then be able to stop it. Removing only
  the test environment does not stop anything (there is no per-environment lifecycle yet, so there is
  nothing safe for this to stop).
- **Removing a project leaves its folder, volumes and databases in place.** `provision remove` stops it,
  edits the registry, and takes hostd's own vhost for each environment it removed off the host; nothing
  under `/var/www` is deleted. The vhost goes because a file left behind would go on claiming those
  hostnames and proxying to a port `choosePort` is then free to give another project. A hand-written
  vhost that was adopted stays in `/etc/apache2/hostd-adopted/`, as it always does. If the rail cannot
  be reached the removal still succeeds and the reply names the file that is still there. Clean the rest
  up by hand once you are sure.

## Domains

hostd's other half of Apache control does not run in Docker at all. Every domain action (writing a vhost,
adding an alias, adopting a hand-configured site) ends with `hostd-agent` dropping a request file in a
directory bind-mounted from the host; a systemd path unit on the host itself picks it up, runs the write,
runs `apache2ctl configtest`, reloads Apache if that passed, and writes a result file back. `hostd-agent`
has no network namespace and cannot reach Apache any other way. The shell script and the two unit files
that do this live in `hostd/host/`; nothing about them is exercised by `npm test`, because a shell script
reloading a real Apache is not something CI can run. This section is what stands in for that missing test
suite: read it in full before the first domain change on a new dedi, not only when something breaks.

The request and result shapes are defined once, in `hostd/src/shared/apache.ts`: a request carries `seq`,
`action` (`reload` or `adopt`), `write` (a single `{path, text}` or null), `remove` (paths to delete) and
`disable` (paths to move out of `sites-enabled`, only ever populated alongside `adopt`); a result carries
`seq`, `ok` and `output`. `hostd/src/agent/apache-rail.ts` is the agent's half: it writes the request by
writing to a `.tmp` file and renaming it into place, so the path unit (which fires on the file's name
appearing) never sees a half-written request, then polls for a result carrying the same `seq` for up to 30
seconds. If nothing answers in time, it deliberately leaves the request file where it is: a host unit that
is merely slow still answers it, and the sequence number means that answer is safely ignored rather than
mistaken for whatever the agent asks next.

### 1. Host setup, done once

The host script's only external dependency is `jq`. Install it before anything else:

```bash
sudo apt-get install -y jq
```

Create the directories the script and the agent both expect. None of this touches an existing site:

```bash
sudo mkdir -p /etc/hostd/apache
sudo mkdir -p /etc/apache2/hostd
sudo mkdir -p /etc/apache2/hostd-adopted
sudo mkdir -p /var/www/hostd-acme/.well-known/acme-challenge
sudo mkdir -p /var/www/hostd-maintenance
```

`/var/www/hostd-maintenance/index.html` needs a minimal placeholder now so `ErrorDocument 503` has
something to serve; its real contents (styling, per-client branding, whatever the holding page should
actually say) belong to the provisioning design, not to this task:

```bash
echo '<!doctype html><title>Maintenance</title><p>Back shortly.</p>' | sudo tee /var/www/hostd-maintenance/index.html >/dev/null
```

Also confirm `/etc/ssl/hostd/origin.pem` and `/etc/ssl/hostd/origin.key` (the Cloudflare Origin CA cert
already in use for the hand-written vhosts) are in place. They are mounted read-only into `hostd-agent`,
and every vhost's `:443` block names them: without them the agent's own boot gate refuses to start at all
(`FATAL HOSTD_ORIGIN_CERT ... does not exist`), which would make every step after this one fail for a
reason that has nothing to do with what it says.

Install the script and the units:

```bash
sudo cp hostd/host/hostd-apache.sh /usr/local/sbin/hostd-apache.sh
sudo chmod 700 /usr/local/sbin/hostd-apache.sh
sudo cp hostd/host/hostd-apache.path hostd/host/hostd-apache.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hostd-apache.path
```

Append the include to Apache's own config, once, and enable the modules every vhost hostd renders needs.
Without `headers`, `Header always set X-Hostd-Token ...` is never set and no domain, alias or adoption can
ever verify; the others are `rewrite` (the maintenance and ACME redirects), `proxy` and `proxy_http` (the
site itself), and `ssl` (every `:443` block):

```bash
cat hostd/host/apache-include.conf | sudo tee -a /etc/apache2/apache2.conf >/dev/null
sudo a2enmod headers rewrite proxy proxy_http ssl
sudo apache2ctl configtest
sudo systemctl reload apache2
```

`apache2ctl configtest` should say `Syntax OK`. An empty `/etc/apache2/hostd/` is fine: the include line
uses `IncludeOptional`, precisely so a fresh install with nothing adopted yet is not a startup error.

### 2. Checking the rail by hand

This is the one thing no automated test covers, because there is no Apache and no systemd in CI. Do this
once after the units are installed, and again after any change to `hostd-apache.sh` itself.

The script guarantees the handshake completes whatever goes wrong: an `EXIT` trap answers with `ok:false`
and always removes `request.json`, even if `jq` is missing, a path cannot be written, or anything else
fails somewhere `set -eu` was not already guarding (which is most of the script; POSIX only suspends
`errexit` inside an `if` condition, not around a plain command). This matters because
`hostd-apache.path` uses `PathExists=`, which needs a false-to-true edge to fire again: a request left
sitting on disk unanswered would mean no domain change on this dedi could ever run again until a human
noticed and cleared it by hand, which is a permanent failure, not the ordinary 30 second timeout
`apache-rail.ts` already tolerates. The same trap also restores anything the script moved aside if it dies
partway through disabling several files, for the same reason the explicit failed-configtest path already
did: a client's hand-written vhost must never end up moved aside with nothing serving in its place. The two
checks below exercise the deliberate failure path (a configtest that fails cleanly); the crash-safety net
itself has no separate hand check here because there is nothing safe to break on purpose on a host that is
serving real traffic. It is proven instead by the automated integration test in
`hostd/src/agent/apache-rail-fake.test.ts`, which runs the real handshake protocol against a temporary
directory and asserts the restore happens.

First, a harmless write. This drops a comment-only file, so `apache2ctl configtest` cannot fail on it:

```bash
sudo tee /etc/hostd/apache/request.json.tmp >/dev/null <<'EOF'
{"seq":1,"action":"reload","write":{"path":"/etc/apache2/hostd/hostd-rail-check.conf","text":"# hostd rail check\n"},"remove":[],"disable":[]}
EOF
sudo mv /etc/hostd/apache/request.json.tmp /etc/hostd/apache/request.json
```

Within a second or two, watch for the result:

```bash
cat /etc/hostd/apache/result.json
ls /etc/hostd/apache/
```

Expect `{"seq":1,"ok":true,"output":"Syntax OK"}` (the exact wording of `output` is whatever
`apache2ctl configtest` printed) and `request.json` gone from the listing: the script always removes it,
success or failure, once it has written a result.

Now a deliberately broken one, at a different path so the first file is left alone:

```bash
sudo tee /etc/hostd/apache/request.json.tmp >/dev/null <<'EOF'
{"seq":2,"action":"reload","write":{"path":"/etc/apache2/hostd/hostd-rail-check-bad.conf","text":"ThisIsNotADirective\n"},"remove":[],"disable":[]}
EOF
sudo mv /etc/hostd/apache/request.json.tmp /etc/hostd/apache/request.json
cat /etc/hostd/apache/result.json
```

Expect `"ok":false` and `output` naming the syntax error, with a `seq` of 2. Apache did not reload: the
script only calls `systemctl reload apache2` after a configtest that passed, and this one did not, so the
site that was serving before this check is still serving exactly what it was. Confirm it by running
`sudo apache2ctl configtest` again right now: it still fails, for the same reason, because the bad file is
still sitting in `/etc/apache2/hostd/hostd-rail-check-bad.conf`. That file being left in place is
deliberate (see the comment above `restore()` in the script): the rail only undoes a `disable` move on a
failed configtest, never a `write`, because reverting a bad write means putting back whatever was there
before it, and only the agent (in `hostd/src/agent/domains.ts`, `revert()`) knows what that was. Clean it
up the same way the agent would, with a follow-up request that removes it and reloads:

```bash
sudo tee /etc/hostd/apache/request.json.tmp >/dev/null <<'EOF'
{"seq":3,"action":"reload","write":null,"remove":["/etc/apache2/hostd/hostd-rail-check-bad.conf","/etc/apache2/hostd/hostd-rail-check.conf"],"disable":[]}
EOF
sudo mv /etc/hostd/apache/request.json.tmp /etc/hostd/apache/request.json
cat /etc/hostd/apache/result.json
```

Expect `"ok":true` again, and `apache2ctl configtest` clean. This is exactly the shape of request
`writeVhost`'s failure path sends automatically in production; running it by hand here is what proves the
whole recovery a real failed write relies on actually happens on this host, not only in a test's fake one.

### 3. Live verification

This proves the whole chain (agent, host unit, Apache, DNS, and api's own verifier) against a name that
belongs to nothing a client depends on: `test.hostd.horizons.gg`.

Add it to the registry's `allowed` list, which is the one carve-out from `reserved: [horizons.gg]`.
`allowed` takes exact hostnames only, never a subtree, and this file should hold only this one entry: it
exists for exactly this check, not as a general escape hatch.

```yaml
allowed: [test.hostd.horizons.gg]
```

In Cloudflare, on the `horizons.gg` zone, create the CNAME:

```
test.hostd.horizons.gg  CNAME  <the host you already keep pointed at the dedi>  (proxied)
```

This is the same target most client domains are CNAMEd to today (see **Enrolling a real site** if you are
unsure which host that is); it is not the apex and does not touch anything `koda@horizons.gg` mail depends
on.

`adopt` is the only route to a vhost hostd owns, and it is also the one that writes it for the first time:
an empty `disable` list is allowed (`hostd/src/shared/protocol.ts`), specifically so an environment nobody
has hand-written a file for is not stuck with a domain in the registry and no vhost forever. So this check
doubles as the first live rehearsal of adoption, using the `hostd-test` project already set up under
**Live checks with a throwaway project**. Give it an `environments` block instead of its plain
`dir`/`upstream` entry, keeping the same directory and port it already has, and add `domains` to its
capabilities:

```yaml
  hostd-test:
    client: cl_test
    name: hostd test
    capabilities: [lifecycle, logs, domains]
    environments:
      live:
        dir: /var/www/hostd-test
        domain: test.hostd.horizons.gg
        port: 5099
        certificate: cloudflare-origin
```

Wait ten seconds, then preview and adopt exactly as **Adopting a site** describes:

```bash
hc http://hostd-api:8080/projects/hostd-test/live/adopt
hc -X POST http://hostd-api:8080/projects/hostd-test/live/adopt \
  -H 'Content-Type: application/json' -d '{"confirm":"hostd test"}'
```

The preview's `claims` list is expected to be empty here (`hostd-test` has no hand-written vhost of its
own to hand over), and `adoptable` is `true` regardless: an empty list has nothing to fail the "can this be
read well enough" check.

Confirm the site serves:

```bash
curl -sSI https://test.hostd.horizons.gg/
```

**Verify the token path is answered, not redirected.** Read the token off the domain record:

```bash
hc http://hostd-api:8080/projects/hostd-test/live/domains
```

then, for the primary and for every alias an environment carries, check the well-known path directly:

```bash
curl -sS -o /dev/null -D- https://<alias-or-primary>/.well-known/hostd/<token>
```

The expected result is `HTTP/... 204` carrying `X-Hostd-Token: <token>`. This matters more for an alias
than for the primary: an alias's `:443` block (`aliasRedirect` in `hostd/src/agent/vhost.ts`) has to
answer the token path while also carrying `Redirect permanent / https://<primary>/`, which would take the
probe with it. The template settles that by making both of them the same kind of directive, a `mod_alias`
redirect at `translate_name`, with the specific one first:

```apache
Redirect 204 /.well-known/hostd/<token>
Redirect permanent / https://<primary>/
```

`mod_alias` takes the first entry that matches, so the token path wins on order. The earlier shape put a
`Redirect 204` inside the `<Location>` block, where it would have run at `fixups`, after the catch-all had
already redirected: that shape depended on config order deciding between two directives that never
competed at the same stage. The `<Location>` that remains carries only `Header always set X-Hostd-Token`,
which is scoped rather than at vhost level on purpose, so the token does not go out on every `301` this
block sends to every visitor.

None of that is proof about Apache's runtime, and nothing this codebase can test settles it, because it
is a question about Apache rather than about the rendered text. This `curl` is the authority.
`test.hostd.horizons.gg` above has no alias of its own, so run it for real the first time any environment
on this dedi actually gets one, whether that is here (add one more hostname to both `allowed` and this
environment's `aliases` before moving on) or the first time a real client's site is adopted or given a
`domain-add` alias. Do not skip it and do not assume it is fine because the primary passed: the primary's
own `:443` block has no catch-all redirect at all, so it cannot fail this way, and passing there proves
nothing about the alias block.

If it comes back `301` instead of `204`, every alias will sit `pending` for 72 hours and then go `failed`
while the primary verifies fine, which reads exactly like a DNS problem and would be debugged in entirely
the wrong place. The ordering fix above is already in the template, so a `301` here means something else
is answering ahead of `mod_alias` on that path, and the next thing to read is the rendered file itself:
`cat /etc/apache2/hostd/<id>-<env>.conf`. Do not try to work around it in DNS or Cloudflare; whatever it
is would still be there for the next alias.

Finally, confirm verification itself passes within the minute: a `pending` domain is checked once a
minute for its first hour, so within about sixty seconds `hc
http://hostd-api:8080/projects/hostd-test/live/domains` should show `test.hostd.horizons.gg` at
`"state":"active"`.

When you are done, remove the `hostd-test` entry's `environments` block (or the whole entry, matching
**Live checks with a throwaway project**'s own cleanup), remove whatever hostd wrote under
`/etc/apache2/hostd/` (`ls /etc/apache2/hostd/` to see it), reload Apache, and take `test.hostd.horizons.gg`
back out of `allowed`.

### 4. Adopting a site

Every real site on this dedi already has a hand-written vhost, serving traffic right now, and adoption is
what replaces that file with hostd's own without a moment where neither is in force. (An environment with
no existing file, freshly provisioned and never hand-configured, adopts too: the steps below still apply,
except steps 2 and 3 have nothing to read and the preview's `claims` list is simply empty. See **Live
verification** above for that case worked through end to end.) Do it in this order:

1. **Preview it, before anything is touched.** `hc http://hostd-api:8080/projects/<id>/<env>/adopt` (GET)
   renders the vhost hostd would write and lists every file in `sites-enabled` that claims one of the
   environment's hostnames, with `adoptable: true` only if every one of them can be read well enough to
   adopt.
2. **Read the whole existing file yourself**, not just the preview's summary of it. The preview only ever
   reports `ServerName` and `ServerAlias` lines (`hostd/src/agent/sites-enabled.ts`); it is not an Apache
   parser and does not claim to be one.
3. **Look for anything the template has no equivalent for**: a `RewriteRule` that is not the plain
   maintenance/ACME/https redirects hostd's own template renders, `Require` or other auth directives, a
   `ProxyPass` to somewhere other than the site's own port, anything under `Include`, `IncludeOptional` or
   `Use` (which the preview already refuses to adopt, since a hostname could be defined somewhere it
   cannot see). Anything found here has to be reconciled by hand, outside hostd, before adopting: adoption
   replaces the file whole, and nothing it does not render survives.
4. **Adopt.** `hc -X POST http://hostd-api:8080/projects/<id>/<env>/adopt -d '{"confirm":"<project
   name>"}'`, typing the project's name back, the same confirmation a delete asks for. This is one rail
   request: the old file moves to `/etc/apache2/hostd-adopted/<name>.bak`, the new one is written, and
   only then does the single configtest run, so there is never a moment with both files loaded (which
   Apache would resolve by file order, silently) or a moment with neither.
5. **Confirm the site serves**, exactly as it did before: `curl -sSI https://<domain>/` against whatever
   the site actually answers with.
6. **Confirm verification passes within the minute**, the same check as the end of **Live verification**
   above.

**The undo**, if adoption needs to be reversed:

```bash
ls /etc/apache2/hostd-adopted/
```

Find the `.bak` file that belongs to this site (there is one per disabled file, named after it), then:

```bash
sudo mv "/etc/apache2/hostd-adopted/<the .bak file just listed>" "/etc/apache2/sites-enabled/<its name with .bak removed>"
sudo rm "/etc/apache2/hostd/<id>-<env>.conf"
sudo apache2ctl configtest && sudo systemctl reload apache2
```

The `.bak` file is moved, never deleted, specifically so this is possible by hand, months later, by
someone who was not the one who adopted the site and has nothing memorized about it beyond what `ls`
shows them.

### 5. Troubleshooting

| Symptom | Cause |
| --- | --- |
| `/health` warns `the Apache host unit has not answered; no domain change can take effect` | The agent's `railAge` (time since the rail last got an answer) is null or over 10 minutes. First look at the unit itself: `sudo systemctl status hostd-apache.path hostd-apache.service` and `sudo journalctl -u hostd-apache.service -n 50` on the host. If both look fine, check whether a request is simply stuck: `cat /etc/hostd/apache/request.json`. The script's own trap means it should always answer and remove that file itself now, even on a crash, but if something outside its control kept it from running at all (the unit disabled, the script not executable, the directory missing), a wedged `request.json` is possible: `hostd-apache.path` only fires on the file going from absent to present (`PathExists`, not `PathChanged`), so a request already sitting there when the unit comes back will never be picked up on its own. Clear it by hand and let the unit re-arm: `sudo rm /etc/hostd/apache/request.json` then `sudo systemctl restart hostd-apache.path`. The domain action that wrote it will already have timed out on the agent's side (after 30 seconds) and reported a failure; retry it once the rail is answering again. |
| After clearing a wedged `request.json`, or after any adoption that failed partway | Confirm nothing was left with no vhost at all. List all three directories: `ls /etc/apache2/hostd-adopted/`, `ls /etc/apache2/sites-enabled/`, `ls /etc/apache2/hostd/`. Every `<name>.bak` in `hostd-adopted` should correspond to *either* `<name>` being back in `sites-enabled` (the adoption was rolled back) *or* a `<id>-<env>.conf` in `hostd/` that renders that hostname (the adoption succeeded and this is its permanent record). A `.bak` matching neither is a site with nothing currently serving it: put it back immediately with the same commands as **The undo**, above, then confirm the site serves again before doing anything else. |
| A domain stays `pending` with `No record exists yet. Add the CNAME and this will start working within a few minutes.` | No DNS record resolves yet for the hostname, or it has not propagated. Nothing to do but wait, unless the CNAME was never created. |
| A domain stays `pending` with `The CNAME is not proxied, so the request reached us directly. Turn the proxy on in Cloudflare.` | The environment's `certificate` is `cloudflare-origin` (which expects Cloudflare in front) but the CNAME's cloud icon is grey, not orange: the Origin certificate only Cloudflare should ever see reached this client's browser directly. Turn proxying on. |
| A domain stays `pending` with `This name points somewhere else at the moment.` | The token this dedi expects did not come back, meaning the hostname currently resolves (through DNS or Cloudflare) to something other than this environment's vhost: a stale CNAME, a different project holding the name, or, if this is an alias, its token path being redirected rather than answered. Run the `curl` in **Live verification** against that alias: `204` with the header means the vhost is fine and the name genuinely points elsewhere, and `301` means something is answering ahead of `mod_alias` on that path, which **Live verification** says how to read. |
| An adoption is refused `these cannot be read well enough to adopt: <path> (Include is used, so the hostnames this file serves cannot be read here)` (or `IncludeOptional`, or `Use`) | The existing vhost pulls in another file, or uses a `mod_macro Use`, that could define a hostname `hostd/src/agent/sites-enabled.ts` cannot see. Resolve or inline whatever that file defines by hand, outside hostd, before adopting; nothing here will half-understand it for you. |
| `/health` warns `waiting for Let's Encrypt support: <project> <env>` | That environment's `certificate` is set to `letsencrypt`, but 4a serves the Cloudflare Origin certificate to every vhost regardless of this setting: the environment works today over the Origin cert, and this warning is only saying certbot itself (4b) is not built yet. Nothing to fix; it clears once 4b lands. |

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FATAL ... is not a file (was projects.yaml created before the first docker compose up?)` | Something other than a file sits at `registry/projects.yaml`, most likely a directory Docker created because the file did not exist before the first `docker compose up`. Remove it, create the file, start again. |
| `registry reload rejected ... has been replaced on the host` | The registry's bind mount is detached, from an older deployment that mounted the file itself. See **Editing the registry**. |
| `FATAL HOSTD_API_TOKEN must be at least 32 characters` | `.env` is missing, or the token is empty or too short. |
| `FATAL RESTIC_PASSWORD is not set` (agent) | `.env.agent` is missing, or it is the unfilled copy of `example.env.agent`. Fill it in (and keep a copy off the dedi), then start again. Without it every backup would fail at `restic init`. |
| `FATAL the agent is not answering on /run/hostd/agent.sock` (api) | The agent is not running or failed its own gate. Read `docker compose logs agent`. |
| `503` with `"code":"agent-unavailable"` | The same, after startup. |
| A project is `"valid":false` with `compose resolves the project name ...` | See step 1 of Enrolling a real site. |
| A project is `"valid":false` with `... does not exist on the dedi` | `dir` is wrong, or the directory was removed. |
| `api` unhealthy with `the audit log could not be written` | The `hostd-state` volume is full or has the wrong owner. |
| Agent log `WARN the fetcher socket ... is not answering` | `hostd-fetcher` is not running or failed its own gate; provisioning and env editing are unavailable until it is, but lifecycle and logs are unaffected. Read `docker compose logs fetcher`. |
| Agent log or health warnings show `project <id> declares storage but no service with role database; if one of its services is a database, correct its role so the storage guard can protect it` | **This is advice, not an error.** The project stays valid, and status, logs, lifecycle and env all keep working exactly as before; nothing is refused. It is only worth acting on if one of the project's services really is a database: if so, correct its role in `hostd/registry/projects.yaml` (see step 2 of Creating a site) so the storage guard can actually protect that database's data directory. A project that genuinely has no database can leave this as is. |
| A `create` or `add-environment` refusal `"fix these invalid projects before provisioning: ..."` | The registry has at least one invalid entry. Provisioning refuses outright rather than risk handing out a port an invalid entry's own (possibly stopped) containers already hold: fix or remove the named entries first, wait ten seconds for the reload, then try again. |
| A `create` or `add-environment` refusal `"compose resolves the project name ..., not ..."` | Same check and message as a `"valid":false` project below, but caught before anything is cloned or registered: the repo's compose file pins a `name:` that does not match the id you gave. The cloned folder was removed and nothing was registered; either add `name: <id>` to the compose file, or use the id the compose file already pins. |
| A `create` or `add-environment` refusal `"no free port ... to ..."` | The configured port range (5000-5999) is full, by registry entry or by an already-published container port. Free one up, or extend `PORT_RANGE` in `src/shared/ports.ts`. |
| A `create` refusal `"... is already registered"`, or an `add-environment` refusal naming a folder that `"already exists"` | The id is already taken, or its folder is already on disk under a different registration. |
| A `create` or `add-environment` refusal `"... is already used by another project"` | The domain is already registered to a different project's environment. |
| A `create` or `add-environment` refusal naming a Git failure | The fetcher could not clone. Check the branch exists on the remote, and that `GITHUB_TOKEN` in `.env.fetcher` can read the repo. |
| A `create` or `add-environment` refusal `"the compose file declares no services"` | The compose file has no services in it at all, not merely none marked site. The cloned folder was removed and nothing was registered. |
| A `create` or `add-environment` refusal `"at least one service must have role site"` | hostd's own image guess (see Creating a site) marked every service database, most likely because the compose file genuinely has no service that is not a database, or an app image happens to contain one of the five matched names by coincidence. The cloned folder was removed and nothing was registered; fix the compose file if the guess was wrong, or enroll the project by hand instead (see Enrolling a real site) if it genuinely has no site-role service under this scheme. |
| A `create` or `add-environment` refusal naming a `docker compose config` error directly (a missing `env_file`, a syntax error) | hostd creates an empty file for any `.env.example` it finds with nothing real beside it yet, but only in the folders and depth a later env listing would itself reach; something the compose file needs still was not there. Fix the compose file or the repo, and try again. |
| A `provision` or `env` refusal naming a registry problem (`"... could not be written"`, or `"... already exists"` for an add) | The write itself failed, or raced another one and lost. A folder left behind after a losing race is not that call's to remove; it is left for you to look at. |
| A `provision remove` refusal `"could not stop ... before removing it: ..."` | The project's folder or compose file is gone (or otherwise broken), so `docker compose stop` cannot run, and removal refuses rather than unregister a project hostd can no longer control. There is no way to force this through hostd: take the entry out of `registry/projects.yaml` by hand instead. |
| A deploy record with `outcome: failed` and a `build exited with code ...` reason | The repo's own build failed; the `output` field holds the tail of it. The running site was never touched, and nothing is retried: push a fix. |
| A deploy record with `outcome: rolled-back` | The new version did not come up healthy within 60 seconds, or would not start at all, so hostd swapped back to the previous copy. The site is on the commit it started on. The reason names the service and the state it was in. |
| A deploy record whose reason ends `the previous copy did not come back healthy either` | The rollback ran but the old copy did not come up. This is the one case that needs hands: look at `docker compose ps` in `<dir>`, and at the agent log, before pushing anything else. |
| `/deploys` shows `"paused": true` | Three consecutive deploys failed. Polling has stopped. Fix the repo, then `POST .../deploy` (or `/rollback`, or a branch switch) to resume; nothing resumes on its own. |
| Agent log `poll <id>:<env>: could not read the branch tip: ...` | The fetch failed (the remote was unreachable, the token cannot read the repo, or the branch does not exist). Nothing was deployed and no failure was counted, so this does not pause the environment. |
| A deploy record `only N GB of free disk, and a deploy needs 10 GB` | The disk is too full to guarantee a swap can complete. Free space, starting with the `<dir>.prev` copies, which the next successful deploy would replace anyway. |
| A deploy record `... has no git repository, so it cannot be deployed` | The environment folder was not created by hostd, so there is no `.git` in it and no `<dir>.git` beside it. Clone it properly, or deploy is not for this project. |
| A deploy record `the running copy could not be stopped: ...` | `docker compose down` failed in the live tree, so nothing was moved and the site is still on the old version. Read the `output`, fix whatever it names, and deploy again. |
| A deploy record `deployed, but the registry could not be updated: ...` | The new version is up and healthy, only `deployed` was not written. The next poll deploys the same commit again, harmlessly. Fix the registry file's permissions. |
