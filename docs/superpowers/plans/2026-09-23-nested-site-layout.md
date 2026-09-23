# Nested Site Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hostd keeps each site under one folder (`/var/www/<site>/{git,live,test,prev/<env>,next/<env>}`) and moves existing flat sites into it during their next deploy's swap window.

**Architecture:** A pure `shared/layout.ts` owns every path shape. The registry learns nested dirs and an explicit per-environment `composeName`, which every compose invocation now passes as `--project-name`. `deployTrees()` becomes layout aware, a new pure `agent/migrate-layout.ts` plans and runs the renames, and `runDeploy` calls it inside the existing maintenance window (and resumes an interrupted one at the start of the next deploy). Provisioning creates new sites nested. A per-repository lock on the fetcher client keeps two environments from running git in one shared repository at once.

**Tech Stack:** TypeScript on Node 22 (`node --import tsx --test`), `yaml`, Docker Compose, git worktrees. All work is in `hostd/`.

**Spec:** `docs/superpowers/specs/2026-09-23-nested-site-layout-design.md`

## Global Constraints

- Never use em dashes (U+2014) in docs, messages, commit messages or PR text. Code comments may use them, but match the surrounding comments, which do not. Check with Python, not a bash `$'\u2014'` grep.
- Every test runs with no Docker, no network and no filesystem: all effects go through injected deps, as the existing tests do.
- Run tests from `hostd/`: one file with `node --import tsx --test src/<path>.test.ts`, everything with `npm test`, types with `npm run typecheck`.
- Environment names stay `live` and `test` in this plan (piece 2 widens them).
- Storage directories stay inside the environment tree. Nothing in this plan moves them.
- Nothing is ever deleted before its replacement is in place, and a deploy never passes `-v` to compose.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviations from the spec, decided while planning

- **Kill switch.** `DeployDeps.migrateLayout` (default `false`) gates *starting* a migration. `index.ts` sets it from `HOSTD_MIGRATE_LAYOUT` (on unless `0`). Resuming an interrupted migration always runs. This keeps every existing deploy test unchanged and gives the operator an off switch on the dedi.
- **Shared repository at creation.** Instead of leaving `live/.git` for the first deploy to move, `createProject` moves it into `<site>/git/.git` straight after the clone. Adding test to a never-deployed site therefore always finds `git/`.
- **Old test clone cleanup.** Only `/var/www/<site>-test.git` is deleted after test migrates. A repository still inside the old tree now sits in `prev/test` and goes with it on the next deploy.
- **The repository lock** wraps the fetcher client per `dir` (every verb, flat repositories too) rather than living inside `deploy.ts`. It is simpler and harmless for flat repositories.

## File map

| File | Change |
| --- | --- |
| `hostd/src/shared/layout.ts` | **New.** Path shapes and helpers: flat and nested dirs, site root, fetcher dir pattern |
| `hostd/src/shared/formats.ts` | `COMPOSE_NAME` pattern |
| `hostd/src/shared/registry.ts` | Nested env dirs, `composeName`, `ProjectEntry.composeName`, cross-project checks |
| `hostd/src/shared/registry-write.ts` | `set-layout` change |
| `hostd/src/shared/fetch-protocol.ts` | `FETCH_DIR` from `layout.ts` |
| `hostd/src/agent/compose.ts` | `ComposeLocation.composeName`, `--project-name` in `composeBase` |
| `hostd/src/agent/backup-run.ts`, `hostd/src/agent/index.ts` | Pass `composeName` to compose |
| `hostd/src/agent/deploy-compose.ts` | Layout-aware `deployTrees`, `migrationTarget`, `composeNameOf` |
| `hostd/src/agent/fetch-lock.ts` | **New.** `serialisePerRepo(client)` |
| `hostd/src/agent/migrate-layout.ts` | **New.** `inspectLayout`, `windowSteps`, `resumeSteps`, `executeSteps` |
| `hostd/src/agent/deploy.ts` | Nested deploys, migration in the window, resume |
| `hostd/src/agent/provision.ts` | Nested create, nested add-test |
| `hostd/RUNBOOK.md` | Layout, migration, recovery |

---

### Task 1: Layout path shapes

**Files:**
- Create: `hostd/src/shared/layout.ts`
- Test: `hostd/src/shared/layout.test.ts`

**Interfaces:**
- Produces:
  - `FLAT_DIR: RegExp`, `NESTED_DIR: RegExp`, `FETCH_DIR: RegExp`
  - `isFlatDir(dir: string): boolean`, `isNestedDir(dir: string): boolean`
  - `siteOf(dir: string): string` (nested gives the parent, flat gives the dir itself)
  - `nestedEnvOf(dir: string): EnvironmentName | null`
  - `nestedDir(site: string, env: EnvironmentName): string`

- [ ] **Step 1: Write the failing test**

```ts
// hostd/src/shared/layout.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { FETCH_DIR, isFlatDir, isNestedDir, nestedDir, nestedEnvOf, siteOf } from './layout.ts'
import { ENVIRONMENTS } from './registry.ts'

describe('layout', () => {
    it('tells a flat dir from a nested one', () => {
        assert.equal(isFlatDir('/var/www/acme'), true)
        assert.equal(isNestedDir('/var/www/acme'), false)
        assert.equal(isNestedDir('/var/www/acme/live'), true)
        assert.equal(isNestedDir('/var/www/acme/test'), true)
        assert.equal(isFlatDir('/var/www/acme/live'), false)
    })

    it('refuses anything that is neither', () => {
        for (const dir of ['/var/www/acme/uat1', '/var/www/acme/git', '/var/www/acme/live/x', '/var/www/../etc', '/var/www/.hidden', '/etc/acme', '/var/www/acme/', '/var/www/acme/prev/live']) {
            assert.equal(isFlatDir(dir) || isNestedDir(dir), false, dir)
        }
    })

    it('finds the site root and environment', () => {
        assert.equal(siteOf('/var/www/acme/test'), '/var/www/acme')
        assert.equal(siteOf('/var/www/acme'), '/var/www/acme')
        assert.equal(nestedEnvOf('/var/www/acme/test'), 'test')
        assert.equal(nestedEnvOf('/var/www/acme'), null)
        assert.equal(nestedDir('/var/www/acme', 'live'), '/var/www/acme/live')
    })

    it('lets the fetcher reach exactly the shapes a deploy uses', () => {
        for (const dir of ['/var/www/b', '/var/www/b.git', '/var/www/b.next', '/var/www/b-test', '/var/www/b/git', '/var/www/b/live', '/var/www/b/test', '/var/www/b/next/live', '/var/www/b/prev/test']) {
            assert.equal(FETCH_DIR.test(dir), true, dir)
        }
        for (const dir of ['/var/www/b/uat1', '/var/www/b/next', '/var/www/b/git/x', '/var/www/b/next/live/x', '/var/www/b/../etc', '/var/www/b//live', '/etc/b']) {
            assert.equal(FETCH_DIR.test(dir), false, dir)
        }
    })

    it('knows every environment the registry does', () => {
        for (const env of ENVIRONMENTS) assert.equal(isNestedDir(`/var/www/acme/${env}`), true, env)
    })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/shared/layout.test.ts`
Expected: FAIL, cannot find module `./layout.ts`.

- [ ] **Step 3: Write the implementation**

```ts
// hostd/src/shared/layout.ts
// Every shape a site's folders can take under /var/www, in one place, so the registry, the fetcher's own
// path check and the deploy all agree on it. Flat is the layout every site had before nesting:
// /var/www/<site> beside /var/www/<site>.git, .prev and .next. Nested keeps them all under one folder:
// /var/www/<site>/{git, live, test, prev/<env>, next/<env>}.

import { posix } from 'node:path'
import type { EnvironmentName } from './registry.ts'

// One segment, and never one that starts with a dot: that alone rules out . and .. anywhere.
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}'
// Kept in step with ENVIRONMENTS in registry.ts; layout.test.ts fails if the two drift.
const ENV = '(?:live|test)'

export const FLAT_DIR = new RegExp(`^/var/www/${SEGMENT}$`)
export const NESTED_DIR = new RegExp(`^/var/www/${SEGMENT}/${ENV}$`)
// What the fetcher may be pointed at: a flat tree or one of its siblings (all one segment), or a
// nested site's repository, one of its environments, or one of their next and prev copies.
export const FETCH_DIR = new RegExp(`^/var/www/${SEGMENT}(?:/(?:git|${ENV}|(?:next|prev)/${ENV}))?$`)

export const isFlatDir = (dir: string): boolean => FLAT_DIR.test(dir)
export const isNestedDir = (dir: string): boolean => NESTED_DIR.test(dir)

export function siteOf(dir: string): string {
    return isNestedDir(dir) ? posix.dirname(dir) : dir
}

export function nestedEnvOf(dir: string): EnvironmentName | null {
    return isNestedDir(dir) ? posix.basename(dir) as EnvironmentName : null
}

export function nestedDir(site: string, env: EnvironmentName): string {
    return posix.join(site, env)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test src/shared/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/layout.ts hostd/src/shared/layout.test.ts
git commit -m "Add the flat and nested site path shapes to hostd"
```

