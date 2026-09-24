# Named environments design

Date: 2026-09-24
Status: approved design, not yet implemented
Extends: `docs/superpowers/specs/2026-09-23-nested-site-layout-design.md` (piece 1, merged in PR #124)

This is piece 2 of 3. Piece 1 moved every site into `/var/www/<site>/{git, live, test, prev/<env>, next/<env>}`.
This piece lets a site have any number of named environments (uat1, uat2, staging), each on its own
branch, port and hostnames, created and deleted from the portal. Piece 3, cloning a new environment's data
from live, gets its own spec.

## Context

Environments are closed to `live` and `test` at every layer:

- `ENVIRONMENTS = ['live', 'test']` in `hostd/src/shared/registry.ts`, and `EnvironmentName` derived from
  it. `environmentOf` answers null for any other name.
- `layout.ts` builds `NESTED_DIR` and `FETCH_DIR` from a `(?:live|test)` literal.
- About ten parsers in `protocol.ts` check against the list, and `parseProvisionAddEnvironment` only
  accepts `test`.
- `routes.ts` matches `:env` segments against the list, and `POST /projects/:id/environments` hardcodes
  `environment: 'test'`.
- `provision.ts addEnvironment` can only make `test`, and only once.
- The portal keeps its own copies: `actions.ts` `ENVIRONMENTS`, `server/hostd/env.ts` `EnvironmentName`,
  `deployWatch.ts`, `ports.ts`, `relay.ts`, `deployLog.tsx`.
- `parseEnvironments` checks dir, port, compose name and nested site only between the live/test pair.

Already generic, and reused as is:

- Deploy history, the poller, deploy, rollback, branch and port changes, domains and domain verification
  are all keyed per environment.
- `deployTrees()` and `migrationTarget()` put any non-live environment at `<site>/<env>` with
  `next/<env>` and `prev/<env>`.
- The portal's Deploys and Domains tabs already take `?env=` and show an `EnvSwitcher` once a site has two
  environments.

Gaps that matter for an extra environment:

- Adding an environment with a domain writes no vhost; only creating a site writes live's first vhost
  (`routes.ts firstVhost`).
- `POST /:env/domains` only ever adds an alias, and the agent refuses an alias on an environment with no
  primary, so the portal cannot give a new environment its first hostname.
- The Environment tab (env files) only edits live.
- Removing an environment leaves its containers running and holding their port.

## Scope

### In scope

- Any number of named environments per site, alongside `live`
- Creating one from the portal (admin): name, branch, optional hostname
- Deleting one (admin, never `live`): stopped, taken off the web, moved to a trash folder, restorable for
  30 days, then purged with its volumes
- Restoring a deleted environment from the portal (admin)
- A hostname added on the Domains tab going to a chosen environment, becoming its primary when it has
  none
- Environment switchers as dropdowns on the Deploys, Domains and Environment tabs
- Runbook updates

### Not in scope

- Cloning a new environment's data from live (piece 3). A new environment starts with its own empty
  database.
- Per-environment Overview, logs, start/stop and backups. They stay live-only.
- Environments on a flat site. Adding one is refused until live has moved into the nested layout (deploy
  live once). An existing flat `test` keeps working and still moves on its next deploy.
- Removing a whole site, which keeps today's behaviour.
- Clients creating, deleting or restoring environments. Clients keep what they see today.

## Names

- One rule, `ENV_NAME = /^[a-z][a-z0-9]{0,15}$/`, in `hostd/src/shared/formats.ts`.
- Reserved, never valid as an environment name: `git`, `next`, `prev` (folders of the nested layout),
  and `environments`, `backups` (route segments under `/projects/:id/` that the api matches before an
  environment).
- `live` is valid (it is the one required environment) but can never be added, deleted or restored.
- `test` becomes an ordinary name. Existing test environments keep working unchanged.
- No hyphen, on purpose. hostd joins `<id>-<env>` into maintenance flag names, vhost file names
  (`<id>-<env>.conf`) and compose project names. With hyphens allowed, `acme` + `test-live` would collide
  with `acme-test` + `live`. Project ids may contain hyphens; environment names may not, so the last
  hyphen always splits the two.
- The portal keeps an exact copy of ENV_NAME and the reserved list (it does not import hostd code).

## hostd shared

### Registry (`registry.ts`)

- `ENVIRONMENTS` and the `EnvironmentName` union go. `EnvironmentName` becomes `string`, and
  `isEnvironmentName(name)` (ENV_NAME and not reserved) replaces membership in the list.
- `environments` accepts any valid name. `live` is still required. Map order: `live` first, then the
  others in the order the YAML lists them.
- The live/test pair checks become all-pairs over the project's environments: no shared dir, port or
  compose name, and every nested environment on the same site.
- `defaultComposeName` is unchanged in shape: nested live is the id, any other nested environment is
  `<id>-<env>`, and a flat dir is its normalised basename.
- `environmentOf(project, name)` answers the environment when the project has it, otherwise null.

### Layout (`layout.ts`)

- The `(?:live|test)` literal is replaced by the ENV_NAME pattern, so `/var/www/acme/uat1` is a nested
  dir and `/var/www/acme/next/uat1` a fetcher path. `git`, `next` and `prev` stay excluded from the
  environment position.
- `layout.test.ts` changes its `uat1` refusals into acceptances and adds refusals for reserved and
  hyphenated names.

### Protocol and registry writes

- Every parser that checked `ENVIRONMENTS` checks `isEnvironmentName` instead; `checkStructure` still
  answers `unknown-environment` when the project does not have the name.
- `ProvisionAddEnvironmentArgs` becomes `{ action: 'add-environment', environment: string, branch,
  domain | null, certificate | null }`, refusing `live` and invalid names.
- New provision actions: `delete-environment { environment }`, `restore-environment { environment,
  deletedAt }`, and a read, `deleted-environments`.
- `registry-write.ts`: `add-environment` and `remove-environment` stay generic. A new change,
  `restore-environment`, writes a stored node back verbatim (with a new port or fewer hostnames when the
  restore had to change them), refusing when the name exists.

## Creating an environment

`POST /projects/:id/environments`, admin only (policy verb `provision`, capability `provision`). Body
`{ name, branch, domain | null }`.

The agent (`provision.ts addEnvironment`, generalised):

1. Refuses: an invalid or reserved name, `live`, a name the project already has, a name with a deleted
   record still inside its 30 days ("restore or wait for it to be purged"), a flat live, a missing
   `<site>/git/.git`, a domain another project or environment already has.
2. Chooses a port (`choosePort`).
3. Fetches the branch into `<site>/git` and adds a worktree at `<site>/<name>` at its tip.
4. Copies live's env files in, rewriting the database name `<id>` to `<id>-<name>` and live's domain to the
   new one (the rule today's test copy uses, with `test` generalised to the name), writes the port into
   `.env`, and writes `hostd.ports.yml`.
5. Resolves compose under the name `<id>-<name>`, owns the tree like the site, writes the registry entry.
6. If a domain was given, the api writes its vhost straight after, the way site creation writes live's
   first vhost (`firstVhost`, generalised to take the environment).

A failure before the registry write removes `<site>/<name>` (this call made it) and nothing else.

The new environment is not started; its first deploy starts it, as with test today.

## Domains

`POST /projects/:id/:env/domains { hostname }`:

- Environment has no primary: the hostname becomes its primary (configure `domains`), and the vhost is
  written (the same path a primary change already uses). Verification state is recorded as primary.
- Environment has a primary: unchanged, an alias.

`maxDomains` still counts per environment. Everything else about domains stays as it is.

## Deleting an environment

`DELETE /projects/:id/environments/:env`, admin only, body `{ name }` (the site's name typed back, as
today). Refused for `live`.

With a per-project lock held (no deploy, port change or env write of that environment may run):

1. `compose down --remove-orphans` for the environment, under its compose name. Never `-v`.
2. Remove its vhost (`removeVhost`), and its api-side domain verification records.
3. Move into `<site>/.deleted/<env>-<unix seconds>/`: `<site>/<env>` to `tree`, `<site>/prev/<env>` to
   `prev` if present, `<site>/next/<env>` to `next` if present. `<site>/.deleted/` is made like the site if
   missing. All renames stay within the site folder.
4. Write the record (below), then `remove-environment` in the registry.

A failure undoes in reverse whatever succeeded: registry, record, moves (moved back), vhost rewritten,
`up -d --no-build` started. An undo that cannot finish stops and the reply says what state is left, never
deleting anything. Environments with a leading dot can never exist, so `.deleted` never collides with one.

### The record

`/var/lib/hostd/deleted-environments.json` (the agent's state directory), one entry per deleted
environment:

```
{ project, environment, deletedAt (ISO), trash (absolute path), composeName, node (the registry node
  exactly as it was, as plain data), actor }
```

Written atomically (temp file and rename). It is outside `projects.yaml` on purpose: a deleted environment
never counts in the registry's port, hostname, dir or compose name checks, and the operator's own edits
never see it.

## Restoring

`POST /projects/:id/deleted-environments/:env/restore`, admin only, body `{ deletedAt }` (which record,
if the same name was deleted more than once).

1. Refuse when the project now has an environment of that name, when the record is past 30 days, or when
   the trash folder is missing.
2. Port: keep the recorded one if still free (`checkPort`), otherwise `choosePort`, and rewrite `.env` and
   `hostd.ports.yml` for it after the move.
3. Hostnames: keep each one that no project or environment has claimed meanwhile; drop the rest. The
   primary is dropped with the rest if taken, and the first kept alias then becomes the primary.
4. Move `tree` back to `<site>/<env>` (and `prev`, `next` if present and their targets are free).
5. `restore-environment` in the registry, with the port and hostnames decided above.
6. Write the vhost when it has a primary, and `up -d --no-build`.
7. Drop the record. The reply lists any hostnames that were dropped and whether the port changed.

A failure before step 5 moves everything back into the trash and leaves the record.

## Purging

The agent sweeps the record every hour (and once at boot). For each entry whose `deletedAt` is more than
30 days old:

1. Delete its trash folder (recursive; it is hostd's own trash and nothing else lives there).
2. Remove the named volumes whose `com.docker.compose.project` label equals the recorded compose name
   (`docker volume ls --filter label=com.docker.compose.project=<name> -q`, then `docker volume rm`). A
   volume still in use is left and retried next sweep. The recorded compose name is always `<id>-<env>`
   or a flat `basename`, never a live compose name, and the sweep refuses to touch a name any registered
   environment currently uses.
3. Drop the entry, and log what was removed.

A failure leaves the entry for the next sweep.

## hostd api

- `:env` route segments accept any valid name; a name the project lacks answers 404
  `unknown-environment`, as today.
- `POST /projects/:id/environments` body becomes `{ name, branch, domain | null }`.
- `DELETE /projects/:id/environments/:env` soft-deletes as above.
- `GET /projects/:id/deleted-environments` lists records for that project: `environment, deletedAt,
  purgeAt, branch, domain, aliases`. Admin only.
- `POST /projects/:id/deleted-environments/:env/restore` as above.
- `environmentsFor` also returns `aliases`, so the portal can show every environment's hostnames.

## Portal

- One shared name rule and type in `server/hostd/env.ts` (`EnvironmentName = string`, `ENV_NAME`,
  `isEnvironmentName`), replacing the copies in `actions.ts`, `deployWatch.ts`, `ports.ts`, `relay.ts` and
  `deployLog.tsx`. Actions validate against the site's own environment list, not a fixed list.
- `EnvSwitcher` becomes a dropdown (a select that navigates), shown when a site has two or more
  environments.
- Deploys tab: unchanged apart from the dropdown.
- Domains tab: the add-hostname form gains an Environment select, defaulting to the environment being
  viewed; submitting adds to that environment. The "no primary" disabled state goes; the first hostname
  of an environment becomes its primary.
- Environment tab (env files): gains the dropdown and reads and writes the chosen environment
  (`saveEnvAction` takes the environment).
- Settings tab, admin only:
  - An Environments section: one row per environment (name, branch, primary domain, last deployed
    commit), `live` first.
  - Add environment: name (validated with ENV_NAME and the reserved list client-side, hostd has the final
    word), branch (the existing branch list), optional hostname. Shows hostd's refusal text on failure.
  - Delete on every non-live row: the site's name typed to confirm, explaining it is stopped and kept for
    30 days.
  - Deleted environments: each with deleted date, days left, Restore. After a restore, show what hostd
    reports (dropped hostnames, new port).
- Overview, logs, start/stop and backups stay live-only.
- Clients: no change to what they can do. The admin-only sections are not rendered for them, and hostd
  refuses them anyway.

## Runbook

- The environment name rule and the reserved names.
- Adding, deleting, restoring environments, and what each does on disk.
- The trash folder, the record file, the 30 day purge and what it removes, and how to purge or restore
  by hand.
- That removing a whole site is unchanged.

## Testing

- hostd, `node --test`, beside the source, with the existing fakes: name validation and reserved names;
  registry all-pairs checks; layout and fetcher path acceptance; every parser accepting a new name and
  refusing reserved or invalid ones; add, delete (with an undo at each step), restore (port kept or
  reassigned, hostnames kept or dropped) and purge (age cutoff, volume filter, refusal of a live compose
  name); the api routes and policy (client refused).
- Portal, vitest: the dropdown switcher, the Domains environment select, the env tab environment, the
  Settings environments section (admin only, add, delete confirm, restore), actions accepting a site's own
  environment names and refusing others.
