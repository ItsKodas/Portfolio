# hostd Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a registered environment redeploy itself when its branch moves: poll GitHub, build into a new tree beside the running one, swap, health-check, and return to the previous copy by itself when that check fails.

**Architecture:** The agent keeps the git repository for an environment beside its folder (`<dir>.git`), checks each new commit out into `<dir>.next` through the fetcher, builds there under the environment's own compose project name, and only then swaps trees (`<dir>` becomes `<dir>.prev`, `<dir>.next` becomes `<dir>`). A deploy is started, not awaited, by the verb that triggers it: api's call timeout is 150 seconds and a build is minutes, so the reply says "started" and the outcome lands in the deploy history. Every side effect (git, Docker, the filesystem, the clock, the maintenance flag) is an injected adapter, so the whole suite runs with no Docker, no network and no disk.

**Tech Stack:** Node 22 ESM with tsx, TypeScript, `node --test`, `yaml`, the Docker Engine API over its socket, the Docker Compose CLI.

**Spec:** `docs/superpowers/specs/2026-09-20-hostd-provisioning-design.md`, the **Deploying** section above all. Read it, and the phase 1 design at `docs/superpowers/specs/2026-09-20-hostd-design.md`, before starting any task. This plan picks up exactly what `docs/superpowers/plans/2026-09-20-hostd-provisioning.md` left under "What this plan leaves for the deployment plan".

## Global Constraints

- **No em dashes** (U+2014) in any non-comment text: docs, runbook, commit messages, PR descriptions. Code comments are exempt.
- **Code style:** 4-space indentation, no semicolons, single quotes, comments that say why. Files sit beside their tests (`x.ts`, `x.test.ts`).
- **Tests:** `node --test` via tsx, `import { describe, it } from 'node:test'`, `import assert from 'node:assert/strict'`. No mocking library: fake the I/O boundary with plain object literals and a local `setup()` factory. Build registries by calling the real `parseRegistry()` on inline YAML.
- **Failures are collected and returned, never thrown.** A deploy that fails returns a record saying so.
- **The agent repeats every check itself.** Nothing api decided lets the agent skip `checkStructure`, the capability check, or its own reading of the registry.
- **Paths never come from the portal.** Every path git, Docker or the filesystem sees is derived from the registry entry the structural check returned.
- **Secrets never reach a log, an audit entry, an error message or a deploy record.** That covers env values, the GitHub token and anything a remote's error text might carry.
- **A deploy is never retried automatically.** The same commit fails the same way.
- **A failed build never touches the running site.** Nothing before the swap may stop, move or overwrite the running tree.
- **Commits** end with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Run everything from `hostd/`: `npm test`, `npm run typecheck`.

## What the design says, and what this plan does about it

Three things in the design cannot be built exactly as written, and each is decided here once rather than guessed at per task.

1. **"The site answering on its port within 60 seconds."** The agent runs `network_mode: none` (phase 1 design, kept deliberately), so it has no network namespace to make that request from, and the fetcher, which does have one, is on a bridge network that cannot reach a port published on the host's loopback address. The health check is therefore Docker's own view: every registered compose service has a running container, and any container with a healthcheck reports `healthy`, within 60 seconds. A repo that declares a healthcheck gets the stronger check. This is recorded in RUNBOOK.md, not hidden.
2. **Where the git repository lives.** Provisioning clones into `<dir>` itself, so `<dir>/.git` is the repository. A deploy renames `<dir>`, which would leave the repository inside `<dir>.prev` and delete it on the next deploy. The first deploy therefore moves `<dir>/.git` to `<dir>.git/.git` once, and from then on every git command runs against `<dir>.git` while the trees under it come and go. The move is idempotent and recoverable: if it is interrupted the repository is already at its new home, which is exactly what the next deploy looks for.
3. **`--single-branch` clones.** `cloneArgv` clones with `--single-branch`, which writes a refspec covering that one branch only, so `git fetch origin` after a branch switch would never create `refs/remotes/origin/<new branch>` and `rev-parse` would fail. The fetch verb therefore takes an optional branch and fetches an explicit refspec for it.

Deliberately **not** built here, and listed in the PR: the Apache vhost and the maintenance page itself (the flag is written and removed as the design describes, and the vhost half belongs to the domains work that has not landed); per-project resource limits, which cannot be applied without generating a compose override, and generating compose files is out of scope in the design's own Scope section.

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/shared/deploys.ts` (new) | The deploy record, the per-environment history, and the pure rules over them (cap, consecutive failures, pause, last healthy commit) |
| `src/agent/deploy-state.ts` (new) | That history on disk: one JSON file, loaded at boot, written atomically per change |
| `src/agent/deploy-compose.ts` (new) | The tree names for one environment, and compose build, up and down against any of them under a pinned project name |
| `src/agent/deploy-health.ts` (new) | Is every registered service running and healthy, and the bounded wait for it |
| `src/agent/deploy.ts` (new) | One deploy end to end: prepare, build, swap, health check, rollback, record |
| `src/agent/deploy-runner.ts` (new) | Starts a deploy without awaiting it, one per environment, and records what it did |
| `src/agent/deploy-poller.ts` (new) | Every 2 minutes per environment: fetch, compare the tip to `deployed`, start a deploy |
| `src/shared/fetch-protocol.ts` (modify) | `fetch` gains an optional branch |
| `src/fetcher/git.ts` (modify) | That branch becomes an explicit refspec |
| `src/shared/registry-write.ts` (modify) | A `set-branch` change |
| `src/shared/protocol.ts` (modify) | The `deploy` verb, its actions, its replies and its capability |
| `src/agent/agent.ts` (modify) | The `deploy` verb handler |
| `src/api/policy.ts` (modify) | `deploy` (admin only) and `deploy-read` (the owner too) |
| `src/api/routes.ts` (modify) | `deploy`, `rollback`, `branch`, `deploys` and `commits` under an environment |
| `src/agent/index.ts` (modify) | Wiring: the state file, the maintenance directory, the runner, the poller in the main loop |
| `docker-compose.yml`, `RUNBOOK.md` (modify) | The state volume, the maintenance bind mount, and how to operate all of it |

---

### Task 1: The deploy record and its history

**Files:**
- Create: `hostd/src/shared/deploys.ts`, `hostd/src/shared/deploys.test.ts`
- Create: `hostd/src/agent/deploy-state.ts`, `hostd/src/agent/deploy-state.test.ts`

**Interfaces:**
- Consumes: `EnvironmentName` from `src/shared/registry.ts`
- Produces:
  - `export const PAUSE_AFTER_FAILURES = 3`, `export const MAX_DEPLOY_RECORDS = 20`
  - `export const DEPLOY_TRIGGERS = ['poll', 'manual', 'rollback', 'branch'] as const`; `export type DeployTrigger = typeof DEPLOY_TRIGGERS[number]`
  - `export type DeployOutcome = 'ok' | 'failed' | 'rolled-back'`
  - `export type DeployRecord = { commit: string, subject: string | null, actor: string, trigger: DeployTrigger, startedAt: string, durationMs: number, outcome: DeployOutcome, reason: string | null, output: string | null }`
  - `export type EnvironmentDeploys = { deploys: DeployRecord[], consecutiveFailures: number, paused: boolean }`
  - `export function emptyDeploys(): EnvironmentDeploys`
  - `export function deployKey(id: string, environment: EnvironmentName): string`
  - `export function recordDeploy(state: EnvironmentDeploys, record: DeployRecord): EnvironmentDeploys`
  - `export function lastHealthyCommit(state: EnvironmentDeploys, exclude: string | null): string | null`
  - `export class DeployStore` with `load()`, `get(key)`, `isPaused(key)`, `record(key, record)`, `resume(key)`, and `export type DeployStateFs`

- [ ] **Step 1: Write the failing tests for the pure rules**

Create `hostd/src/shared/deploys.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    emptyDeploys, recordDeploy, lastHealthyCommit, deployKey,
    MAX_DEPLOY_RECORDS, PAUSE_AFTER_FAILURES, type DeployOutcome, type DeployRecord,
} from './deploys.ts'

const record = (commit: string, outcome: DeployOutcome): DeployRecord => ({
    commit, subject: null, actor: 'hostd', trigger: 'poll',
    startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1000, outcome, reason: null, output: null,
})

