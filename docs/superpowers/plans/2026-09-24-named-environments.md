# Named Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A site can have any number of named environments beside `live`, created, deleted (30 day trash) and restored from the portal, with hostnames assigned per environment.

**Architecture:** Wave 1 opens the environment model in hostd's shared code (names, registry, layout, protocol, routes). Wave 2 runs three independent tracks in parallel, each in its own git worktree off the wave 1 commit: hostd create plus domains, hostd delete/restore/purge, and the portal. Wave 3 merges them, adds the runbook, and runs the whole-branch review.

**Tech Stack:** TypeScript, Node 22 (`node --import tsx --test`) for hostd; Next.js with vitest for the portal (`npm test` at the repo root). Docker Compose, git worktrees.

**Spec:** `docs/superpowers/specs/2026-09-24-named-environments-design.md`

## Global Constraints

- Environment names: `ENV_NAME = /^[a-z][a-z0-9]{0,15}$/`; reserved `git`, `next`, `prev`; `live` valid but never added, deleted or restored.
- Deleted environments are kept 30 days (`DELETED_KEEP_MS = 30 * 24 * 60 * 60_000`), then purged with their volumes. Purge sweep: every hour and once at boot.
- Record file: `/var/lib/hostd/deleted-environments.json`, written via temp file and rename.
- Trash path: `<site>/.deleted/<env>-<unix seconds>/` with `tree`, `prev`, `next` inside.
- Never `compose down -v`. Nothing is deleted before its replacement is in place, except build trees and the purge itself.
- Admin only for create, delete, restore and the deleted list (policy verb `provision`).
- No em dashes (U+2014) in docs, UI text, messages, commit messages or PR text. Check with Python `chr(0x2014)`, never a literal or a `—` escape in a heredoc.
- Commit messages: subject, blank line, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Use `git commit -F <file>`.
- hostd tests: `cd hostd && npm test`, types `npm run typecheck`. Portal tests: `npm test` at the repo root (vitest), types `npx tsc --noEmit`.
- Tests use the existing fakes; no Docker, network or real filesystem.

## Planning decision

Rulings recorded here rather than in a ledger, since this plan is written before execution:

- **Tasks are specified by interface, behaviour and required tests, not full code.** The change spans roughly 40 files, and the implementers are capable models working against the existing code. Each task still names its files, exact signatures and the tests that must exist.
- **Wave 2 runs in three separate worktrees in parallel** at the user's request. The three tracks touch mostly disjoint files. Where they share a file (`protocol.ts`, `routes.ts`, `agent.ts`), each track adds its own new functions and cases, and the controller resolves the merge in wave 3.

---

## Wave 1

### Task 1: Open the environment model in hostd

**Files:** `hostd/src/shared/formats.ts`, `registry.ts`, `layout.ts`, `protocol.ts`, `registry-write.ts`, `ports.ts`, `deploys.ts`; `hostd/src/api/routes.ts` (env segment matching, ports query), `hostd/src/agent/vhost.ts` and anything else typed `EnvironmentName`; all their tests.

