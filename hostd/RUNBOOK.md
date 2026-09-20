# hostd runbook

hostd lets the client portal control client sites on this dedi. Phase 1 covers status, start, stop,
restart and logs. It is two containers:

- `hostd-agent` holds the Docker socket. It has no network and listens only on a Unix socket.
- `hostd-api` speaks HTTP on the private `hostd` Docker network. Nothing is published on the host.

Client sites never depend on hostd. If it is down, every site keeps serving; only the portal's controls
stop working.

## Before the first start

1. Pull the repo on the dedi, then work in `hostd/`.
2. Create `hostd/.env` from `hostd/example.env`. Generate the token here on the dedi, and paste it into
   the file yourself:

   ```bash
   openssl rand -hex 32
   ```

3. Create `hostd/registry/projects.yaml` from `hostd/registry/projects.example.yaml`, and delete the
   example project for now. `registry/` is already there, because the example lives in it, and the
   containers mount that directory rather than the file inside it.

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

### Moving an older deployment

A dedi set up before 2026-09-20 has the registry at `hostd/projects.yaml`. After pulling this version:

```bash
cd hostd
mkdir -p registry
mv projects.yaml registry/projects.yaml
docker compose up -d --force-recreate
```

`--force-recreate`, not `restart`: a restart keeps the container's existing mounts, so it would still be
looking for the old path.

## First start

```bash
cd hostd
docker compose up -d --build
docker compose ps
```

The build runs the whole test suite. A failing test stops the build, and whatever was running before
keeps running.

Both containers should report `healthy` within about two minutes. Both logs should show `listening`:

```bash
docker compose logs agent | tail -20
docker compose logs api | tail -20
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

Add a stray `[` anywhere in `registry/projects.yaml`. Within ten seconds, both logs show `WARN registry reload
rejected, still using the last good version`, and check 2 still works. Remove the `[`, and the warning
clears.

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

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `FATAL ... is not a file (was projects.yaml created before the first docker compose up?)` | Something other than a file sits at `registry/projects.yaml`. Remove it, create the file, start again. |
| `registry reload rejected ... has been replaced on the host` | The registry's bind mount is detached, from an older deployment that mounted the file itself. See **Editing the registry**. |
| `FATAL HOSTD_API_TOKEN must be at least 32 characters` | `.env` is missing, or the token is empty or too short. |
| `FATAL the agent is not answering on /run/hostd/agent.sock` (api) | The agent is not running or failed its own gate. Read `docker compose logs agent`. |
| `503` with `"code":"agent-unavailable"` | The same, after startup. |
| A project is `"valid":false` with `compose resolves the project name ...` | See step 1 of Enrolling a real site. |
| A project is `"valid":false` with `... does not exist on the dedi` | `dir` is wrong, or the directory was removed. |
| `api` unhealthy with `the audit log could not be written` | The `hostd-state` volume is full or has the wrong owner. |