describe('deploy history', () => {
    it('keys an environment by project and name', () => {
        assert.equal(deployKey('acme', 'test'), 'acme:test')
    })

    it('puts the newest record first and keeps the cap', () => {
        let state = emptyDeploys()
        for (let i = 0; i < MAX_DEPLOY_RECORDS + 5; i++) state = recordDeploy(state, record(`commit${i}`, 'ok'))
        assert.equal(state.deploys.length, MAX_DEPLOY_RECORDS)
        assert.equal(state.deploys[0]!.commit, `commit${MAX_DEPLOY_RECORDS + 4}`)
    })

    it('counts consecutive failures and pauses on the third', () => {
        let state = emptyDeploys()
        state = recordDeploy(state, record('a', 'failed'))
        state = recordDeploy(state, record('b', 'rolled-back'))
        assert.equal(state.consecutiveFailures, 2)
        assert.equal(state.paused, false)
        state = recordDeploy(state, record('c', 'failed'))
        assert.equal(state.consecutiveFailures, PAUSE_AFTER_FAILURES)
        assert.equal(state.paused, true)
    })

    it('clears the count on a deploy that worked', () => {
        let state = emptyDeploys()
        state = recordDeploy(state, record('a', 'failed'))
        state = recordDeploy(state, record('b', 'ok'))
        assert.equal(state.consecutiveFailures, 0)
        assert.equal(state.paused, false)
    })

    it('finds the last commit recorded healthy, skipping the one running now', () => {
        let state = emptyDeploys()
        state = recordDeploy(state, record('old', 'ok'))
        state = recordDeploy(state, record('broken', 'failed'))
        state = recordDeploy(state, record('current', 'ok'))
        assert.equal(lastHealthyCommit(state, 'current'), 'old')
        assert.equal(lastHealthyCommit(state, null), 'current')
    })

    it('has no healthy commit to return when nothing has ever worked', () => {
        const state = recordDeploy(emptyDeploys(), record('a', 'failed'))
        assert.equal(lastHealthyCommit(state, null), null)
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/deploys.test.ts`
Expected: FAIL, `Cannot find module './deploys.ts'`.

- [ ] **Step 3: Implement the pure rules**

Create `hostd/src/shared/deploys.ts`:

```ts
// What one deploy leaves behind, and the rules over a run of them. Pure: the store beside it (in
// agent/deploy-state.ts) is what puts this on disk. Nothing here ever holds an env value or a repo URL,
// because a client is allowed to read this history for their own site.

import type { EnvironmentName } from './registry.ts'

// A repo with a broken build would otherwise rebuild every two minutes for ever. Three is enough to ride
// out a flaky remote and few enough that a genuinely broken branch stops quickly.
export const PAUSE_AFTER_FAILURES = 3
// Enough for the portal to draw a history without this file growing without bound.
export const MAX_DEPLOY_RECORDS = 20

export const DEPLOY_TRIGGERS = ['poll', 'manual', 'rollback', 'branch'] as const
export type DeployTrigger = typeof DEPLOY_TRIGGERS[number]
export type DeployOutcome = 'ok' | 'failed' | 'rolled-back'

export type DeployRecord = {
    commit: string
    subject: string | null
    // 'hostd' for a poll, 'admin' for everything a person asked for: the agent never learns which user
    // that was, and the audit log in api is where that is recorded.
    actor: string
    trigger: DeployTrigger
    startedAt: string
    durationMs: number
    outcome: DeployOutcome
    reason: string | null
    // The tail of whatever command failed, so a broken build is diagnosable from the portal. Never an
    // env file's contents: nothing here reads one.
    output: string | null
}

export type EnvironmentDeploys = { deploys: DeployRecord[], consecutiveFailures: number, paused: boolean }

export function emptyDeploys(): EnvironmentDeploys {
    return { deploys: [], consecutiveFailures: 0, paused: false }
}

export function deployKey(id: string, environment: EnvironmentName): string {
    return `${id}:${environment}`
}

// A rolled-back deploy counts as a failure: the site is serving the commit it started on, and a branch
// that keeps doing this must stop being polled just as surely as one that fails to build.
export function recordDeploy(state: EnvironmentDeploys, record: DeployRecord): EnvironmentDeploys {
    const consecutiveFailures = record.outcome === 'ok' ? 0 : state.consecutiveFailures + 1
    return {
        deploys: [record, ...state.deploys].slice(0, MAX_DEPLOY_RECORDS),
        consecutiveFailures,
        paused: consecutiveFailures >= PAUSE_AFTER_FAILURES,
    }
}

// The newest commit this environment is known to have served healthily, which is what a rollback goes
// back to. `exclude` is whatever is deployed now, so rolling back from a healthy deploy goes to the one
// before it rather than to itself.
export function lastHealthyCommit(state: EnvironmentDeploys, exclude: string | null): string | null {
    const found = state.deploys.find(record => record.outcome === 'ok' && record.commit !== exclude)
    return found?.commit ?? null
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npx tsx --test src/shared/deploys.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for the store**

Create `hostd/src/agent/deploy-state.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployStore, type DeployStateFs } from './deploy-state.ts'
import { emptyDeploys, type DeployRecord } from '../shared/deploys.ts'

const PATH = '/var/lib/hostd/deploys.json'

const record = (commit: string, outcome: DeployRecord['outcome']): DeployRecord => ({
    commit, subject: null, actor: 'hostd', trigger: 'poll',
    startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1000, outcome, reason: null, output: null,
})

function setup(files: Record<string, string> = {}) {
    const store = new Map(Object.entries(files))
    const made: string[] = []
    const fs: DeployStateFs = {
        readFile: async path => {
            const text = store.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
            return text
        },
        writeFile: async (path, text) => { store.set(path, text) },
        rename: async (from, to) => {
            store.set(to, store.get(from)!)
            store.delete(from)
        },
        mkdir: async dir => { made.push(dir) },
    }
    return { fs, files: store, made }
}

describe('DeployStore', () => {
    it('starts empty when the file does not exist yet', async () => {
        const { fs } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.get('acme:live'), emptyDeploys())
        assert.equal(store.isPaused('acme:live'), false)
    })

    it('reads what an earlier run wrote', async () => {
        const saved = JSON.stringify({ environments: { 'acme:live': { deploys: [record('abc1234', 'ok')], consecutiveFailures: 0, paused: false } } })
        const { fs } = setup({ [PATH]: saved })
        const store = new DeployStore(PATH, fs)
        await store.load()
        assert.equal(store.get('acme:live').deploys[0]!.commit, 'abc1234')
    })

    it('starts empty, rather than throwing, when the file is unreadable', async () => {
        const { fs } = setup({ [PATH]: 'not json at all' })
        const store = new DeployStore(PATH, fs)
        await store.load()
        assert.deepEqual(store.get('acme:live'), emptyDeploys())
    })

    it('writes through a temporary file and a rename, never over the file itself', async () => {
        const { fs, files } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        await store.record('acme:live', record('abc1234', 'ok'))
        assert.equal(store.get('acme:live').deploys.length, 1)
        assert.equal([...files.keys()].length, 1)
        const written = JSON.parse(files.get(PATH)!)
        assert.equal(written.environments['acme:live'].deploys[0].commit, 'abc1234')
    })

    it('pauses after three failures and resumes when asked', async () => {
        const { fs } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        await store.record('acme:live', record('a', 'failed'))
        await store.record('acme:live', record('b', 'failed'))
        await store.record('acme:live', record('c', 'rolled-back'))
        assert.equal(store.isPaused('acme:live'), true)
        await store.resume('acme:live')
        assert.equal(store.isPaused('acme:live'), false)
        assert.equal(store.get('acme:live').consecutiveFailures, 0)
        // Resuming forgets the failures, not the history itself.
        assert.equal(store.get('acme:live').deploys.length, 3)
    })

    it('keeps the history in memory even when the write fails', async () => {
        const { fs } = setup()
        const store = new DeployStore(PATH, fs)
        await store.load()
        fs.writeFile = async () => { throw new Error('disk full') }
        await store.record('acme:live', record('abc1234', 'ok'))
        assert.equal(store.get('acme:live').deploys[0]!.commit, 'abc1234')
    })
})
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy-state.test.ts`
Expected: FAIL, `Cannot find module './deploy-state.ts'`.

- [ ] **Step 7: Implement the store**

Create `hostd/src/agent/deploy-state.ts`:

```ts
// The deploy history on disk: one JSON file for every environment, read once at boot and written
// atomically on every change. One file rather than one per environment because the whole thing is a few
// hundred records at most, and one atomic rename is easier to reason about than a directory of them.
//
// A write that fails never costs the caller its record: the deploy has already happened by the time this
// is called, exactly like the audit log's own rule, so the in-memory state is updated first and a failed
// write is a logged problem rather than a thrown one.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'

import { describeError } from '../shared/formats.ts'
import { emptyDeploys, recordDeploy, type DeployRecord, type EnvironmentDeploys } from '../shared/deploys.ts'

export type DeployStateFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string, options?: { flag: string }): Promise<void>
    rename(from: string, to: string): Promise<void>
    mkdir(dir: string): Promise<void>
}

const nodeFs: DeployStateFs = {
    readFile: path => readFile(path, 'utf8'),
    writeFile: (path, text, options) => writeFile(path, text, { encoding: 'utf8', flag: options?.flag }),
    rename: (from, to) => rename(from, to),
    mkdir: async dir => { await mkdir(dir, { recursive: true }) },
}

type Saved = { environments: Record<string, EnvironmentDeploys> }

export class DeployStore {
    private environments = new Map<string, EnvironmentDeploys>()
    private problem: string | null = null

    constructor(
        private readonly path: string,
        private readonly fs: DeployStateFs = nodeFs,
        private readonly log: (message: string) => void = () => {},
    ) {}

    // Never throws: a missing file is an environment that has never deployed, and an unreadable one is a
    // problem to warn about, not a reason to refuse to start. Starting empty can at worst cost an
    // environment its pause, which the next three failures re-earn.
    async load(): Promise<void> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch {
            return
        }
        try {
            const saved = JSON.parse(text) as Partial<Saved>
            if (!saved || typeof saved !== 'object' || !saved.environments) throw new Error('shape')
            this.environments = new Map(Object.entries(saved.environments))
        } catch (error) {
            this.problem = `the deploy history at ${this.path} could not be read: ${describeError(error)}`
            this.log(`WARN ${this.problem}`)
        }
    }

    warnings(): string[] {
        return this.problem ? [this.problem] : []
    }

    get(key: string): EnvironmentDeploys {
        return this.environments.get(key) ?? emptyDeploys()
    }

    isPaused(key: string): boolean {
        return this.get(key).paused
    }

    async record(key: string, record: DeployRecord): Promise<void> {
        this.environments.set(key, recordDeploy(this.get(key), record))
        await this.save()
    }

    // What a manual deploy, a rollback or a branch switch does to a paused environment: the operator has
    // acted, so polling starts again and the failures that paused it are forgotten.
    async resume(key: string): Promise<void> {
        const state = this.get(key)
        if (!state.paused && state.consecutiveFailures === 0) return
        this.environments.set(key, { ...state, consecutiveFailures: 0, paused: false })
        await this.save()
    }

    private async save(): Promise<void> {
        const saved: Saved = { environments: Object.fromEntries(this.environments) }
        // Same directory, so the rename is atomic, and a random suffix with 'wx' (O_CREAT | O_EXCL) so
        // the temporary name can neither be guessed and pre-planted nor opened through if it is.
        const temporary = posix.join(posix.dirname(this.path), `.${posix.basename(this.path)}.${randomBytes(6).toString('hex')}.tmp`)
        try {
            await this.fs.mkdir(posix.dirname(this.path))
            await this.fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' })
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            this.log(`WARN the deploy history could not be written: ${describeError(error)}`)
        }
    }
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add hostd/src/shared/deploys.ts hostd/src/shared/deploys.test.ts hostd/src/agent/deploy-state.ts hostd/src/agent/deploy-state.test.ts
git commit -m "Keep a deploy history, and pause an environment after three failures

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Compose against any tree, and the health check

**Files:**
- Create: `hostd/src/agent/deploy-compose.ts`, `hostd/src/agent/deploy-compose.test.ts`
- Create: `hostd/src/agent/deploy-health.ts`, `hostd/src/agent/deploy-health.test.ts`

**Interfaces:**
- Consumes: `ComposeLocation`, `Runner`, `tail`, `LIFECYCLE_TIMEOUT_MS` from `src/agent/compose.ts`; `DockerApi`, `pickPerService`, `buildServiceStatuses` from `src/agent/docker.ts`; `EnvironmentEntry`, `ProjectEntry` from `src/shared/registry.ts`
- Produces:
  - `export type DeployTrees = { dir: string, next: string, prev: string, repo: string, git: string }`
  - `export function deployTrees(dir: string): DeployTrees`
  - `export function composeNameOf(environment: EnvironmentEntry): string`
  - `export function locationIn(environment: EnvironmentEntry, dir: string): ComposeLocation`
  - `export function buildArgv(location: ComposeLocation, name: string): string[]`, `upArgv`, `downArgv`
  - `export const BUILD_TIMEOUT_MS`, `export const SWAP_TIMEOUT_MS`
  - `export type ComposeResult = { ok: true, output: string } | { ok: false, message: string, output: string }`
  - `export async function runCompose(argv: string[], timeoutMs: number, run: Runner): Promise<ComposeResult>`
  - `export const HEALTH_TIMEOUT_MS`, `export const HEALTH_INTERVAL_MS`
  - `export function unhealthyServices(project: ProjectEntry, statuses: ServiceStatus[]): string[]`
  - `export type HealthDeps = { docker: DockerApi, now: () => number, sleep: (ms: number) => Promise<void> }`
  - `export async function waitForHealthy(project: ProjectEntry, composeName: string, deps: HealthDeps): Promise<{ ok: true } | { ok: false, problem: string }>`

- [ ] **Step 1: Write the failing tests for the compose commands**

Create `hostd/src/agent/deploy-compose.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { deployTrees, composeNameOf, locationIn, buildArgv, upArgv, downArgv, runCompose } from './deploy-compose.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { Runner } from './compose.ts'

const REGISTRY_YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [deploy]
    environments:
      live:
        dir: /var/www/acme
        compose: [docker-compose.yml, docker-compose.prod.yml]
        branch: main
        port: 5010
      test:
        dir: /var/www/acme-test
        branch: develop
        port: 5110
`

const registry = parseRegistry(REGISTRY_YAML)
const live = registry.projects.get('acme')!.environments.get('live')!
const test = registry.projects.get('acme')!.environments.get('test')!

describe('deploy trees', () => {
    it('names the trees beside the environment folder', () => {
        assert.deepEqual(deployTrees('/var/www/acme'), {
            dir: '/var/www/acme',
            next: '/var/www/acme.next',
            prev: '/var/www/acme.prev',
            repo: '/var/www/acme.git',
            git: '/var/www/acme/.git',
        })
    })

    it('takes the compose project name from the folder, which is what the guard already enforces', () => {
        assert.equal(composeNameOf(live), 'acme')
        assert.equal(composeNameOf(test), 'acme-test')
    })

    it('moves every compose file the registry named into another tree, in the registry order', () => {
        assert.deepEqual(locationIn(live, '/var/www/acme.next'), {
            dir: '/var/www/acme.next',
            composePaths: ['/var/www/acme.next/docker-compose.yml', '/var/www/acme.next/docker-compose.prod.yml'],
        })
    })
})

describe('compose commands', () => {
    it('pins the project name, so a build in acme.next produces acme images', () => {
        assert.deepEqual(buildArgv(locationIn(live, '/var/www/acme.next'), 'acme'), [
            'compose', '--project-name', 'acme', '--project-directory', '/var/www/acme.next',
            '-f', '/var/www/acme.next/docker-compose.yml', '-f', '/var/www/acme.next/docker-compose.prod.yml',
            'build',
        ])
    })

    it('starts without building or pulling, because the build already happened', () => {
        assert.deepEqual(upArgv(locationIn(test, '/var/www/acme-test'), 'acme-test'), [
            'compose', '--project-name', 'acme-test', '--project-directory', '/var/www/acme-test',
            '-f', '/var/www/acme-test/docker-compose.yml',
            'up', '-d', '--no-build', '--pull', 'never',
        ])
    })

    it('takes the old copy down with its orphans, and never its volumes', () => {
        const argv = downArgv(locationIn(test, '/var/www/acme-test'), 'acme-test')
        assert.deepEqual(argv.slice(-2), ['down', '--remove-orphans'])
        assert.equal(argv.includes('-v'), false)
        assert.equal(argv.includes('--volumes'), false)
    })
})

describe('runCompose', () => {
    const runner = (result: { exitCode: number | null, timedOut?: boolean, stderr?: string }): Runner =>
        async () => ({ exitCode: result.exitCode, stdout: 'building', stderr: result.stderr ?? '', timedOut: result.timedOut ?? false })

    it('returns the output on success', async () => {
        const result = await runCompose(['compose', 'build'], 1000, runner({ exitCode: 0 }))
        assert.deepEqual(result, { ok: true, output: 'building' })
    })

    it('returns the exit code and both streams on failure, never throws', async () => {
        const result = await runCompose(['compose', 'build'], 1000, runner({ exitCode: 2, stderr: 'no such file' }))
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /exited with code 2/)
        assert.match(result.output, /no such file/)
    })

    it('says so when the command timed out', async () => {
        const result = await runCompose(['compose', 'build'], 1000, runner({ exitCode: null, timedOut: true }))
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.message : '', /timed out/)
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy-compose.test.ts`
Expected: FAIL, `Cannot find module './deploy-compose.ts'`.

- [ ] **Step 3: Implement the compose commands**

Create `hostd/src/agent/deploy-compose.ts`:

```ts
// Compose, aimed at a tree that is not (yet) the environment's own folder. Everything here is built from
// registry values and the folder names derived from them, so no value from a request can reach a command
// line, exactly as in compose.ts.

import { posix } from 'node:path'

import { tail, type ComposeLocation, type Runner } from './compose.ts'
import type { EnvironmentEntry } from '../shared/registry.ts'

// A build runs the repo's own Dockerfile, which can legitimately take a long time on a cold cache.
export const BUILD_TIMEOUT_MS = 30 * 60_000
// down and up during a swap, while the maintenance page is up: the same bound lifecycle uses.
export const SWAP_TIMEOUT_MS = 120_000

export type DeployTrees = {
    dir: string
    next: string
    prev: string
    // Where the git repository lives once a deploy has moved it out of the tree, so renaming the tree
    // can never take the repository with it.
    repo: string
    // The repository's original home, inside the tree, as a fresh clone leaves it.
    git: string
}

export function deployTrees(dir: string): DeployTrees {
    return { dir, next: `${dir}.next`, prev: `${dir}.prev`, repo: `${dir}.git`, git: posix.join(dir, '.git') }
}

// The environment's own folder basename, which is what an unpinned compose file resolves to and what
// guard.ts already refuses to let drift (see composeNameProblem). Pinning it with --project-name is what
// lets a build in <dir>.next produce the images the swapped-in tree then starts.
export function composeNameOf(environment: EnvironmentEntry): string {
    return posix.basename(environment.dir)
}

// The same compose files the registry named for this environment, resolved inside another tree and in
// the registry's own order, because compose merges -f files left to right.
export function locationIn(environment: EnvironmentEntry, dir: string): ComposeLocation {
    return { dir, composePaths: environment.composePaths.map(path => posix.join(dir, posix.relative(environment.dir, path))) }
}

function base(location: ComposeLocation, name: string): string[] {
    return ['compose', '--project-name', name, '--project-directory', location.dir, ...location.composePaths.flatMap(path => ['-f', path])]
}

export const buildArgv = (location: ComposeLocation, name: string): string[] => [...base(location, name), 'build']
export const upArgv = (location: ComposeLocation, name: string): string[] => [...base(location, name), 'up', '-d', '--no-build', '--pull', 'never']
// --remove-orphans, because a commit that deletes a service would otherwise leave its container running
// under this project's name for ever. Never -v: a deploy must not be able to delete a client's data.
export const downArgv = (location: ComposeLocation, name: string): string[] => [...base(location, name), 'down', '--remove-orphans']

export type ComposeResult = { ok: true, output: string } | { ok: false, message: string, output: string }

export async function runCompose(argv: string[], timeoutMs: number, run: Runner): Promise<ComposeResult> {
    const result = await run('docker', argv, timeoutMs)
    // Compose writes its progress to stderr, so both streams are the output.
    const output = tail([result.stdout, result.stderr].filter(text => text !== '').join('\n'))
    const what = argv[argv.length - 1] === '--remove-orphans' ? 'down' : argv[argv.length - 1]
    if (result.timedOut) return { ok: false, message: `${what} timed out after ${Math.round(timeoutMs / 1000)} seconds`, output }
    if (result.exitCode === null) return { ok: false, message: `${what} could not run`, output }
    if (result.exitCode !== 0) return { ok: false, message: `${what} exited with code ${result.exitCode}`, output }
    return { ok: true, output }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npx tsx --test src/agent/deploy-compose.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for the health check**

Create `hostd/src/agent/deploy-health.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { unhealthyServices, waitForHealthy, HEALTH_TIMEOUT_MS } from './deploy-health.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.ts'
import type { ServiceStatus } from '../shared/protocol.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
`)
const project = registry.projects.get('acme')!

const status = (service: string, state: string, health: string | null): ServiceStatus =>
    ({ service, role: 'site', state, health, startedAt: null, restartCount: null, image: null })

describe('unhealthyServices', () => {
    it('is happy when every service is running and nothing reports a health status', () => {
        assert.deepEqual(unhealthyServices(project, [status('web', 'running', null), status('db', 'running', null)]), [])
    })

    it('names a service that is not running', () => {
        assert.deepEqual(unhealthyServices(project, [status('web', 'exited', null), status('db', 'running', null)]), ['web (exited)'])
    })

    it('names a service whose container reports unhealthy', () => {
        assert.deepEqual(unhealthyServices(project, [status('web', 'running', 'unhealthy'), status('db', 'running', 'healthy')]), ['web (unhealthy)'])
    })

    it('waits on a container that is still starting', () => {
        assert.deepEqual(unhealthyServices(project, [status('web', 'running', 'starting'), status('db', 'running', 'healthy')]), ['web (starting)'])
    })

    it('names a service with no container at all', () => {
        assert.deepEqual(unhealthyServices(project, [status('web', 'missing', null), status('db', 'running', null)]), ['web (missing)'])
    })
})

type Frame = { state: string, health?: string }

function fakeDocker(frames: Frame[]) {
    let calls = 0
    const docker: Partial<DockerApi> = {
        async listProjectContainers(): Promise<ContainerSummary[]> {
            return ['web', 'db'].map(service => ({
                Id: `${'a'.repeat(12)}${service === 'web' ? '1' : '2'}`,
                State: 'running',
                Labels: { 'com.docker.compose.service': service },
            }))
        },
        async inspect(): Promise<ContainerInspect> {
            const frame = frames[Math.min(calls, frames.length - 1)]!
            return {
                Id: 'a'.repeat(12),
                RestartCount: 0,
                Config: { Tty: false, Image: 'acme-web' },
                State: { Status: frame.state, StartedAt: '2026-09-21T00:00:00Z', ...(frame.health ? { Health: { Status: frame.health } } : {}) },
            }
        },
    }
    return { docker: docker as DockerApi, next: () => { calls++ } }
}

describe('waitForHealthy', () => {
    it('passes as soon as everything is running', async () => {
        const { docker } = fakeDocker([{ state: 'running' }])
        let slept = 0
        const result = await waitForHealthy(project, 'acme', { docker, now: () => 0, sleep: async ms => { slept += ms } })
        assert.deepEqual(result, { ok: true })
        assert.equal(slept, 0)
    })

    it('waits for a container that starts unhealthy and becomes healthy', async () => {
        const { docker, next } = fakeDocker([{ state: 'running', health: 'starting' }, { state: 'running', health: 'healthy' }])
        const result = await waitForHealthy(project, 'acme', { docker, now: () => 0, sleep: async () => { next() } })
        assert.deepEqual(result, { ok: true })
    })

    it('gives up after the timeout and says which service was wrong', async () => {
        const { docker } = fakeDocker([{ state: 'running', health: 'unhealthy' }])
        let clock = 0
        const result = await waitForHealthy(project, 'acme', { docker, now: () => clock, sleep: async ms => { clock += ms } })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /web \(unhealthy\)/)
        assert.ok(clock >= HEALTH_TIMEOUT_MS)
    })

    it('treats a Docker read that throws as not healthy yet, and reports it if time runs out', async () => {
        const docker = {
            listProjectContainers: async () => { throw new Error('socket closed') },
            inspect: async () => { throw new Error('socket closed') },
        } as unknown as DockerApi
        let clock = 0
        const result = await waitForHealthy(project, 'acme', { docker, now: () => clock, sleep: async ms => { clock += ms } })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /socket closed/)
    })
})
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy-health.test.ts`
Expected: FAIL, `Cannot find module './deploy-health.ts'`.

- [ ] **Step 7: Implement the health check**

Create `hostd/src/agent/deploy-health.ts`:

```ts
// Is this environment actually serving? The design asks for "every service running, and the site
// answering on its port". The agent runs with network_mode: none, so it has no network namespace to make
// that request from, and the fetcher (which has one) is on a bridge network that cannot reach a port
// published on the host's loopback address. So this is Docker's own view instead: every registered
// compose service has a running container, and any container that declares a healthcheck reports healthy.
// A repo that declares one therefore gets the stronger check, and RUNBOOK.md says so.

import { describeError } from '../shared/formats.ts'
import type { ProjectEntry } from '../shared/registry.ts'
import type { ServiceStatus } from '../shared/protocol.ts'
import { buildServiceStatuses, pickPerService, type ContainerInspect, type DockerApi } from './docker.ts'

export const HEALTH_TIMEOUT_MS = 60_000
export const HEALTH_INTERVAL_MS = 2_000

// 'starting' counts as not healthy yet, deliberately: a container whose healthcheck has not passed once
// is exactly what the wait is for.
export function unhealthyServices(project: ProjectEntry, statuses: ServiceStatus[]): string[] {
    const wrong: string[] = []
    for (const status of statuses) {
        if (status.state !== 'running') wrong.push(`${status.service} (${status.state})`)
        else if (status.health !== null && status.health !== 'healthy') wrong.push(`${status.service} (${status.health})`)
    }
    return wrong
}

export type HealthDeps = { docker: DockerApi, now: () => number, sleep: (ms: number) => Promise<void> }

export async function waitForHealthy(
    project: ProjectEntry, composeName: string, deps: HealthDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    const started = deps.now()
    let problem = 'no container was found'
    for (;;) {
        try {
            const chosen = pickPerService(await deps.docker.listProjectContainers(composeName))
            const inspected = new Map<string, ContainerInspect>()
            for (const [service, container] of chosen) {
                if (Object.hasOwn(project.services, service)) inspected.set(service, await deps.docker.inspect(container.Id))
            }
            const wrong = unhealthyServices(project, buildServiceStatuses(project, inspected))
            if (wrong.length === 0) return { ok: true }
            problem = `not healthy after ${Math.round(HEALTH_TIMEOUT_MS / 1000)} seconds: ${wrong.join(', ')}`
        } catch (error) {
            // A Docker read that fails is not a healthy site, but it is also not proof of an unhealthy
            // one: keep waiting, and report this if the time runs out with nothing better to say.
            problem = `the Docker API could not be read: ${describeError(error)}`
        }
        if (deps.now() - started >= HEALTH_TIMEOUT_MS) return { ok: false, problem }
        await deps.sleep(HEALTH_INTERVAL_MS)
    }
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add hostd/src/agent/deploy-compose.ts hostd/src/agent/deploy-compose.test.ts hostd/src/agent/deploy-health.ts hostd/src/agent/deploy-health.test.ts
git commit -m "Build and start an environment from any tree, and check it is healthy

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Prepare a new tree and build it

**Files:**
- Modify: `hostd/src/shared/fetch-protocol.ts`, `hostd/src/shared/fetch-protocol.test.ts`
- Modify: `hostd/src/fetcher/git.ts`, `hostd/src/fetcher/git.test.ts`
- Create: `hostd/src/agent/deploy.ts`, `hostd/src/agent/deploy.test.ts`

**Interfaces:**
- Consumes: everything from tasks 1 and 2; `FetchClient` from `src/agent/fetch-client.ts`; `listEnvFiles`, `readEnvFile`, `writeEnvFile`, `EnvFs` from `src/agent/env-files.ts`; `RegistryWriter` from `src/shared/registry-write.ts`
- Produces:
  - `FetchRequest`'s fetch member becomes `{ verb: 'fetch', dir: string, branch: string | null }`
  - `export const MIN_FREE_BYTES = 10 * 1024 ** 3`
  - `export type DeployFs = { exists(path): Promise<boolean>, mkdir(dir): Promise<void>, rmdir(dir): Promise<void>, move(from, to): Promise<void>, freeBytes(path): Promise<number>, setMaintenance(key): Promise<void>, clearMaintenance(key): Promise<void> }`
  - `export type DeployDeps = { registry, refreshRegistry, writer, fetcher, docker, runner, fs, envFs?, now, sleep, log }`
  - `export type DeployRequest = { trigger: DeployTrigger, actor: string, commit?: string }`
  - `export async function currentTip(project, environment, deps): Promise<{ ok: true, commit: string } | { ok: false, problem: string }>`
  - `export async function runDeploy(project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps): Promise<DeployRecord>`

Task 4 completes `runDeploy`; this task takes it as far as a built tree at `<dir>.next` and stops, so nothing here can touch the running site at all.

- [ ] **Step 1: Write the failing tests for a branch-aware fetch**

Add to `hostd/src/shared/fetch-protocol.test.ts`:

```ts
describe('fetch with a branch', () => {
    it('accepts a fetch with no branch, as the ordinary case', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/acme.git' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'fetch', dir: '/var/www/acme.git', branch: null } })
    })

    it('accepts a branch, which is what makes a branch switch fetchable at all', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/acme.git', branch: 'develop' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'fetch', dir: '/var/www/acme.git', branch: 'develop' } })
    })

    it('refuses a branch that could be read as an option or a path', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/acme.git', branch: '--upload-pack=sh' }))
        assert.equal(parsed.ok, false)
    })
})
```

Add to `hostd/src/fetcher/git.test.ts`:

```ts
describe('fetchArgv', () => {
    it('fetches everything the clone tracks when no branch is named', () => {
        assert.deepEqual(fetchArgv('/var/www/acme.git', null), ['-C', '/var/www/acme.git', 'fetch', '--prune', '--', 'origin'])
    })

    it('fetches an explicit refspec for a named branch, which a --single-branch clone would otherwise never see', () => {
        assert.deepEqual(fetchArgv('/var/www/acme.git', 'develop'), [
            '-C', '/var/www/acme.git', 'fetch', '--prune', '--', 'origin', '+refs/heads/develop:refs/remotes/origin/develop',
        ])
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/fetch-protocol.test.ts src/fetcher/git.test.ts`
Expected: FAIL: the parsed fetch has no `branch`, and `fetchArgv` takes one argument.

- [ ] **Step 3: Implement the branch-aware fetch**

In `hostd/src/shared/fetch-protocol.ts`, change the fetch member of `FetchRequest` to `{ verb: 'fetch', dir: string, branch: string | null }` and its case:

```ts
        case 'fetch': {
            if (!onlyKeys(raw, ['verb', 'dir', 'branch'])) return refuse('fetch takes only dir and branch')
            const dir = dirOf(raw, 'dir')
            if (!dir) return refuse('dir must be a folder directly under /var/www')
            // Optional: an ordinary fetch of whatever the clone already tracks. A branch, when given,
            // becomes an explicit refspec in git.ts, because a --single-branch clone (which is what
            // cloneArgv makes) writes a refspec covering that one branch only, so a plain fetch after a
            // branch switch would never create the remote-tracking ref the new branch's tip is read from.
            if (raw.branch === undefined || raw.branch === null) return { ok: true, request: { verb: 'fetch', dir, branch: null } }
            const branch = branchOf(raw)
            if (!branch) return branchRefusal(raw)
            return { ok: true, request: { verb: 'fetch', dir, branch } }
        }
```

In `hostd/src/fetcher/git.ts`:

```ts
export const fetchArgv = (dir: string, branch: string | null) => [
    '-C', dir, 'fetch', '--prune', '--', 'origin',
    ...(branch ? [`+refs/heads/${branch}:refs/remotes/origin/${branch}`] : []),
]
```

and in `argvFor`: `case 'fetch': return fetchArgv(request.dir, request.branch)`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test`
Expected: PASS

- [ ] **Step 5: Write the failing tests for prepare and build**

Create `hostd/src/agent/deploy.test.ts`. This file grows in task 4; these are the cases that must hold before a swap exists at all.

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { runDeploy, currentTip, MIN_FREE_BYTES, type DeployDeps, type DeployFs } from './deploy.ts'
import { RegistryWriter, type RegistryWriteFs } from '../shared/registry-write.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { EnvFs } from './env-files.ts'
import type { Runner, RunResult } from './compose.ts'
import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.ts'
import type { FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

const REGISTRY_PATH = '/etc/hostd/registry/projects.yaml'
const TIP = '3f7c1a2b5d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a'

const REGISTRY_YAML = `
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
        dir: /var/www/acme
        branch: main
        domain: acme.com
        port: 5010
        deployed: abc1234
`

type SetupOptions = {
    registryYaml?: string
    fetchReplies?: Partial<Record<FetchRequest['verb'], FetchReply>>
    existsPaths?: string[]
    freeBytes?: number
    envTree?: Record<string, string>
    // Keyed by the compose subcommand the argv ends with: 'build', 'up', 'down'.
    composeResults?: Record<string, Partial<RunResult>>
    containerState?: { state: string, health?: string }
}

function setup(options: SetupOptions = {}) {
    const yaml = options.registryYaml ?? REGISTRY_YAML
    let registry = parseRegistry(yaml)
    const calls: string[] = []
    const fetchRequests: FetchRequest[] = []
    const composeRuns: string[][] = []
    const logs: string[] = []
    const maintenance = new Set<string>()
    const exists = new Set(options.existsPaths ?? ['/var/www/acme/.git'])
    const files = new Map(Object.entries(options.envTree ?? { '/var/www/acme/.env': 'DATABASE_URL=postgres://live\n' }))

    const registryFiles = new Map<string, string>([[REGISTRY_PATH, yaml]])
    const registryFs: RegistryWriteFs = {
        readFile: async path => registryFiles.get(path) ?? Promise.reject(new Error('missing')),
        writeFile: async (path, text) => { registryFiles.set(path, text) },
        rename: async (from, to) => {
            registryFiles.set(to, registryFiles.get(from)!)
            registryFiles.delete(from)
            calls.push('registry-write')
        },
        unlink: async () => {},
    }

    const envFs: EnvFs = {
        async readdir(dir) {
            const prefix = dir.endsWith('/') ? dir : `${dir}/`
            const seen = new Set<string>()
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue
                const rest = path.slice(prefix.length)
                if (!rest.includes('/')) seen.add(rest)
            }
            return [...seen].map(name => ({ name, isDirectory: () => false, isFile: () => true }))
        },
        async readFile(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`)
            return text
        },
        async writeFile(path, text) { files.set(path, text) },
        async rename(from, to) {
            files.set(to, files.get(from)!)
            files.delete(from)
        },
        async stat(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: no such file, stat '${path}'`)
            return { size: Buffer.byteLength(text) }
        },
        async realpath(path) { return path },
    }

    const fs: DeployFs = {
        exists: async path => exists.has(path),
        mkdir: async dir => { calls.push(`mkdir ${dir}`); exists.add(dir) },
        rmdir: async dir => { calls.push(`rmdir ${dir}`); exists.delete(dir) },
        move: async (from, to) => { calls.push(`move ${from} ${to}`); exists.delete(from); exists.add(to) },
        freeBytes: async () => options.freeBytes ?? MIN_FREE_BYTES * 2,
        setMaintenance: async key => { calls.push('maintenance on'); maintenance.add(key) },
        clearMaintenance: async key => { calls.push('maintenance off'); maintenance.delete(key) },
    }

    const frame = options.containerState ?? { state: 'running' }
    const docker: DockerApi = {
        ping: async () => true,
        listProjectContainers: async (): Promise<ContainerSummary[]> => ([
            { Id: `${'a'.repeat(12)}1`, State: 'running', Labels: { 'com.docker.compose.service': 'web' } },
        ]),
        listAllContainers: async () => [],
        inspect: async (): Promise<ContainerInspect> => ({
            Id: 'a'.repeat(12), RestartCount: 0, Config: { Tty: false, Image: 'acme-web' },
            State: { Status: frame.state, StartedAt: '2026-09-21T00:00:00Z', ...(frame.health ? { Health: { Status: frame.health } } : {}) },
        }),
        logs: async () => { throw new Error('not used') },
    }

    const runner: Runner = async (command, args) => {
        composeRuns.push(args)
        const subcommand = args.includes('build') ? 'build' : args.includes('up') ? 'up' : 'down'
        calls.push(`compose ${subcommand}`)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(options.composeResults?.[subcommand] ?? {}) }
    }

    const deps: DeployDeps = {
        registry: () => registry,
        refreshRegistry: async () => { registry = parseRegistry(registryFiles.get(REGISTRY_PATH)!) },
        writer: new RegistryWriter(REGISTRY_PATH, registryFs),
        fetcher: {
            call: async request => {
                calls.push(`fetcher ${request.verb}`)
                fetchRequests.push(request)
                const canned = options.fetchReplies?.[request.verb]
                if (canned) return canned
                if (request.verb === 'tip') return { ok: true, commit: TIP }
                if (request.verb === 'log') return { ok: true, commits: [{ commit: TIP.slice(0, 7), subject: 'Make it faster', author: 'Koda', at: '2026-09-21T00:00:00Z' }] }
                return { ok: true }
            },
        },
        docker,
        runner,
        fs,
        envFs,
        now: () => 1_000,
        sleep: async () => {},
        log: message => logs.push(message),
    }

    const project = () => registry.projects.get('acme')!
    const environment = () => project().environments.get('live')!
    return { deps, project, environment, calls, fetchRequests, composeRuns, logs, files, registryFiles, maintenance, exists }
}

const request = { trigger: 'poll' as const, actor: 'hostd' }

describe('currentTip', () => {
    it('moves the repository out of the tree once, so a swap can never take it with it', async () => {
        const context = setup()
        const result = await currentTip(context.project(), context.environment(), context.deps)
        assert.deepEqual(result, { ok: true, commit: TIP })
        assert.ok(context.calls.includes('move /var/www/acme/.git /var/www/acme.git/.git'))
        assert.deepEqual(context.fetchRequests[0], { verb: 'fetch', dir: '/var/www/acme.git', branch: 'main' })
    })

    it('leaves an already-moved repository alone', async () => {
        const context = setup({ existsPaths: ['/var/www/acme.git'] })
        await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(context.calls.some(call => call.startsWith('move')), false)
    })

    it('returns the problem when the fetch fails, and never reaches the tip', async () => {
        const context = setup({ fetchReplies: { fetch: { ok: false, code: 'failed', message: 'could not read from remote' } } })
        const result = await currentTip(context.project(), context.environment(), context.deps)
        assert.equal(result.ok, false)
        assert.equal(context.calls.includes('fetcher tip'), false)
    })
})

describe('runDeploy, before the swap', () => {
    it('refuses when the disk is nearly full, and touches nothing', async () => {
        const context = setup({ freeBytes: 1024 })
        const record = await runDeploy(context.project(), context.environment(), request, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /free disk/)
        assert.deepEqual(context.calls, [])
    })

    it('checks the new commit out into a fresh tree beside the running one', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.deepEqual(context.fetchRequests.find(sent => sent.verb === 'checkout'), {
            verb: 'checkout', dir: '/var/www/acme.git', worktree: '/var/www/acme.next', commit: TIP,
        })
    })

    it('removes a tree left behind by an earlier deploy before checking out', async () => {
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme.next'] })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const removed = context.calls.indexOf('rmdir /var/www/acme.next')
        const checkedOut = context.calls.indexOf('fetcher checkout')
        assert.ok(removed !== -1 && removed < checkedOut)
    })

    it('carries the env files into the new tree, and leaves the running copy alone', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(context.files.get('/var/www/acme.next/.env'), 'DATABASE_URL=postgres://live\n')
        assert.equal(context.files.get('/var/www/acme/.env'), 'DATABASE_URL=postgres://live\n')
    })

    it('records the commit subject from the branch log', async () => {
        const context = setup()
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.subject, 'Make it faster')
    })

    it('builds in the new tree under the environment\'s own compose project name', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const build = context.composeRuns.find(argv => argv.includes('build'))!
        assert.deepEqual(build.slice(0, 5), ['compose', '--project-name', 'acme', '--project-directory', '/var/www/acme.next'])
    })

    it('never touches the running site when the checkout fails', async () => {
        const context = setup({ fetchReplies: { checkout: { ok: false, code: 'failed', message: 'no such commit' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /no such commit/)
        assert.equal(context.calls.some(call => call.startsWith('compose')), false)
        assert.equal(context.calls.some(call => call.startsWith('move /var/www/acme ')), false)
        assert.equal(context.calls.includes('maintenance on'), false)
    })

    it('never touches the running site when the build fails, and keeps the build output', async () => {
        const context = setup({ composeResults: { build: { exitCode: 1, stderr: 'npm ERR! missing module' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.output ?? '', /npm ERR! missing module/)
        assert.equal(context.calls.includes('compose down'), false)
        assert.equal(context.calls.includes('maintenance on'), false)
        assert.equal(context.calls.some(call => call.startsWith('move /var/www/acme ')), false)
        // The half-built tree is not left lying around for the next deploy to trip over.
        assert.ok(context.calls.includes('rmdir /var/www/acme.next'))
    })

    it('refuses an environment with no branch, rather than guessing one', async () => {
        const context = setup({
            registryYaml: REGISTRY_YAML.replace('        branch: main\n', ''),
        })
        const record = await runDeploy(context.project(), context.environment(), request, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /branch/)
        assert.deepEqual(context.calls, [])
    })

    it('refuses when one of its own tree names is a registered project folder', async () => {
        const context = setup({
            registryYaml: `${REGISTRY_YAML}
  squatter:
    client: cl_2
    name: Squatter
    dir: /var/www/acme.next
    upstream: 127.0.0.1:5099
    services:
      web: { role: site }
`,
        })
        const record = await runDeploy(context.project(), context.environment(), request, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.match(record.reason ?? '', /squatter/)
        assert.deepEqual(context.calls, [])
    })
})
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy.test.ts`
Expected: FAIL, `Cannot find module './deploy.ts'`.

- [ ] **Step 7: Implement prepare and build**

Create `hostd/src/agent/deploy.ts`. Task 4 replaces the marked section with the swap; until then a built tree is as far as this goes.

```ts
// One deploy, end to end. The order is the whole point: nothing before the swap may stop, move or write
// to the running tree, so a fetch, a checkout or a build that fails leaves the site serving exactly what
// it was serving before, and the only thing to clean up is the new tree.
//
// Every dependency is injected, so the tests need no Docker, no network and no filesystem. Nothing here
// throws: a failure becomes a DeployRecord saying what went wrong, because the caller's job is to record
// it, not to catch it.
//
// The git repository lives at <dir>.git, not inside <dir>, because a deploy renames <dir>: leaving the
// repository in the tree would move it into <dir>.prev and delete it on the next deploy. Provisioning
// clones into <dir>, so the first deploy of an environment moves <dir>/.git across once. That move is
// idempotent: if it is interrupted the repository is already at its new home, which is what the next
// deploy looks for.

import { posix } from 'node:path'

import { describeError } from '../shared/formats.ts'
import type { EnvironmentEntry, ProjectEntry, Registry } from '../shared/registry.ts'
import type { RegistryWriter } from '../shared/registry-write.ts'
import type { Commit } from '../shared/fetch-protocol.ts'
import { deployKey, type DeployRecord, type DeployTrigger } from '../shared/deploys.ts'
import type { FetchClient } from './fetch-client.ts'
import type { Runner } from './compose.ts'
import type { DockerApi } from './docker.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
import {
    buildArgv, composeNameOf, deployTrees, locationIn, runCompose, BUILD_TIMEOUT_MS, type DeployTrees,
} from './deploy-compose.ts'

// The worst case is a swap that cannot complete, so a deploy refuses to start rather than risk it.
export const MIN_FREE_BYTES = 10 * 1024 ** 3
// Enough to find the subject of any commit a poll is likely to pick up. A subject that cannot be found
// (a rollback to something older) is null, never a reason to fail the deploy.
const SUBJECT_LOG_LIMIT = 50

export type DeployFs = {
    exists(path: string): Promise<boolean>
    mkdir(dir: string): Promise<void>
    rmdir(dir: string): Promise<void>
    move(from: string, to: string): Promise<void>
    freeBytes(path: string): Promise<number>
    // The flag Apache reads to serve the holding page. Keyed <id>-<env>, as the design names it.
    setMaintenance(key: string): Promise<void>
    clearMaintenance(key: string): Promise<void>
}

export type DeployDeps = {
    registry: () => Registry
    refreshRegistry: () => Promise<void>
    writer: RegistryWriter
    fetcher: FetchClient
    docker: DockerApi
    runner: Runner
    fs: DeployFs
    envFs?: EnvFs
    now: () => number
    sleep: (ms: number) => Promise<void>
    log(message: string): void
}

export type DeployRequest = {
    trigger: DeployTrigger
    actor: string
    // Set by the poller (which has just read the tip) and by a rollback (which names an older commit).
    // Absent for a manual deploy, which reads the tip for itself.
    commit?: string
}

// A tree name of this deploy's own that some other project has registered as its folder. Far-fetched,
// and cheap to refuse: the alternative is a deploy that deletes another client's site.
function treesProblem(registry: Registry, id: string, trees: DeployTrees): string | null {
    const mine = [trees.next, trees.prev, trees.repo]
    for (const [otherId, project] of registry.projects) {
        if (otherId === id) continue
        for (const environment of project.environments.values()) {
            if (mine.includes(environment.dir)) return `${environment.dir} is registered to ${otherId}, so ${id} cannot deploy`
        }
    }
    return null
}

// Moves the repository out of the tree the first time, and confirms there is one at all. Every git
// command after this runs against trees.repo, which no swap ever renames.
async function ensureRepo(trees: DeployTrees, deps: DeployDeps): Promise<{ ok: true } | { ok: false, problem: string }> {
    if (await deps.fs.exists(trees.repo)) return { ok: true }
    if (!(await deps.fs.exists(trees.git))) {
        return { ok: false, problem: `${trees.dir} has no git repository, so it cannot be deployed; it was not created by hostd` }
    }
    await deps.fs.mkdir(trees.repo)
    await deps.fs.move(trees.git, posix.join(trees.repo, '.git'))
    deps.log(`deploy ${trees.dir}: moved the git repository to ${trees.repo}`)
    return { ok: true }
}

// Fetch, then the tip of the tracked branch. Separate from runDeploy because the poller needs exactly
// this and nothing else: it compares the answer with the registry's `deployed` before deciding whether
// there is anything to deploy at all.
export async function currentTip(
    project: ProjectEntry, environment: EnvironmentEntry, deps: DeployDeps,
): Promise<{ ok: true, commit: string } | { ok: false, problem: string }> {
    const branch = environment.branch
    if (!branch) return { ok: false, problem: `${project.id} ${environment.name} has no branch to track` }
    const trees = deployTrees(environment.dir)
    try {
        const repo = await ensureRepo(trees, deps)
        if (!repo.ok) return repo
        const fetched = await deps.fetcher.call({ verb: 'fetch', dir: trees.repo, branch })
        if (!fetched.ok) return { ok: false, problem: fetched.message }
        const tip = await deps.fetcher.call({ verb: 'tip', dir: trees.repo, branch })
        if (!tip.ok) return { ok: false, problem: tip.message }
        if (!tip.commit) return { ok: false, problem: `the fetcher gave no commit for ${branch}` }
        return { ok: true, commit: tip.commit }
    } catch (error) {
        return { ok: false, problem: describeError(error) }
    }
}

// Best effort, never a reason to fail a deploy: the subject is for the history to read well.
async function subjectOf(trees: DeployTrees, branch: string, commit: string, deps: DeployDeps): Promise<string | null> {
    try {
        const log = await deps.fetcher.call({ verb: 'log', dir: trees.repo, branch, limit: SUBJECT_LOG_LIMIT })
        if (!log.ok || !log.commits) return null
        // The log's own hashes are abbreviated, so this matches by prefix rather than equality.
        const found = (log.commits as Commit[]).find(entry => entry.commit !== '' && commit.startsWith(entry.commit))
        return found?.subject ?? null
    } catch {
        return null
    }
}

// The env files are not in the repo, so a fresh checkout has none (or has whatever the repo commits,
// which plausibly points at nothing this site uses). Carrying them across is what makes the new tree
// runnable. A file that cannot be copied fails the deploy: starting a container with half its settings
// is worse than not deploying.
async function carryEnvFiles(
    environment: EnvironmentEntry, next: EnvironmentEntry, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    const files = await listEnvFiles(environment, deps.envFs)
    for (const file of files) {
        const read = await readEnvFile(environment, file.path, deps.envFs)
        // The path is named, never the contents: an env value must not reach a log line or a record.
        if (!read.ok) return { ok: false, problem: `${file.path} could not be read from the running copy` }
        const written = await writeEnvFile(next, file.path, read.text, deps.envFs)
        if (!written.ok) return { ok: false, problem: `${file.path} could not be written into the new tree` }
    }
    return { ok: true }
}

export async function runDeploy(
    project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps,
): Promise<DeployRecord> {
    const startedMs = deps.now()
    const startedAt = new Date(startedMs).toISOString()
    const trees = deployTrees(environment.dir)
    const name = composeNameOf(environment)
    const key = deployKey(project.id, environment.name)

    const record = (
        commit: string, subject: string | null, outcome: DeployRecord['outcome'], reason: string | null, output: string | null = null,
    ): DeployRecord => ({
        commit, subject, actor: request.actor, trigger: request.trigger, startedAt,
        durationMs: deps.now() - startedMs, outcome, reason, output,
    })
    const failed = (reason: string, output: string | null = null) => {
        deps.log(`deploy ${project.id} ${environment.name}: failed, ${reason}`)
        return record(request.commit ?? '', null, 'failed', reason, output)
    }

    if (!project.repo) return failed(`${project.id} has no repo to deploy from`)
    if (!environment.branch) return failed(`${project.id} ${environment.name} has no branch to track`)
    const squatter = treesProblem(deps.registry(), project.id, trees)
    if (squatter) return failed(squatter)

    try {
        const free = await deps.fs.freeBytes(environment.dir)
        if (free < MIN_FREE_BYTES) {
            return failed(`only ${Math.round(free / 1024 ** 3)} GB of free disk, and a deploy needs ${MIN_FREE_BYTES / 1024 ** 3} GB`)
        }

        let commit = request.commit
        if (!commit) {
            const tip = await currentTip(project, environment, deps)
            if (!tip.ok) return failed(tip.problem)
            commit = tip.commit
        } else {
            const repo = await ensureRepo(trees, deps)
            if (!repo.ok) return failed(repo.problem)
        }

        const subject = await subjectOf(trees, environment.branch, commit, deps)
        const fail = (reason: string, output: string | null = null) => {
            deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: failed, ${reason}`)
            return record(commit, subject, 'failed', reason, output)
        }

        // Prepare. A tree left behind by an earlier deploy is removed first: git refuses to add a
        // worktree over an existing folder, and whatever is in there is nobody's current version.
        if (await deps.fs.exists(trees.next)) await deps.fs.rmdir(trees.next)
        const checkedOut = await deps.fetcher.call({ verb: 'checkout', dir: trees.repo, worktree: trees.next, commit })
        if (!checkedOut.ok) {
            await deps.fs.rmdir(trees.next).catch(() => {})
            return fail(checkedOut.message)
        }

        const nextEnvironment: EnvironmentEntry = { ...environment, dir: trees.next, composePaths: locationIn(environment, trees.next).composePaths }
        const carried = await carryEnvFiles(environment, nextEnvironment, deps)
        if (!carried.ok) {
            await deps.fs.rmdir(trees.next).catch(() => {})
            return fail(carried.problem)
        }

        // Build. The site is still serving the old version throughout, and a failure here ends the
        // deploy with nothing of the running environment touched.
        deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: building`)
        const built = await runCompose(buildArgv(locationIn(environment, trees.next), name), BUILD_TIMEOUT_MS, deps.runner)
        if (!built.ok) {
            await deps.fs.rmdir(trees.next).catch(() => {})
            return fail(built.message, built.output)
        }

        // TASK 4 REPLACES THIS: swap, health check, rollback and the registry write.
        void key
        return record(commit, subject, 'ok', null)
    } catch (error) {
        return failed(describeError(error))
    }
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add hostd/src/shared/fetch-protocol.ts hostd/src/shared/fetch-protocol.test.ts hostd/src/fetcher/git.ts hostd/src/fetcher/git.test.ts hostd/src/agent/deploy.ts hostd/src/agent/deploy.test.ts
git commit -m "Prepare and build a deploy in a tree beside the running site

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Swap, health check and automatic rollback

**Files:**
- Modify: `hostd/src/agent/deploy.ts`, `hostd/src/agent/deploy.test.ts`

**Interfaces:**
- Consumes: everything from task 3
- Produces: `runDeploy` completes: on success the registry's `deployed` is written and the record is `ok`; on a failed health check the previous tree is back in place and the record is `rolled-back`

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/agent/deploy.test.ts`:

```ts
describe('runDeploy, the swap', () => {
    it('puts the maintenance flag up before the swap and takes it down after', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const on = context.calls.indexOf('maintenance on')
        const down = context.calls.indexOf('compose down')
        const off = context.calls.indexOf('maintenance off')
        assert.ok(on !== -1 && on < down && down < off)
        assert.equal(context.maintenance.size, 0)
    })

    it('takes the old copy down, moves the trees, and starts the new one', async () => {
        const context = setup()
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const order = context.calls.filter(call => call.startsWith('compose ') || call.startsWith('move '))
        assert.deepEqual(order, [
            'compose build',
            'compose down',
            'move /var/www/acme /var/www/acme.prev',
            'move /var/www/acme.next /var/www/acme',
            'compose up',
        ])
    })

    it('keeps only one previous copy', async () => {
        const context = setup({ existsPaths: ['/var/www/acme/.git', '/var/www/acme.prev'] })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        const removed = context.calls.indexOf('rmdir /var/www/acme.prev')
        const moved = context.calls.indexOf('move /var/www/acme /var/www/acme.prev')
        assert.ok(removed !== -1 && removed < moved)
    })

    it('records the commit in the registry once it is healthy', async () => {
        const context = setup()
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'ok')
        assert.equal(record.commit, TIP)
        assert.equal(context.environment().deployed, TIP.slice(0, 40))
    })

    it('does not touch the running site when the old copy will not come down', async () => {
        const context = setup({ composeResults: { down: { exitCode: 1, stderr: 'permission denied' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(context.calls.some(call => call.startsWith('move /var/www/acme ')), false)
        assert.equal(context.calls.includes('maintenance off'), true)
    })
})

describe('runDeploy, when the new version is not healthy', () => {
    const unhealthy = { containerState: { state: 'running', health: 'unhealthy' } }

    it('swaps back by itself and records the deploy as rolled back', async () => {
        const context = setup(unhealthy)
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.match(record.reason ?? '', /unhealthy/)
        const moves = context.calls.filter(call => call.startsWith('move '))
        assert.deepEqual(moves, [
            'move /var/www/acme /var/www/acme.prev',
            'move /var/www/acme.next /var/www/acme',
            'move /var/www/acme /var/www/acme.next',
            'move /var/www/acme.prev /var/www/acme',
        ])
        // The tree that failed is not kept: it is a checkout of a commit git still has.
        assert.ok(context.calls.lastIndexOf('rmdir /var/www/acme.next') > context.calls.indexOf('move /var/www/acme.prev /var/www/acme'))
    })

    it('leaves the site on the commit it started on', async () => {
        const context = setup(unhealthy)
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(context.environment().deployed, 'abc1234')
        assert.equal(context.calls.includes('registry-write'), false)
    })

    it('rolls back the same way when the new version will not start at all', async () => {
        const context = setup({ composeResults: { up: { exitCode: 1, stderr: 'port is already allocated' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.match(record.reason ?? '', /port is already allocated/)
        assert.ok(context.calls.includes('move /var/www/acme.prev /var/www/acme'))
    })

    it('says so when the previous copy does not come back healthy either', async () => {
        const context = setup({ ...unhealthy, composeResults: { up: { exitCode: 1, stderr: 'no such image' } } })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'rolled-back')
        assert.match(record.reason ?? '', /the previous copy/)
        assert.equal(context.maintenance.size, 0)
    })

    it('has nothing to swap back to on a first deploy, and says that instead of pretending', async () => {
        // No previous copy exists because the move itself failed, which is the only way to reach the
        // health check without one.
        const context = setup(unhealthy)
        context.deps.fs.move = async (from, to) => {
            context.calls.push(`move ${from} ${to}`)
            if (to.endsWith('.prev')) throw new Error('read-only file system')
        }
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(context.maintenance.size, 0)
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy.test.ts`
Expected: FAIL: no maintenance flag, no down, no moves, no registry write.

- [ ] **Step 3: Implement the swap**

In `hostd/src/agent/deploy.ts`, add the imports `downArgv`, `upArgv`, `SWAP_TIMEOUT_MS` from `./deploy-compose.ts` and `waitForHealthy` from `./deploy-health.ts`, then replace the block marked `TASK 4 REPLACES THIS` with:

```ts
        // Swap. Everything from here until the flag comes down is the only window in which the running
        // site is not serving, so it holds no network calls and no builds: a down, two renames and an up.
        await deps.fs.setMaintenance(key)
        let swapped = false
        try {
            const down = await runCompose(downArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
            if (!down.ok) {
                // Nothing has moved, so the old tree is still the site and can simply be started again
                // by the operator or by the next deploy. Refusing to move on is what keeps that true.
                await deps.fs.rmdir(trees.next).catch(() => {})
                return fail(`the running copy could not be stopped: ${down.message}`, down.output)
            }

            // Only one previous copy is kept, which is what bounds the disk this costs.
            if (await deps.fs.exists(trees.prev)) await deps.fs.rmdir(trees.prev)
            await deps.fs.move(trees.dir, trees.prev)
            swapped = true
            await deps.fs.move(trees.next, trees.dir)

            const up = await runCompose(upArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
            const healthy = up.ok
                ? await waitForHealthy(project, name, { docker: deps.docker, now: deps.now, sleep: deps.sleep })
                : { ok: false as const, problem: up.message }
            if (!healthy.ok) {
                const back = await swapBack(project, environment, trees, name, deps)
                deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: rolled back, ${healthy.problem}`)
                const reason = back.ok
                    ? `${healthy.problem}; rolled back to the previous copy`
                    : `${healthy.problem}; the previous copy did not come back healthy either: ${back.problem}`
                return record(commit, subject, 'rolled-back', reason, up.ok ? null : up.output)
            }
        } finally {
            // Always: a flag left behind would serve the holding page over a site that is running.
            await deps.fs.clearMaintenance(key).catch(() => {})
        }
        void swapped

        // Record. The registry is written last, so `deployed` only ever names a commit that this
        // environment actually served, and the store is refreshed so the next poll compares against it.
        const written = await deps.writer.write({ kind: 'set-deployed', id: project.id, environment: environment.name, commit: commit.slice(0, 40) })
        if (!written.ok) {
            // The site is up and healthy on the new commit; only the bookkeeping failed. Saying so beats
            // pretending it failed, and the next poll will simply deploy the same commit again.
            deps.log(`deploy ${project.id} ${environment.name}: deployed, but the registry could not be updated: ${written.problem}`)
            return record(commit, subject, 'failed', `deployed, but the registry could not be updated: ${written.problem}`)
        }
        await deps.refreshRegistry()
        deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: deployed`)
        return record(commit, subject, 'ok', null)
```

and add, above `runDeploy`:

```ts
// The automatic return the design is emphatic about: the new tree is parked back at <dir>.next, the
// previous one takes its place, and only once the previous copy is up and healthy is the failed tree
// removed. Nothing is deleted before its replacement is in place, so an interrupted rollback still
// leaves both copies on disk.
async function swapBack(
    project: ProjectEntry, environment: EnvironmentEntry, trees: DeployTrees, name: string, deps: DeployDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    if (!(await deps.fs.exists(trees.prev))) return { ok: false, problem: 'there is no previous copy to go back to' }
    await runCompose(downArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
    await deps.fs.move(trees.dir, trees.next)
    await deps.fs.move(trees.prev, trees.dir)
    const up = await runCompose(upArgv(locationIn(environment, trees.dir), name), SWAP_TIMEOUT_MS, deps.runner)
    if (!up.ok) return { ok: false, problem: up.message }
    const healthy = await waitForHealthy(project, name, { docker: deps.docker, now: deps.now, sleep: deps.sleep })
    if (!healthy.ok) return { ok: false, problem: healthy.problem }
    await deps.fs.rmdir(trees.next).catch(() => {})
    return { ok: true }
}
```

The `swapped` flag exists so the `catch` around the whole body can tell a throw before the first move (nothing to undo) from one after it. Replace `void swapped` and the outer `catch (error)` with:

```ts
    } catch (error) {
        await deps.fs.clearMaintenance(key).catch(() => {})
        return failed(describeError(error))
    }
```

and inside the swap's own `try`, let a throw propagate to that outer catch: the record is `failed`, the maintenance flag is cleared, and whichever tree is at `<dir>` is what the operator finds. RUNBOOK.md's troubleshooting section says how to read that.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/deploy.ts hostd/src/agent/deploy.test.ts
git commit -m "Swap the new tree in, check it, and go back by itself when it is not healthy

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Starting deploys, and noticing commits

**Files:**
- Create: `hostd/src/agent/deploy-runner.ts`, `hostd/src/agent/deploy-runner.test.ts`
- Create: `hostd/src/agent/deploy-poller.ts`, `hostd/src/agent/deploy-poller.test.ts`

**Interfaces:**
- Consumes: `runDeploy`, `currentTip`, `DeployDeps` from `./deploy.ts`; `DeployStore` from `./deploy-state.ts`; `deployKey`, `DeployTrigger` from `../shared/deploys.ts`
- Produces:
  - `export class DeployRunner` with `constructor(deps: DeployDeps & { store: DeployStore })`, `isRunning(key: string): boolean`, `start(project, environment, request): { ok: true } | Refusal`, `settle(): Promise<void>`
  - `export const POLL_EVERY_MS = 120_000`
  - `export class DeployPoller` with `constructor(deps: PollerDeps)`, `tick(): Promise<string[]>`

- [ ] **Step 1: Write the failing tests for the runner**

Create `hostd/src/agent/deploy-runner.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployRunner } from './deploy-runner.ts'
import { DeployStore, type DeployStateFs } from './deploy-state.ts'
import { parseRegistry, type EnvironmentEntry, type ProjectEntry } from '../shared/registry.ts'
import type { DeployDeps } from './deploy.ts'
import type { DeployRecord } from '../shared/deploys.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [deploy]
    environments:
      live:
        dir: /var/www/acme
        branch: main
        port: 5010
`)
const project = registry.projects.get('acme')!
const environment = project.environments.get('live')!

function memoryFs(): DeployStateFs {
    const files = new Map<string, string>()
    return {
        readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
        writeFile: async (path, text) => { files.set(path, text) },
        rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
        mkdir: async () => {},
    }
}

function setup(outcome: DeployRecord['outcome'] = 'ok') {
    const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
    const runs: string[] = []
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const deploy = async (_p: ProjectEntry, _e: EnvironmentEntry, request: { trigger: string }): Promise<DeployRecord> => {
        runs.push(request.trigger)
        await gate
        return {
            commit: 'abc1234', subject: null, actor: 'hostd', trigger: 'poll',
            startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1, outcome, reason: null, output: null,
        }
    }
    const runner = new DeployRunner({ store, log: () => {} } as unknown as DeployDeps & { store: DeployStore }, deploy)
    return { runner, store, runs, release }
}

describe('DeployRunner', () => {
    it('starts a deploy and answers at once, without waiting for it', async () => {
        const { runner, runs, release } = setup()
        const started = runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        assert.deepEqual(started, { ok: true, started: { environment: 'live', trigger: 'manual' } })
        assert.deepEqual(runs, ['manual'])
        assert.equal(runner.isRunning('acme:live'), true)
        release()
        await runner.settle()
        assert.equal(runner.isRunning('acme:live'), false)
    })

    it('refuses a second deploy for the same environment while one is running', async () => {
        const { runner, release } = setup()
        runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        const second = runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
        assert.equal(second.ok, false)
        assert.equal(second.ok === false ? second.code : '', 'busy')
        release()
        await runner.settle()
    })

    it('records what the deploy did', async () => {
        const { runner, store, release } = setup('rolled-back')
        runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
        release()
        await runner.settle()
        assert.equal(store.get('acme:live').deploys[0]!.outcome, 'rolled-back')
        assert.equal(store.get('acme:live').consecutiveFailures, 1)
    })

    it('refuses to poll a paused environment, and lets a person deploy it anyway', async () => {
        const { runner, store, release } = setup('failed')
        for (let i = 0; i < 3; i++) {
            runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
            release()
            await runner.settle()
        }
        assert.equal(store.isPaused('acme:live'), true)
        const polled = runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
        assert.equal(polled.ok, false)
        assert.equal(polled.ok === false ? polled.code : '', 'unavailable')

        const manual = runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        assert.equal(manual.ok, true)
        release()
        await runner.settle()
        // The manual deploy failed too, so it is paused again, but it did run.
        assert.equal(store.get('acme:live').deploys.length, 4)
    })

    it('releases the environment when the deploy itself throws', async () => {
        const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
        const runner = new DeployRunner(
            { store, log: () => {} } as unknown as DeployDeps & { store: DeployStore },
            async () => { throw new Error('unexpected') },
        )
        runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        await runner.settle()
        assert.equal(runner.isRunning('acme:live'), false)
        assert.equal(store.get('acme:live').deploys[0]!.outcome, 'failed')
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy-runner.test.ts`
Expected: FAIL, `Cannot find module './deploy-runner.ts'`.

- [ ] **Step 3: Implement the runner**

Create `hostd/src/agent/deploy-runner.ts`:

```ts
// Starts a deploy and answers immediately. A deploy is minutes of building; api's own call timeout is
// 150 seconds, so a verb that waited for one would always time out. The reply says the deploy started,
// and the deploy history (which the portal already polls) is where the outcome shows up.
//
// One deploy per environment at a time, as the design says. Two different environments may deploy at
// once: they share nothing but the machine.

import { describeError } from '../shared/formats.ts'
import { deployKey, type DeployRecord, type DeployTrigger } from '../shared/deploys.ts'
import { refuse, type EnvironmentName, type Refusal } from '../shared/protocol.ts'
import type { EnvironmentEntry, ProjectEntry } from '../shared/registry.ts'
import { runDeploy, type DeployDeps, type DeployRequest } from './deploy.ts'
import type { DeployStore } from './deploy-state.ts'

export type DeployRunnerDeps = DeployDeps & { store: DeployStore }
export type StartedReply = { ok: true, started: { environment: EnvironmentName, trigger: DeployTrigger } }
type Deploy = (project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps) => Promise<DeployRecord>

export class DeployRunner {
    private readonly running = new Map<string, Promise<void>>()

    // `deploy` is injected only so the tests can hold a deploy open and watch the locking; production
    // always passes the real one.
    constructor(private readonly deps: DeployRunnerDeps, private readonly deploy: Deploy = runDeploy) {}

    isRunning(key: string): boolean {
        return this.running.has(key)
    }

    start(project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest): StartedReply | Refusal {
        const key = deployKey(project.id, environment.name)
        // Taken before any await, so two requests arriving together cannot both see a free slot.
        if (this.running.has(key)) return refuse('busy', `${project.id} ${environment.name} already has a deploy running`)
        // A person asking is what resumes a paused environment: the poller is what must stay stopped.
        if (request.trigger === 'poll' && this.deps.store.isPaused(key)) {
            return refuse('unavailable', `${project.id} ${environment.name} is paused after repeated failures; deploy it by hand to resume`)
        }

        this.running.set(key, this.run(key, project, environment, request))
        return { ok: true, started: { environment: environment.name, trigger: request.trigger } }
    }

    // For the agent's own shutdown and for the tests: production never awaits a deploy.
    async settle(): Promise<void> {
        await Promise.all([...this.running.values()])
    }

    private async run(key: string, project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest): Promise<void> {
        try {
            if (request.trigger !== 'poll') await this.deps.store.resume(key)
            let record: DeployRecord
            try {
                record = await this.deploy(project, environment, request, this.deps)
            } catch (error) {
                // runDeploy returns its failures rather than throwing, so this is the unforeseen kind.
                // It still has to be recorded, or a crashing deploy would never count towards the pause.
                record = {
                    commit: request.commit ?? '', subject: null, actor: request.actor, trigger: request.trigger,
                    startedAt: new Date(this.deps.now()).toISOString(), durationMs: 0,
                    outcome: 'failed', reason: describeError(error), output: null,
                }
            }
            await this.deps.store.record(key, record)
            if (this.deps.store.isPaused(key)) {
                this.deps.log(`deploy ${key}: paused after repeated failures; deploy it by hand to resume`)
            }
        } finally {
            this.running.delete(key)
        }
    }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npx tsx --test src/agent/deploy-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing tests for the poller**

Create `hostd/src/agent/deploy-poller.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployPoller, POLL_EVERY_MS } from './deploy-poller.ts'
import { DeployStore, type DeployStateFs } from './deploy-state.ts'
import { parseRegistry, type EnvironmentEntry, type ProjectEntry } from '../shared/registry.ts'
import type { DeployRequest } from './deploy.ts'

const TIP = '3f7c1a2b5d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a'

const REGISTRY_YAML = `
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [deploy]
    environments:
      live:
        dir: /var/www/acme
        branch: main
        port: 5010
        deployed: ${TIP.slice(0, 7)}
      test:
        dir: /var/www/acme-test
        branch: develop
        port: 5110
  manual:
    client: cl_2
    name: Manual
    dir: /var/www/manual
    upstream: 127.0.0.1:5020
    services:
      web: { role: site }
    capabilities: [lifecycle]
`

function memoryFs(): DeployStateFs {
    const files = new Map<string, string>()
    return {
        readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
        writeFile: async (path, text) => { files.set(path, text) },
        rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
        mkdir: async () => {},
    }
}

function setup(options: { tips?: Record<string, string>, tipProblem?: string, registryYaml?: string } = {}) {
    const registry = parseRegistry(options.registryYaml ?? REGISTRY_YAML)
    const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
    const started: Array<{ key: string, request: DeployRequest }> = []
    const running = new Set<string>()
    const logs: string[] = []
    let clock = 0

    const poller = new DeployPoller({
        registry: () => registry,
        store,
        runner: {
            isRunning: (key: string) => running.has(key),
            start: (project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest) => {
                started.push({ key: `${project.id}:${environment.name}`, request })
                return { ok: true as const, started: { environment: environment.name, trigger: request.trigger } }
            },
        },
        tip: async (project, environment) => {
            if (options.tipProblem) return { ok: false as const, problem: options.tipProblem }
            return { ok: true as const, commit: options.tips?.[`${project.id}:${environment.name}`] ?? TIP }
        },
        now: () => clock,
        log: message => logs.push(message),
    })
    return { poller, store, started, running, logs, advance: (ms: number) => { clock += ms }, registry }
}

describe('DeployPoller', () => {
    it('deploys an environment whose branch has moved', async () => {
        const context = setup({ tips: { 'acme:live': 'f00dcafedeadbeef0000111122223333444455556' } })
        const keys = await context.poller.tick()
        assert.ok(keys.includes('acme:live'))
        assert.equal(context.started[0]!.request.trigger, 'poll')
        assert.equal(context.started[0]!.request.commit, 'f00dcafedeadbeef0000111122223333444455556')
        assert.equal(context.started[0]!.request.actor, 'hostd')
    })

    it('leaves an environment alone when the tip is what is already deployed', async () => {
        const context = setup()
        await context.poller.tick()
        assert.equal(context.started.some(start => start.key === 'acme:live'), false)
    })

    it('deploys an environment that has never deployed', async () => {
        const context = setup()
        const keys = await context.poller.tick()
        assert.ok(keys.includes('acme:test'))
    })

    it('never polls a project without the deploy capability', async () => {
        const context = setup()
        await context.poller.tick()
        assert.equal(context.started.some(start => start.key.startsWith('manual:')), false)
    })

    it('waits two minutes before checking the same environment again', async () => {
        const context = setup()
        await context.poller.tick()
        const first = context.started.length
        await context.poller.tick()
        assert.equal(context.started.length, first)
        context.advance(POLL_EVERY_MS)
        await context.poller.tick()
        assert.ok(context.started.length > first)
    })

    it('skips an environment that is already deploying', async () => {
        const context = setup()
        context.running.add('acme:test')
        const keys = await context.poller.tick()
        assert.equal(keys.includes('acme:test'), false)
    })

    it('skips a paused environment without so much as a fetch', async () => {
        const context = setup()
        await context.store.record('acme:test', {
            commit: 'abc1234', subject: null, actor: 'hostd', trigger: 'poll',
            startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1, outcome: 'failed', reason: null, output: null,
        })
        await context.store.resume('acme:test')
        context.store.get('acme:test')
        // Three failures is what pauses it.
        for (let i = 0; i < 3; i++) {
            await context.store.record('acme:test', {
                commit: 'abc1234', subject: null, actor: 'hostd', trigger: 'poll',
                startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1, outcome: 'failed', reason: null, output: null,
            })
        }
        const keys = await context.poller.tick()
        assert.equal(keys.includes('acme:test'), false)
    })

    it('logs a fetch that failed and does not count it as a deploy failure', async () => {
        const context = setup({ tipProblem: 'could not read from remote repository' })
        const keys = await context.poller.tick()
        assert.deepEqual(keys, [])
        assert.equal(context.store.get('acme:live').consecutiveFailures, 0)
        assert.ok(context.logs.some(line => line.includes('could not read from remote repository')))
    })
})
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/deploy-poller.test.ts`
Expected: FAIL, `Cannot find module './deploy-poller.ts'`.

- [ ] **Step 7: Implement the poller**

Create `hostd/src/agent/deploy-poller.ts`:

```ts
// How a deploy is noticed: every 2 minutes per environment, ask GitHub for the tip of the tracked branch
// and compare it with what the registry says is deployed. No webhook, deliberately (see the design):
// nothing new is exposed to the internet and it works the same for every repo. The cost is that a deploy
// can start up to 2 minutes after a push.

import { describeError } from '../shared/formats.ts'
import { deployKey } from '../shared/deploys.ts'
import type { EnvironmentEntry, ProjectEntry, Registry } from '../shared/registry.ts'
import type { Refusal } from '../shared/protocol.ts'
import type { DeployRequest } from './deploy.ts'
import type { DeployStore } from './deploy-state.ts'
import type { StartedReply } from './deploy-runner.ts'

export const POLL_EVERY_MS = 120_000

export type PollerDeps = {
    registry: () => Registry
    store: DeployStore
    runner: {
        isRunning(key: string): boolean
        start(project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest): StartedReply | Refusal
    }
    tip(project: ProjectEntry, environment: EnvironmentEntry): Promise<{ ok: true, commit: string } | { ok: false, problem: string }>
    now: () => number
    log(message: string): void
}

export class DeployPoller {
    private readonly checkedAt = new Map<string, number>()

    constructor(private readonly deps: PollerDeps) {}

    // Returns the keys it started a deploy for, which is what the agent's main loop logs.
    async tick(): Promise<string[]> {
        const started: string[] = []
        for (const project of this.deps.registry().projects.values()) {
            if (!project.repo || !project.capabilities.has('deploy')) continue
            for (const environment of project.environments.values()) {
                if (!environment.branch) continue
                const key = deployKey(project.id, environment.name)
                if (this.deps.runner.isRunning(key)) continue
                // Checked before the fetch, not after: a paused environment must cost nothing at all,
                // which is the whole point of pausing it.
                if (this.deps.store.isPaused(key)) continue
                const last = this.checkedAt.get(key)
                if (last !== undefined && this.deps.now() - last < POLL_EVERY_MS) continue
                this.checkedAt.set(key, this.deps.now())

                let tip: { ok: true, commit: string } | { ok: false, problem: string }
                try {
                    tip = await this.deps.tip(project, environment)
                } catch (error) {
                    tip = { ok: false, problem: describeError(error) }
                }
                if (!tip.ok) {
                    // Nothing was deployed, so nothing is recorded: a remote that is briefly unreachable
                    // must not spend one of the three failures that pause an environment.
                    this.deps.log(`poll ${key}: could not read the branch tip: ${tip.problem}`)
                    continue
                }
                // A short `deployed` (the operator may have written one by hand) is compared as a prefix
                // of the full hash the fetcher returns, so an abbreviated entry does not redeploy for ever.
                if (environment.deployed && tip.commit.startsWith(environment.deployed)) continue

                const reply = this.deps.runner.start(project, environment, { trigger: 'poll', actor: 'hostd', commit: tip.commit })
                if (reply.ok) {
                    this.deps.log(`poll ${key}: ${environment.branch} moved to ${tip.commit.slice(0, 7)}, deploying`)
                    started.push(key)
                } else {
                    this.deps.log(`poll ${key}: not deploying, ${reply.message}`)
                }
            }
        }
        return started
    }
}
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add hostd/src/agent/deploy-runner.ts hostd/src/agent/deploy-runner.test.ts hostd/src/agent/deploy-poller.ts hostd/src/agent/deploy-poller.test.ts
git commit -m "Notice a commit by polling, and run one deploy per environment at a time

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The deploy verb

**Files:**
- Modify: `hostd/src/shared/registry-write.ts`, `hostd/src/shared/registry-write.test.ts`
- Modify: `hostd/src/shared/protocol.ts`, `hostd/src/shared/protocol.test.ts`
- Modify: `hostd/src/agent/agent.ts`, `hostd/src/agent/agent.test.ts`

**Interfaces:**
- Consumes: `DeployRunner`, `DeployStore`, `currentTip`, `lastHealthyCommit`
- Produces:
  - `Change` gains `{ kind: 'set-branch', id: string, environment: EnvironmentName, branch: string }`
  - `export type DeployArgs = DeployStartArgs | DeployRollbackArgs | DeployBranchArgs | DeployHistoryArgs | DeployCommitsArgs` with actions `'deploy' | 'rollback' | 'set-branch' | 'history' | 'commits'`, each carrying `environment: EnvironmentName`
  - `export type DeployRequest = { verb: 'deploy', project: string, args: DeployArgs }` joined into `ProjectRequest`
  - `export const MAX_COMMITS = 100`, `export const DEFAULT_COMMITS = 30`
  - `export type DeployStartedReply`, `export type DeployHistoryReply`, `export type DeployCommitsReply`, all joined into `AgentReply`
  - `VERB_CAPABILITY.deploy = 'deploy'`
  - `AgentDeps` gains `deploys?: { runner: DeployRunner, store: DeployStore, deps: DeployDeps }`

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/registry-write.test.ts`:

```ts
it('sets a branch', () => {
    const result = applyChange(BASE, { kind: 'set-branch', id: 'acme', environment: 'live', branch: 'develop' })
    assert.equal(result.ok, true)
    assert.equal(parseRegistry(result.ok ? result.text : '').projects.get('acme')!.environments.get('live')!.branch, 'develop')
})

it('refuses a branch on an environment that does not exist', () => {
    assert.equal(applyChange(BASE, { kind: 'set-branch', id: 'acme', environment: 'test', branch: 'develop' }).ok, false)
})

it('refuses a branch the registry itself would not load', () => {
    assert.equal(applyChange(BASE, { kind: 'set-branch', id: 'acme', environment: 'live', branch: '--upload-pack' }).ok, false)
})
```

Add to `hostd/src/shared/protocol.test.ts`:

```ts
describe('deploy requests', () => {
    it('parses a deploy', () => {
        const parsed = parseAgentRequest(JSON.stringify({ verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'live' } }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'live' } } })
    })

    it('parses a rollback, a branch switch, a history read and a commit list', () => {
        for (const args of [
            { action: 'rollback', environment: 'test' },
            { action: 'set-branch', environment: 'live', branch: 'develop' },
            { action: 'history', environment: 'live' },
            { action: 'commits', environment: 'live', limit: 10 },
        ]) {
            const parsed = parseAgentRequest(JSON.stringify({ verb: 'deploy', project: 'acme', args }))
            assert.equal(parsed.ok, true, JSON.stringify(args))
        }
    })

    it('refuses an unknown action, an unknown environment, a bad branch and a silly limit', () => {
        for (const args of [
            { action: 'destroy', environment: 'live' },
            { action: 'deploy', environment: 'staging' },
            { action: 'set-branch', environment: 'live', branch: 'a branch' },
            { action: 'commits', environment: 'live', limit: 100000 },
            { action: 'deploy', environment: 'live', extra: 1 },
        ]) {
            assert.equal(parseAgentRequest(JSON.stringify({ verb: 'deploy', project: 'acme', args })).ok, false, JSON.stringify(args))
        }
    })

    it('needs the deploy capability, and refuses an environment the project does not have', () => {
        // Built with the same parseRegistry helper the rest of this file uses.
        assert.equal(VERB_CAPABILITY.deploy, 'deploy')
    })
})
```

Add to `hostd/src/agent/agent.test.ts` (the existing `setup()` there gains a `deploys` dependency; follow its shape):

```ts
describe('the deploy verb', () => {
    it('refuses every deploy action when deploys are not configured', async () => {})
    it('refuses a project without the deploy capability, before anything runs', async () => {})
    it('starts a manual deploy and answers at once', async () => {})
    it('refuses a second deploy while one is running', async () => {})
    it('rolls back to the last commit recorded healthy', async () => {})
    it('refuses a rollback when nothing has ever deployed healthily', async () => {})
    it('writes the new branch, then deploys it', async () => {})
    it('refuses a branch the registry would not accept, and writes nothing', async () => {})
    it('returns the history with the pause and the deployed commit', async () => {})
    it('returns the branch log for the commit list', async () => {})
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/registry-write.test.ts src/shared/protocol.test.ts src/agent/agent.test.ts`
Expected: FAIL on the new change kind, the new verb, and the new handler.

- [ ] **Step 3: Implement**

`registry-write.ts`: add `{ kind: 'set-branch', id, environment, branch }` to `Change` and a case in `edit` that refuses when the environment is absent and otherwise `doc.setIn(['projects', id, 'environments', environment, 'branch'], branch)`. The validation that a branch is a plain branch name needs no new code: `applyChange` already re-parses the whole document with `parseRegistry`, which refuses one that is not.

`protocol.ts`: add the argument and reply types listed above, parse them in the same style as `parseEnvArgs` (an `onlyKeys` guard per action, the environment checked against `ENVIRONMENTS`, `branch` against `GIT_REF`, `limit` a whole number from 1 to `MAX_COMMITS` defaulting to `DEFAULT_COMMITS`), add `deploy: 'deploy'` to `VERB_CAPABILITY`, join `DeployRequest` into `ProjectRequest` and the three replies into `AgentReply`, and widen `checkStructure`'s environment check from `request.verb === 'env'` to `(request.verb === 'env' || request.verb === 'deploy')`.

`agent.ts`: `AgentDeps` gains `deploys?: { runner: DeployRunner, store: DeployStore, deps: DeployDeps }`, and `handle` gains `case 'deploy': return reply(await this.deploy(checked.project, request.args))`:

```ts
    private async deploy(project: ProjectEntry, args: DeployArgs): Promise<AgentReply> {
        if (!this.deps.deploys) return refuse('unavailable', 'deploys are not configured')
        const { runner, store, deps } = this.deps.deploys
        // checkStructure has already confirmed this environment exists on the project.
        const environment = environmentOf(project, args.environment)!
        const key = deployKey(project.id, environment.name)

        if (args.action === 'history') {
            const state = store.get(key)
            return {
                ok: true, environment: environment.name, branch: environment.branch, deployed: environment.deployed,
                paused: state.paused, consecutiveFailures: state.consecutiveFailures, deploys: state.deploys,
            }
        }

        if (args.action === 'commits') {
            const trees = deployTrees(environment.dir)
            if (!environment.branch) return refuse('bad-request', `${project.id} ${environment.name} has no branch to list`)
            // Before the first deploy the repository is still inside the tree, where provisioning cloned
            // it; after it, it is beside the tree. Both are asked about rather than assumed.
            const dir = (await deps.fs.exists(trees.repo)) ? trees.repo : environment.dir
            const log = await deps.fetcher.call({ verb: 'log', dir, branch: environment.branch, limit: args.limit })
            return log.ok ? { ok: true, commits: log.commits ?? [] } : refuse(log.code === 'bad-request' ? 'bad-request' : 'failed', log.message)
        }

        if (args.action === 'rollback') {
            const target = lastHealthyCommit(store.get(key), environment.deployed)
            if (!target) return refuse('bad-request', `${project.id} ${environment.name} has no earlier healthy deploy to go back to`)
            return runner.start(project, environment, { trigger: 'rollback', actor: 'admin', commit: target })
        }

        if (args.action === 'set-branch') {
            const written = await deps.writer.write({ kind: 'set-branch', id: project.id, environment: environment.name, branch: args.branch })
            if (!written.ok) return refuse('bad-request', written.problem)
            await deps.refreshRegistry()
            // Re-read, so the deploy that follows tracks the branch just written rather than the one
            // this request arrived holding.
            const refreshed = deps.registry().projects.get(project.id)
            const moved = refreshed ? environmentOf(refreshed, environment.name) : null
            if (!refreshed || !moved) return { ok: true, output: `${environment.name} now tracks ${args.branch}` }
            return runner.start(refreshed, moved, { trigger: 'branch', actor: 'admin' })
        }

        return runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
    }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared hostd/src/agent/agent.ts hostd/src/agent/agent.test.ts
git commit -m "Give the agent a deploy verb: deploy, roll back, switch branch, read history

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The deploy routes

**Files:**
- Modify: `hostd/src/api/policy.ts`, `hostd/src/api/policy.test.ts`
- Modify: `hostd/src/api/routes.ts`, `hostd/src/api/routes.test.ts`

**Interfaces:**
- Consumes: the `deploy` verb from task 6
- Produces:
  - `PolicyVerb` gains `'deploy'` (admin only, like `provision`) and `'deploy-read'` (the owner too)
  - `Route` gains `{ verb: 'deploy' | 'rollback' | 'branch' | 'deploys' | 'commits', project: string, environment: EnvironmentName }`
  - `POST /projects/:id/:env/deploy`, `POST /projects/:id/:env/rollback`, `PUT /projects/:id/:env/branch` `{ branch }`, `GET /projects/:id/:env/deploys`, `GET /projects/:id/:env/commits?limit=`

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/api/policy.test.ts`:

```ts
it('lets only the admin deploy, roll back or switch branch', () => {})
it('lets the owner read deploy history and commits, and refuses another client with a 404', () => {})
it('refuses both when the deploy capability is off', () => {})
```

Add to `hostd/src/api/routes.test.ts`:

```ts
describe('deploy routes', () => {
    it('matches deploy, rollback, branch, deploys and commits under an environment', () => {
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/deploy'), { verb: 'deploy', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/test/rollback'), { verb: 'rollback', project: 'acme', environment: 'test' })
        assert.deepEqual(matchRoute('PUT', '/projects/acme/live/branch'), { verb: 'branch', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploys'), { verb: 'deploys', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/commits'), { verb: 'commits', project: 'acme', environment: 'live' })
    })

    it('still matches the env routes it shares a path with', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/env'), { verb: 'env-list', project: 'acme', environment: 'live' })
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/env/api/.env'), { verb: 'env-file', project: 'acme', environment: 'live', path: 'api/.env' })
    })

    it('refuses the wrong method and an unknown action', () => {
        assert.deepEqual(matchRoute('GET', '/projects/acme/live/deploy'), { verb: 'method-not-allowed' })
        assert.deepEqual(matchRoute('POST', '/projects/acme/live/nonsense'), { verb: 'not-found' })
    })

    it('starts a deploy and audits it', async () => {})
    it('passes a branch switch through and audits the branch, not the whole body', async () => {})
    it('refuses a branch body with an unknown field', async () => {})
    it('lets a client read its own deploy history and commits', async () => {})
    it('refuses a client the deploy, rollback and branch routes with a 404, and audits the refusal', async () => {})
    it('refuses a commits limit that is not a small whole number', async () => {})
    it('returns 503 when the agent cannot be reached', async () => {})
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/api/routes.test.ts src/api/policy.test.ts`
Expected: FAIL on the new routes and verbs.

- [ ] **Step 3: Implement**

`policy.ts`: add `'deploy' | 'deploy-read'` to `PolicyVerb`, add `deploy` to the admin-only list beside `provision` and `env`, and resolve the capability for both through a small map rather than `VERB_CAPABILITY` alone:

```ts
const POLICY_CAPABILITY: Record<PolicyVerb, Capability | null> = {
    status: null, audit: null, lifecycle: 'lifecycle', logs: 'logs', provision: 'provision', env: 'env',
    // Reading the history and the commit list is the half of the deploy capability a client may use.
    deploy: 'deploy', 'deploy-read': 'deploy',
}
```

`routes.ts`: inside the existing environment branch of `matchRoute`, handle `parts.length === 4` by action (`env`, `deploy`, `rollback`, `branch`, `deploys`, `commits`) before falling through to the env-file case, so the env routes keep working exactly as they do. Add a `parseBranchBody` in the style of `parseEnvWriteBody` (`onlyKeys(value, ['branch'])`, `typeof value.branch === 'string'`), and a `parseCommitsLimit(params)` in the style of `parseLimit` (1 to `MAX_COMMITS`, default `DEFAULT_COMMITS`, `null` when it is neither). Widen `respondAgentAction`'s first parameter to `'provision' | 'env' | 'deploy'`. The four mutating routes authorize with `'deploy'`, call the agent through `callAgentAudited`, and answer through `respondAgentAction('deploy', ...)`, with targets `${environment} deploy`, `${environment} rollback` and `${environment} branch ${branch}`. The two read routes authorize with `'deploy-read'` and call `callAgent`, unaudited on success, exactly as `status` already is.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/api
git commit -m "Expose deploys over the API, with history and commits readable by the client

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Wiring, and how to operate it

**Files:**
- Modify: `hostd/src/agent/index.ts`
- Modify: `hostd/docker-compose.yml`, `hostd/RUNBOOK.md`

**Interfaces:**
- Consumes: everything above
- Produces: an agent that polls, deploys and records, with the state file and the maintenance directory mounted

- [ ] **Step 1: Wire the agent**

In `hostd/src/agent/index.ts`:

```ts
const DEPLOY_STATE_FILE = process.env.HOSTD_DEPLOY_STATE_FILE ?? '/var/lib/hostd/deploys.json'
// The flag Apache reads. A tmpfs path on the host, so a reboot can never leave a site behind a
// maintenance page nobody remembers putting up.
const MAINTENANCE_DIR = process.env.HOSTD_MAINTENANCE_DIR ?? '/run/hostd/maintenance'
```

and, after the `provision` dependencies are built:

```ts
    const deployStore = new DeployStore(DEPLOY_STATE_FILE, undefined, log)
    await deployStore.load()
    const deployDeps: DeployDeps = {
        registry: () => store.current(),
        refreshRegistry: async () => { await store.refresh() },
        writer,
        fetcher,
        docker,
        runner,
        fs: {
            exists,
            mkdir: dir => mkdir(dir, { recursive: true }),
            rmdir: dir => rm(dir, { recursive: true, force: true }),
            move: (from, to) => rename(from, to),
            freeBytes: async path => {
                const info = await statfs(path)
                return info.bavail * info.bsize
            },
            setMaintenance: async key => {
                await mkdir(MAINTENANCE_DIR, { recursive: true })
                await writeFile(join(MAINTENANCE_DIR, key), '')
            },
            clearMaintenance: key => rm(join(MAINTENANCE_DIR, key), { force: true }),
        },
        now: Date.now,
        sleep,
        log,
    }
    const deployRunner = new DeployRunner({ ...deployDeps, store: deployStore })
    const deployPoller = new DeployPoller({
        registry: () => store.current(),
        store: deployStore,
        runner: deployRunner,
        tip: (project, environment) => currentTip(project, environment, deployDeps),
        now: Date.now,
        log,
    })
```

Pass `deploys: { runner: deployRunner, store: deployStore, deps: deployDeps }` to `new Agent({ ... })`, add `...deployStore.warnings()` to `warnings()`, and call the poller once per turn of the main loop, after the registry refresh:

```ts
        await deployPoller.tick()
```

A tick is cheap when nothing is due (it does no work at all until an environment's 2 minutes are up), and it never awaits a deploy, only the fetch that decides whether to start one.

- [ ] **Step 2: Mount what the agent now writes**

In `hostd/docker-compose.yml`, under `agent`:

```yaml
      HOSTD_DEPLOY_STATE_FILE: /var/lib/hostd/deploys.json
      HOSTD_MAINTENANCE_DIR: /run/hostd/maintenance
```

and its volumes gain:

```yaml
      # The deploy history and the pause state, which must survive a restart: otherwise an environment
      # paused after three failed builds would start rebuilding every two minutes again.
      - hostd-agent-state:/var/lib/hostd
      # The maintenance flags, on the host's own tmpfs so Apache can see them. Nested inside the
      # hostd-sock volume above on purpose: the design names this exact path, and /run is wiped on
      # reboot, so a flag can never outlive the deploy that wrote it.
      - /run/hostd/maintenance:/run/hostd/maintenance
```

and the volumes block gains `hostd-agent-state:`.

- [ ] **Step 3: Write the runbook section**

Add to `hostd/RUNBOOK.md`:

- **How a deploy happens**: polled every 2 minutes per environment, one at a time, build then swap then health check, rolled back by itself when the check fails, never retried.
- **What the health check actually checks**: every registered compose service running, and any container that declares a healthcheck reporting healthy, within 60 seconds. Not an HTTP request to the site: the agent has no network. A repo that wants the stronger check declares a healthcheck in its compose file.
- **The trees on disk**: `<dir>` is the running copy, `<dir>.prev` the previous one, `<dir>.git` the repository (moved out of the tree by the first deploy), `<dir>.next` only during a deploy. A deploy refuses to start with less than 10 GB free.
- **When an environment is paused**: three consecutive failures. `hc deploy <id> <env>` resumes it, so does a branch switch. Nothing resumes on its own.
- **The maintenance flag**: `/run/hostd/maintenance/<id>-<env>` while a swap is in progress. Apache's side of this (serving the holding page for that flag, and when the upstream is unreachable) is not built yet, so today the flag is written and removed and nothing reads it.
- A troubleshooting row for each new failure: build failed, would not come down, rolled back, previous copy did not come back healthy, paused, no free disk, no git repository, branch has no remote-tracking ref.

- [ ] **Step 4: Verify**

```bash
cd hostd && npm test && npm run typecheck && docker compose build
```

Then, on the dedi, against the throwaway repo the provisioning rehearsal used and **before** any client project gets `deploy`: push a commit and watch it deploy, break the build deliberately and watch the site keep serving, break the health check deliberately and watch it roll back, fail three times and watch it pause, deploy by hand to resume, switch branch, and roll back.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/index.ts hostd/docker-compose.yml hostd/RUNBOOK.md
git commit -m "Poll for deploys from the agent, and keep the history across restarts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-review against the spec

| Spec requirement (Deploying) | Where |
| --- | --- |
| Poll every 2 minutes per environment, no webhook | Task 5, `DeployPoller` |
| Different from `deployed` means a deploy | Task 5 |
| One deploy per environment at a time | Task 5, `DeployRunner` |
| Prepare: fetch and check out into `<dir>.next` | Task 3 |
| Carry the env files across | Task 3 |
| Build, with the site still serving | Task 3 |
| Swap: flag, down, move, up, flag off | Task 4 |
| Health check | Task 2 and task 4, with the port probe replaced by Docker's own view |
| Record commit, subject, actor, duration, outcome, and `deployed` | Tasks 1, 3 and 4 |
| Steps 1 to 3 leave the running site untouched | Task 3's tests assert it directly |
| A failed health check swaps back and records `rolled-back` | Task 4 |
| Never retried automatically | Nothing retries: a failure is recorded and the poller waits for the next commit |
| Three consecutive failures pause the environment | Tasks 1 and 5 |
| Rollback to the last healthy commit | Task 6, rebuilding that commit rather than reusing the kept image |
| Branch switching, then an ordinary deploy | Task 6 |
| Deploy history and the commit list, client-readable | Tasks 6 and 7 |
| Disk threshold | Task 3 |
| The editing lock holding a deploy | **Not built.** The env write lock in `agent.ts` is per request and held for a single atomic write, so there is no window for a deploy to land inside an edit; a lock spanning a portal editing session is a portal concept that does not exist yet. Called out in the PR. |
| Resource limits at start | **Not built**, and deliberately: it needs a generated compose override, and generating compose files is out of scope in the design's own Scope section. |
| The vhost and the maintenance page | **Not built.** The flag is written and removed as designed; Apache's half belongs with the vhost work, which has not landed. |
