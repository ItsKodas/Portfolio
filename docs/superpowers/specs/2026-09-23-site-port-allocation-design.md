# Choosing a site's port

Date: 2026-09-23. Status: approved in chat.

## Problem

hostd already picks a port for every new environment (`choosePort` in `hostd/src/shared/ports.ts`, the
lowest free one from 5000 to 5999), but only ever writes it to the registry, where the vhost uses it as
the upstream. Nothing tells the site. `portEnv` (default `WEB_PORT`) is parsed and never used. Each site
binds whatever its own `.env` or compose file hard codes, so two sites can bind the same port, and the
vhost can proxy to a port the site is not on.

It also cannot see a port something other than Docker holds. The agent has `network_mode: none` and only
asks Docker for published ports. On the dedi today 5004 and 5006 are listening and belong to no
registered site, so `choosePort` would hand either one out.

## Goal

- The admin chooses each environment's port in the portal: in the New site form, and later in Settings.
- A port is 5000 to 65535, not allocated to any registered environment, and not listening on the host.
- hostd writes the chosen port into the site, so the portal is the one place a port is set.

## Port rules

One function in `hostd/src/shared/ports.ts`, `portProblem(port, registry, listening, own?)`, used by the
create, the change and the check endpoint:

- A whole number from 5000 to 65535 (`PORT_RANGE` becomes `{ from: 5000, to: 65535 }`).
- Not the `port` of any environment in the registry, live or test, running or not. The message names it:
  `taken by arbysauto (live)`.
- Not in `listening` (below). The message is `in use on the host`.
- `own` is the environment being changed: its current port is not counted as taken, so saving an
  unchanged port passes.

`choosePort` keeps its shape (lowest free port in the range) and applies the same rules. Invalid registry
entries still refuse provisioning, as today.

## Seeing the host's ports

`hostd/src/agent/host-ports.ts`. The agent already holds the Docker socket, so it runs a short-lived
container in the host's network namespace, through the `docker` CLI, the same way the rest of the agent
shells out to Docker:

- Image: the agent's own. `docker inspect --format {{.Image}} <container>` reads its image id (the
  container name is `hostd-agent`, overridable with `HOSTD_AGENT_CONTAINER`), so nothing is ever pulled
  (the agent is offline) and a rebuild never leaves the probe on a stale tag.
- `docker run --rm --name hostd-port-probe-<hex> --network host --read-only --cap-drop ALL
  --security-opt no-new-privileges --pull never --entrypoint cat <image> /proc/net/tcp /proc/net/tcp6`.
  Run in the host namespace, that lists every socket on the machine: Docker's proxies, Apache, databases,
  and whatever holds 5004 and 5006. `--rm` cleans up a container that exits on its own; one left behind by
  a timeout or a non-zero exit is removed with a follow-up `docker rm -f`.
- `parseProcNetTcp(text)` keeps rows in state `0A` (LISTEN) and returns their local ports as a
  `Set<number>`. Pure, tested on fixtures.
- 10 second timeout. A probe that times out, exits non-zero or returns nothing parseable is a failure,
  and a failure refuses the create or change (`unavailable`, "could not read the host's ports"). hostd
  never assumes a port is free.
- Docker's own published ports are added on top of what the probe reads: a container that is starting
  may have its port reserved by Docker before it is listening, and the union of both is what counts.
- A reading is cached for 2 seconds, so the portal's live check asking for a suggestion and a verdict
  back to back costs one probe, not two.

## Writing the port into the site

The port lives in the environment's root `.env` as `<portEnv>=<port>` (`WEB_PORT` unless the registry
entry names another variable). The site's compose file is expected to publish it, for example:

```yaml
ports: ["127.0.0.1:${WEB_PORT}:3000"]
```

`writePortEnv(environment, key, port)` in `hostd/src/agent/port-env.ts` rewrites the one line (or appends
it, or creates `.env`) through `env-files.ts`, so it stays inside the env-file boundary, and hands back the
previous text so a failed step can restore it. Deploys already carry env files into the next tree
(`carryEnvFiles` in `deploy.ts`), so the port survives every deploy.

