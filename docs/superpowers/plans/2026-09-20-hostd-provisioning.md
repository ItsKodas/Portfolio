# hostd Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the portal create a client site from a Git repository, with live and test environments, env files it can edit, and a registry hostd writes itself.

**Architecture:** hostd gains a third container (`fetcher`) that does Git and holds the GitHub token but has no Docker socket. The agent keeps the socket, gains write access to `/var/www` and the registry directory, derives every path from the registry, and calls the fetcher over a Unix socket. The registry grows environments; single-environment entries keep working and mean "live only". Deployment itself (polling, build and swap, rollback) is a separate plan that builds on this one.

**Tech Stack:** Node 22 ESM with tsx, TypeScript, `node --test`, `yaml`, Docker Engine API over its socket, Docker Compose CLI, Alpine images.

**Spec:** `docs/superpowers/specs/2026-09-20-hostd-provisioning-design.md`. Read it before starting any task, along with the phase 1 design at `docs/superpowers/specs/2026-09-20-hostd-design.md`.

## Global Constraints

- **No em dashes** (U+2014) in any non-comment text: docs, runbook, commit messages, PR descriptions. Code comments are exempt.
- **Code style:** 4-space indentation, no semicolons, single quotes, comments that say why. Files sit beside their tests (`x.ts`, `x.test.ts`).
- **Tests:** `node --test` via tsx, `import { describe, it } from 'node:test'`, `import assert from 'node:assert/strict'`. No mocking library: fake the I/O boundary with plain object literals and a local `setup()` factory. Build registries by calling the real `parseRegistry()` on inline YAML.
- **The image build runs the whole suite** (`RUN npm test` in the Dockerfile's `base` stage), so a failing test blocks deployment.
- **The agent repeats every check itself.** `api` deciding something never lets the agent skip its own `checkStructure`.
- **Paths never come from the portal.** Every filesystem path the agent or fetcher acts on is derived from the registry entry.
- **Secrets never reach a log, an audit entry or an error message.** That covers env values and the GitHub token.
- **Commits** end with a blank line then `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; PR descriptions end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Run everything from `hostd/`: `npm test`, `npm run typecheck`.

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/shared/registry.ts` (modify) | Parse `repo`, `environments`, `limits`, `portEnv`; keep single-environment entries valid |
| `src/shared/registry-write.ts` (new) | Build the YAML for a changed registry and write it atomically, validating first |
| `src/shared/fetch-protocol.ts` (new) | The request and reply shapes the fetcher speaks, and their parser |
| `src/shared/ports.ts` (new) | Choose a free port from the configured range |
| `src/shared/envfiles.ts` (new) | Find env files in an environment, and decide whether a path may be written |
| `src/fetcher/git.ts` (new) | `clone`, `fetch`, `checkout`, `log` as functions over a Runner |
| `src/fetcher/index.ts` (new) | The fetcher entrypoint: boot checks, Unix socket server |
| `src/agent/fetch-client.ts` (new) | The agent's client for the fetcher socket |
| `src/agent/provision.ts` (new) | Create and delete projects and environments, end to end |
| `src/agent/env-files.ts` (new) | Read and write env files for one environment |
| `src/agent/agent.ts` (modify) | New verbs: `provision`, `env` |
| `src/shared/protocol.ts` (modify) | Those verbs, their arguments, and their capabilities |
| `src/api/routes.ts` (modify) | The new routes, admin-only, audited |
| `src/api/policy.ts` (modify) | `provision` and `env` verbs, admin-only |
| `Dockerfile`, `docker-compose.yml`, `example.env`, `RUNBOOK.md` (modify) | The fetcher container, the new mounts, the registry directory move |

---

### Task 1: Environments in the registry

**Files:**
- Modify: `hostd/src/shared/registry.ts`
- Modify: `hostd/src/shared/registry.test.ts`
- Modify: `hostd/projects.example.yaml`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `export const ENVIRONMENTS = ['live', 'test'] as const`; `export type EnvironmentName = typeof ENVIRONMENTS[number]`
  - `export type EnvironmentEntry = { name: EnvironmentName, dir: string, composePath: string, branch: string | null, domain: string | null, port: number, certificate: 'letsencrypt' | 'cloudflare-origin' | null, deployed: string | null }`
  - `ProjectEntry` gains: `repo: string | null`, `portEnv: string`, `limits: { memory: string | null, cpus: string | null }`, `environments: Map<EnvironmentName, EnvironmentEntry>`
  - `ProjectEntry.dir` and `.composePath` keep their meaning and equal the live environment's, so every phase 1 call site keeps working unchanged
  - `export function environmentOf(project: ProjectEntry, name: string): EnvironmentEntry | null`

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/registry.test.ts`:

```ts
describe('environments', () => {
    it('reads a single-environment entry as live only, with dir and port carried over', () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
`)
        const acme = registry.projects.get('acme')!
        assert.equal(acme.repo, null)
        assert.equal(acme.environments.size, 1)
        const live = acme.environments.get('live')!
        assert.equal(live.dir, '/var/www/acme')
        assert.equal(live.port, 5010)
        assert.equal(live.branch, null)
        assert.equal(live.deployed, null)
        assert.equal(acme.dir, live.dir)
    })

    it('reads two environments, each with its own branch, domain, port and deployed commit', () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    environments:
      live:
        dir: /var/www/acme
        branch: main
        domain: acme.com
        port: 5010
        certificate: letsencrypt
        deployed: 3f7c1a2
      test:
        dir: /var/www/acme-test
        branch: develop
        domain: test.acme.com
        port: 5110
        certificate: cloudflare-origin
`)
        const acme = registry.projects.get('acme')!
        assert.equal(acme.repo, 'git@github.com:ItsKodas/acme.git')
        assert.deepEqual([...acme.environments.keys()], ['live', 'test'])
        assert.equal(acme.environments.get('test')!.branch, 'develop')
        assert.equal(acme.environments.get('test')!.certificate, 'cloudflare-origin')
        assert.equal(acme.environments.get('live')!.deployed, '3f7c1a2')
        // The live environment is what the phase 1 fields mean
        assert.equal(acme.dir, '/var/www/acme')
        assert.equal(acme.upstream.port, 5010)
    })

    it('refuses an entry with both dir and environments, so there is one way to say it', () => {
        assert.equal(invalidReason('dir: /var/www/acme\n    environments: { live: { dir: /var/www/acme, port: 5010 } }'),
            'dir and environments cannot both be given')
    })

    it('requires a live environment, and refuses an unknown environment name', () => {
        assert.match(invalidReason('environments: { test: { dir: /var/www/acme-test, port: 5010 } }')!, /live/)
        assert.match(invalidReason('environments: { live: { dir: /var/www/a, port: 5010 }, staging: { dir: /var/www/b, port: 5011 } }')!, /staging/)
    })

    it('refuses two environments sharing a folder or a port', () => {
        assert.match(invalidReason('environments: { live: { dir: /var/www/a, port: 5010 }, test: { dir: /var/www/a, port: 5011 } }')!, /dir/)
        assert.match(invalidReason('environments: { live: { dir: /var/www/a, port: 5010 }, test: { dir: /var/www/b, port: 5010 } }')!, /port/)
    })

    it('refuses a branch or commit that is not a plain name', () => {
        assert.match(invalidReason('repo: git@github.com:x/y.git\n    environments: { live: { dir: /var/www/a, port: 5010, branch: "--upload-pack=evil" } }')!, /branch/)
    })

    it('refuses a repo that is not an ssh or https git URL', () => {
        assert.match(invalidReason('repo: "file:///etc/passwd"\n    environments: { live: { dir: /var/www/a, port: 5010 } }')!, /repo/)
    })

    it('reads limits and portEnv, with defaults', () => {
        const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
`)
        assert.deepEqual(registry.projects.get('acme')!.limits, { memory: '1g', cpus: '1' })
        assert.equal(registry.projects.get('acme')!.portEnv, 'WEB_PORT')
    })
})
```

`invalidReason(body)` is a helper to add beside the existing helpers in that file:

```ts
// Builds a one-project registry around the given body and returns why that project was rejected
function invalidReason(body: string): string | null {
    const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    services: { web: { role: site } }
    ${body}
`)
    return registry.invalid.get('acme') ?? null
}
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/registry.test.ts`
Expected: FAIL, `acme.repo` undefined and `environments` undefined.

- [ ] **Step 3: Implement**

In `hostd/src/shared/registry.ts`:

```ts
export const ENVIRONMENTS = ['live', 'test'] as const
export type EnvironmentName = typeof ENVIRONMENTS[number]

export const CERTIFICATE_MODES = ['letsencrypt', 'cloudflare-origin'] as const
export type CertificateMode = typeof CERTIFICATE_MODES[number]

export type EnvironmentEntry = {
    name: EnvironmentName
    dir: string
    composePath: string
    branch: string | null
    domain: string | null
    port: number
    certificate: CertificateMode | null
    deployed: string | null
}

// A git ref or branch name that cannot be read as an option or a path traversal
export const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/
export const GIT_COMMIT = /^[0-9a-f]{7,40}$/
// ssh (git@host:owner/repo.git) or https (https://host/owner/repo.git)
export const GIT_REPO = /^(git@[A-Za-z0-9.-]+:[A-Za-z0-9._\/-]+\.git|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+(\.git)?)$/

export const DEFAULT_LIMITS = { memory: '1g', cpus: '1' }
export const DEFAULT_PORT_ENV = 'WEB_PORT'
```

Parsing rules, added to `parseProject`:

- `repo`: optional, must match `GIT_REPO`, default `null`. A project with `environments` and branches but no `repo` is a problem: `branch needs repo`.
- `portEnv`: optional, must match `ENV_NAME`, default `DEFAULT_PORT_ENV`.
- `limits`: optional mapping with optional `memory` (`/^[0-9]+(b|k|m|g)$/i`) and `cpus` (`/^[0-9]+(\.[0-9]+)?$/`), each defaulting from `DEFAULT_LIMITS`.
- `environments`: optional mapping. When absent, one entry is synthesised from the existing `dir`, `compose` and `upstream`: `{ name: 'live', dir, composePath, branch: null, domain: null, port: upstream.port, certificate: null, deployed: null }`. When present, `dir`, `compose` and `upstream` at project level are refused (`dir and environments cannot both be given`), a `live` key is required, every key must be in `ENVIRONMENTS`, and each environment parses:
  - `dir`: same rule as today's project `dir`
  - `compose`: optional, default `'docker-compose.yml'`, `composePath = posix.join(dir, compose)`
  - `branch`: optional, `GIT_REF`
  - `domain`: optional, `HOSTNAME`, and not at or below a `reserved` entry
  - `port`: required, whole number 1 to 65535
  - `certificate`: optional, from `CERTIFICATE_MODES`
  - `deployed`: optional, `GIT_COMMIT`
- Two environments may not share a `dir` (`environments live and test share dir <dir>`) or a `port` (`... share port <port>`).
- After parsing, `project.dir`, `project.composePath` and `project.upstream` are set from the live environment, so every phase 1 caller keeps working.
- The cross-project checks that exist today (two projects sharing a `dir`) now compare **every** environment's `dir` across every project.

Add:

```ts
export function environmentOf(project: ProjectEntry, name: string): EnvironmentEntry | null {
    return (ENVIRONMENTS as readonly string[]).includes(name)
        ? project.environments.get(name as EnvironmentName) ?? null
        : null
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: every test passes, including the existing ones, which prove single-environment entries still parse.

- [ ] **Step 5: Document the new shape**

Add a commented two-environment example to `hostd/projects.example.yaml`, beneath the existing one, showing `repo`, `environments`, `limits` and `portEnv`, and a line saying that an entry without `environments` means live only.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/shared/registry.ts hostd/src/shared/registry.test.ts hostd/projects.example.yaml
git commit -m "Give a project environments, a repo and limits

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Writing the registry

**Files:**
- Create: `hostd/src/shared/registry-write.ts`
- Test: `hostd/src/shared/registry-write.test.ts`

**Interfaces:**
- Consumes: `parseRegistry`, `RegistryError`, `Registry`, `ProjectEntry`, `EnvironmentEntry` (Task 1)
- Produces:
  - `export type RegistryWriteFs = { readFile(path: string): Promise<string>, writeFile(path: string, text: string): Promise<void>, rename(from: string, to: string): Promise<void>, unlink(path: string): Promise<void> }`
  - `export type Change = { kind: 'add-project', id: string, project: ProjectDraft } | { kind: 'add-environment', id: string, environment: EnvironmentDraft } | { kind: 'set-deployed', id: string, environment: EnvironmentName, commit: string } | { kind: 'remove-project', id: string } | { kind: 'remove-environment', id: string, environment: EnvironmentName }`
  - `export type ProjectDraft = { client: string, name: string, repo: string, services: Record<string, { role: 'site' } | { role: 'database', engine: string }>, environment: EnvironmentDraft }`
  - `export type EnvironmentDraft = { name: EnvironmentName, dir: string, branch: string, domain: string | null, port: number, certificate: CertificateMode | null }`
  - `export function applyChange(text: string, change: Change): { ok: true, text: string } | { ok: false, problem: string }`
  - `export class RegistryWriter { constructor(path: string, fs?: RegistryWriteFs); async write(change: Change): Promise<{ ok: true } | { ok: false, problem: string }> }`

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/shared/registry-write.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from './registry.ts'
import { RegistryWriter, applyChange, type Change, type RegistryWriteFs } from './registry-write.ts'

const BASE = `reserved: [horizons.gg]
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    environments:
      live:
        dir: /var/www/acme
        branch: main
        domain: acme.com
        port: 5010
        certificate: letsencrypt
`

const addProject: Change = {
    kind: 'add-project',
    id: 'bakery',
    project: {
        client: 'cl_2', name: 'Bakery', repo: 'git@github.com:ItsKodas/bakery.git',
        services: { web: { role: 'site' } },
        environment: { name: 'live', dir: '/var/www/bakery', branch: 'main', domain: 'bakery.com', port: 5011, certificate: 'letsencrypt' },
    },
}

describe('applyChange', () => {
    it('adds a project that parses back with the fields it was given', () => {
        const result = applyChange(BASE, addProject)
        assert.ok(result.ok)
        const registry = parseRegistry(result.text)
        const bakery = registry.projects.get('bakery')!
        assert.equal(bakery.name, 'Bakery')
        assert.equal(bakery.environments.get('live')!.port, 5011)
        // and the project that was already there is untouched
        assert.equal(registry.projects.get('acme')!.environments.get('live')!.domain, 'acme.com')
    })

    it('keeps comments and unrelated formatting in the file', () => {
        const withComment = `# hand written note\n${BASE}`
        const result = applyChange(withComment, addProject)
        assert.ok(result.ok)
        assert.match(result.text, /# hand written note/)
    })

    it('adds an environment to an existing project', () => {
        const result = applyChange(BASE, {
            kind: 'add-environment', id: 'acme',
            environment: { name: 'test', dir: '/var/www/acme-test', branch: 'develop', domain: 'test.acme.com', port: 5110, certificate: 'letsencrypt' },
        })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('test')!.branch, 'develop')
    })

    it('records a deployed commit', () => {
        const result = applyChange(BASE, { kind: 'set-deployed', id: 'acme', environment: 'live', commit: '9a1b2c3' })
        assert.ok(result.ok)
        assert.equal(parseRegistry(result.text).projects.get('acme')!.environments.get('live')!.deployed, '9a1b2c3')
    })

    it('removes a project and an environment', () => {
        const gone = applyChange(BASE, { kind: 'remove-project', id: 'acme' })
        assert.ok(gone.ok)
        assert.equal(parseRegistry(gone.text).projects.size, 0)
    })

    it('refuses a change that would produce a registry hostd would reject', () => {
        const clash = applyChange(BASE, { ...addProject, project: { ...addProject.project, environment: { ...addProject.project.environment, dir: '/var/www/acme' } } })
        assert.equal(clash.ok, false)
        assert.match(clash.ok === false ? clash.problem : '', /dir/)
    })

    it('refuses an id that already exists, and one that is reserved', () => {
        assert.equal(applyChange(BASE, { ...addProject, id: 'acme' }).ok, false)
        assert.equal(applyChange(BASE, { ...addProject, id: 'mail' }).ok, false)
    })

    it('refuses a change to a project that is not there', () => {
        assert.equal(applyChange(BASE, { kind: 'set-deployed', id: 'ghost', environment: 'live', commit: '9a1b2c3' }).ok, false)
    })
})

describe('RegistryWriter', () => {
    function fakeFs(initial: string) {
        const files = new Map<string, string>([['/etc/hostd/projects.yaml', initial]])
        const calls: string[] = []
        const fs: RegistryWriteFs = {
            readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
            writeFile: async (path, text) => { calls.push(`write ${path}`); files.set(path, text) },
            rename: async (from, to) => { calls.push(`rename ${from} -> ${to}`); files.set(to, files.get(from)!); files.delete(from) },
            unlink: async path => { calls.push(`unlink ${path}`); files.delete(path) },
        }
        return { fs, files, calls }
    }

    it('writes a temporary file beside the registry and renames it over the original', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        assert.deepEqual(await writer.write(addProject), { ok: true })
        assert.deepEqual(calls, ['write /etc/hostd/.projects.yaml.tmp', 'rename /etc/hostd/.projects.yaml.tmp -> /etc/hostd/projects.yaml'])
        assert.match(files.get('/etc/hostd/projects.yaml')!, /bakery/)
    })

    it('leaves the file untouched when the change is refused', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const result = await writer.write({ ...addProject, id: 'acme' })
        assert.equal(result.ok, false)
        assert.equal(files.get('/etc/hostd/projects.yaml'), BASE)
        assert.deepEqual(calls, [])
    })

    it('removes the temporary file when the rename fails, and reports the problem', async () => {
        const { fs, files, calls } = fakeFs(BASE)
        fs.rename = async () => { throw new Error('read-only file system') }
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const result = await writer.write(addProject)
        assert.equal(result.ok, false)
        assert.equal(files.get('/etc/hostd/projects.yaml'), BASE)
        assert.ok(calls.includes('unlink /etc/hostd/.projects.yaml.tmp'))
    })

    it('serialises concurrent writes, so two additions both survive', async () => {
        const { fs, files } = fakeFs(BASE)
        const writer = new RegistryWriter('/etc/hostd/projects.yaml', fs)
        const second: Change = { ...addProject, id: 'cafe', project: { ...addProject.project, name: 'Cafe', environment: { ...addProject.project.environment, dir: '/var/www/cafe', port: 5012 } } }
        const [a, b] = await Promise.all([writer.write(addProject), writer.write(second)])
        assert.deepEqual([a, b], [{ ok: true }, { ok: true }])
        const registry = parseRegistry(files.get('/etc/hostd/projects.yaml')!)
        assert.deepEqual([...registry.projects.keys()].sort(), ['acme', 'bakery', 'cafe'])
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/registry-write.test.ts`
Expected: FAIL, cannot resolve `./registry-write.ts`.

- [ ] **Step 3: Implement**

Create `hostd/src/shared/registry-write.ts`:

```ts
// The only code that writes the registry. Every change is applied to the document, parsed back with the
// same validator hostd uses at load, and only then written: a write can never produce a file hostd would
// refuse to load. Editing the parsed YAML document rather than re-serialising the Registry keeps the
// operator's comments and hand-written formatting intact.

import { parseDocument, type Document } from 'yaml'

import { parseRegistry, RegistryError, type CertificateMode, type EnvironmentName } from './registry.ts'
import { describeError, RESERVED_PROJECT_IDS, PROJECT_ID } from './formats.ts'

export type RegistryWriteFs = {
    readFile(path: string): Promise<string>
    writeFile(path: string, text: string): Promise<void>
    rename(from: string, to: string): Promise<void>
    unlink(path: string): Promise<void>
}

export type EnvironmentDraft = {
    name: EnvironmentName
    dir: string
    branch: string
    domain: string | null
    port: number
    certificate: CertificateMode | null
}

export type ProjectDraft = {
    client: string
    name: string
    repo: string
    services: Record<string, { role: 'site' } | { role: 'database', engine: string }>
    environment: EnvironmentDraft
}

export type Change =
    | { kind: 'add-project', id: string, project: ProjectDraft }
    | { kind: 'add-environment', id: string, environment: EnvironmentDraft }
    | { kind: 'set-deployed', id: string, environment: EnvironmentName, commit: string }
    | { kind: 'remove-project', id: string }
    | { kind: 'remove-environment', id: string, environment: EnvironmentName }

const environmentNode = (draft: EnvironmentDraft) => ({
    dir: draft.dir,
    branch: draft.branch,
    ...(draft.domain ? { domain: draft.domain } : {}),
    port: draft.port,
    ...(draft.certificate ? { certificate: draft.certificate } : {}),
})

function edit(doc: Document, change: Change): string | null {
    const projects = doc.getIn(['projects'])
    if (!projects) return 'the registry has no projects section'
    const has = (id: string) => doc.hasIn(['projects', id])

    switch (change.kind) {
        case 'add-project':
            if (!PROJECT_ID.test(change.id)) return `${change.id} is not a valid project id`
            if (RESERVED_PROJECT_IDS.has(change.id)) return `${change.id} is reserved`
            if (has(change.id)) return `${change.id} already exists`
            doc.setIn(['projects', change.id], {
                client: change.project.client,
                name: change.project.name,
                repo: change.project.repo,
                services: change.project.services,
                environments: { [change.project.environment.name]: environmentNode(change.project.environment) },
            })
            return null
        case 'add-environment':
            if (!has(change.id)) return `${change.id} is not registered`
            if (doc.hasIn(['projects', change.id, 'environments', change.environment.name])) {
                return `${change.id} already has a ${change.environment.name} environment`
            }
            doc.setIn(['projects', change.id, 'environments', change.environment.name], environmentNode(change.environment))
            return null
        case 'set-deployed':
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return `${change.id} has no ${change.environment} environment`
            }
            doc.setIn(['projects', change.id, 'environments', change.environment, 'deployed'], change.commit)
            return null
        case 'remove-project':
            if (!has(change.id)) return `${change.id} is not registered`
            doc.deleteIn(['projects', change.id])
            return null
        case 'remove-environment':
            if (change.environment === 'live') return 'the live environment cannot be removed on its own'
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return `${change.id} has no ${change.environment} environment`
            }
            doc.deleteIn(['projects', change.id, 'environments', change.environment])
            return null
    }
}

export function applyChange(text: string, change: Change): { ok: true, text: string } | { ok: false, problem: string } {
    let doc: Document
    try {
        doc = parseDocument(text)
        if (doc.errors.length > 0) return { ok: false, problem: doc.errors[0].message }
    } catch (error) {
        return { ok: false, problem: describeError(error) }
    }

    const problem = edit(doc, change)
    if (problem) return { ok: false, problem }

    const next = doc.toString()
    // The same validator that runs at load, so a write can never produce a file hostd would refuse
    let registry
    try {
        registry = parseRegistry(next)
    } catch (error) {
        return { ok: false, problem: error instanceof RegistryError ? error.failures.join('; ') : describeError(error) }
    }
    const id = change.id
    const invalid = registry.invalid.get(id)
    if (invalid) return { ok: false, problem: invalid }
    if (change.kind !== 'remove-project' && !registry.projects.has(id)) return { ok: false, problem: `${id} did not survive the change` }
    return { ok: true, text: next }
}

export class RegistryWriter {
    // One write at a time: two callers adding a project must not both read the same text and lose one.
    private queue: Promise<unknown> = Promise.resolve()

    constructor(private readonly path: string, private readonly fs: RegistryWriteFs = nodeFs) {}

    async write(change: Change): Promise<{ ok: true } | { ok: false, problem: string }> {
        const run = this.queue.then(() => this.writeNow(change), () => this.writeNow(change))
        this.queue = run.catch(() => {})
        return run
    }

    private async writeNow(change: Change): Promise<{ ok: true } | { ok: false, problem: string }> {
        let text: string
        try {
            text = await this.fs.readFile(this.path)
        } catch (error) {
            return { ok: false, problem: `the registry could not be read: ${describeError(error)}` }
        }
        const applied = applyChange(text, change)
        if (!applied.ok) return applied

        // Same directory, so the rename is atomic: a crash leaves either the old file or the new one.
        const temporary = this.path.replace(/([^/]+)$/, '.$1.tmp')
        try {
            await this.fs.writeFile(temporary, applied.text)
            await this.fs.rename(temporary, this.path)
        } catch (error) {
            await this.fs.unlink(temporary).catch(() => {})
            return { ok: false, problem: `the registry could not be written: ${describeError(error)}` }
        }
        return { ok: true }
    }
}
```

`nodeFs` is the obvious wrapper over `node:fs/promises` (`readFile` with `'utf8'`, `writeFile` with `'utf8'`, `rename`, `unlink`), defined in the same file.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/registry-write.ts hostd/src/shared/registry-write.test.ts
git commit -m "Write the registry atomically, validating before the rename

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The fetcher's protocol and Git commands

**Files:**
- Create: `hostd/src/shared/fetch-protocol.ts`, `hostd/src/fetcher/git.ts`
- Test: `hostd/src/shared/fetch-protocol.test.ts`, `hostd/src/fetcher/git.test.ts`

**Interfaces:**
- Consumes: `Runner`, `RunResult` from `src/agent/compose.ts` (move nothing: import the type)
- Produces:
  - `export type FetchRequest = { verb: 'clone', repo: string, dir: string, branch: string } | { verb: 'fetch', dir: string } | { verb: 'checkout', dir: string, worktree: string, commit: string } | { verb: 'log', dir: string, branch: string, limit: number } | { verb: 'tip', dir: string, branch: string }`
  - `export type Commit = { commit: string, subject: string, author: string, at: string }`
  - `export type FetchReply = { ok: true, commit?: string, commits?: Commit[] } | { ok: false, code: 'bad-request' | 'failed' | 'unavailable', message: string }`
  - `export function parseFetchRequest(line: string): { ok: true, request: FetchRequest } | FetchReply`
  - `git.ts`: `export function cloneArgv(repo: string, dir: string, branch: string): string[]`, `fetchArgv(dir)`, `checkoutArgv(dir, worktree, commit)`, `logArgv(dir, branch, limit)`, `tipArgv(dir, branch)`, and `export async function runGit(request: FetchRequest, run: Runner): Promise<FetchReply>`
  - `export function parseLog(stdout: string): Commit[]`

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/shared/fetch-protocol.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseFetchRequest } from './fetch-protocol.ts'

const refusalOf = (value: unknown) => {
    const result = parseFetchRequest(JSON.stringify(value))
    return result.ok === true ? null : result.message
}

describe('parseFetchRequest', () => {
    it('reads a clone', () => {
        const result = parseFetchRequest(JSON.stringify({ verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main' }))
        assert.deepEqual(result, { ok: true, request: { verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main' } })
    })

    it('refuses an unknown verb and unknown fields', () => {
        assert.equal(refusalOf({ verb: 'push', dir: '/var/www/b' }), 'unknown verb')
        assert.equal(refusalOf({ verb: 'fetch', dir: '/var/www/b', remote: 'evil' }), 'fetch takes only dir')
    })

    it('refuses anything outside /var/www, and any traversal', () => {
        assert.match(refusalOf({ verb: 'fetch', dir: '/etc' })!, /dir/)
        assert.match(refusalOf({ verb: 'fetch', dir: '/var/www/../etc' })!, /dir/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b', worktree: '/etc/x', commit: 'a1b2c3d' })!, /worktree/)
    })

    it('refuses a branch, commit or repo that could be read as an option', () => {
        assert.match(refusalOf({ verb: 'clone', repo: '--upload-pack=evil', dir: '/var/www/b', branch: 'main' })!, /repo/)
        assert.match(refusalOf({ verb: 'log', dir: '/var/www/b', branch: '--all', limit: 10 })!, /branch/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b', worktree: '/var/www/b.next', commit: 'HEAD;rm -rf /' })!, /commit/)
    })

    it('bounds the log limit', () => {
        assert.match(refusalOf({ verb: 'log', dir: '/var/www/b', branch: 'main', limit: 100000 })!, /limit/)
    })
})
```

Create `hostd/src/fetcher/git.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { cloneArgv, checkoutArgv, parseLog, runGit } from './git.ts'
import type { Runner, RunResult } from '../agent/compose.ts'

const ok: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false }

function recorder(results: RunResult[] = [ok]) {
    const runs: string[][] = []
    let index = 0
    const run: Runner = async (command, args) => {
        runs.push([command, ...args])
        return results[Math.min(index++, results.length - 1)]
    }
    return { run, runs }
}

describe('argv', () => {
    it('clones one branch, without running repo hooks or prompting', () => {
        assert.deepEqual(cloneArgv('git@github.com:a/b.git', '/var/www/b', 'main'),
            ['clone', '--branch', 'main', '--single-branch', '--', 'git@github.com:a/b.git', '/var/www/b'])
    })

    it('checks a commit out into a separate tree without touching the original', () => {
        assert.deepEqual(checkoutArgv('/var/www/b', '/var/www/b.next', 'a1b2c3d'),
            ['-C', '/var/www/b', 'worktree', 'add', '--detach', '--force', '/var/www/b.next', 'a1b2c3d'])
    })
})

describe('parseLog', () => {
    it('reads the record-separated format back into commits', () => {
        const stdout = 'a1b2c3dAdd the thingKoda2026-09-20T01:00:00Z9d8c7b6Fix itKoda2026-09-19T01:00:00Z'
        assert.deepEqual(parseLog(stdout), [
            { commit: 'a1b2c3d', subject: 'Add the thing', author: 'Koda', at: '2026-09-20T01:00:00Z' },
            { commit: '9d8c7b6', subject: 'Fix it', author: 'Koda', at: '2026-09-19T01:00:00Z' },
        ])
    })

    it('copes with a subject containing newlines and separators', () => {
        assert.deepEqual(parseLog('a1b2c3done\ntwoKoda2026-09-20T01:00:00Z'),
            [{ commit: 'a1b2c3d', subject: 'one\ntwo', author: 'Koda', at: '2026-09-20T01:00:00Z' }])
    })

    it('returns nothing for empty output', () => {
        assert.deepEqual(parseLog(''), [])
    })
})

describe('runGit', () => {
    it('reports the commit it cloned', async () => {
        const { run, runs } = recorder([ok, { ...ok, stdout: 'a1b2c3d4e5f6\n' }])
        const reply = await runGit({ verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main' }, run)
        assert.deepEqual(reply, { ok: true, commit: 'a1b2c3d4e5f6' })
        assert.equal(runs[0][1], 'clone')
    })

    it('reports a failure with git's message, not a stack', async () => {
        const { run } = recorder([{ exitCode: 128, stdout: '', stderr: 'fatal: repository not found', timedOut: false }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b' }, run)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'fatal: repository not found' })
    })

    it('never puts the token in a message', async () => {
        const { run } = recorder([{ exitCode: 128, stdout: '', stderr: 'fatal: https://x-access-token:ghp_secret@github.com/a/b.git not found', timedOut: false }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b' }, run)
        assert.equal(reply.ok, false)
        assert.ok(!JSON.stringify(reply).includes('ghp_secret'))
    })

    it('calls a timeout what it is', async () => {
        const { run } = recorder([{ exitCode: null, stdout: '', stderr: '', timedOut: true }])
        const reply = await runGit({ verb: 'fetch', dir: '/var/www/b' }, run)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'git fetch timed out' })
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/fetch-protocol.test.ts src/fetcher/git.test.ts`
Expected: FAIL, neither module exists.

- [ ] **Step 3: Implement the protocol**

Create `hostd/src/shared/fetch-protocol.ts`. It mirrors `protocol.ts`: one `switch` on the verb, an `onlyKeys` guard per verb, and every field validated before it is read.

- `dir` and `worktree`: must match `/^\/var\/www\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, refused otherwise (`dir must be a folder directly under /var/www`). This is what stops any path from the caller reaching Git.
- `repo`: `GIT_REPO` from `registry.ts`.
- `branch`: `GIT_REF`. `commit`: `GIT_COMMIT`. Both refuse anything starting with `-`, which is what keeps a value from being read as an option.
- `limit`: a whole number, 1 to 500.

Create `hostd/src/fetcher/git.ts`:

```ts
// Git, as a set of argument lists and one runner. Every value is validated by fetch-protocol before it
// arrives, and `--` separates options from arguments everywhere a value could otherwise look like one.

import { tail, type Runner } from '../agent/compose.ts'
import type { Commit, FetchReply, FetchRequest } from '../shared/fetch-protocol.ts'

export const GIT_TIMEOUT_MS = 300_000
const FIELD = ''
const RECORD = ''

export const cloneArgv = (repo: string, dir: string, branch: string) =>
    ['clone', '--branch', branch, '--single-branch', '--', repo, dir]
export const fetchArgv = (dir: string) => ['-C', dir, 'fetch', '--prune', '--', 'origin']
export const checkoutArgv = (dir: string, worktree: string, commit: string) =>
    ['-C', dir, 'worktree', 'add', '--detach', '--force', worktree, commit]
export const logArgv = (dir: string, branch: string, limit: number) =>
    ['-C', dir, 'log', `--max-count=${limit}`, `--format=%h${FIELD}%s${FIELD}%an${FIELD}%aI${RECORD}`, `origin/${branch}`, '--']
export const tipArgv = (dir: string, branch: string) => ['-C', dir, 'rev-parse', `origin/${branch}`, '--']
const headArgv = (dir: string) => ['-C', dir, 'rev-parse', 'HEAD', '--']

export function parseLog(stdout: string): Commit[] {
    return stdout.split(RECORD).map(record => record.trim()).filter(Boolean).map(record => {
        const [commit, subject, author, at] = record.split(FIELD)
        return { commit, subject, author, at }
    })
}
```

`runGit(request, run)` switches on the verb, runs the argument list with `GIT_TIMEOUT_MS`, and maps the result:

- `timedOut` becomes `{ ok: false, code: 'failed', message: 'git <verb> timed out' }`
- a non-zero exit becomes `{ ok: false, code: 'failed', message: redact(tail(stderr) || tail(stdout)) }`
- success becomes `{ ok: true }`, plus `commit` for `clone` (a `rev-parse HEAD` after the clone), `tip`, and `checkout`, and `commits` for `log`

`redact(text)` replaces anything matching `/:\/\/[^@\s]+@/g` with `://***@` and any `ghp_[A-Za-z0-9]+` or `github_pat_[A-Za-z0-9_]+` with `***`, so a token in Git's own error text cannot reach an audit entry.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/fetch-protocol.ts hostd/src/shared/fetch-protocol.test.ts hostd/src/fetcher/git.ts hostd/src/fetcher/git.test.ts
git commit -m "Speak Git behind a validated protocol

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Choosing a port

**Files:**
- Create: `hostd/src/shared/ports.ts`
- Test: `hostd/src/shared/ports.test.ts`

**Interfaces:**
- Consumes: `Registry` (Task 1)
- Produces:
  - `export const PORT_RANGE = { from: 5000, to: 5999 }`; `export type PortRange = { from: number, to: number }`
  - `export type PortCheck = (port: number) => Promise<boolean>` (true when something is already listening)
  - `export function takenPorts(registry: Registry): Set<number>`
  - `export async function choosePort(registry: Registry, inUse: PortCheck, range?: PortRange): Promise<{ ok: true, port: number } | { ok: false, problem: string }>`
  - `export const listeningOnHost: PortCheck`

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/shared/ports.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from './registry.ts'
import { choosePort, takenPorts, type PortCheck } from './ports.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:a/acme.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5000 }
      test: { dir: /var/www/acme-test, port: 5001 }
`)

const free: PortCheck = async () => false

describe('takenPorts', () => {
    it('collects the port of every environment', () => {
        assert.deepEqual([...takenPorts(registry)].sort(), [5000, 5001])
    })
})

describe('choosePort', () => {
    it('gives the lowest port the registry is not using', async () => {
        assert.deepEqual(await choosePort(registry, free), { ok: true, port: 5002 })
    })

    it('skips a port something is already listening on, even when the registry does not know it', async () => {
        const busy: PortCheck = async port => port === 5002 || port === 5003
        assert.deepEqual(await choosePort(registry, busy), { ok: true, port: 5004 })
    })

    it('refuses when the range is full, naming the range', async () => {
        const result = await choosePort(registry, async () => true, { from: 5000, to: 5002 })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /5000 to 5002/)
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/ports.test.ts`
Expected: FAIL, cannot resolve `./ports.ts`.

- [ ] **Step 3: Implement**

Create `hostd/src/shared/ports.ts`:

```ts
// Which port a new environment gets. Two sources of truth, because either alone is wrong: the registry
// knows about environments that are not running, and the host knows about everything else on the box.

import { createServer } from 'node:net'

import type { Registry } from './registry.ts'

export const PORT_RANGE = { from: 5000, to: 5999 }
export type PortRange = { from: number, to: number }
export type PortCheck = (port: number) => Promise<boolean>

export function takenPorts(registry: Registry): Set<number> {
    const taken = new Set<number>()
    for (const project of registry.projects.values()) {
        for (const environment of project.environments.values()) taken.add(environment.port)
    }
    return taken
}

export const listeningOnHost: PortCheck = port => new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(false)))
})

export async function choosePort(registry: Registry, inUse: PortCheck, range: PortRange = PORT_RANGE) {
    const taken = takenPorts(registry)
    for (let port = range.from; port <= range.to; port++) {
        if (taken.has(port)) continue
        if (await inUse(port)) continue
        return { ok: true as const, port }
    }
    return { ok: false as const, problem: `no free port between ${range.from} and ${range.to}` }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/ports.ts hostd/src/shared/ports.test.ts
git commit -m "Choose a free port for a new environment

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Finding and editing env files

**Files:**
- Create: `hostd/src/shared/envfiles.ts`, `hostd/src/agent/env-files.ts`
- Test: `hostd/src/shared/envfiles.test.ts`, `hostd/src/agent/env-files.test.ts`

**Interfaces:**
- Consumes: `EnvironmentEntry` (Task 1)
- Produces:
  - `envfiles.ts`: `export function isEnvFileName(name: string): boolean`; `export function envPathProblem(relative: string): string | null`; `export const SKIP_DIRECTORIES: Set<string>`; `export const MAX_ENV_BYTES = 64 * 1024`; `export const MAX_ENV_DEPTH = 4`
  - `env-files.ts`: `export type EnvFileList = { path: string, example: string | null, bytes: number }[]`; `export type EnvFs = { readdir(dir: string): Promise<{ name: string, isDirectory(): boolean, isFile(): boolean }[]>, readFile(path: string): Promise<string>, writeFile(path: string, text: string): Promise<void>, rename(from: string, to: string): Promise<void>, stat(path: string): Promise<{ size: number }> }`; `export async function listEnvFiles(environment: EnvironmentEntry, fs?: EnvFs): Promise<EnvFileList>`; `export async function readEnvFile(environment: EnvironmentEntry, relative: string, fs?: EnvFs): Promise<{ ok: true, text: string } | { ok: false, problem: string }>`; `export async function writeEnvFile(environment: EnvironmentEntry, relative: string, text: string, fs?: EnvFs): Promise<{ ok: true } | { ok: false, problem: string }>`

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/shared/envfiles.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { envPathProblem, isEnvFileName } from './envfiles.ts'

describe('isEnvFileName', () => {
    it('recognises the shapes a project actually uses', () => {
        for (const name of ['.env', '.env.local', '.env.test', '.env.production', 'app.env', '.env.example']) {
            assert.equal(isEnvFileName(name), true, name)
        }
    })

    it('rejects anything else, including files that merely mention env', () => {
        for (const name of ['docker-compose.yml', 'environment.ts', 'env.js', '.environment', 'README.md']) {
            assert.equal(isEnvFileName(name), false, name)
        }
    })
})

describe('envPathProblem', () => {
    it('accepts a relative path to an env file, including one in a subfolder', () => {
        assert.equal(envPathProblem('.env'), null)
        assert.equal(envPathProblem('api/.env.test'), null)
    })

    it('refuses an absolute path, a traversal, and a path that leaves the folder', () => {
        assert.match(envPathProblem('/etc/passwd'), /relative/)
        assert.match(envPathProblem('../.env'), /outside/)
        assert.match(envPathProblem('api/../../.env'), /outside/)
    })

    it('refuses a file that is not an env file, which is what keeps this from editing code', () => {
        assert.match(envPathProblem('src/index.ts'), /env file/)
        assert.match(envPathProblem('docker-compose.yml'), /env file/)
    })

    it('refuses a path deeper than the limit', () => {
        assert.match(envPathProblem('a/b/c/d/e/.env'), /deep/)
    })
})
```

Create `hostd/src/agent/env-files.test.ts` with a fake `EnvFs` over an in-memory tree, proving:

```ts
it('lists every env file in the environment, with its example beside it', async () => {})
it('skips .git and node_modules, which can hold thousands of files', async () => {})
it('refuses to read or write anything that is not an env file, and writes nothing', async () => {})
it('refuses text larger than the limit', async () => {})
it('writes through a temporary file and renames, so a crash cannot truncate a live env file', async () => {})
it('reports a missing file as a problem rather than throwing', async () => {})
it('never includes file contents in a problem message', async () => {})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/shared/envfiles.test.ts src/agent/env-files.test.ts`
Expected: FAIL, neither module exists.

- [ ] **Step 3: Implement**

Create `hostd/src/shared/envfiles.ts`:

```ts
// Which files the portal may edit. Deliberately narrow: an env file, inside one environment's folder,
// nothing else. This is the whole reason the env capability cannot be used to change code.

export const MAX_ENV_BYTES = 64 * 1024
export const MAX_ENV_DEPTH = 4
export const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'vendor', 'dist', '.next'])

const ENV_FILE = /^(\.env(\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+\.env)$/

export const isEnvFileName = (name: string) => ENV_FILE.test(name)

export function envPathProblem(relative: string): string | null {
    if (!relative || relative.startsWith('/')) return 'the path must be relative to the environment folder'
    if (relative.includes('\0') || relative.includes('\\')) return 'the path is not valid'
    const parts = relative.split('/')
    if (parts.some(part => part === '' || part === '.' || part === '..')) return 'the path must not point outside the environment folder'
    if (parts.length > MAX_ENV_DEPTH) return `the path is more than ${MAX_ENV_DEPTH} folders deep`
    if (!isEnvFileName(parts[parts.length - 1])) return 'that is not an env file'
    return null
}
```

`env-files.ts` walks `environment.dir` with `readdir(..., { withFileTypes: true })`, skipping `SKIP_DIRECTORIES`, stopping at `MAX_ENV_DEPTH`, and collecting names `isEnvFileName` accepts. For each file it records its size and, when a sibling `.env.example` or `<name>.example` exists, that path as `example`. Reads and writes call `envPathProblem` first and then join onto `environment.dir`; a write goes to `<file>.tmp` in the same directory and is renamed over the target, and refuses text over `MAX_ENV_BYTES`. Every failure is returned, never thrown, and never includes file contents.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/envfiles.ts hostd/src/shared/envfiles.test.ts hostd/src/agent/env-files.ts hostd/src/agent/env-files.test.ts
git commit -m "Find and edit env files, and nothing else

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The fetcher service and the agent's client for it

**Files:**
- Create: `hostd/src/fetcher/index.ts`, `hostd/src/fetcher/server.ts`, `hostd/src/agent/fetch-client.ts`
- Test: `hostd/src/fetcher/server.test.ts`, `hostd/src/agent/fetch-client.test.ts`

**Interfaces:**
- Consumes: `parseFetchRequest`, `runGit` (Task 3), `createSpawnRunner`, `readRequestLine` (`src/agent/server.ts`)
- Produces:
  - `server.ts`: `export async function handleFetchConnection(socket: Duplex, run: (request: FetchRequest) => Promise<FetchReply>, log: (message: string) => void): Promise<void>`
  - `fetch-client.ts`: `export class FetcherUnavailableError extends Error {}`; `export type FetchClient = { call(request: FetchRequest): Promise<FetchReply> }`; `export function createFetchClient(connect: () => Duplex, options?: { timeoutMs?: number }): FetchClient`; `export const FETCH_TIMEOUT_MS = 330_000`

- [ ] **Step 1: Write the failing tests**

`server.test.ts` drives `handleFetchConnection` over a `PassThrough` pair, mirroring `src/agent/server.test.ts`:

```ts
it('answers one request per connection and ends the socket', async () => {})
it('refuses an oversized line without reading all of it', async () => {})
it('refuses a malformed request with bad-request, and never calls git', async () => {})
it('turns a thrown error into unavailable rather than crashing the process', async () => {})
it('logs every request with its verb and outcome, and never a credential', async () => {})
```

`fetch-client.test.ts` mirrors `src/api/agent-client.test.ts`:

```ts
it('writes one JSON line and reads one reply', async () => {})
it('throws FetcherUnavailableError when the socket closes with no reply', async () => {})
it('throws FetcherUnavailableError on timeout, and closes the socket', async () => {})
it('passes a refusal through unchanged', async () => {})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/fetcher/server.test.ts src/agent/fetch-client.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`server.ts` follows `src/agent/server.ts`: read one line with `readRequestLine`, `parseFetchRequest`, call `run`, write one JSON line, end. There is no streaming, so it is the simpler half of that file.

`index.ts`, the fetcher entrypoint, follows `src/agent/index.ts`:

- Env: `HOSTD_FETCH_SOCKET` (default `/run/hostd/fetch.sock`), `HOSTD_SOCKET_GID` (default `1000`), `HOSTD_STATUS_FILE` (default `/tmp/hostd-status.json`), `GITHUB_TOKEN` (required, never logged).
- Boot gate, failures collected and named: the token is present; `/var/www` is a writable mounted directory; `git --version` runs.
- At boot it writes the token into a Git credential file (`/root/.git-credentials`, mode 0600) and sets `credential.helper store` plus `url.https://github.com/.insteadOf git@github.com:`, so an ssh-style repo URL is fetched over HTTPS with the token and no SSH key is needed. The token never appears in an argument list, so it cannot reach `ps` output.
- Serves the socket with `umask(0o117)`, `chown(0, SOCKET_GID)`, `chmod(0o660)`, exactly as the agent does.
- Main loop every 10 seconds: write the status file with any warnings.

`fetch-client.ts` is `src/api/agent-client.ts` with the streaming removed: connect, write, read one line, close, under `FETCH_TIMEOUT_MS` (longer than the fetcher's own Git timeout, as the api client's timeout is longer than the agent's).

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/fetcher hostd/src/agent/fetch-client.ts hostd/src/agent/fetch-client.test.ts
git commit -m "Put Git in its own container behind a socket

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Provisioning in the agent

**Files:**
- Create: `hostd/src/agent/provision.ts`
- Test: `hostd/src/agent/provision.test.ts`
- Modify: `hostd/src/shared/protocol.ts`, `hostd/src/shared/protocol.test.ts`, `hostd/src/shared/registry.ts` (capability list), `hostd/src/agent/agent.ts`, `hostd/src/agent/agent.test.ts`

**Interfaces:**
- Consumes: `RegistryWriter`, `Change` (Task 2); `choosePort` (Task 4); the env file functions (Task 5); `FetchClient` (Task 6)
- Produces:
  - `CAPABILITIES` gains `'provision'` and `'env'`
  - New requests: `{ verb: 'provision', args: { action: 'create', id, client, name, repo, branch, domain, certificate } }`; `{ verb: 'provision', project, args: { action: 'add-environment', environment: 'test', branch, domain, certificate } }`; `{ verb: 'provision', project, args: { action: 'remove', environment: EnvironmentName | null } }`; `{ verb: 'env', project, args: { action: 'list' | 'read' | 'write', environment, path?, text? } }`
  - `VERB_CAPABILITY` gains `provision: 'provision'`, `env: 'env'`
  - New replies: `{ ok: true, project: { id: string, state: 'needs-setup' }, envFiles: EnvFileList }`, `{ ok: true, files: EnvFileList }`, `{ ok: true, text: string }`
  - `provision.ts`: `export type ProvisionDeps = { registry: () => Registry, writer: RegistryWriter, fetcher: FetchClient, choosePort: () => Promise<{ ok: true, port: number } | { ok: false, problem: string }>, mkdir(dir: string): Promise<void>, rmdir(dir: string): Promise<void>, exists(dir: string): Promise<boolean>, resolve(dir: string, composePath: string): Promise<{ ok: true, services: Record<string, { role: 'site' }> } | { ok: false, problem: string }>, log(message: string): void }`; `export async function createProject(args, deps): Promise<AgentReply>`; `export async function addEnvironment(project, args, deps): Promise<AgentReply>`; `export async function removeProject(project, environment, deps): Promise<AgentReply>`

- [ ] **Step 1: Write the failing tests**

`provision.test.ts`, every dependency faked and recorded:

```ts
it('creates the folder, clones, reads the compose file, writes the registry, and reports needs-setup', async () => {})
it('does those in order, so nothing is registered before it exists on disk', async () => {})
it('removes the folder and writes nothing when the clone fails', async () => {})
it('removes the folder and writes nothing when the compose file has no site service', async () => {})
it('refuses an id that is taken, reserved or malformed, before touching the disk', async () => {})
it('refuses when the folder already exists, before cloning', async () => {})
it('refuses when no port is free, before touching the disk', async () => {})
it('refuses a domain another project already uses', async () => {})
it('names the test environment folder <id>-test and gives it its own port', async () => {})
it('copies live env files into a new test environment, pointing the site URL and database at test', async () => {})
it('refuses a second test environment', async () => {})
it('removing a project unregisters it and deletes no files', async () => {})
it('refuses to remove the live environment on its own', async () => {})
it('never puts repo credentials or an env value into a log line', async () => {})
```

In `agent.test.ts`:

```ts
it('refuses provision and env when the capability is off', async () => {})
it('refuses an env write whose path is not an env file', async () => {})
it('holds the env lock while writing, so a second write is refused as busy', async () => {})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/agent/provision.test.ts`
Expected: FAIL, `./provision.ts` missing.

- [ ] **Step 3: Implement**

`createProject(args, deps)` runs in this order, because each step is undoable only while the later ones have not happened:

1. Validate id, client, name, repo, branch and domain with the registry's own regexes; refuse `bad-request` naming the field.
2. Refuse if the id is registered, reserved, or its folder already exists.
3. Refuse if another project already uses the domain.
4. `choosePort`; refuse `unavailable` with its problem when the range is full.
5. `mkdir` the folder.
6. `fetcher.call({ verb: 'clone', ... })`. On failure: `rmdir`, refuse `failed` with Git's message.
7. `resolve` the compose file. On failure, or when no service has `role: site`: `rmdir`, refuse `invalid-project`.
8. `writer.write({ kind: 'add-project', ... })` with the services found in step 7. On failure: `rmdir`, refuse `failed`.
9. List env files, reply `{ ok: true, project: { id, state: 'needs-setup' }, envFiles }`.

`addEnvironment` is the same from step 3, with folder `<dir>-test`, a fresh port, and one extra step after the clone: copy each env file from live, rewriting any value whose key ends `_URL`, `_HOST`, `_DOMAIN` or `_ORIGIN` and contains the live domain to the test domain, and any value containing the live database name to the test one. Every copied file is named in the reply, so the operator knows what to review.

`removeProject` writes `remove-project` (or `remove-environment`) and touches no files: folders, volumes and databases stay. The reply names the folder left behind.

In `agent.ts`: both verbs go through the existing `checkStructure` gate, and an `envBusy: Set<string>` keyed `<project>:<environment>` guards env writes, refusing `busy` exactly as `lifecycleBusy` does.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent hostd/src/shared/protocol.ts hostd/src/shared/protocol.test.ts hostd/src/shared/registry.ts
git commit -m "Create and remove projects and environments from the agent

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The API routes

**Files:**
- Modify: `hostd/src/api/routes.ts`, `hostd/src/api/routes.test.ts`, `hostd/src/api/policy.ts`, `hostd/src/api/policy.test.ts`

**Interfaces:**
- Consumes: the agent verbs from Task 7
- Produces: `POST /projects`, `DELETE /projects/:id`, `POST /projects/:id/environments`, `DELETE /projects/:id/environments/:env`, `GET /projects/:id/:env/env`, `GET|PUT /projects/:id/:env/env/*path`. `PolicyVerb` gains `'provision'` and `'env'`.

- [ ] **Step 1: Write the failing tests**

In `policy.test.ts`:

```ts
it('lets only admin provision or touch env files, whatever the project says', () => {
    assert.equal(authorize(registry, { kind: 'client', client: 'cl_1' }, 'acme', 'provision').ok, false)
    assert.equal(authorize(registry, { kind: 'client', client: 'cl_1' }, 'acme', 'env').ok, false)
})
it('gives a client the same 404 for provision as for a project that is not theirs', () => {})
it('still requires the capability for admin', () => {})
```

In `routes.test.ts`, with a fake `AgentClient` recording requests:

```ts
it('creates a project and returns what the agent replied', async () => {})
it('refuses a create with a missing or malformed field, without calling the agent', async () => {})
it('requires the project name typed back to delete, and refuses when it does not match', async () => {})
it('passes an env write through with its path and text, and audits it without the text', async () => {})
it('rejects an env path with a traversal before the agent is called', async () => {})
it('refuses every new route for a client actor, and audits the refusal', async () => {})
it('returns 503 with code unavailable when the agent cannot be reached', async () => {})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && npx tsx --test src/api/routes.test.ts src/api/policy.test.ts`
Expected: FAIL on the new routes and verbs.

- [ ] **Step 3: Implement**

`matchRoute` gains the new shapes in its existing style: split the path, check `PROJECT_ID`, check the environment segment against `ENVIRONMENTS`. Bodies are read with a 64 KB cap and parsed as JSON; a body that is not an object, or that carries an unknown field, is `400 bad-request` before the agent is called. `authorize` refuses `provision` and `env` for any client actor with the same `404 not-found` it already uses, so a client cannot learn which projects exist.

Audit entries: `verb: 'provision'` with `target` the id and action; `verb: 'env'` with `target` the file path. The text of an env file never appears in an audit entry, an error message or a log line.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hostd/src/api
git commit -m "Expose provisioning and env editing over the API

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Deployment files and the runbook

**Files:**
- Modify: `hostd/Dockerfile`, `hostd/docker-compose.yml`, `hostd/.gitignore`, `hostd/RUNBOOK.md`
- Create: `hostd/example.env.fetcher`

**Interfaces:**
- Consumes: everything above
- Produces: a stack of three containers

- [ ] **Step 1: Add the fetcher image stage**

In `hostd/Dockerfile`, after the `agent` stage:

```dockerfile
FROM base AS fetcher
RUN apk add --no-cache git
CMD ["node", "--import", "tsx", "src/fetcher/index.ts"]
```

It stays root because it writes into `/var/www`, where site files belong to root, and it has no Docker socket.

- [ ] **Step 2: Change the compose file**

- The registry moves to `./registry/projects.yaml` on the host, mounted as a **directory**: `./registry:/etc/hostd` writable for the agent, `:ro` for api and fetcher. A rename cannot replace a bind-mounted file from inside a container, which is why this is a directory now.
- `agent`: `/var/www:/var/www` (drop `:ro`), and `HOSTD_FETCH_SOCKET: /run/hostd/fetch.sock`.
- New `fetcher` service: build target `fetcher`, `container_name: hostd-fetcher`, `env_file: .env.fetcher`, volumes `/var/www:/var/www`, `./registry:/etc/hostd:ro`, `hostd-sock:/run/hostd`, joined to the `hostd` network because it needs GitHub, the same healthcheck shape, `restart: unless-stopped`. It does **not** get `/var/run/docker.sock`.

- [ ] **Step 3: Env example and gitignore**

Create `hostd/example.env.fetcher`:

```bash
# Copy to hostd/.env.fetcher on the dedi. A fine-grained GitHub personal access token, read-only, limited
# to the client repositories. Never commit the filled-in copy.
GITHUB_TOKEN=
```

`.gitignore` gains `.env.fetcher` and `registry/projects.yaml`.

- [ ] **Step 4: Runbook**

Add to `hostd/RUNBOOK.md`:

- **Upgrading from phase 1**: stop the stack, `mkdir registry && mv projects.yaml registry/projects.yaml`, create `.env.fetcher`, `docker compose up -d --build`. The agent refuses to start while `hostd/projects.yaml` still exists, so an upgrade cannot run against a stale registry.
- **Creating a site**, with the exact `hc` calls: create, list env files, write one, start.
- **What is deliberately not automatic**: the first start waits for the operator, and removing a project leaves its folder, volumes and databases in place.
- A troubleshooting row for each new refusal: no free port, id taken, domain taken, clone failed, compose has no site service, registry write refused.

- [ ] **Step 5: Verify, locally then on the dedi**

```bash
cd hostd && npm test && npm run typecheck && docker compose build
```

Then on the dedi, the rehearsal the spec calls for, against a throwaway repo and **before** any client project gets `provision`: create it, list its env files, write one, start it, add a test environment, remove both, and confirm the folders are still there afterwards.

- [ ] **Step 6: Commit**

```bash
git add hostd/Dockerfile hostd/docker-compose.yml hostd/example.env.fetcher hostd/.gitignore hostd/RUNBOOK.md
git commit -m "Run a third container for Git, and move the registry into a folder

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## What this plan leaves for the deployment plan

Polling GitHub, building into a new tree and swapping, the maintenance flag, the health check, automatic
rollback, branch switching, deploy history, the failure pause, the deploy lock, and applying each
project's resource limits when its containers start. This plan stops at a
project that exists, is registered, has its env files, and can be started by the lifecycle verbs that
already work.