**Produces:**
- `formats.ts`: `ENV_NAME: RegExp`, `RESERVED_ENVIRONMENT_NAMES: ReadonlySet<string>` (`git`, `next`, `prev`), `isEnvironmentName(name: unknown): name is string`.
- `registry.ts`: `EnvironmentName = string`; `ENVIRONMENTS` removed (update every importer); `environmentOf(project, name)` answers the project's own environment or null; `environments` map with `live` first, then YAML order; all-pairs checks (dir, port, composeName, same nested site) with messages naming both environments.
- `layout.ts`: the environment position in `NESTED_DIR` and `FETCH_DIR` accepts `isEnvironmentName` names (build the regex from ENV_NAME's body and exclude reserved names, or post-check). `nestedEnvOf` unchanged in meaning.
- `protocol.ts`: every parser that checked `ENVIRONMENTS` checks `isEnvironmentName`, and error text reads "must be an environment name" instead of listing live and test. `parseProvisionAddEnvironment` still only builds the existing test-shaped args in this task (Task 2 widens it). `checkStructure` keeps answering `unknown-environment` for a name the project lacks.
- `routes.ts`: `:env` segments are accepted when `isEnvironmentName`; the project lookup decides 404 as today.
- `index.ts` backup guard (`ENVIRONMENTS.some(...)`) loops over the project's own environments.

**Required tests (update the ones that asserted refusal of `uat1`/`staging`):**
- `uat1` and `staging` accepted in registry, layout (`/var/www/acme/uat1`, `/var/www/acme/next/uat1`), fetcher paths, and every protocol parser; reserved (`git`, `next`, `prev`), hyphenated (`uat-1`), uppercase and 17-character names refused.
- A registry with `live`, `test` and `uat1` parses with map order live, test, uat1 (and live first when YAML lists it later).
- All-pairs: `uat1` sharing a port with `test` is refused, naming both.
- A route `/projects/acme/uat1/deploys` for a project that has `uat1` is matched; for one that lacks it answers 404 `unknown-environment`.

**Commit:** "Let hostd environments take any name, not only live and test"

---

## Wave 2 (three parallel tracks, each in its own worktree off Task 1)

### Task 2 (track A): Create environments and assign hostnames

**Files:** `hostd/src/shared/protocol.ts` (add-environment args), `hostd/src/agent/provision.ts` (`addEnvironment`, `copyEnvFiles`, `rewriteEnvText`), `hostd/src/agent/agent.ts` (dispatch), `hostd/src/api/routes.ts` (`parseAddEnvironmentBody`, the add-environment handler, `firstVhost`, `POST /:env/domains`), `hostd/src/agent/domains.ts` if the agent side needs it; tests.

**Produces:**
- `ProvisionAddEnvironmentArgs = { action: 'add-environment', environment: string, branch: string, domain: string | null, certificate: CertificateMode | null }`; parser refuses `live`, reserved and invalid names.
- `parseAddEnvironmentBody` accepts `{ name, branch, domain }` (certificate optional, default null), mapping `name` to `environment`.
- `addEnvironment(project, args, deps, envFs)` behaves per the spec's "Creating an environment": refuses an existing name, a flat live, a missing `<site>/git/.git`; dir `<site>/<env>`; composeName `<id>-<env>`; env files copied from live with the database `<id>` rewritten to `<id>-<env>` and live's domain to the new one; port chosen and written into `.env` and `hostd.ports.yml`; `collidesWith` live's compose name. The flat-live clone branch is removed; a flat live is refused with "deploy live once so it moves into the nested layout, then add environments".
- A deleted-name check hook: `ProvisionDeps.deletedWithin?: (project: string, environment: string) => Promise<boolean>`; when it answers true, refuse with "<env> was deleted less than 30 days ago; restore it or wait for it to be purged". Track B wires the real function; default undefined means no check.
- `firstVhost(id, environment)` takes the environment; the add-environment handler calls it when the new environment has a domain, the same way create does for live.
- `POST /:env/domains`: when the environment has no primary, set it as primary through the existing configure `domains` path (which records it and writes the vhost as a primary change does), and record verification as primary; otherwise alias as today.

**Required tests:**
- add `uat1` on a nested site: worktree at `/var/www/acme/uat1` from `/var/www/acme/git`, composeName `acme-uat1`, env text `DATABASE_URL=...acme` rewritten to `acme-uat1`, port chosen, registry entry written.
- a second environment (`uat2`) after `test` exists works; adding an existing name, `live`, `git`, a flat live, and a deleted-within name are each refused with their messages.
- api: body `{ name: 'uat1', branch: 'main', domain: 'uat1.acme.com' }` reaches the agent as add-environment `uat1`, then writes the vhost for `uat1`; a client actor is refused.
- domains: a first hostname on an environment with no primary becomes its primary and triggers the vhost write; a second becomes an alias.

**Commit(s):** "Add named environments to a site, and give a new one its vhost", "Make the first hostname of an environment its primary"

### Task 3 (track B): Delete, restore and purge environments

**Files (new):** `hostd/src/agent/environment-trash.ts` (+ test), `hostd/src/agent/deleted-store.ts` (+ test). **Modified:** `hostd/src/shared/protocol.ts` (new provision actions), `hostd/src/shared/registry-write.ts` (`restore-environment` change), `hostd/src/agent/agent.ts` (dispatch, per-project lock), `hostd/src/agent/index.ts` (wiring, hourly sweep), `hostd/src/api/routes.ts` (DELETE environment, GET deleted list, POST restore), `hostd/src/api/policy.ts` if a verb is needed; tests.

**Produces:**
- `DeletedRecord = { project: string, environment: string, deletedAt: string, trash: string, composeName: string, node: Record<string, unknown>, actor: string }`.
- `DeletedStore` over a `DeletedStoreFs` (read, write temp, rename): `list(project?)`, `add(record)`, `remove(project, environment, deletedAt)`, `deletedWithin(project, environment, now)`.
- `deleteEnvironment(project, environmentName, actor, deps)`: spec's "Deleting an environment" steps with the undo; refuses `live` and names the project lacks. Uses `compose down --remove-orphans` with the environment's compose name at its dir, `removeVhost`, moves under `<site>/.deleted/<env>-<unix>/{tree,prev,next}`, writes the record, then `remove-environment`.
- `restoreEnvironment(project, environmentName, deletedAt, deps)`: spec's "Restoring": port kept via `checkPort` or re-chosen (then `.env` and `hostd.ports.yml` rewritten), hostnames kept only when free (first kept alias promoted when the primary is taken), moves back, `restore-environment` registry change, vhost when it has a primary, `up -d --no-build`, record removed. Reply `{ ok: true, port, portChanged: boolean, droppedHostnames: string[] }`.
- `purgeDeleted(now, deps)`: records older than `DELETED_KEEP_MS`: recursive delete of the trash folder, volumes by compose project label via the docker CLI runner (`docker volume ls --filter label=com.docker.compose.project=<name> -q`, `docker volume rm <each>`), refusing any compose name a registered environment uses; entry removed only when both succeed.
- `registry-write.ts` `restore-environment { id, environment, node }` writes the node back, refusing an existing name.
- Routes: `DELETE /projects/:id/environments/:env` body `{ name }` (site name typed back) calls delete; `GET /projects/:id/deleted-environments` answers `{ environments: [{ environment, deletedAt, purgeAt, branch, domain, aliases }] }`; `POST /projects/:id/deleted-environments/:env/restore` body `{ deletedAt }`. All admin only.
- Wiring: the store at `/var/lib/hostd/deleted-environments.json`; `deletedWithin` exported for track A's `ProvisionDeps.deletedWithin` (wire it in `index.ts` in this track; if track A's field does not exist yet in this worktree, add the optional field to `ProvisionDeps` yourself with that exact name and signature).
- Remove the old `removeProject(project, env)` environment path in favour of `deleteEnvironment`; removing a whole site is unchanged.