After writing it, the agent runs `docker compose config` for the environment and requires that some
service publishes that port on the host. If none does, the step fails with `notPublishedProblem(key,
port)` from `provision.ts`, for example: `no service publishes port 5010; publish $WEB_PORT in the
compose file, like "127.0.0.1:$WEB_PORT:3000"`. `ResolvedService` gains `ports`.

## New site

- `POST /projects` and `ProvisionCreateArgs` gain `port` (optional; omitted means `choosePort`, today's
  behaviour, for the runbook's hand calls).
- In `createProject` (agent, under the provisioning lock): after the id and domain checks, refresh the
  host's ports and apply `portProblem`. After the clone and `createMissingEnvFiles`, write the port into
  `.env`, then resolve and check the compose file publishes it. Any failure rolls back the whole create,
  as a compose failure does today.
- New admin-only `GET /ports?port=N&project=ID&environment=live|test`. api asks the agent, which answers
  `{ suggested: number, problem: string | null }`: the lowest free port, and what is wrong with `N` if
  one was given. `project` and `environment` go together and name the environment being changed, so its
  own current port is not counted as taken. It takes no lock and is advice only; the create and change
  check again under the lock.
- Portal: `server/hostd/ports.ts` (`checkPort(config, caller, { port?, own? })`), and a Port field in the
  New site modal. When the modal opens it fills in `suggested`. As the admin types (debounced) it shows
  the problem under the field. The zod schema gains `port: 5000 to 65535`, and `createSiteAction` passes
  it.

## Changing it in Settings

- `PUT /projects/:id/:env/port` with `{ port }`, admin only, matching the shape of the other
  per-environment routes, under the provisioning lock.
- The agent, in order:
  1. Applies `portProblem` with `own` set to this environment.
  2. Writes the port into `.env`, keeping the old line to put back.
  3. Resolves the compose file and checks the port is published.
  4. Writes the registry (new `set-port` change in `registry-write.ts`).
  5. Recreates the containers: `docker compose up -d` (which rereads `.env`), with the same argv the
     deploy uses, in the environment's own folder.
  6. If the environment has a vhost, rewrites it through the Apache rail to proxy to the new port.
- A failure at any step undoes the steps before it: `.env` line put back, registry put back, containers
  brought up again on the old port. The reply names the step that failed.
- An unchanged port is a no-op that answers ok.
- The change refuses busy while another provisioning action, a deploy (including a rollback or a branch
  switch) for that environment, a lifecycle action for the project, or an env write for that environment
  is running, and it holds all four off in turn while it runs itself, so nothing else can touch this
  environment's containers or `.env` mid-change. The deploy poller itself is not held off: a poll that
  lands mid-change is a known gap, not something this task closes.
- Portal: the Settings tab shows each environment's port in an editable field with the same live check
  and a note that saving restarts the site. It saves through its own action, not the existing settings
  form, because it restarts containers and the rest of Settings does not.

## Add-environment

Adding a test environment now writes that environment's own port into its `.env` the same way create
does, and requires its compose file to publish it. A test environment provisioned before this task, whose
compose file does not yet publish `${WEB_PORT}`, needs that fixed before its port can be checked or
changed the same way live's can.

## Out of scope

- Moving `backroom` (3002) and `1stcanzuk` (3000) above 5000. Once their compose files use
  `${WEB_PORT}`, that is done from Settings.
- A port field for a new test environment. It keeps `choosePort`, now with the host check.
- UDP ports. Sites are proxied over HTTP, so only TCP listeners matter.

## Testing

hostd (`node:test`):

- `parseProcNetTcp`: IPv4 and IPv6 rows, only LISTEN kept, header skipped, hex ports decoded.
- `portProblem`: below 5000, above 65535, taken by another environment (message names it), in use on
  the host, own port allowed.
- The host probe: container created with host networking from the agent's own image, always removed,
  timeout and non-zero exit are failures.
- Create: writes `WEB_PORT` (and a custom `portEnv`), refuses and rolls back when compose does not
  publish the port, refuses a port that is listening.
- Port change: happy path order; a failure at each step undoes the earlier ones; unchanged port is a
  no-op; the vhost is rewritten only when there is one.
- Routes: `GET /ports` and the change route are admin only.

Portal (Vitest):

- `checkPort` and the change call's request shapes.
- New site modal: fills in the suggested port, shows a taken port's message, sends `port`.
- Settings: the port field's check and save, and the restart note.
