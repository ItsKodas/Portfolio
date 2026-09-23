# Nested site layout design

Date: 2026-09-23
Status: approved design, implemented
Extends: `docs/superpowers/specs/2026-09-20-hostd-provisioning-design.md` (the deploy path it defines is
live)

This is piece 1 of 3. Piece 2 is named environments (uat1, uat2, a domain-to-environment dropdown, an
environment switcher on the Deploy page). Piece 3 is cloning a new environment's data from live. Both get
their own specs; this one only changes where a site lives on disk.

## Context

Every hostd site is a flat set of siblings under `/var/www`:

```
/var/www/backroom          what live serves (a git worktree)
/var/www/backroom.git      the repository, moved out of the tree on the first deploy
/var/www/backroom.prev     the previous copy, kept for the automatic rollback
/var/www/backroom.next     a build in progress
/var/www/backroom-test     the test environment, a separate clone
/var/www/backroom-test.git
/var/www/backroom-test.prev
```

With a dozen sites, `/var/www` holds four or more entries per site, and adding more environments per
site (piece 2) would multiply that. The paths come from one function, `deployTrees()` in
`hostd/src/agent/deploy-compose.ts`, plus `provision.ts` for creation.

The compose project name is derived from the folder basename (`composeNameOf()`), and lifecycle,
logs and the guard run compose with no `--project-name` at all, relying on compose to derive the same
name from the folder. A nested layout breaks that derivation: every live folder would be called `live`.

## Scope

### In scope

- A nested per-site layout, for live and test
- Migrating existing sites to it automatically, during their next deploy's swap window
- An explicit compose project name per environment, passed on every compose invocation
- Creating new sites nested from the start; adding a test environment to a nested site as a worktree of
  the shared repository
- Runbook updates

### Not in scope

- Moving storage directories out of the environment tree. They are bind-mounted by relative path from
  each client's own compose file, so moving them means editing client repos. They stay inside the tree,
  exactly as today.
- Environment names other than `live` and `test` (piece 2)
- Any portal change. The portal never sees a path.
- `/var/www/horizons`, which is deployed by GitHub Actions and is not in the hostd registry
- Migrating a site that never deploys. A redeploy of the same commit (the portal's Deploy button) is the
  way to migrate one on demand.
- Deleting anything a project removal leaves behind, which stays as today

## Layout

```
/var/www/backroom/
  git/           the repository (holds .git), shared by every environment
  live/          what live serves
  test/          what test serves
  prev/live      the previous live copy
  prev/test
  next/live      a build in progress, only during a deploy
  next/test
```

`<site>` is the flat live folder's own name, which is not always the project id (`args.dir` at creation
can differ). The parent and its `prev/` and `next/` folders take the owner and mode of the flat live tree
they replace, read from disk, never assumed, the same rule `deploy.ts` follows today.

## Registry

- `DIR` accepts `/var/www/<site>` (flat) and `/var/www/<site>/<env>` where `<env>` is `live` or `test`.
  `<site>` keeps today's one-segment pattern.
- A new optional environment key `composeName`, matching the compose project name pattern
  (lowercase letters, digits, `-` and `_`, starting with a letter or digit).
- When absent, it defaults to:
  - flat: `basename(dir)` normalised the way compose normalises a folder name (lowercased, every
    character outside `[a-z0-9_-]` dropped), which is exactly today's behaviour
  - nested: the project id for live, `<id>-<env>` for anything else
- Migration always writes `composeName` explicitly, so an existing site keeps the name its containers
  and named volumes already carry, whatever its folder or id.
- A registry-wide check: no two environments, in any project, resolve to the same compose name. A
  collision marks both projects invalid with a message naming the name and both environments.
- A new registry-write kind, `set-layout`: `{ id, environment, dir, composeName }`. It rewrites that
  environment's `dir` and sets `composeName`. Compose paths are stored relative to `dir`, and storage
  paths are derived from the live `dir`, so neither needs rewriting.

## Deploy trees

`deployTrees(environment)` becomes layout aware:

| Layout | dir | next | prev | repo |
| --- | --- | --- | --- | --- |
| flat | `/var/www/s` | `/var/www/s.next` | `/var/www/s.prev` | `/var/www/s.git` |
| nested | `/var/www/s/<env>` | `/var/www/s/next/<env>` | `/var/www/s/prev/<env>` | `/var/www/s/git` |

`repositoryIn()` stays `<repo>/.git`. `ensureRepo()` is unchanged in shape: for a nested site created
fresh, it moves `live/.git` into `git/.git` on the first deploy.

A second function, `nestedTrees(environment)`, gives the nested trees a flat environment will migrate
to: `<site>` is the flat live folder's basename (for test, the live environment's, since the test
folder is `<site>-test`).

`composeNameOf(environment)` returns the environment's resolved `composeName`.

`treesProblem()` also refuses when `<site>.migrating`, the new parent `/var/www/<site>`, or any nested
path is registered to another project.