**Required tests:**
- delete `uat1`: call order down, vhost removal, moves (tree, prev, next when present), record, registry; containers never taken down with `-v`; `live` refused.
- delete undo: a failing move moves back what moved, rewrites the vhost, runs up, leaves no record and the registry unchanged; an undo that cannot finish stops without deleting anything.
- restore: port kept when free; re-chosen and `.env` rewritten when taken; a taken hostname dropped and reported; taken primary with a free alias promotes the alias; refused when the name exists again, when past 30 days, when the trash is gone.
- purge: only records older than 30 days; volumes filtered by the recorded compose name; a record whose compose name a registered environment uses is refused and kept; a failing volume removal keeps the record.
- store: atomic write (temp then rename), round trip, deletedWithin.
- routes: each new route for admin; client refused; DELETE of `live` refused.

**Commit(s):** one per coherent step, e.g. "Keep a record of deleted hostd environments", "Delete a hostd environment into a 30 day trash", "Restore a deleted hostd environment", "Purge deleted hostd environments after 30 days".

### Task 4 (track C): Portal

**Files:** `server/hostd/env.ts` (shared name rule and type), `server/hostd/deployWatch.ts`, `server/hostd/ports.ts`, `server/hostd/relay.ts`, `server/hostd/projects.ts` (aliases on Environment), new `server/hostd/environments.ts` (create, delete, list deleted, restore wrappers); `app/(portal)/portal/sites/[id]/actions.ts`, `envSwitcher.tsx`, `domainsPanel.tsx`, `domainControls.tsx`, `env.tsx`, `envForm.tsx`, `page.tsx`, `settings.tsx`, `deployLog.tsx`, CSS module; tests beside each.

