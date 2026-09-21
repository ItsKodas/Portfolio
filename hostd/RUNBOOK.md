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

The portal does not exist yet, so the checks below call the API from a throwaway container on the
`hostd` network. Define this helper in the shell, from `hostd/`. It reads the token from `.env` inside
the throwaway container, so the token never appears in the host's process list:

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

## Creating a site

`create` only clones the repo and notices which services the compose file resolves: each one is guessed
site or database from its image name (postgres, mysql, mariadb, mongo or redis becomes database; anything
else, including a database run from a renamed or custom image, becomes site). It is a starting point, not
a guarantee, and the result is registered with no capabilities at all. Steps 2 and 3 below must both
happen, in that order, before anything past step 1 does anything useful.

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
`capabilities`. Nothing else switches it on, and a project enrolled by hand with no repo simply never
deploys.

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
- **Removing a project leaves its folder, volumes and databases in place.** `provision remove` only stops
  and edits the registry; nothing under `/var/www` is deleted. Clean those up by hand once you are sure.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FATAL ... is not a file (was projects.yaml created before the first docker compose up?)` | Something other than a file sits at `registry/projects.yaml`, most likely a directory Docker created because the file did not exist before the first `docker compose up`. Remove it, create the file, start again. |
| `registry reload rejected ... has been replaced on the host` | The registry's bind mount is detached, from an older deployment that mounted the file itself. See **Editing the registry**. |
| `FATAL HOSTD_API_TOKEN must be at least 32 characters` | `.env` is missing, or the token is empty or too short. |
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