## Compose name on every invocation

`composeBase()` in `compose.ts` gains `--project-name <composeName>`, so lifecycle, logs, config and the
guard all use the explicit name instead of compose deriving it from the folder. `configArgv` takes the
name as well, since provisioning resolves a folder that is not registered yet.

The guard's expectation is unchanged: live must resolve to the project id. Because `--project-name`
overrides a compose file's own `name:`, the guard now compares the environment's `composeName` against
the expectation, and a registry entry whose live `composeName` is not the project id is a guard problem
with the same message as today.

## Migration

### Eligibility

- Live: any flat live environment, on any deploy.
- Test: a flat test environment whose project's live environment is already nested. Until then test
  deploys flat, as today. The two never touch each other's folders.

### When

Inside the swap window of a normal deploy, so the site is down for no longer than any other deploy.
Everything before the swap runs as today, in the flat layout: fetch into the flat repository, checkout
and build in `<site>.next` (for test, the checkout comes from `<site>/git` into `<site>/next/test`; see
below).

It must be inside the window. Docker records a container's bind-mount source paths when the container
is created, so renaming folders under running containers would leave them pointing at paths that no
longer exist the next time the host restarts them. Migrating only between a `down` and an `up` means
every container is recreated against the new paths.

### Live, step by step

With the maintenance flag up:

1. `down` the running copy at its flat paths (as today).
2. Delete `/var/www/s.prev` if it exists (as today).
3. Rename `/var/www/s` to `/var/www/s.migrating`.
4. Make `/var/www/s/` and `/var/www/s/prev/`, and `own` them like `/var/www/s.migrating`.
5. Rename `/var/www/s.migrating` to `/var/www/s/prev/live`.
6. Rename `/var/www/s.next` to `/var/www/s/live`.
7. Rename `/var/www/s.git` to `/var/www/s/git`.
8. `up` in `/var/www/s/live` with the pinned compose name, then the health check.
9. If the health check fails, the normal `swapBack()` runs with the nested trees: `live` goes back to
   `next/live` and `prev/live` becomes `live`. The site stays nested, on the previous commit, recorded
   `rolled-back`.

After the window:

10. `git worktree repair` from `/var/www/s/git` for `/var/www/s/live` and `/var/www/s/prev/live`
    (best effort, logged, as today).
11. `set-layout` for live: `dir: /var/www/s/live`, `composeName: <the name used before>`.
12. `set-deployed`, as today.

### Test

When test deploys and live is already nested:

1. Fetch test's branch into `/var/www/s/git` (under the shared-repo lock below).
2. Check out into `/var/www/s/next/test` from `/var/www/s/git`, carry env and compose files, own and
   build, all as today.
3. In the window: `down` at the flat paths, delete `/var/www/s-test.prev`, make `/var/www/s/prev/` if
   missing, rename `/var/www/s-test` to `/var/www/s/prev/test`, rename `/var/www/s/next/test` to
   `/var/www/s/test`, `up`, health check, with the nested `swapBack()` on failure.
4. After the window: repair, `set-layout` for test (`composeName` is the old `basename`, normally
   `s-test`), `set-deployed`.
5. Only then delete `/var/www/s-test.git` (and a `.git` inside the old tree, now at `prev/test/.git`, if
   the repository was never moved out). Its commits were all fetched from GitHub, which step 1 has
   already fetched into `git/`, so nothing is lost.

### Undo and resume

The executor records each rename it completes. If a rename in the window fails, it undoes the completed
renames in reverse order, removes any folder it made, runs `up` on the flat tree and records `failed`
with a reason naming the step.

At the start of every deploy, before anything else, a resume check reads the disk. It runs whether or
not migration is switched on, because a move already under way has to finish either way:

| On disk | Registry | Action |
| --- | --- | --- |
| flat only | flat | nothing (the normal path) |
| `s.migrating` exists | flat | finish the layout forward (`s/`, `s/prev/`, `s.migrating` to `prev/live`, `s.git` to `s/git`), serve the old tree (below), repair, `set-layout`; the deploy then continues nested |
| `s/live` and `s/git/.git` exist | flat | `up -d --no-build` in `s/live` with the pinned name (a failure is logged, not fatal), then redo repair and `set-layout` |
| `s/` has no `.git` of its own, and the environment's first compose file exists under `s/prev/live` | flat | a window whose undo stopped part way: the same as the `s.migrating` row |
| anything else: live's `s/` is neither a flat tree (no compose file at its root) nor one of the shapes above; test has both or neither of its flat and nested trees | flat | refuse the deploy: record `failed` with "`s` is neither flat nor nested", touch nothing, and leave it to the operator |
| nested | nested | nothing |

The old-tree rule for the interrupted rows is the old tree's compose file, not a `.git`: a first deploy
moves the repository out to `s.git` before its window, so the tree that reaches `prev/live` has none. A
folder that still has its own `.git` is a flat tree, even one that has lost its compose file, so it is
never mistaken for a move to finish.