**Consumes (the hostd API contract, from the spec; it may not exist in this worktree yet, so the wrappers are tested with mocked fetch like the existing `server/hostd/*.test.ts`):**
- `POST /projects/:id/environments { name, branch, domain }`
- `DELETE /projects/:id/environments/:env { name }`
- `GET /projects/:id/deleted-environments` returns `{ environments: [{ environment, deletedAt, purgeAt, branch, domain, aliases }] }`
- `POST /projects/:id/deleted-environments/:env/restore { deletedAt }` returns `{ port, portChanged, droppedHostnames }`
- `GET /projects/:id` environments now include `aliases`.
- `POST /projects/:id/:env/domains { hostname }` makes the first hostname primary (so the portal no longer disables add when there is no primary).

**Produces:**
- `server/hostd/env.ts`: `ENV_NAME`, `RESERVED_ENVIRONMENT_NAMES`, `isEnvironmentName`, `EnvironmentName = string`; every other copy removed.
- actions validate the environment against the site's own list; `saveEnvAction(id, environment, ...)`; new `addEnvironmentAction`, `deleteEnvironmentAction`, `restoreEnvironmentAction`, all admin only (the same `isAdmin` check other admin actions use).
- `EnvSwitcher` renders a select that navigates to `?tab=<tab>&env=<name>`, shown for two or more environments; used on Deploys, Domains and the Environment tab.
- Domains: the add form has an Environment select (default the viewed environment); first hostname allowed.
- Environment tab: reads and writes the selected environment.
- Settings (admin only): Environments list, Add environment form (name with client-side ENV_NAME and reserved check, branch select from the existing branch list, optional hostname), Delete per non-live row with the site name typed to confirm and the 30 day explanation, Deleted list with days left and Restore, showing dropped hostnames or a changed port after a restore.
- Copy follows the site's existing voice; no em dashes.

**Required tests:** the switcher (hidden for one environment, select navigates); domains select default and submission to the chosen environment; env tab environment round trip; settings sections hidden for clients, add validation (reserved, hyphen), delete confirm, restore result text; actions accepting `uat1` when the site has it and refusing a name it lacks; the new wrappers' request shapes.

**Commit(s):** coherent steps, e.g. "Share one environment name rule across the portal", "Pick an environment from a dropdown on the site tabs", "Add, delete and restore environments from a site's Settings".

---

## Wave 3

### Task 5: Merge, runbook, verify

- Merge tracks A, B, C into `claude/named-environments` (controller), resolving shared-file conflicts so both sides' behaviour survives; wire track A's `deletedWithin` hook to track B's store if not already.
- `hostd/RUNBOOK.md`: name rule and reserved names; adding, deleting, restoring environments and what each does on disk; trash folder, record file, 30 day purge and what it removes; restoring or purging by hand; removing a whole site unchanged.
- Full hostd and portal test suites and type checks green.
- Merge `origin/Master` if it moved (resolve, retest).

**Commit:** "Document named environments in the hostd runbook"
