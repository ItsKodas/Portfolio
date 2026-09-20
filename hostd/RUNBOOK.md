# hostd runbook

hostd lets the client portal control client sites on this dedi. Phase 1 covers status, start, stop,
restart and logs; phase 2 adds provisioning: creating and removing projects and environments, and editing
their env files. It is three containers:

- `hostd-agent` holds the Docker socket. It has no network and listens only on a Unix socket.
- `hostd-api` speaks HTTP on the private `hostd` Docker network. Nothing is published on the host.
- `hostd-fetcher` does Git. It has a network and the GitHub token, and can write under `/var/www`, but
  never gets the Docker socket, so a compromise there cannot touch a container, the registry or anything
  outside `/var/www`.

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

4. Create `hostd/registry/projects.yaml` from `hostd/projects.example.yaml` (`mkdir -p registry` first),
   and delete the example project for now. **This must exist before the first `docker compose up`:** if
   it does not, Docker creates the missing pieces as directories instead, and all three containers refuse
   to start with a message saying so. If that happens, remove the directory it created in place of the
   file, create the file, and start again.

## Upgrading from phase 1

An existing phase 1 install has `hostd/projects.yaml` and no `hostd/.env.fetcher`.

1. Stop the stack: `docker compose down`.
2. Move the registry into its own folder: `mkdir -p registry && mv projects.yaml registry/projects.yaml`.
   (`-p` matters here: if a previous, incomplete `docker compose up` already created `registry` as an
   empty directory, a plain `mkdir` fails and the `&&` never runs the `mv`.)
3. Create `hostd/.env.fetcher` from `hostd/example.env.fetcher` (see step 3 above).
4. `docker compose up -d --build`.

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
```

Expect:
- `docker port` prints nothing: no host port is published.
- The network mode is `none`.
- The socket is `srw-rw----` owned by `0 1000`.

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

2. Add the entry. List every service in the compose file that you want visible, with its role, and give
   each database its engine.

3. Only add `storage` entries for directories that are bind mounts of the site container, such as
   uploads or media. Never add the site directory itself, and never a directory holding the compose
   file, `.env`, an env file, a Dockerfile or a build context. hostd refuses those anyway, and says why.

4. Wait ten seconds, then run `hc http://hostd-api:8080/projects` and confirm `"valid":true`.

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
   new entry. Wait ten seconds for the reload before going on to step 3.

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
`certificate`, then the same review, env and start steps against the new `test` environment.

## What is deliberately not automatic

- **The first start waits for the operator.** `create` registers a project with no capabilities at all and
  every service role only guessed from its image, and env files are only ever listed, never filled in:
  nothing runs until the entry is reviewed, `lifecycle` (and whatever else) is enabled, and the env files
  are edited.
- **Removing a project leaves its folder, volumes and databases in place.** `provision remove` only edits
  the registry; nothing under `/var/www` is deleted. Clean those up by hand once you are sure.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FATAL ... is not a file (was projects.yaml created before the first docker compose up?)` | Docker created a directory at `hostd/registry/projects.yaml` because `registry/projects.yaml` did not exist before the first `docker compose up`. Remove the directory, create the file, start again. |
| `FATAL HOSTD_API_TOKEN must be at least 32 characters` | `.env` is missing, or the token is empty or too short. |
| `FATAL the agent is not answering on /run/hostd/agent.sock` (api) | The agent is not running or failed its own gate. Read `docker compose logs agent`. |
| `503` with `"code":"agent-unavailable"` | The same, after startup. |
| A project is `"valid":false` with `compose resolves the project name ...` | See step 1 of Enrolling a real site. |
| A project is `"valid":false` with `... does not exist on the dedi` | `dir` is wrong, or the directory was removed. |
| `api` unhealthy with `the audit log could not be written` | The `hostd-state` volume is full or has the wrong owner. |
| Agent log `WARN the fetcher socket ... is not answering` | `hostd-fetcher` is not running or failed its own gate; provisioning and env editing are unavailable until it is, but lifecycle and logs are unaffected. Read `docker compose logs fetcher`. |
| A project is `"valid":false` with `storage is configured but no service is marked role database` | A service that is really a database is still marked `role: site` (or missing a role entirely); see step 2 of Creating a site. The project stays invalid, and lifecycle stays refused, until it is corrected. |
| A `create` or `add-environment` refusal `"no free port ... to ..."` | The configured port range (5000-5999) is full, by registry entry or by an already-published container port. Free one up, or extend `PORT_RANGE` in `src/shared/ports.ts`. |
| A `create` refusal `"... is already registered"`, or an `add-environment` refusal naming a folder that `"already exists"` | The id is already taken, or its folder is already on disk under a different registration. |
| A `create` or `add-environment` refusal `"... is already used by another project"` | The domain is already registered to a different project's environment. |
| A `create` or `add-environment` refusal naming a Git failure | The fetcher could not clone. Check the branch exists on the remote, and that `GITHUB_TOKEN` in `.env.fetcher` can read the repo. |
| A `create` or `add-environment` refusal `"the compose file declares no services"` | The compose file has no services in it at all, not merely none marked site. The cloned folder was removed and nothing was registered. |
| A `create` or `add-environment` refusal `"at least one service must have role site"` | hostd's own image guess (see Creating a site) marked every service database, most likely because the compose file genuinely has no service that is not a database, or an app image happens to contain one of the five matched names by coincidence. The cloned folder was removed and nothing was registered; fix the compose file if the guess was wrong, or enroll the project by hand instead (see Enrolling a real site) if it genuinely has no site-role service under this scheme. |
| A `create` or `add-environment` refusal naming a `docker compose config` error directly (a missing `env_file`, a syntax error) | hostd creates an empty file for any `.env.example` it finds with nothing real beside it yet, but only in the folders and depth a later env listing would itself reach; something the compose file needs still was not there. Fix the compose file or the repo, and try again. |
| A `provision` or `env` refusal naming a registry problem (`"... could not be written"`, or `"... already exists"` for an add) | The write itself failed, or raced another one and lost. A folder left behind after a losing race is not that call's to remove; it is left for you to look at. |