**Serving the old tree.** Once the layout is finished forward, and `s/prev/live` exists, the resume puts
the tree that was serving before the window back, rather than the build the window was about to swap in,
which no health check has seen. A build that already reached `s/live` is moved to `s/next/live` (making
`s/next/` like the site if missing, and removing a stale `next/live` first); a build still at the flat
`s.next` is removed. Then `s/prev/live` becomes `s/live` and is started. A build tree is never client
data, and the deploy that resumed the move rebuilds. If `s/prev/live` is missing, whatever reached `s/live`
(or the build at `s.next`, if nothing did) is served instead. Nothing is removed during a resume but a
build tree: never `prev/*`, `live` or `s/`.

**Refusing instead of deploying flat.** A folder that is neither shape is refused rather than deployed
flat, because a flat deploy would rename a folder hostd cannot read to `.prev`, and the deploy after that
would delete it. The cost is that such a site stops auto-deploying until the operator puts it right (the
RUNBOOK says how, including putting a test tree back from `prev/test`).

**Accepted residual.** A crash after the window's last rename and before its `up` leaves a disk that
cannot be told apart from a finished move whose registry write failed, so the `s/live` row starts whatever
is in `live`: here, the new build, unchecked. The deploy that resumed it swaps a checked build in straight
away (and a failed health check there rolls back to that same tree). Accepted, because nothing on disk
distinguishes the two cases and the window between the rename and the `up` is a second or two.

Resume goes forward only, never back: once `/var/www/s/` exists the nested layout is the true one.

The maintenance flag is cleared in the existing `finally`, so no way out of the window leaves the
holding page up.

## Shared repository lock

Nested environments share `git/`, so two concurrent deploys of one project (live and test, each already
serialised on its own key) could collide on git's own lock files. The agent holds a per-project mutex
around every fetcher call against a nested repository (`fetch`, `tip`, `checkout`, `repair`, `log`).
Builds and swaps are outside it and still run in parallel.

## Fetcher path check

`FETCH_DIR` in `fetch-protocol.ts` widens to exactly these shapes, with the same segment pattern as
today:

- `/var/www/<site>`
- `/var/www/<site>/git`
- `/var/www/<site>/{live,test}`
- `/var/www/<site>/{next,prev}/{live,test}`
- the flat `.git`, `.next` and `-test` siblings it already accepts

Anything else, including `..`, empty segments and deeper paths, is refused.

## Provisioning

- **Create.** `/var/www/<dir>` must not exist. The agent makes `/var/www/<dir>/`, owned like `/var/www`,
  and the fetcher clones into `/var/www/<dir>/live`. The registry entry is written nested, with no
  `composeName` (the default, the project id, is correct). The first deploy's `ensureRepo` moves
  `live/.git` to `git/.git`.
- **Add test, live nested.** Fetch the branch into `<site>/git`, add a worktree at `<site>/test`, then
  the env-file copy, resolve and registry write as today. If live has never deployed (its repository
  is still at `live/.git`), `ensureRepo` runs first.
- **Add test, live flat.** Unchanged: a separate clone at `/var/www/<dir>-test`.
- **Remove.** Unchanged: unregisters and leaves the folders.

## Side effects

- Backup snapshots taken after a site migrates record storage under `<site>/live/...`, so older
  snapshots show the old paths when browsed. Restic deduplicates by content, so there is no extra disk
  cost.
- The commit list (`agent.ts`) reads the repository through `deployTrees()`, so it follows the migration
  with no change of its own.

## Testing

All with `node --test` beside the source, using the existing fakes.

- `migrate-layout.test.ts` (the planner): each disk state in the resume table produces the right steps
  or refusal; a failure at each window step produces the right undo.
- `deploy.test.ts`: a flat live migrates in the window (the ordered renames, `up` in `live/`, then
  `set-layout` and `set-deployed`); a health failure after migrating swaps back on nested paths; test
  waits for live, then migrates into `<site>/test`, and its old clone is deleted only after the fetch
  into `git/` succeeded; a nested redeploy uses `next/<env>` and `prev/<env>`.
- `deploy-compose.test.ts`: `deployTrees` and `nestedTrees` for both layouts; `composeNameOf` with and
  without the key.
- `compose.test.ts`: `--project-name` is present in lifecycle and config argv.
- `registry.test.ts`, `registry-write.test.ts`, `fetch-protocol` tests: the new path shapes accepted and
  look-alikes refused; `composeName` defaults and uniqueness; `set-layout` round-trips.
- `provision.test.ts`: a new site is created nested; add-test on a nested live makes a worktree from
  `git/`.
- By hand on the dedi after merge: redeploy one low-stakes site first, then check `docker compose ls`,
  `docker volume ls` for its named volumes, and the site itself, before letting the rest migrate on
  their own next deploys.