---

### Task 2: Registry understands nested dirs and composeName

**Files:**
- Modify: `hostd/src/shared/formats.ts` (after `DIR_NAME`, line 9)
- Modify: `hostd/src/shared/registry.ts` (`EnvironmentEntry` :34-52, `ProjectEntry` :74-93, `ENVIRONMENT_KEYS` :135, `parseEnvironmentDir` :375, `parseEnvironment` :383-462, `parseEnvironments` :466-481, `parseProject` :484-578, `parseRegistry` cross checks :658-685)
- Test: `hostd/src/shared/registry.test.ts`

**Interfaces:**
- Consumes: `isFlatDir`, `isNestedDir`, `nestedEnvOf`, `siteOf` from Task 1
- Produces:
  - `EnvironmentEntry.composeName: string` (always resolved)
  - `ProjectEntry.composeName: string` (live's)
  - `COMPOSE_NAME: RegExp` in `formats.ts`

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/shared/registry.test.ts`:

```ts
function envProject(environments: string, id = 'acme'): string {
    return `projects:
  ${id}:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    environments:
${environments}`
}

describe('nested layout', () => {
    it('accepts nested dirs and defaults the compose names from the project id', () => {
        const registry = parseRegistry(envProject(`      live: { dir: /var/www/acme-site/live, port: 5010 }
      test: { dir: /var/www/acme-site/test, port: 5011 }
`))
        const project = registry.projects.get('acme')!
        assert.equal(project.environments.get('live')!.composeName, 'acme')
        assert.equal(project.environments.get('test')!.composeName, 'acme-test')
        assert.equal(project.composeName, 'acme')
        assert.equal(project.dir, '/var/www/acme-site/live')
    })

    it('defaults a flat dir to its own folder name, as compose always did', () => {
        const registry = parseRegistry(envProject(`      live: { dir: /var/www/acme, port: 5010 }
      test: { dir: /var/www/acme-test, port: 5011 }
`))
        assert.equal(registry.projects.get('acme')!.environments.get('test')!.composeName, 'acme-test')
    })

    it('takes an explicit composeName over the default', () => {
        const registry = parseRegistry(envProject(`      live: { dir: /var/www/acme/live, port: 5010, composeName: acme }
      test: { dir: /var/www/acme/test, port: 5011, composeName: acme-staging }
`))
        assert.equal(registry.projects.get('acme')!.environments.get('test')!.composeName, 'acme-staging')
    })

    it('refuses a malformed composeName', () => {
        const reason = parseRegistry(envProject(`      live: { dir: /var/www/acme/live, port: 5010, composeName: Acme! }
`)).invalid.get('acme')
        assert.match(reason ?? '', /composeName/)
    })

    it('refuses a nested dir under the wrong environment', () => {
        const reason = parseRegistry(envProject(`      live: { dir: /var/www/acme/test, port: 5010 }
`)).invalid.get('acme')
        assert.match(reason ?? '', /environments\.live\.dir/)
    })

    it('refuses nested environments of one project under two different sites', () => {
        const reason = parseRegistry(envProject(`      live: { dir: /var/www/acme/live, port: 5010 }
      test: { dir: /var/www/other/test, port: 5011 }
`)).invalid.get('acme')
        assert.match(reason ?? '', /same site/)
    })

    it('allows a flat test beside a nested live, which is what a migration passes through', () => {
        const registry = parseRegistry(envProject(`      live: { dir: /var/www/acme/live, port: 5010 }
      test: { dir: /var/www/acme-test, port: 5011 }
`))
        assert.ok(registry.projects.has('acme'))
    })

    it('refuses two environments of one project sharing a compose name', () => {
        const reason = parseRegistry(envProject(`      live: { dir: /var/www/acme/live, port: 5010 }
      test: { dir: /var/www/acme/test, port: 5011, composeName: acme }
`)).invalid.get('acme')
        assert.match(reason ?? '', /compose name acme/)
    })

    it('refuses two projects sharing a compose name or a site folder', () => {
        const text = `projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010 }
  other:
    client: cl_1
    name: Other
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme/live, port: 5020, composeName: other }
`
        const registry = parseRegistry(text)
        assert.match(registry.invalid.get('acme') ?? '', /site \/var\/www\/acme is also used by other/)
        assert.match(registry.invalid.get('other') ?? '', /site \/var\/www\/acme is also used by acme/)
    })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx --test src/shared/registry.test.ts`
Expected: FAIL on every new test (`composeName` is undefined, nested dirs refused).

- [ ] **Step 3: Add `COMPOSE_NAME` to formats.ts**

After `DIR_NAME` in `hostd/src/shared/formats.ts`:

```ts
// Docker Compose's own rule for a project name: lowercase letters, digits, dashes and underscores,
// starting with a letter or digit.
export const COMPOSE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
```

- [ ] **Step 4: Implement the registry changes**

In `hostd/src/shared/registry.ts`:

1. Imports: add `COMPOSE_NAME` to the `./formats.ts` import, and add
   `import { isFlatDir, isNestedDir, nestedEnvOf, siteOf } from './layout.ts'`.
2. `EnvironmentEntry`: add after `composePaths`:

```ts
    // The compose project name every compose call for this environment passes as --project-name. Written
    // explicitly by a layout migration, so a site keeps the name its containers and volumes already
    // carry; otherwise the folder name for a flat dir (what compose itself derived) and, for a nested
    // one, the project id for live and <id>-<env> for the rest.
    composeName: string
```

3. `ProjectEntry`: add `composeName: string` after `composePaths` (the live environment's, mirrored the same way `dir` is).
4. `ENVIRONMENT_KEYS`: add `'composeName'`.
5. Replace `parseEnvironmentDir`:

```ts
// A flat dir (/var/www/<site>, what every site had before nesting) or a nested one
// (/var/www/<site>/<environment>). Which environment a nested dir names is checked by the caller.
function parseEnvironmentDir(raw: unknown): string | null {
    return typeof raw === 'string' && (isFlatDir(raw) || isNestedDir(raw)) ? raw : null
}

function defaultComposeName(id: string, name: EnvironmentName, dir: string): string {
    if (!isNestedDir(dir)) return posix.basename(dir)
    return name === 'live' ? id : `${id}-${name}`
}
```

6. `parseEnvironment` takes the project id first: `function parseEnvironment(id: string, name: EnvironmentName, raw: unknown, rules: HostRules, problems: string[])`. Change the dir problem and add the nested and composeName checks right after `const dir = ...`:

```ts
    const dir = parseEnvironmentDir(raw.dir)
    if (!dir) problems.push(`${where}.dir must be /var/www/<site> or /var/www/<site>/${name}`)
    else if (isNestedDir(dir) && nestedEnvOf(dir) !== name) problems.push(`${where}.dir ${dir} is nested under another environment's name`)

    let composeName: string | null = null
    if (raw.composeName !== undefined) {
        if (typeof raw.composeName === 'string' && COMPOSE_NAME.test(raw.composeName)) composeName = raw.composeName
        else problems.push(`${where}.composeName must be lowercase letters, digits, - and _`)
    }
```

   and the return:

```ts
    if (!dir || port === null) return null
    return {
        name, dir, composePaths: compose.map(file => posix.join(dir, file)), composeName: composeName ?? defaultComposeName(id, name, dir),
        branch, domain, aliases, port, certificate, deployed, websockets, flexibleSsl,
    }
```

7. `parseEnvironments(id: string, raw, rules, problems)` passes `id` to `parseEnvironment`, and after the existing live/test checks adds:

```ts
    if (live && test) {
        if (live.composeName === test.composeName) problems.push(`environments live and test share compose name ${live.composeName}`)
        if (isNestedDir(live.dir) && isNestedDir(test.dir) && siteOf(live.dir) !== siteOf(test.dir)) {
            problems.push('environments live and test must be nested under the same site')
        }
    }
```

8. `parseProject`: call `parseEnvironments(id, raw.environments, rules, problems)`. In the legacy branch's synthesised live environment add `composeName: posix.basename(dir)`. Before the final return, read `const composeName = live?.composeName ?? null`, add `|| !composeName` to the guard condition, and add `composeName` to the returned entry after `composePaths`.
9. `parseRegistry` cross-project loop: inside `for (const env of entry.environments.values())`, after the port check:

```ts
            const sharingName = [...parsed.values()]
                .filter(other => other.id !== id && [...other.environments.values()].some(otherEnv => otherEnv.composeName === env.composeName))
                .map(other => other.id)
            if (sharingName.length > 0) messages.push(`compose name ${env.composeName} is also used by ${sharingName.join(', ')}`)

            // A flat /var/www/acme and a nested /var/www/acme/live are the same folder on disk, whichever
            // project wrote which: a migration of one would move the other's tree.
            const site = siteOf(env.dir)
            const sharingSite = [...parsed.values()]
                .filter(other => other.id !== id && [...other.environments.values()].some(otherEnv => siteOf(otherEnv.dir) === site))
                .map(other => other.id)
            if (sharingSite.length > 0) messages.push(`site ${site} is also used by ${sharingSite.join(', ')}`)
```

   Use a `Set` when building `messages` if the same message would repeat for live and test (join `[...new Set(messages)]`).

- [ ] **Step 5: Fix the compile fallout**

Run: `npm run typecheck`
Every object literal typed `EnvironmentEntry` or `ProjectEntry` now needs `composeName`. Add `composeName` equal to the value the entry's own dir implies (`posix.basename(dir)` for a flat dir). The known places are `provision.ts` (the `live` literal in `createProject`, the `test` literal in `addEnvironment`) and test fixtures. Fix each until typecheck is clean.

- [ ] **Step 6: Run the tests**

Run: `node --import tsx --test src/shared/registry.test.ts` then `npm test`
Expected: PASS. If an existing assertion checked the old `dir must be /var/www/<one segment>` text for an **environments** entry, update it to the new message. The legacy project-level `dir` check (registry.test.ts:192) keeps its message and must still pass unchanged.

- [ ] **Step 7: Commit**

```bash
git add hostd/src/shared hostd/src/agent
git commit -m "Let the hostd registry describe nested sites and compose names"
```

---

### Task 3: `set-layout` registry write

**Files:**
- Modify: `hostd/src/shared/registry-write.ts` (the `Change` union :63-89, the `switch` near :223)
- Test: `hostd/src/shared/registry-write.test.ts`

**Interfaces:**
- Consumes: Task 2's registry
- Produces: `Change` member `{ kind: 'set-layout', id: string, environment: EnvironmentName, dir: string, composeName: string }`

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/shared/registry-write.test.ts` (uses the file's existing `BASE` and `applyChange`):

```ts
describe('set-layout', () => {
    it('moves an environment to its nested dir and pins its compose name', () => {
        const result = applyChange(BASE, { kind: 'set-layout', id: 'acme', environment: 'live', dir: '/var/www/acme/live', composeName: 'acme' })
        assert.ok(result.ok)
        const live = parseRegistry(result.text).projects.get('acme')!.environments.get('live')!
        assert.equal(live.dir, '/var/www/acme/live')
        assert.equal(live.composeName, 'acme')
        assert.match(result.text, /composeName: acme/)
    })

    it('refuses an environment that does not exist', () => {
        assert.equal(applyChange(BASE, { kind: 'set-layout', id: 'acme', environment: 'test', dir: '/var/www/acme/test', composeName: 'acme-test' }).ok, false)
    })

    it('refuses a dir the registry would not load', () => {
        assert.equal(applyChange(BASE, { kind: 'set-layout', id: 'acme', environment: 'live', dir: '/var/www/acme/test', composeName: 'acme' }).ok, false)
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/shared/registry-write.test.ts`
Expected: FAIL (type error on the unknown kind, or `ok: false`).

- [ ] **Step 3: Implement**

Add to the `Change` union after `set-deployed`:

```ts
    // Written once per environment, by the deploy that moves it into the nested layout. Both keys at
    // once: the dir changes the folder compose would derive a name from, so the name it had is pinned
    // in the same write.
    | { kind: 'set-layout', id: string, environment: EnvironmentName, dir: string, composeName: string }
```

and to the switch after `case 'set-deployed'`:

```ts
        case 'set-layout':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            // No grammar check here, as set-branch: parseRegistry below is the one rule for both keys.
            doc.setIn(['projects', change.id, 'environments', change.environment, 'dir'], change.dir)
            doc.setIn(['projects', change.id, 'environments', change.environment, 'composeName'], change.composeName)
            return null
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test src/shared/registry-write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/registry-write.ts hostd/src/shared/registry-write.test.ts
git commit -m "Add a set-layout registry write for nested sites"
```

---

### Task 4: Fetcher accepts nested paths

**Files:**
- Modify: `hostd/src/shared/fetch-protocol.ts:9-10`
- Test: `hostd/src/shared/fetch-protocol.test.ts`

**Interfaces:**
- Consumes: `FETCH_DIR` from Task 1

- [ ] **Step 1: Write the failing test**

Append inside the existing top-level `describe` of `fetch-protocol.test.ts` (it already has `parseFetchRequest` and `refusalOf`):

```ts
    it('accepts a nested site repository, environment, and next or prev copy', () => {
        const fetched = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b/git', branch: 'main' }))
        assert.equal(fetched.ok, true)
        const checkout = parseFetchRequest(JSON.stringify({ verb: 'checkout', dir: '/var/www/b/git', worktree: '/var/www/b/next/live', commit: 'a1b2c3d' }))
        assert.equal(checkout.ok, true)
        const repair = parseFetchRequest(JSON.stringify({ verb: 'repair', dir: '/var/www/b/git', worktree: '/var/www/b/prev/test' }))
        assert.equal(repair.ok, true)
    })

    it('refuses anything deeper or wider than a nested site', () => {
        assert.match(refusalOf({ verb: 'fetch', dir: '/var/www/b/git/.git' })!, /dir/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b/git', worktree: '/var/www/b/uat1', commit: 'a1b2c3d' })!, /worktree/)
        assert.match(refusalOf({ verb: 'repair', dir: '/var/www/b/git', worktree: '/var/www/b/next' })!, /worktree/)
    })
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/shared/fetch-protocol.test.ts`
Expected: the first new test FAILS.

- [ ] **Step 3: Implement**

In `fetch-protocol.ts`, delete the local `FETCH_DIR` constant and its comment and import it instead:

```ts
// Every path the caller may hand Git: a flat tree or sibling, or a nested site's repository,
// environment, or next and prev copy (see layout.ts). Nothing else reaches Git.
import { FETCH_DIR } from './layout.ts'
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test src/shared/fetch-protocol.test.ts`
Expected: PASS, including every existing refusal.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/fetch-protocol.ts hostd/src/shared/fetch-protocol.test.ts
git commit -m "Let the hostd fetcher reach nested site folders"
```

---

### Task 5: Pass the compose project name on every invocation

**Files:**
- Modify: `hostd/src/agent/compose.ts:23-42`, `:225-240`
- Modify: `hostd/src/agent/backup-run.ts:133`, `:139`
- Modify: `hostd/src/agent/provision.ts` (`resolve` call :268 and its comment)
- Test: `hostd/src/agent/compose.test.ts`, `hostd/src/agent/provision.test.ts`

**Interfaces:**
- Consumes: `ProjectEntry.composeName` (Task 2)
- Produces:
  - `ComposeLocation = { dir: string, composePaths: string[], composeName: string }`
  - `composeBase(location)` starting `['compose', '--project-name', composeName, '--project-directory', dir, ...]`
  - `ProvisionAttempt.composeName: string`, handed to `deps.resolve` as `expectedName`

- [ ] **Step 1: Write the failing test**

Append to `hostd/src/agent/compose.test.ts` (import `lifecycleArgv` and `configArgv` if they are not imported yet, plus `parseRegistry`):

```ts
describe('compose project name', () => {
    const project = parseRegistry(`projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme/live, port: 5010 }
`).projects.get('acme')!

    it('is passed explicitly, so a nested folder called live never names the project', () => {
        assert.deepEqual(lifecycleArgv(project, 'stop').slice(0, 5), ['compose', '--project-name', 'acme', '--project-directory', '/var/www/acme/live'])
        assert.deepEqual(configArgv(project).slice(0, 3), ['compose', '--project-name', 'acme'])
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/agent/compose.test.ts`
Expected: FAIL (no `--project-name`).

- [ ] **Step 3: Implement**

In `compose.ts`:

```ts
export type ComposeLocation = { dir: string, composePaths: string[], composeName: string }

export function composeBase(project: ComposeLocation): string[] {
    // One -f per registered file, in the registry's order, because compose merges them left to right.
    // An explicit -f also stops compose loading docker-compose.override.yml on its own, so a site with
    // an override is only described correctly when the registry names it too. The project name is
    // always explicit: a nested site's folder is called live or test, which is no project's name.
    return [
        'compose', '--project-name', project.composeName, '--project-directory', project.dir,
        ...project.composePaths.flatMap(path => ['-f', path]),
    ]
}
```

In `resolveNewProject`, the name compose resolves is now always the one passed, so build the location with it: change the signature's first parameter to `location: { dir: string, composePaths: string[] }` and call `resolveCompose({ ...location, composeName: expectedName }, run)`. The `composeNameProblem` call stays: it now catches only `expectedName === collidesWith`, which is exactly the collision it exists for. Update the comment above `resolveNewProject` that says expectedName is the folder basename: it is the environment's compose name.

In `backup-run.ts` lines 133 and 139, pass `composeName: project.composeName` in both location literals.

In `provision.ts`: add `composeName: string` to `ProvisionAttempt` (comment: "The compose project name this environment will run under, checked by resolve before anything is registered"). Replace `deps.resolve(posix.basename(dir), ...)` with `deps.resolve(attempt.composeName, ...)` and rewrite the comment above it to say so. In `createProject` pass `composeName: posix.basename(dir)`. In `addEnvironment` pass `composeName: posix.basename(dir)` and `collidesWith: project.composeName`. (Task 10 changes both again for nested sites.)

- [ ] **Step 4: Typecheck and test**

Run: `npm run typecheck`, then `npm test`
Expected: clean and PASS. Any existing test asserting an exact compose argv (in `compose.test.ts`, `backup-run.test.ts`, `guard-tracker.test.ts`, `agent.test.ts`) gains `'--project-name', '<name>'` after `'compose'`. Update those expectations; do not change behaviour to satisfy them.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent
git commit -m "Pass the compose project name explicitly on every hostd compose call"
```

---

### Task 6: Layout-aware deploy trees

**Files:**
- Modify: `hostd/src/agent/deploy-compose.ts:15-45`
- Test: `hostd/src/agent/deploy-compose.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers, `EnvironmentEntry.composeName`
- Produces:
  - `DeployTrees = { dir, next, prev, repo, git, site: string | null }`. `site` is the nested parent, or `null` for flat.
  - `deployTrees(dir: string): DeployTrees`, unchanged signature
  - `migrationTarget(project: ProjectEntry, environment: EnvironmentEntry): DeployTrees | null`
  - `migratingOf(site: string): string`, which gives `${site}.migrating`
  - `composeNameOf(environment)`, which returns `environment.composeName`

- [ ] **Step 1: Write the failing tests**

Append to `hostd/src/agent/deploy-compose.test.ts` (import `parseRegistry` and the new names):

```ts
describe('deployTrees by layout', () => {
    it('keeps the flat siblings for a flat dir', () => {
        assert.deepEqual(deployTrees('/var/www/acme'), {
            dir: '/var/www/acme', next: '/var/www/acme.next', prev: '/var/www/acme.prev', repo: '/var/www/acme.git', git: '/var/www/acme/.git', site: null,
        })
    })

    it('puts everything under the site for a nested dir', () => {
        assert.deepEqual(deployTrees('/var/www/acme/test'), {
            dir: '/var/www/acme/test', next: '/var/www/acme/next/test', prev: '/var/www/acme/prev/test', repo: '/var/www/acme/git', git: '/var/www/acme/test/.git', site: '/var/www/acme',
        })
    })
})

describe('migrationTarget', () => {
    const registry = (live: string, test: string) => parseRegistry(`projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: ${live}, port: 5010 }
      test: { dir: ${test}, port: 5011 }
`).projects.get('acme')!

    it('sends a flat live under a site of its own folder name', () => {
        const project = registry('/var/www/acme', '/var/www/acme-test')
        assert.equal(migrationTarget(project, project.environments.get('live')!)!.dir, '/var/www/acme/live')
    })

    it('holds a flat test back until live is nested', () => {
        const project = registry('/var/www/acme', '/var/www/acme-test')
        assert.equal(migrationTarget(project, project.environments.get('test')!), null)
    })

    it('sends a flat test under live once live is nested', () => {
        const project = registry('/var/www/acme/live', '/var/www/acme-test')
        const target = migrationTarget(project, project.environments.get('test')!)!
        assert.equal(target.dir, '/var/www/acme/test')
        assert.equal(target.repo, '/var/www/acme/git')
    })

    it('has nothing to do for a nested environment', () => {
        const project = registry('/var/www/acme/live', '/var/www/acme/test')
        assert.equal(migrationTarget(project, project.environments.get('live')!), null)
    })

    it('uses the registry compose name, not the folder', () => {
        const project = registry('/var/www/acme/live', '/var/www/acme/test')
        assert.equal(composeNameOf(project.environments.get('test')!), 'acme-test')
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/agent/deploy-compose.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `deploy-compose.ts`, import `isNestedDir, siteOf, nestedDir` from `../shared/layout.ts` and `ProjectEntry` from the registry, then replace `DeployTrees`, `deployTrees` and `composeNameOf`:

```ts
export type DeployTrees = {
    dir: string
    next: string
    prev: string
    // Where the git repository lives once a deploy has moved it out of the tree, so renaming the tree
    // can never take the repository with it. Shared by every environment of a nested site.
    repo: string
    // The repository's original home, inside the tree, as a fresh clone leaves it.
    git: string
    // The folder a nested site keeps everything under, or null for a flat one.
    site: string | null
}

export function deployTrees(dir: string): DeployTrees {
    if (isNestedDir(dir)) {
        const site = siteOf(dir)
        const env = posix.basename(dir)
        return {
            dir, next: posix.join(site, 'next', env), prev: posix.join(site, 'prev', env),
            repo: posix.join(site, 'git'), git: posix.join(dir, '.git'), site,
        }
    }
    return { dir, next: `${dir}.next`, prev: `${dir}.prev`, repo: `${dir}.git`, git: posix.join(dir, '.git'), site: null }
}

// Where a flat environment goes when it is nested, or null when it is not to move (yet). Live goes
// under a site named after its own flat folder. Any other environment waits until live has moved,
// because until then /var/www/<site> is live's own tree and nothing can be put inside it.
export function migrationTarget(project: ProjectEntry, environment: EnvironmentEntry): DeployTrees | null {
    if (isNestedDir(environment.dir)) return null
    if (environment.name === 'live') return deployTrees(nestedDir(environment.dir, 'live'))
    const live = project.environments.get('live')
    if (!live || !isNestedDir(live.dir)) return null
    return deployTrees(nestedDir(siteOf(live.dir), environment.name))
}

// Where a flat live tree waits during its own migration, between leaving /var/www/<site> and
// arriving at /var/www/<site>/prev/live. The one moment the site's folder name is free to be made.
export const migratingOf = (site: string): string => `${site}.migrating`

// Pinned with --project-name on every deploy step, which is what lets a build in the next tree
// produce the images the swapped-in tree then starts.
export function composeNameOf(environment: EnvironmentEntry): string {
    return environment.composeName
}
```

Update the stale comment above the old `composeNameOf` accordingly. `repositoryIn` stays as it is.

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test src/agent/deploy-compose.test.ts`, then `npm test`
Expected: PASS. Existing tests comparing a whole `deployTrees(...)` object gain `site: null`.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/deploy-compose.ts hostd/src/agent/deploy-compose.test.ts
git commit -m "Make hostd's deploy trees follow a site's layout"
```

---

### Task 7: Serialise fetcher calls per repository

**Files:**
- Create: `hostd/src/agent/fetch-lock.ts`
- Test: `hostd/src/agent/fetch-lock.test.ts`
- Modify: `hostd/src/agent/index.ts` (where `fetcher` is constructed)

**Interfaces:**
- Consumes: `FetchClient` from `./fetch-client.ts` (`{ call(request: FetchRequest): Promise<FetchReply> }`)
- Produces: `serialisePerRepo(client: FetchClient): FetchClient`

- [ ] **Step 1: Write the failing test**

```ts
// hostd/src/agent/fetch-lock.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { serialisePerRepo } from './fetch-lock.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

function gated() {
    const order: string[] = []
    const releases: Array<() => void> = []
    const client = {
        call: (request: FetchRequest) => new Promise<FetchReply>(resolve => {
            const dir = 'dir' in request ? request.dir : '-'
            order.push(`start ${request.verb} ${dir}`)
            releases.push(() => { order.push(`end ${request.verb} ${dir}`); resolve({ ok: true }) })
        }),
    }
    return { client, order, releases }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

describe('serialisePerRepo', () => {
    it('runs one call at a time against one repository', async () => {
        const { client, order, releases } = gated()
        const locked = serialisePerRepo(client)
        const first = locked.call({ verb: 'fetch', dir: '/var/www/a/git', branch: 'main', credential: null })
        const second = locked.call({ verb: 'tip', dir: '/var/www/a/git', branch: 'dev' })
        await tick()
        assert.deepEqual(order, ['start fetch /var/www/a/git'])
        releases[0]!()
        await first
        await tick()
        assert.deepEqual(order, ['start fetch /var/www/a/git', 'end fetch /var/www/a/git', 'start tip /var/www/a/git'])
        releases[1]!()
        await second
    })

    it('lets two repositories run at once', async () => {
        const { client, order, releases } = gated()
        const locked = serialisePerRepo(client)
        const a = locked.call({ verb: 'fetch', dir: '/var/www/a/git', branch: 'main', credential: null })
        const b = locked.call({ verb: 'fetch', dir: '/var/www/b/git', branch: 'main', credential: null })
        await tick()
        assert.equal(order.length, 2)
        releases.forEach(release => release())
        await Promise.all([a, b])
    })

    it('does not let a failed call hold the lock', async () => {
        const client = { call: async (): Promise<FetchReply> => { throw new Error('socket closed') } }
        const locked = serialisePerRepo(client)
        await assert.rejects(locked.call({ verb: 'tip', dir: '/var/www/a/git', branch: 'main' }))
        await assert.rejects(locked.call({ verb: 'tip', dir: '/var/www/a/git', branch: 'main' }))
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/agent/fetch-lock.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// hostd/src/agent/fetch-lock.ts
// One git command at a time per repository. A nested site's environments share one repository, so a
// live deploy and a test deploy running together would otherwise collide on git's own lock files (a
// fetch updating refs while a worktree add reads them). Keyed by the request's dir, which is the
// repository for every verb that has one; a verb without a dir (branches, credentials) passes straight
// through. Flat repositories are locked the same way, which costs nothing, since one flat repository
// only ever had one environment using it.

import type { FetchClient } from './fetch-client.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

export function serialisePerRepo(client: FetchClient): FetchClient {
    const tails = new Map<string, Promise<unknown>>()
    return {
        call(request: FetchRequest): Promise<FetchReply> {
            if (!('dir' in request)) return client.call(request)
            const key = request.dir
            const before = tails.get(key) ?? Promise.resolve()
            const run = before.catch(() => {}).then(() => client.call(request))
            const tail = run.catch(() => {})
            tails.set(key, tail)
            void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
            return run
        },
    }
}
```

If `FetchClient` has members other than `call`, spread them through (`{ ...client, call }`), and check `fetch-client.ts` for its exact shape first.

- [ ] **Step 4: Wire it in**

In `hostd/src/agent/index.ts`, wrap the fetcher client where it is constructed so that provisioning, deploy, the poller and the agent all share the one wrapped instance: `const fetcher = serialisePerRepo(<existing construction>)`, with the import added.

- [ ] **Step 5: Run tests and typecheck**

Run: `node --import tsx --test src/agent/fetch-lock.test.ts`, `npm run typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/agent/fetch-lock.ts hostd/src/agent/fetch-lock.test.ts hostd/src/agent/index.ts
git commit -m "Run one git command at a time per repository in hostd"
```

---

### Task 8: Migration planner and executor

**Files:**
- Create: `hostd/src/agent/migrate-layout.ts`
- Test: `hostd/src/agent/migrate-layout.test.ts`

**Interfaces:**
- Consumes: `DeployTrees`, `migratingOf`, `repositoryIn` (Task 6), `DeployFs` from `./deploy.ts` (type-only import)
- Produces:
  - `type Step = { kind: 'move', from: string, to: string } | { kind: 'mkdir', dir: string, like: string }`
  - `type LayoutState = 'flat' | 'interrupted' | 'moved' | 'unknown'`
  - `inspectLayout(environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees, exists: (path: string) => Promise<boolean>): Promise<LayoutState>`
  - `windowSteps(environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees): Step[]`
  - `resumeSteps(from: DeployTrees, to: DeployTrees): Step[]` (live only)
  - `executeSteps(steps: Step[], fs: DeployFs, mode: 'window' | 'resume'): Promise<{ ok: true } | { ok: false, step: string, problem: string, undone: boolean }>`

The two directions:
- **live:** `from = deployTrees('/var/www/s')` and `to = deployTrees('/var/www/s/live')`
- **test:** `from = deployTrees('/var/www/s-test')` and `to = deployTrees('/var/www/s/test')`

- [ ] **Step 1: Write the failing tests**

```ts
// hostd/src/agent/migrate-layout.test.ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { executeSteps, inspectLayout, resumeSteps, windowSteps } from './migrate-layout.ts'
import { deployTrees } from './deploy-compose.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { DeployFs } from './deploy.ts'

const project = parseRegistry(`projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010 }
      test: { dir: /var/www/acme-test, port: 5011 }
`).projects.get('acme')!
const live = project.environments.get('live')!
const test = project.environments.get('test')!
const liveFrom = deployTrees('/var/www/acme')
const liveTo = deployTrees('/var/www/acme/live')
const testFrom = deployTrees('/var/www/acme-test')
const testTo = deployTrees('/var/www/acme/test')

function disk(paths: string[], failOn?: string) {
    const present = new Set(paths)
    const calls: string[] = []
    const fs = {
        exists: async (path: string) => present.has(path),
        mkdir: async (dir: string) => { calls.push(`mkdir ${dir}`); present.add(dir) },
        rmdir: async (dir: string) => { calls.push(`rmdir ${dir}`); present.delete(dir) },
        move: async (from: string, to: string) => {
            if (failOn === `${from} ${to}`) throw new Error('EXDEV')
            calls.push(`move ${from} ${to}`); present.delete(from); present.add(to)
        },
        owner: async () => ({ uid: 1000, gid: 1000, mode: 0o775 }),
        own: async (dir: string) => { calls.push(`own ${dir}`) },
    } as unknown as DeployFs
    return { fs, calls, present, exists: fs.exists }
}

describe('inspectLayout', () => {
    it('reads a flat live', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme', '/var/www/acme/docker-compose.yml']).exists), 'flat')
    })
    it('reads a live interrupted between leaving and arriving', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme.migrating']).exists), 'interrupted')
    })
    it('reads a live that moved but was never recorded', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme', '/var/www/acme/live', '/var/www/acme/git/.git']).exists), 'moved')
    })
    it('refuses to guess at a folder that is neither', async () => {
        assert.equal(await inspectLayout(live, liveFrom, liveTo, disk(['/var/www/acme']).exists), 'unknown')
    })
    it('reads a flat and a moved test', async () => {
        assert.equal(await inspectLayout(test, testFrom, testTo, disk(['/var/www/acme-test']).exists), 'flat')
        assert.equal(await inspectLayout(test, testFrom, testTo, disk(['/var/www/acme/test']).exists), 'moved')
        assert.equal(await inspectLayout(test, testFrom, testTo, disk(['/var/www/acme-test', '/var/www/acme/test']).exists), 'unknown')
    })
})

describe('windowSteps', () => {
    it('moves a live tree under its own name, build and repository included', () => {
        assert.deepEqual(windowSteps(live, liveFrom, liveTo), [
            { kind: 'move', from: '/var/www/acme', to: '/var/www/acme.migrating' },
            { kind: 'mkdir', dir: '/var/www/acme', like: '/var/www/acme.migrating' },
            { kind: 'mkdir', dir: '/var/www/acme/prev', like: '/var/www/acme.migrating' },
            { kind: 'move', from: '/var/www/acme.migrating', to: '/var/www/acme/prev/live' },
            { kind: 'move', from: '/var/www/acme.next', to: '/var/www/acme/live' },
            { kind: 'move', from: '/var/www/acme.git', to: '/var/www/acme/git' },
        ])
    })

    it('moves a test tree beside a nested live, from a build already in next/test', () => {
        assert.deepEqual(windowSteps(test, testFrom, testTo), [
            { kind: 'mkdir', dir: '/var/www/acme/prev', like: '/var/www/acme' },
            { kind: 'move', from: '/var/www/acme-test', to: '/var/www/acme/prev/test' },
            { kind: 'move', from: '/var/www/acme/next/test', to: '/var/www/acme/test' },
        ])
    })
})

describe('executeSteps', () => {
    it('runs every step and owns each folder it makes like its pattern', async () => {
        const { fs, calls } = disk(['/var/www/acme', '/var/www/acme.next', '/var/www/acme.git'])
        assert.deepEqual(await executeSteps(windowSteps(live, liveFrom, liveTo), fs, 'window'), { ok: true })
        assert.deepEqual(calls, [
            'move /var/www/acme /var/www/acme.migrating',
            'mkdir /var/www/acme', 'own /var/www/acme',
            'mkdir /var/www/acme/prev', 'own /var/www/acme/prev',
            'move /var/www/acme.migrating /var/www/acme/prev/live',
            'move /var/www/acme.next /var/www/acme/live',
            'move /var/www/acme.git /var/www/acme/git',
        ])
    })

    it('undoes what it did, in reverse, when a step fails', async () => {
        const { fs, calls, present } = disk(['/var/www/acme', '/var/www/acme.next', '/var/www/acme.git'], '/var/www/acme.next /var/www/acme/live')
        const result = await executeSteps(windowSteps(live, liveFrom, liveTo), fs, 'window')
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.undone, true)
        assert.match(!result.ok ? result.step : '', /acme\.next/)
        assert.deepEqual(calls.slice(-4), [
            'move /var/www/acme/prev/live /var/www/acme.migrating',
            'rmdir /var/www/acme/prev',
            'rmdir /var/www/acme',
            'move /var/www/acme.migrating /var/www/acme',
        ])
        assert.deepEqual([...present].sort(), ['/var/www/acme', '/var/www/acme.git', '/var/www/acme.next'])
    })

    it('skips a folder that is already there rather than making or owning it', async () => {
        const { fs, calls } = disk(['/var/www/acme', '/var/www/acme/prev', '/var/www/acme-test', '/var/www/acme/next/test'])
        await executeSteps(windowSteps(test, testFrom, testTo), fs, 'window')
        assert.equal(calls.includes('mkdir /var/www/acme/prev'), false)
    })

    it('finishes an interrupted live forward, skipping moves already done', async () => {
        const { fs, calls } = disk(['/var/www/acme.migrating', '/var/www/acme', '/var/www/acme/prev', '/var/www/acme/git'])
        assert.deepEqual(await executeSteps(resumeSteps(liveFrom, liveTo), fs, 'resume'), { ok: true })
        assert.deepEqual(calls, ['move /var/www/acme.migrating /var/www/acme/prev/live'])
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/agent/migrate-layout.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// hostd/src/agent/migrate-layout.ts
// Moving one environment from the flat layout (/var/www/<site> beside .git, .prev, .next) into the
// nested one (/var/www/<site>/{git, live, test, prev/<env>, next/<env>}). The planning is pure, a list
// of steps worked out from the two sets of trees; the executor is the only part that touches disk, and
// only through DeployFs. runDeploy calls it inside the maintenance window, between the down and the up,
// because Docker records a container's bind-mount paths when it creates it: renaming folders under a
// running container would leave it pointing at paths that no longer exist the next time the host
// restarted it.

import { posix } from 'node:path'

import type { EnvironmentEntry } from '../shared/registry.ts'
import { describeError } from '../shared/formats.ts'
import { migratingOf, repositoryIn, type DeployTrees } from './deploy-compose.ts'
import type { DeployFs } from './deploy.ts'

export type Step =
    | { kind: 'move', from: string, to: string }
    // Made only if missing, then given the ownership and mode `like` has, read at the time.
    | { kind: 'mkdir', dir: string, like: string }

export type LayoutState = 'flat' | 'interrupted' | 'moved' | 'unknown'

// What is on disk for an environment the registry still records as flat. `to` must be a nested set of
// trees (to.site is not null).
export async function inspectLayout(
    environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees, exists: (path: string) => Promise<boolean>,
): Promise<LayoutState> {
    const site = to.site!
    if (environment.name === 'live') {
        if (await exists(migratingOf(site))) return 'interrupted'
        if (await exists(to.dir) && await exists(repositoryIn(to))) return 'moved'
        // A flat tree is one compose can run: its first registered compose file is at its root.
        const compose = environment.composePaths[0]
        if (compose && await exists(compose)) return 'flat'
        return 'unknown'
    }
    const flat = await exists(from.dir)
    const nested = await exists(to.dir)
    if (flat && !nested) return 'flat'
    if (nested && !flat) return 'moved'
    return 'unknown'
}

// The renames inside the window. For live, the build is still in the flat <site>.next, because the
// site's own folder name is only free once live's tree has left it. For any other environment, live
// is already nested, so the build is in <site>/next/<env>, checked out from the shared repository.
export function windowSteps(environment: EnvironmentEntry, from: DeployTrees, to: DeployTrees): Step[] {
    const site = to.site!
    const prevParent = posix.dirname(to.prev)
    if (environment.name === 'live') {
        const migrating = migratingOf(site)
        return [
            { kind: 'move', from: from.dir, to: migrating },
            { kind: 'mkdir', dir: site, like: migrating },
            { kind: 'mkdir', dir: prevParent, like: migrating },
            { kind: 'move', from: migrating, to: to.prev },
            { kind: 'move', from: from.next, to: to.dir },
            { kind: 'move', from: from.repo, to: to.repo },
        ]
    }
    return [
        { kind: 'mkdir', dir: prevParent, like: site },
        { kind: 'move', from: from.dir, to: to.prev },
        { kind: 'move', from: to.next, to: to.dir },
    ]
}

// Live only: the window's steps after the first, for an agent that died between them. Run in 'resume'
// mode, which skips a move whose source is already gone.
export function resumeSteps(from: DeployTrees, to: DeployTrees): Step[] {
    const migrating = migratingOf(to.site!)
    return [
        { kind: 'mkdir', dir: to.site!, like: migrating },
        { kind: 'mkdir', dir: posix.dirname(to.prev), like: migrating },
        { kind: 'move', from: migrating, to: to.prev },
        { kind: 'move', from: from.next, to: to.dir },
        { kind: 'move', from: from.repo, to: to.repo },
    ]
}

const describeStep = (step: Step): string => step.kind === 'move' ? `move ${step.from} to ${step.to}` : `make ${step.dir}`

// In 'window' mode a failure undoes every completed step in reverse and says whether that worked; the
// caller then starts the flat tree again. In 'resume' mode there is nothing to undo to: the flat layout
// is already gone, so a failure is only reported, and the next deploy tries again.
export async function executeSteps(
    steps: Step[], fs: DeployFs, mode: 'window' | 'resume',
): Promise<{ ok: true } | { ok: false, step: string, problem: string, undone: boolean }> {
    const done: Step[] = []
    for (const step of steps) {
        try {
            if (step.kind === 'mkdir') {
                if (await fs.exists(step.dir)) continue
                const like = await fs.owner(step.like)
                await fs.mkdir(step.dir)
                done.push(step)
                await fs.own(step.dir, like)
            } else {
                if (mode === 'resume' && !(await fs.exists(step.from))) continue
                await fs.move(step.from, step.to)
                done.push(step)
            }
        } catch (error) {
            const problem = describeError(error)
            if (mode === 'resume') return { ok: false, step: describeStep(step), problem, undone: false }
            let undone = true
            for (const back of done.reverse()) {
                try {
                    if (back.kind === 'move') await fs.move(back.to, back.from)
                    else await fs.rmdir(back.dir)
                } catch {
                    undone = false
                }
            }
            return { ok: false, step: describeStep(step), problem, undone }
        }
    }
    return { ok: true }
}
```

Note on the undo order in the test: after `mkdir /var/www/acme` the undo removes `/var/www/acme/prev`, then `/var/www/acme`, then moves `.migrating` back, which is exactly the reverse of `done`. `rmdir` only ever runs on a folder this call made, after everything moved into it has moved back out.

- [ ] **Step 4: Run to verify it passes**

Run: `node --import tsx --test src/agent/migrate-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/migrate-layout.ts hostd/src/agent/migrate-layout.test.ts
git commit -m "Plan and run the move of a hostd site into the nested layout"
```

---

### Task 9: Deploys migrate, resume, and run nested

**Files:**
- Modify: `hostd/src/agent/deploy.ts` (`DeployDeps` :62-74, `currentTip` :137-155, `swapBack` :251-267, `runDeploy` :269-433)
- Test: `hostd/src/agent/deploy.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 6 and 8
- Produces:
  - `DeployDeps.migrateLayout?: boolean`
  - `export function sourceTrees(project, environment, deps): { trees: DeployTrees, target: DeployTrees | null }`

**Behaviour to implement:**

1. **`sourceTrees(project, environment, deps)`:**
   - `trees = deployTrees(environment.dir)`;
   - `target = deps.migrateLayout ? migrationTarget(project, environment) : null`.
   - It returns `{ trees, target }`.
   - The checkout and repository used for **fetch, tip, log and checkout** are `build = target && environment.name !== 'live' ? target : trees`. That is, a test waiting to migrate already builds from the shared repository.
   - `currentTip` uses `build.repo` and runs `ensureRepo(build)`.
2. **Nested parents.** Before the checkout, when `build.site` is set, make `posix.dirname(build.next)` and `posix.dirname(build.prev)` if missing (mkdir, then `own` like `build.site`). Reuse `executeSteps([{ kind: 'mkdir', ... }], deps.fs, 'window')`.
3. **Resume at the start.** Right after the `treesProblem` check, when the environment is flat and `migrationTarget(project, environment)` is not null (regardless of `migrateLayout`), call `inspectLayout`:
   - **`'unknown'`**: log `deploy <id> <env>: <site> is neither flat nor nested, so it is not being moved`, set `target = null`, and carry on flat.
   - **`'interrupted'`** (live only), with the maintenance flag up:
     1. run `executeSteps(resumeSteps(trees, to), fs, 'resume')`;
     2. if `to.dir` is still missing and `to.prev` exists, move `to.prev` to `to.dir`;
     3. `up` at `to.dir` with `composeNameOf(environment)`;
     4. clear the flag;
     5. then the same finish as `'moved'`.
   - **`'moved'`**:
     1. repair `to.dir` and `to.prev` (best effort);
     2. write `set-layout` with `dir: to.dir` and `composeName: environment.composeName`;
     3. `refreshRegistry()`;
     4. carry on with `environment` replaced by `{ ...environment, dir: to.dir, composePaths: locationIn(environment, to.dir).composePaths }`, `trees = to` and `target = null`.
   - If the resume's registry write fails, return `failed('migrated, but the registry could not be updated: <problem>')`.
4. **In the window**, replacing the two existing renames when `target` is set:
   1. delete `trees.prev` (old flat prev) and `target.prev` if they exist;
   2. `executeSteps(windowSteps(environment, trees, target), deps.fs, 'window')`;
   3. on failure, run `up` at `trees.dir` with the old location and return `fail(\`moving to ${target.site} failed at ${step}: ${problem}${undone ? '' : '; the undo did not finish either, so the next deploy completes the move'}\`)`;
   4. on success, the rest of the window works on `live = target` (up at `target.dir`, health, `swapBack(project, environment, target, name, deps)` on failure).
   
   With no target, keep today's code, with `live = trees`.
5. **`swapBack`:** the fake's `rolledBack` flag and the real code both use `trees.prev`, so it works for nested trees unchanged. Confirm it only uses `trees.*`.
6. **After the window:**
   1. repair `live.dir` from `live.repo`, and when migrated also `live.prev`;
   2. when migrated, write `set-layout` (`dir: target.dir`, `composeName: environment.composeName`) **before** `set-deployed`;
   3. on failure, return `record(commit, subject, 'failed', \`deployed and moved to ${target.site}, but the registry could not be updated: ${problem}\`)`;
   4. after a successful test migration, and only after `set-deployed` has also been written, `rmdir(trees.repo)` if it exists (the old `<site>-test.git`), best effort and logged.
   
   A rolled-back migrated deploy still writes `set-layout` (the tree is nested either way) but not `set-deployed`.

- [ ] **Step 1: Extend the test harness**

In `deploy.test.ts` `setup()`:
- add `migrateLayout?: boolean` to `SetupOptions` and pass it into `deps`;
- in the fake `move`, set `rolledBack = true` when `from.endsWith('.prev') || from.includes('/prev/')`;
- make the fake `move` carry children the way a real rename does: every path in `exists` equal to `from` or starting with `${from}/` is re-keyed under `to`. Without this, `/var/www/acme.git/.git` stays behind when `/var/www/acme.git` moves to `/var/www/acme/git`, and every nested test fails in `ensureRepo`;
- default `owners` to include `'/var/www/acme.migrating'` and `'/var/www/acme'`, both `{ uid: 1000, gid: 1000, mode: 0o775 }`.

Add fixtures:

```ts
const REGISTRY_YAML_TEST = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [deploy, env]
    environments:
      live:
        dir: /var/www/acme/live
        composeName: acme
        branch: main
        port: 5010
      test:
        dir: /var/www/acme-test
        branch: develop
        port: 5011
`
const REGISTRY_YAML_NESTED = REGISTRY_YAML_TEST.replace('dir: /var/www/acme-test', 'dir: /var/www/acme/test')
```

- [ ] **Step 2: Write the failing tests**

Add a `describe('nested layout', ...)` to `deploy.test.ts`. Use the file's existing way of reading the environment from `deps.registry()` and calling `runDeploy` with a manual request; mirror the neighbouring tests for exact call shapes.

```ts
describe('nested layout', () => {
    const manual = { trigger: 'manual' as const, actor: 'koda' }

    it('leaves a flat live alone while migration is switched off', async () => {
        const t = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        assert.ok(t.calls.includes('move /var/www/acme.next /var/www/acme'))
    })

    it('moves a flat live into the nested layout inside the window', async () => {
        const t = setup({ migrateLayout: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        const window = t.calls.slice(t.calls.indexOf('maintenance on'), t.calls.indexOf('maintenance off') + 1)
        assert.deepEqual(window.filter(call => call.startsWith('move') || call.startsWith('compose')), [
            'compose down',
            'move /var/www/acme /var/www/acme.migrating',
            'move /var/www/acme.migrating /var/www/acme/prev/live',
            'move /var/www/acme.next /var/www/acme/live',
            'move /var/www/acme.git /var/www/acme/git',
            'compose up',
        ])
        const live = t.deps.registry().projects.get('acme')!.environments.get('live')!
        assert.equal(live.dir, '/var/www/acme/live')
        assert.equal(live.composeName, 'acme')
        assert.equal(live.deployed, TIP)
        const upArgs = t.composeRuns.at(-1)!
        assert.deepEqual(upArgs.slice(0, 5), ['compose', '--project-name', 'acme', '--project-directory', '/var/www/acme/live'])
    })

    it('puts the flat tree back and starts it when a move fails', async () => {
        const t = setup({ migrateLayout: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'] })
        const move = t.deps.fs.move
        t.deps.fs.move = async (from, to) => { if (to === '/var/www/acme/live') throw new Error('EXDEV'); return move(from, to) }
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /moving to \/var\/www\/acme failed/)
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme')
        assert.ok(t.calls.includes('move /var/www/acme.migrating /var/www/acme'))
        assert.equal(t.calls.filter(call => call === 'compose up').length, 1)
    })

    it('swaps back on nested paths when the migrated tree is unhealthy, and stays nested', async () => {
        const t = setup({ migrateLayout: true, existsPaths: ['/var/www/acme/.git', '/var/www/acme/docker-compose.yml'], containerState: { state: 'exited' } })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.ok(t.calls.includes('move /var/www/acme/live /var/www/acme/next/live'))
        assert.ok(t.calls.includes('move /var/www/acme/prev/live /var/www/acme/live'))
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
    })

    it('finishes an interrupted migration before deploying', async () => {
        const t = setup({ existsPaths: ['/var/www/acme.migrating', '/var/www/acme.next', '/var/www/acme.git', '/var/www/acme.git/.git'] })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('live')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        assert.ok(t.calls.includes('move /var/www/acme.migrating /var/www/acme/prev/live'))
        assert.equal(t.deps.registry().projects.get('acme')!.environments.get('live')!.dir, '/var/www/acme/live')
        assert.ok(t.fetchRequests.some(request => request.verb === 'checkout' && request.worktree === '/var/www/acme/next/live'))
    })

    it('builds a waiting test from the shared repository, then moves it beside live', async () => {
        const t = setup({
            migrateLayout: true, registryYaml: REGISTRY_YAML_TEST,
            existsPaths: ['/var/www/acme', '/var/www/acme/git/.git', '/var/www/acme/live', '/var/www/acme-test', '/var/www/acme-test.git', '/var/www/acme-test.git/.git'],
            owners: { '/var/www/acme': { uid: 1000, gid: 1000, mode: 0o775 }, '/var/www/acme-test': { uid: 1000, gid: 1000, mode: 0o775 } },
            envTree: { '/var/www/acme-test/.env': 'X=1\n' },
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('test')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        assert.ok(t.fetchRequests.every(request => !('dir' in request) || request.dir === '/var/www/acme/git'))
        assert.ok(t.calls.includes('move /var/www/acme-test /var/www/acme/prev/test'))
        assert.ok(t.calls.includes('move /var/www/acme/next/test /var/www/acme/test'))
        const testEnv = t.deps.registry().projects.get('acme')!.environments.get('test')!
        assert.equal(testEnv.dir, '/var/www/acme/test')
        assert.equal(testEnv.composeName, 'acme-test')
        assert.ok(t.calls.indexOf('rmdir /var/www/acme-test.git') > t.calls.lastIndexOf('registry-write'))
    })

    it('deploys a nested environment through next/<env> and prev/<env>', async () => {
        const t = setup({
            registryYaml: REGISTRY_YAML_NESTED,
            existsPaths: ['/var/www/acme', '/var/www/acme/git/.git', '/var/www/acme/test'],
            owners: { '/var/www/acme': { uid: 1000, gid: 1000, mode: 0o775 }, '/var/www/acme/test': { uid: 1000, gid: 1000, mode: 0o775 } },
            envTree: { '/var/www/acme/test/.env': 'X=1\n' },
        })
        const project = t.deps.registry().projects.get('acme')!
        const record = await runDeploy(project, project.environments.get('test')!, manual, t.deps)
        assert.equal(record.outcome, 'ok')
        assert.ok(t.calls.includes('mkdir /var/www/acme/next'))
        assert.ok(t.calls.includes('move /var/www/acme/test /var/www/acme/prev/test'))
        assert.ok(t.calls.includes('move /var/www/acme/next/test /var/www/acme/test'))
    })
})
```

Adjust fixture paths if `setup()` needs anything more for a given test (for example a `.env` in the tree), but do not weaken what each test asserts.

- [ ] **Step 3: Run to verify failure**

Run: `node --import tsx --test src/agent/deploy.test.ts`
Expected: the new tests FAIL, and every existing test still passes.

- [ ] **Step 4: Implement the behaviour above in `deploy.ts`**

Add `migrateLayout?: boolean` to `DeployDeps` with the comment "Whether a deploy may start moving a flat environment into the nested layout. Resuming a move already under way always runs. On in production unless HOSTD_MIGRATE_LAYOUT=0 (see index.ts)."

Keep every existing comment about ordering true. Where a comment names `<dir>.next`/`<dir>.prev` generically, add that the nested equivalents are `next/<env>`/`prev/<env>`. Update the file's header comment to describe both layouts.

- [ ] **Step 5: Run tests and typecheck**

Run: `node --import tsx --test src/agent/deploy.test.ts`, then `npm test` and `npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/agent/deploy.ts hostd/src/agent/deploy.test.ts
git commit -m "Move hostd sites into the nested layout during their deploy window"
```

---

### Task 10: Provision new sites nested

**Files:**
- Modify: `hostd/src/agent/provision.ts` (`ProvisionDeps` :40-68, `ProvisionAttempt` :178-207, `provisionOnDisk` :213-297, `createProject` :299-360, `addEnvironment` :362-433)
- Modify: `hostd/src/agent/index.ts` (the provision deps literal around :200-214)
- Test: `hostd/src/agent/provision.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5 and 6
- Produces:
  - `ProvisionDeps.move(from: string, to: string): Promise<void>`
  - `ProvisionAttempt.root: string` (the folder `mkdir` makes and a rollback removes)
  - `ProvisionAttempt.source: { kind: 'clone' } | { kind: 'worktree', repo: string }`

**Behaviour:**

`provisionOnDisk`:
- `mkdir(attempt.root)`, then, if `dir !== root`, `mkdir(dir)` (clone only). A rollback removes `root`.
- For `source.kind === 'clone'`: clone into `dir` as today. Then, when `root !== dir`, split the repository out:
  1. `mkdir(posix.join(root, 'git'))`;
  2. `move(posix.join(dir, '.git'), posix.join(root, 'git', '.git'))`;
  3. log `provision <id>: moved the git repository to <root>/git`.
- For `source.kind === 'worktree'`: run three fetcher calls against `source.repo` and roll back on any failure:
  1. `fetch` (branch, `project.credential`);
  2. `tip` (branch);
  3. `checkout` with `worktree: dir` and the tip commit.
  
  No `mkdir(dir)` first, because git makes the folder itself. In this case `root === dir`.
- `own(root, like)` replaces `own(dir, like)`.

`createProject`:
- `site = /var/www/${args.dir ?? args.id}`, `dir = ${site}/live`, `root = site`;
- refuse if `site` exists (message unchanged: `${site} already exists`);
- `composeName: args.id`; `likeDir: '/var/www'`; `source: { kind: 'clone' }`;
- the `live` literal uses `dir` and `composeName: args.id`.

`addEnvironment`:
- if `isNestedDir(project.dir)`:
  - `site = siteOf(project.dir)`, `dir = ${site}/test`, `root = dir`;
  - refuse `unavailable` with `${site}/git has no repository to add test from` when `!(await deps.exists(`${site}/git/.git`))`;
  - `source: { kind: 'worktree', repo: `${site}/git` }`, `composeName: `${project.id}-test``, `likeDir: site`.
- otherwise keep today's flat behaviour (`${project.dir}-test`, a clone, `composeName: posix.basename(dir)`, `root = dir`).
- `collidesWith: project.composeName` in both cases.

In `index.ts`, add `move: (from, to) => rename(from, to)` to the provision deps, and change `mkdir: dir => mkdir(dir)` so it stays non-recursive (unchanged).

- [ ] **Step 1: Write the failing tests**

Add to `provision.test.ts`, using that file's existing factory and fakes. Extend its fake deps with `move` recording `move <from> <to>` the same way `mkdir` is recorded.

```ts
describe('nested sites', () => {
    it('creates a new site nested, with its repository split out beside live', async () => {
        // use the file's existing create fixture/args; only the paths below are new
        const { deps, calls } = provisionSetup()
        const reply = await createProject({ ...CREATE_ARGS, id: 'acme' }, deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(calls.filter(call => /^(mkdir|move|clone)/.test(call)), [
            'mkdir /var/www/acme',
            'mkdir /var/www/acme/live',
            'clone /var/www/acme/live',
            'mkdir /var/www/acme/git',
            'move /var/www/acme/live/.git /var/www/acme/git/.git',
        ])
        const live = deps.registry().projects.get('acme')!.environments.get('live')!
        assert.equal(live.dir, '/var/www/acme/live')
        assert.equal(live.composeName, 'acme')
    })

    it('removes the whole site folder when a create fails', async () => {
        const { deps, calls } = provisionSetup({ cloneFails: true })
        await createProject({ ...CREATE_ARGS, id: 'acme' }, deps)
        assert.ok(calls.includes('rmdir /var/www/acme'))
    })

    it('adds test to a nested site as a worktree of the shared repository', async () => {
        const { deps, calls, fetchRequests } = provisionSetup({ registryYaml: NESTED_LIVE_YAML, existsPaths: ['/var/www/acme/git/.git'] })
        const project = deps.registry().projects.get('acme')!
        const reply = await addEnvironment(project, { branch: 'develop', domain: null, certificate: null }, deps)
        assert.equal(reply.ok, true)
        assert.equal(calls.some(call => call.startsWith('clone')), false)
        assert.deepEqual(fetchRequests.map(request => request.verb), ['fetch', 'tip', 'checkout'])
        assert.ok(fetchRequests.some(request => request.verb === 'checkout' && request.worktree === '/var/www/acme/test' && request.dir === '/var/www/acme/git'))
        assert.equal(deps.registry().projects.get('acme')!.environments.get('test')!.composeName, 'acme-test')
    })

    it('refuses to add test to a nested site with no shared repository', async () => {
        const { deps } = provisionSetup({ registryYaml: NESTED_LIVE_YAML, existsPaths: [] })
        const project = deps.registry().projects.get('acme')!
        const reply = await addEnvironment(project, { branch: 'develop', domain: null, certificate: null }, deps)
        assert.equal(reply.ok, false)
    })
})
```

Rename `provisionSetup`, `CREATE_ARGS`, `cloneFails` and the fetch recording to whatever `provision.test.ts` already calls its factory, create args and failure switch. Add `NESTED_LIVE_YAML` (an `acme` project with `repo`, `live: { dir: /var/www/acme/live, port: 5010 }`, `capabilities: [provision]` and whatever the existing add-environment fixture has) beside the existing fixtures. Update existing create tests that asserted the flat `/var/www/<id>` clone path to the nested one: that change is the point of this task.

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/agent/provision.test.ts`
Expected: the new tests FAIL.

- [ ] **Step 3: Implement the behaviour above**

- [ ] **Step 4: Run tests and typecheck**

Run: `node --import tsx --test src/agent/provision.test.ts`, then `npm test` and `npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/provision.ts hostd/src/agent/provision.test.ts hostd/src/agent/index.ts
git commit -m "Create new hostd sites in the nested layout"
```

---

### Task 11: Switch it on, and document it

**Files:**
- Modify: `hostd/src/agent/index.ts` (the `deployDeps` literal around :217-248)
- Modify: `hostd/RUNBOOK.md`
- Modify: `hostd/docker-compose.yml` only if the agent's environment is listed there explicitly (check first)

- [ ] **Step 1: Wire the switch**

In `deployDeps` add:

```ts
        // On unless the operator sets HOSTD_MIGRATE_LAYOUT=0: the way to stop sites moving into the
        // nested layout on their next deploy without a release. A move already under way always finishes.
        migrateLayout: process.env.HOSTD_MIGRATE_LAYOUT !== '0',
```

- [ ] **Step 2: Update the RUNBOOK**

In `hostd/RUNBOOK.md`:

1. Wherever the flat siblings (`<dir>.git`, `<dir>.prev`, `<dir>.next`, `<dir>-test`) are described, add the nested layout table from the spec's "Layout" section, and say that sites move on their next deploy (a redeploy from the portal moves one on demand).
2. Add a "Moving a site into the nested layout" section covering:
   - what happens in the window;
   - `HOSTD_MIGRATE_LAYOUT=0` to pause it;
   - how to recognise each interrupted state on disk (`<site>.migrating`, a nested folder with the registry still flat) and that the next deploy finishes it;
   - the refusal `<site> is neither flat nor nested`, and what to look at.
3. Add a note that compose must always be run with `-p <composeName>` by hand in a nested site, because the folder is named `live` or `test`. For example `docker compose -p acme --project-directory /var/www/acme/live ps`.
4. In the section about cleaning up after `provision remove`, list the nested folder as one thing to delete.
5. Where backups mention storage paths, note that snapshots after a move record `<site>/live/...`.

Check the file for em dashes with Python before committing:

```bash
python -c "import sys;t=open('hostd/RUNBOOK.md',encoding='utf-8').read();print('emdash' if '\u2014' in t else 'clean')"
```

Expected: `clean`.

- [ ] **Step 3: Full verification**

Run: `npm test` and `npm run typecheck` in `hostd/`
Expected: every test passes, no type errors. Paste the summary line of the test run into the PR description.

- [ ] **Step 4: Commit**

```bash
git add hostd/src/agent/index.ts hostd/RUNBOOK.md
git commit -m "Turn on the nested layout move in hostd and document it"
```

---

## After merge (by hand, on the dedi)

1. Redeploy one low-stakes site from the portal (arbysauto).
2. On the dedi, check each of these:
   - `ls /var/www/arbysauto` shows `git live prev`;
   - `docker compose ls` still lists `arbysauto`;
   - `docker volume ls | grep arbysauto` shows the same volumes as before;
   - the site loads.
3. Only then let the rest move on their own next deploys, or redeploy them one at a time.
4. If anything looks wrong, set `HOSTD_MIGRATE_LAYOUT=0` for the agent and restart it; already nested sites keep working.
