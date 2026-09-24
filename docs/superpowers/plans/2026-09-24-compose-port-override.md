# Publishing a Site's Port For It: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hostd writes a `hostd.ports.yml` compose override for every environment it provisions, moves or deploys, so the port set in the portal is the only host port a site publishes, whatever the repo's compose file says.

**Architecture:** A new `hostd/src/agent/port-override.ts` resolves the repo's own compose files, picks the site service and its container port, and writes the override text (`ports: !override` for the site service, `ports: !reset []` for every other service with ports). Provisioning, the port change and the deploy call it through an injected dependency, so tests never touch a real `/var/www`. The registry records the file as the last entry of the environment's compose list.

**Tech Stack:** TypeScript on Node 22 (`node --test` via tsx) for hostd; Next.js with zod and vitest for the portal.

**Spec:** `docs/superpowers/specs/2026-09-24-compose-port-override-design.md`

## Global Constraints

- Never use em dashes (U+2014) anywhere except code comments: not in UI copy, docs, commit messages or PR text. Check with Python (bash `$'\u2014'` greps can silently match nothing):
  `python -c "import sys;[print(f) for f in sys.argv[1:] if '\u2014' in open(f,encoding='utf-8').read()]" <files>`
- The file name is exactly `hostd.ports.yml`, in the environment's folder (`<dir>/hostd.ports.yml`), always the last compose file.
- The published address is always `127.0.0.1`.
- The override references the port variable (`${WEB_PORT}` or the registry's `portEnv`), never the number, so the port lives only in `.env`.
- `MAX_COMPOSE_FILES` stays 8 in the registry, counting `hostd.ports.yml`; a create may name at most 7 of its own.
- Match the surrounding code: 4-space indentation, no semicolons, single quotes, comments that say why. Tests are plain recorders, no mocking library, in hostd.
- hostd tests: `cd hostd && npm test` (all) or `cd hostd && node --import tsx --test src/agent/port-override.test.ts` (one file). Typecheck: `cd hostd && npm run typecheck`.
- Portal tests: `npx vitest run <path>` from the repo root.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

- Create `hostd/src/agent/port-override.ts`: builds the override text (pure) and writes it (through a passed-in `writeFile`).
- Create `hostd/src/agent/port-override.test.ts`.
- Modify `hostd/src/shared/registry.ts`: `PORT_OVERRIDE_FILE` constant.
- Modify `hostd/src/agent/compose.ts`: `ResolvedService` gains `expose` and `network_mode`; export `guessRole`.
- Modify `hostd/src/shared/registry-write.ts` (+ test): `set-port` takes an optional `compose` list.
- Modify `hostd/src/agent/provision.ts` (+ test): write the override on create and add-environment; new `notPublishedProblem`.
- Modify `hostd/src/agent/port-change.ts` (+ test): write the override for an environment that has none.
- Modify `hostd/src/agent/deploy.ts` (+ test): rebuild the override in the new tree.
- Modify `hostd/src/agent/agent.ts` (+ `agent.test.ts` fixture): wire the port change.
- Modify `hostd/src/agent/index.ts`: production wiring.
- Modify `hostd/src/shared/protocol.ts` (+ test): refuse the reserved name, 7 files at most.
- Modify `app/(portal)/portal/newSite/schema.ts`, `NewSite.tsx`; create `app/(portal)/portal/newSite/schema.test.ts`.
- Modify `hostd/RUNBOOK.md`.

---

### Task 1: Build the override text

**Files:**
- Create: `hostd/src/agent/port-override.ts`
- Create: `hostd/src/agent/port-override.test.ts`
- Modify: `hostd/src/shared/registry.ts:124` (beside `MAX_COMPOSE_FILES`)
- Modify: `hostd/src/agent/compose.ts:176-186` (`ResolvedService`), `hostd/src/agent/compose.ts:269` (`guessRole`)

**Interfaces:**
- Consumes: `ResolvedCompose`, `ResolvedService`, `guessRole` from `compose.ts`.
- Produces:
  - `export const PORT_OVERRIDE_FILE = 'hostd.ports.yml'` in `shared/registry.ts`
  - `export type PortOverride = { ok: true, text: string, service: string, target: number } | { ok: false, problem: string }`
  - `export function portOverride(resolved: ResolvedCompose, portEnv: string): PortOverride`

- [ ] **Step 1: Add the constant and the compose fields**

In `hostd/src/shared/registry.ts`, after `export const MAX_COMPOSE_FILES = 8`:

```ts
// The compose file hostd writes into every environment it provisions, moves or deploys, listed last so it
// merges over the repo's own (see agent/port-override.ts). Counted in MAX_COMPOSE_FILES like any other.
export const PORT_OVERRIDE_FILE = 'hostd.ports.yml'
```

In `hostd/src/agent/compose.ts`, add to `ResolvedService` after `ports`:

```ts
    // As config writes them: the container ports a service says it listens on without publishing any
    expose?: Array<string | number>
    // 'host' makes compose ignore ports altogether, so hostd cannot choose the port such a service binds
    network_mode?: string
```

and change `function guessRole(` to `export function guessRole(`.

- [ ] **Step 2: Write the failing tests**

Create `hostd/src/agent/port-override.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { portOverride } from './port-override.ts'
import type { ResolvedCompose, ResolvedService } from './compose.ts'

const HEADER = '# Written by hostd. The port is set in the portal; do not edit this file.\nservices:\n'
const compose = (services: Record<string, ResolvedService>): ResolvedCompose => ({ name: 'acme', services })

describe('portOverride', () => {
    it('replaces a hard-coded mapping with the chosen port on loopback', () => {
        const result = portOverride(compose({ web: { build: '.', ports: [{ target: 3000, published: '3000', protocol: 'tcp' }] } }), 'WEB_PORT')
        assert.deepEqual(result, {
            ok: true, service: 'web', target: 3000,
            text: `${HEADER}  "web":\n    ports: !override ["127.0.0.1:\${WEB_PORT}:3000"]\n`,
        })
    })

    // backroom's "${BIND_ADDR:-127.0.0.1}:${PORT:-3001}:${PORT:-3001}", as config resolves it
    it('keeps the container port the repo resolves to', () => {
        const result = portOverride(compose({ backroom: { build: '.', ports: [{ target: 3001, published: '3001', host_ip: '127.0.0.1', protocol: 'tcp' }] } }), 'WEB_PORT')
        assert.equal(result.ok && result.service, 'backroom')
        assert.equal(result.ok && result.target, 3001)
    })

    it('names the registry\'s own port variable', () => {
        const result = portOverride(compose({ web: { ports: [{ target: 3000 }] } }), 'PORT')
        assert.match(result.ok ? result.text : '', /"127\.0\.0\.1:\$\{PORT\}:3000"/)
    })

    it('uses expose when the service publishes nothing', () => {
        const result = portOverride(compose({ web: { build: '.', expose: ['8080'] } }), 'WEB_PORT')
        assert.equal(result.ok && result.target, 8080)
    })

    it('skips a UDP entry listed before the TCP one', () => {
        const result = portOverride(compose({ web: { ports: [{ target: 9000, published: '9000', protocol: 'udp' }, { target: 3000, published: '3000', protocol: 'tcp' }] } }), 'WEB_PORT')
        assert.equal(result.ok && result.target, 3000)
    })

    it('refuses a site service that names no port', () => {
        assert.deepEqual(portOverride(compose({ web: { build: '.' } }), 'WEB_PORT'), {
            ok: false,
            problem: 'web does not say which port it listens on; add expose: ["3000"] (the port inside the container) to it in the compose file',
        })
    })

    it('refuses a site service on the host network', () => {
        assert.deepEqual(portOverride(compose({ web: { network_mode: 'host', expose: ['3000'] } }), 'WEB_PORT'), {
            ok: false, problem: 'web uses network_mode: host, so hostd cannot choose its port; remove network_mode from it',
        })
    })

    it('picks the one site service that says its port, and leaves a portless one out', () => {
        const result = portOverride(compose({ web: { ports: [{ target: 3000 }] }, worker: { build: '.' } }), 'WEB_PORT')
        assert.equal(result.ok && result.service, 'web')
        assert.doesNotMatch(result.ok ? result.text : '', /worker/)
    })

    it('refuses when it cannot tell which service is the site', () => {
        assert.deepEqual(portOverride(compose({ web: { build: '.' }, worker: { build: '.' } }), 'WEB_PORT'), {
            ok: false,
            problem: 'hostd cannot tell which service is the site (web, worker); give the others an image it recognises as a database, or publish a port from the site\'s service only',
        })
    })

    it('refuses a compose file with no services', () => {
        assert.deepEqual(portOverride(compose({}), 'WEB_PORT'), { ok: false, problem: 'the compose file declares no services' })
    })

    // A database published to the host would be open on the dedi's public interface, since Docker's own
    // iptables rules go around the firewall, and two sites publishing 27017 would collide
    it('strips host ports from every other service', () => {
        const result = portOverride(compose({
            web: { ports: [{ target: 3000 }] },
            db: { image: 'mongo:7', ports: [{ target: 27017, published: '27017' }] },
        }), 'WEB_PORT')
        assert.equal(result.ok && result.text,
            `${HEADER}  "db":\n    ports: !reset []\n  "web":\n    ports: !override ["127.0.0.1:\${WEB_PORT}:3000"]\n`)
    })
})
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd hostd && node --import tsx --test src/agent/port-override.test.ts`
Expected: FAIL, `Cannot find module './port-override.ts'`.

- [ ] **Step 4: Write `portOverride`**

Create `hostd/src/agent/port-override.ts`:

```ts
// The compose override that makes the portal's port the only host port a site publishes, whatever the
// repo's own compose file says. The repo is never edited: a deploy checks out a fresh tree and the
// checkout's copy of a file always wins, so an edit would last until the next deploy. Instead hostd owns
// one more compose file, listed last, which compose merges over the repo's:
//
// - the site's service gets `ports: !override`, so the repo's own mappings, a hard-coded "3000:3000"
//   included, cannot also claim a host port; always on loopback, since Apache is the only thing that
//   should reach a site
// - every other service with ports gets `ports: !reset []`, so a database the repo publishes for a
//   developer's laptop is not open on the dedi (Docker's iptables rules go around the firewall)
//
// Services still reach each other over the compose network by service name, so nothing inside a site
// changes. The port itself stays in .env: the file names the variable, never the number.

import { guessRole, type ResolvedCompose, type ResolvedService } from './compose.ts'

export type PortOverride = { ok: true, text: string, service: string, target: number } | { ok: false, problem: string }

// One port, as config writes a target or an expose entry: a number, or a string that may carry a
// protocol ("3000/tcp"). A range ("3000-3005") is not one port and is skipped.
function singlePort(value: string | number | undefined): number | null {
    const text = typeof value === 'number' ? String(value) : value?.trim()
    const match = text === undefined ? null : /^(\d{1,5})(?:\/tcp)?$/.exec(text)
    if (!match) return null
    const port = Number(match[1])
    return port >= 1 && port <= 65535 ? port : null
}

// The first TCP target in the order the file lists them, then the first expose entry
function containerPort(service: ResolvedService): number | null {
    for (const port of service.ports ?? []) {
        if (port.protocol !== undefined && port.protocol !== 'tcp') continue
        const target = singlePort(port.target)
        if (target !== null) return target
    }
    for (const entry of service.expose ?? []) {
        const port = singlePort(entry)
        if (port !== null) return port
    }
    return null
}

const saysItsPort = (service: ResolvedService) => (service.ports?.length ?? 0) > 0 || (service.expose?.length ?? 0) > 0

export function portOverride(resolved: ResolvedCompose, portEnv: string): PortOverride {
    // Sorted, so the file is the same text for the same services however config ordered them
    const names = Object.keys(resolved.services).sort()
    if (names.length === 0) return { ok: false, problem: 'the compose file declares no services' }
    const sites = names.filter(name => guessRole(resolved.services[name]!).role === 'site')
    // A lone site service is the site even when it names no port, so the refusal below can say what to add
    const candidates = sites.length === 1 ? sites : sites.filter(name => saysItsPort(resolved.services[name]!))
    if (candidates.length !== 1) {
        return {
            ok: false,
            problem: `hostd cannot tell which service is the site (${(sites.length > 0 ? sites : names).join(', ')}); give the others an image it recognises as a database, or publish a port from the site's service only`,
        }
    }
    const service = candidates[0]!
    const web = resolved.services[service]!
    if (web.network_mode === 'host') {
        return { ok: false, problem: `${service} uses network_mode: host, so hostd cannot choose its port; remove network_mode from it` }
    }
    const target = containerPort(web)
    if (target === null) {
        return { ok: false, problem: `${service} does not say which port it listens on; add expose: ["3000"] (the port inside the container) to it in the compose file` }
    }

    // Built as text: the yaml library would need teaching to write the two tags. JSON strings are valid
    // YAML double-quoted scalars, so a service name or a mapping can never break out of its line.
    const lines = ['# Written by hostd. The port is set in the portal; do not edit this file.', 'services:']
    for (const name of names) {
        if (name === service) {
            lines.push(`  ${JSON.stringify(name)}:`, `    ports: !override [${JSON.stringify(`127.0.0.1:\${${portEnv}}:${target}`)}]`)
        } else if ((resolved.services[name]!.ports?.length ?? 0) > 0) {
            lines.push(`  ${JSON.stringify(name)}:`, '    ports: !reset []')
        }
    }
    return { ok: true, text: `${lines.join('\n')}\n`, service, target }
}
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `cd hostd && node --import tsx --test src/agent/port-override.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `cd hostd && npm run typecheck`
Expected: no errors.

```bash
git add hostd/src/agent/port-override.ts hostd/src/agent/port-override.test.ts hostd/src/shared/registry.ts hostd/src/agent/compose.ts
git commit -m "Build the compose override that publishes a site's port" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Resolve the repo's files and write the override

**Files:**
- Modify: `hostd/src/agent/port-override.ts`
- Modify: `hostd/src/agent/port-override.test.ts`

**Interfaces:**
- Consumes: `portOverride` (Task 1), `resolveCompose`, `ComposeLocation`, `Runner` from `compose.ts`, `PORT_OVERRIDE_FILE`.
- Produces:
  - `export type PortOverrideResult = { ok: true, composePaths: string[], service: string, target: number } | { ok: false, problem: string }`
  - `export function isPortOverride(path: string): boolean`
  - `export function portOverridePath(dir: string): string`
  - `export async function buildPortOverride(location: ComposeLocation, portEnv: string, run: Runner, writeFile: (path: string, text: string) => Promise<void>): Promise<PortOverrideResult>`

- [ ] **Step 1: Write the failing tests**

Add to the imports of `port-override.test.ts`:

```ts
import { buildPortOverride, isPortOverride, portOverridePath } from './port-override.ts'
import type { Runner } from './compose.ts'
```

(merge `portOverride` into the same import line) and append:

```ts
describe('buildPortOverride', () => {
    const config = JSON.stringify({ name: 'acme', services: { web: { build: '.', ports: [{ target: 3000, published: '3000' }] } } })
    const recorder = (stdout = config, exitCode = 0) => {
        const runs: string[][] = []
        const writes: Array<{ path: string, text: string }> = []
        const run: Runner = async (_command, args) => { runs.push(args); return { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no such file', timedOut: false } }
        const writeFile = async (path: string, text: string) => { writes.push({ path, text }) }
        return { runs, writes, run, writeFile }
    }

    it('resolves only the repo\'s own files, writes the override and lists it last', async () => {
        const { runs, writes, run, writeFile } = recorder()
        const location = { dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'] }
        const result = await buildPortOverride(location, 'WEB_PORT', run, writeFile)
        assert.deepEqual(result, { ok: true, composePaths: ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'], service: 'web', target: 3000 })
        assert.equal(runs.length, 1)
        assert.ok(runs[0]!.includes('/var/www/acme/docker-compose.yml'))
        assert.ok(!runs[0]!.includes('/var/www/acme/hostd.ports.yml'))
        assert.equal(writes[0]?.path, '/var/www/acme/hostd.ports.yml')
        assert.match(writes[0]?.text ?? '', /!override/)
    })

    it('adds the override to a list that does not have it', async () => {
        const { run, writeFile } = recorder()
        const result = await buildPortOverride({ dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml'] }, 'WEB_PORT', run, writeFile)
        assert.deepEqual(result.ok && result.composePaths, ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'])
    })

    it('writes nothing when compose cannot be resolved', async () => {
        const { writes, run, writeFile } = recorder('', 1)
        const result = await buildPortOverride({ dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml'] }, 'WEB_PORT', run, writeFile)
        assert.equal(result.ok, false)
        assert.deepEqual(writes, [])
    })

    it('writes nothing when the override cannot be built', async () => {
        const { writes, run, writeFile } = recorder(JSON.stringify({ name: 'acme', services: { web: { build: '.' } } }))
        const result = await buildPortOverride({ dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml'] }, 'WEB_PORT', run, writeFile)
        assert.match(result.ok ? '' : result.problem, /does not say which port/)
        assert.deepEqual(writes, [])
    })

    it('refuses a list that is only the override', async () => {
        const { run, writeFile } = recorder()
        assert.deepEqual(await buildPortOverride({ dir: '/var/www/acme', composePaths: ['/var/www/acme/hostd.ports.yml'] }, 'WEB_PORT', run, writeFile),
            { ok: false, problem: 'the environment names no compose file of its own' })
    })

    it('knows the override by name, wherever it is listed', () => {
        assert.equal(portOverridePath('/var/www/acme-test'), '/var/www/acme-test/hostd.ports.yml')
        assert.equal(isPortOverride('/var/www/acme/hostd.ports.yml'), true)
        assert.equal(isPortOverride('/var/www/acme/docker-compose.yml'), false)
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && node --import tsx --test src/agent/port-override.test.ts`
Expected: FAIL, `buildPortOverride` is not exported.

- [ ] **Step 3: Write `buildPortOverride`**

In `port-override.ts`, change the imports to:

```ts
import { posix } from 'node:path'

import { PORT_OVERRIDE_FILE } from '../shared/registry.ts'
import { guessRole, resolveCompose, type ComposeLocation, type ResolvedCompose, type ResolvedService, type Runner } from './compose.ts'
```

and append:

```ts
export type PortOverrideResult = { ok: true, composePaths: string[], service: string, target: number } | { ok: false, problem: string }

export function isPortOverride(path: string): boolean {
    return posix.basename(path) === PORT_OVERRIDE_FILE
}

export function portOverridePath(dir: string): string {
    return posix.join(dir, PORT_OVERRIDE_FILE)
}

// Resolves the repo's own files, never the override itself (it would hide the mappings being replaced),
// so this is the same answer the first time and every time after. Run after the port is in .env, so any
// ${...} in the repo's mappings resolves to what the repo would run with. Answers the environment's full
// compose list with the override last, which is what the registry records and compose is run with.
export async function buildPortOverride(
    location: ComposeLocation, portEnv: string, run: Runner, writeFile: (path: string, text: string) => Promise<void>,
): Promise<PortOverrideResult> {
    const own = location.composePaths.filter(path => !isPortOverride(path))
    if (own.length === 0) return { ok: false, problem: 'the environment names no compose file of its own' }
    const resolved = await resolveCompose({ dir: location.dir, composePaths: own }, run)
    if (!resolved.ok) return resolved
    const override = portOverride(resolved.resolved, portEnv)
    if (!override.ok) return override
    const path = portOverridePath(location.dir)
    await writeFile(path, override.text)
    return { ok: true, composePaths: [...own, path], service: override.service, target: override.target }
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && node --import tsx --test src/agent/port-override.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/port-override.ts hostd/src/agent/port-override.test.ts
git commit -m "Write the port override from the repo's own compose files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A port change can record the compose list

**Files:**
- Modify: `hostd/src/shared/registry-write.ts:77-79` (the `set-port` change type), `hostd/src/shared/registry-write.ts:269-281` (its case)
- Test: `hostd/src/shared/registry-write.test.ts` (the `describe('set-port'` block, line 288)

**Interfaces:**
- Produces: `{ kind: 'set-port', id: string, environment: EnvironmentName, port: number, compose?: string[] }`. `compose` is relative to the environment's dir; absent leaves the key alone; `['docker-compose.yml']` alone removes the key.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('set-port', ...)` in `registry-write.test.ts`:

```ts
    // A port change on a site created before hostd.ports.yml adds it to the environment's list in the same
    // write as the port, so the two can never disagree
    it('writes the compose list beside the port when given one', () => {
        const result = applyChange(BASE, { kind: 'set-port', id: 'acme', environment: 'live', port: 5099, compose: ['docker-compose.yml', 'hostd.ports.yml'] })
        assert.equal(result.ok, true)
        const live = parseRegistry(result.ok ? result.text : '').projects.get('acme')?.environments.get('live')
        assert.equal(live?.port, 5099)
        assert.deepEqual(live?.composePaths, ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'])
    })

    it('puts the default list back as no compose key at all', () => {
        const added = applyChange(BASE, { kind: 'set-port', id: 'acme', environment: 'live', port: 5099, compose: ['docker-compose.yml', 'hostd.ports.yml'] })
        const undone = applyChange(added.ok ? added.text : '', { kind: 'set-port', id: 'acme', environment: 'live', port: 5010, compose: ['docker-compose.yml'] })
        assert.equal(undone.ok, true)
        assert.doesNotMatch(undone.ok ? undone.text : '', /compose/)
    })

    it('leaves the compose list alone when given none', () => {
        const added = applyChange(BASE, { kind: 'set-port', id: 'acme', environment: 'live', port: 5099, compose: ['docker-compose.yml', 'hostd.ports.yml'] })
        const moved = applyChange(added.ok ? added.text : '', { kind: 'set-port', id: 'acme', environment: 'live', port: 5098 })
        assert.deepEqual(parseRegistry(moved.ok ? moved.text : '').projects.get('acme')?.environments.get('live')?.composePaths,
            ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'])
    })
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && node --import tsx --test src/shared/registry-write.test.ts`
Expected: FAIL, a TypeScript excess property error on `compose` (tsx strips types, so it may instead fail on the `composePaths` assertion). Either is a failure.

- [ ] **Step 3: Implement**

In `registry-write.ts`, replace the `set-port` member of `Change`:

```ts
    // The environment's port, which the vhost proxies to and the site's .env publishes. Whether it is
    // free on the host is the agent's check; whether it is unique in the registry is parseRegistry's.
    // compose, relative to the environment's dir, is written in the same edit when given: a port change
    // is what adds hostd.ports.yml to an environment created before it, and its undo takes it away.
    | { kind: 'set-port', id: string, environment: EnvironmentName, port: number, compose?: string[] }
```

and in the `case 'set-port':` block replace the final `doc.setIn(...)` and `return null` with:

```ts
            doc.setIn(['projects', change.id, 'environments', change.environment, 'port'], change.port)
            if (change.compose) {
                // The same rule environmentNode follows: the default list alone is written as no key
                const path = ['projects', change.id, 'environments', change.environment, 'compose']
                if (change.compose.length === 1 && change.compose[0] === 'docker-compose.yml') doc.deleteIn(path)
                else doc.setIn(path, flowList(doc, change.compose))
            }
            return null
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd hostd && node --import tsx --test src/shared/registry-write.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/registry-write.ts hostd/src/shared/registry-write.test.ts
git commit -m "Let a port change write the environment's compose list" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Create and add-environment write the override

**Files:**
- Modify: `hostd/src/agent/provision.ts` (`ProvisionDeps` at line 41, `notPublishedProblem` at line 120, `ProvisionAttempt.write` at line 223, `provisionOnDisk` at lines 263-325, `createProject`'s `write` at line ~395, `addEnvironment`'s `write` at line ~470)
- Modify: `hostd/src/agent/provision.test.ts` (setup at lines 83-195 and the assertions listed below)
- Modify: `hostd/src/agent/agent.test.ts:445-466` (`fakeProvisionDeps`)
- Modify: `hostd/src/agent/index.ts:200-230` (the `provision` deps)

**Interfaces:**
- Consumes: `PortOverrideResult`, `buildPortOverride`, `portOverridePath` (Task 2); `ComposeLocation` from `compose.ts`; `PORT_OVERRIDE_FILE`.
- Produces:
  - `ProvisionDeps.portOverride: (location: ComposeLocation, portEnv: string) => Promise<PortOverrideResult>`
  - `ProvisionDeps.removePortOverride: (dir: string) => Promise<void>` (used by Task 5)
  - `notPublishedProblem(dir: string, port: number): string`, now `hostd could not publish port <port> (its override did not take effect); check hostd.ports.yml in <dir>`
  - `writeOwnedFile(path, text)` in `index.ts` (used by Task 6's wiring)

- [ ] **Step 1: Update the test fixture and write the failing tests**

In `provision.test.ts`:

1. Add `overrideResult?: PortOverrideResult` to `SetupOptions`, and import it: `import type { PortOverrideResult } from './port-override.ts'`. Add `import { posix } from 'node:path'` if the file does not already import it.
2. In `setup`, beside the other recorders: `const overrideCalls: Array<{ dir: string, composePaths: string[], portEnv: string }> = []`.
3. Add to `deps`, after `setPortEnv`:

```ts
        portOverride: async (location, portEnv) => {
            calls.push('portOverride')
            overrideCalls.push({ dir: location.dir, composePaths: location.composePaths, portEnv })
            return options.overrideResult ?? { ok: true, composePaths: [...location.composePaths, posix.join(location.dir, 'hostd.ports.yml')], service: 'web', target: 3000 }
        },
        removePortOverride: async () => { calls.push('removePortOverride') },
```

4. Add `overrideCalls` to the object `setup` returns.
5. Update the existing assertions the new step changes:
   - line 280: `['exists', 'choosePort', 'mkdir', 'clone', 'setPortEnv', 'portOverride', 'owner', 'own', 'resolve', 'write']`
   - line 436: `['exists', 'choosePort', 'mkdir', 'clone', 'setPortEnv', 'portOverride', 'owner', 'own', 'resolve', 'rmdir']`
   - line 211: `composePaths: ['/var/www/bakery/docker-compose.yml', '/var/www/bakery/hostd.ports.yml']`
   - line 234: `composePaths: ['/var/www/bakery_site/docker-compose.yml', '/var/www/bakery_site/docker-compose.prod.yml', '/var/www/bakery_site/hostd.ports.yml']`
   - line 242: the same three paths
   - line 316: `message: notPublishedProblem('/var/www/bakery', 5100)`
   - line 619: `composePaths: ['/var/www/acme-test/docker-compose.yml', '/var/www/acme-test/hostd.ports.yml']`
6. Add these tests to the `createProject` describe block (beside "rolls back when no service publishes the port"):

```ts
    it('writes the override from the repo\'s own files after the port is in .env', async () => {
        const { deps, overrideCalls, calls, logs } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(overrideCalls, [{ dir: '/var/www/bakery', composePaths: ['/var/www/bakery/docker-compose.yml'], portEnv: 'WEB_PORT' }])
        assert.ok(calls.indexOf('setPortEnv') < calls.indexOf('portOverride'))
        assert.ok(calls.indexOf('portOverride') < calls.indexOf('own'))
        assert.ok(logs.includes('provision bakery: published 5100 to web:3000'), logs.join('\n'))
    })

    it('records the override as the last compose file', async () => {
        const { deps, registryFiles } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')?.environments.get('live')?.composePaths,
            ['/var/www/bakery/docker-compose.yml', '/var/www/bakery/hostd.ports.yml'])
    })

    it('rolls back when the override cannot be built', async () => {
        const problem = 'web does not say which port it listens on; add expose: ["3000"] (the port inside the container) to it in the compose file'
        const { deps, rmdirs, calls } = setup({ overrideResult: { ok: false, problem } })
        assert.deepEqual(await createProject(createArgs(), deps), { ok: false, code: 'invalid-project', message: problem })
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.ok(!calls.includes('resolve'))
        assert.ok(!calls.includes('write'))
    })
```

7. Add to the `addEnvironment` describe block (use the same `acme` project and args its other tests use; copy the call from the test at line ~619):

```ts
    it('records the test environment\'s own compose list, override last', async () => {
        const { deps, registryFiles } = setup()
        const reply = await addEnvironment(acme, { action: 'add-environment', environment: 'test', branch: 'develop', domain: 'test.acme.com', certificate: null }, deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('acme')?.environments.get('test')?.composePaths,
            ['/var/www/acme-test/docker-compose.yml', '/var/www/acme-test/hostd.ports.yml'])
    })
```

If the neighbouring tests build `acme` or the args differently (read the test at line ~619), use their exact names instead of these.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && node --import tsx --test src/agent/provision.test.ts`
Expected: FAIL: the order assertions miss `portOverride`, and the new tests fail.

- [ ] **Step 3: Implement in `provision.ts`**

1. Imports: add `PORT_OVERRIDE_FILE` to the `../shared/registry.ts` import, change the compose import to `import { runLifecycle, type ComposeLocation, type GuessedService, type Runner } from './compose.ts'`, and add `import type { PortOverrideResult } from './port-override.ts'`.
2. Add to `ProvisionDeps`, after `setPortEnv`:

```ts
    // Writes hostd.ports.yml into location.dir from the environment's own compose files and answers its
    // full compose list, override last (port-override.ts). A dependency so a test never runs compose or
    // writes into a real /var/www.
    portOverride: (location: ComposeLocation, portEnv: string) => Promise<PortOverrideResult>
    // Removes an environment's hostd.ports.yml, for a port change's undo. A file already gone is not an error.
    removePortOverride: (dir: string) => Promise<void>
```

3. Replace `notPublishedProblem`:

```ts
// Said the same way by create, add-environment and a port change. hostd wrote the override itself, so
// this only happens when it did not take effect, and the operator is pointed at the file, not the repo.
export function notPublishedProblem(dir: string, port: number): string {
    return `hostd could not publish port ${port} (its override did not take effect); check ${PORT_OVERRIDE_FILE} in ${dir}`
}
```

4. In `ProvisionAttempt`, change `write` to take the recorded list, and update its comment's first line:

```ts
    // Given the services resolve found (each guessed site or database) and the environment's compose
    // list relative to dir (the repo's files, then hostd.ports.yml), attempts the registry write. ...
    write: (services: Record<string, GuessedService>, compose: string[]) => Promise<{ ok: true } | { ok: false, problem: string, conflict?: true }>
```

(keep the rest of the existing comment as it is).

5. In `provisionOnDisk`, straight after the `portWritten` block:

```ts
        // After the port is in .env, which the repo's own mappings may read, and before own, so the new
        // file is owned with the rest of the tree
        const override = await deps.portOverride({ dir, composePaths }, attempt.portEnv)
        if (!override.ok) {
            await rollback('publishing the port failed')
            return refuse('invalid-project', override.problem)
        }
        deps.log(`provision ${id}: published ${attempt.port} to ${override.service}:${override.target}`)
        const merged = override.composePaths
```

Then in the rest of `provisionOnDisk` use `merged` instead of `composePaths`: in `deps.resolve(posix.basename(dir), dir, merged, attempt.collidesWith)`, in `notPublishedProblem(dir, attempt.port)` (replacing `notPublishedProblem(attempt.portEnv, attempt.port)`), in `attempt.write(resolved.services, merged.map(path => posix.relative(dir, path)))`, and in `return { ok: true, composePaths: merged }`.

6. In `createProject`, change the `write` callback's signature to `write: (services, written) => deps.writer.write({` and, inside its `environment: { ... }`, replace `compose, ...flags` with `compose: written, ...flags`. The outer `compose` variable is still what goes into the attempt's `compose:` field.
7. In `addEnvironment`, change `write: () => deps.writer.write({` to `write: (_services, written) => deps.writer.write({` and add `compose: written` to its `environment: { ... }` object, so the test environment records its own list rather than inheriting live's.

- [ ] **Step 4: Fix the agent test fixture**

In `agent.test.ts` `fakeProvisionDeps`, after `setPortEnv`:

```ts
        portOverride: async location => ({ ok: true, composePaths: [...location.composePaths, `${location.dir}/hostd.ports.yml`], service: 'web', target: 3000 }),
        removePortOverride: async () => {},
```

- [ ] **Step 5: Wire production in `index.ts`**

Add `import { buildPortOverride, portOverridePath } from './port-override.ts'`. Before `const provision: ProvisionDeps = {`, add:

```ts
    // hostd.ports.yml is written as root into a folder the operator owns, so it takes the folder's owner,
    // as every other file hostd puts in a site does. A create and a deploy own the whole tree afterwards
    // anyway; a port change writes into a folder that is already in use and has no such step.
    const writeOwnedFile = async (path: string, text: string) => {
        const like = await ownerOf(posix.dirname(path))
        await writeFile(path, text, { mode: 0o644 })
        await chown(path, like.uid, like.gid)
    }
```

(`ownerOf`, `writeFile`, `chown` and `posix` are already imported or defined in this file; check `ownerOf`'s definition is above this point and move the new function below it if not). Add to `provision`, after `setPortEnv`:

```ts
        portOverride: (location, portEnv) => buildPortOverride(location, portEnv, runner, writeOwnedFile),
        removePortOverride: dir => rm(portOverridePath(dir), { force: true }),
```

- [ ] **Step 6: Run the tests and the typecheck**

Run: `cd hostd && npm run typecheck && npm test`
Expected: typecheck clean and every test passing. `port-change.ts` still calls `notPublishedProblem(project.portEnv, port)` until Task 5; that typechecks (both arguments are strings) and its test still passes, since the test builds its expected message with the same function. Any failure is a real regression: fix it before committing.

- [ ] **Step 7: Commit**

```bash
git add hostd/src/agent/provision.ts hostd/src/agent/provision.test.ts hostd/src/agent/agent.test.ts hostd/src/agent/index.ts
git commit -m "Publish the chosen port through hostd.ports.yml on create" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: A port change adds the override to an environment without one

**Files:**
- Modify: `hostd/src/agent/port-change.ts`
- Modify: `hostd/src/agent/port-change.test.ts`
- Modify: `hostd/src/agent/agent.ts:614-640` (the `changePort` deps)

**Interfaces:**
- Consumes: `isPortOverride`, `PortOverrideResult` (Task 2); `ProvisionDeps.portOverride`, `ProvisionDeps.removePortOverride`, `notPublishedProblem(dir, port)` (Task 4); `set-port`'s `compose` (Task 3).
- Produces, in `PortChangeDeps`:
  - `override: (environment: EnvironmentEntry) => Promise<PortOverrideResult>`
  - `removeOverride: (environment: EnvironmentEntry) => Promise<void>`
  - `writePort: (port: number, compose?: string[]) => Promise<{ ok: true } | { ok: false, problem: string }>`

- [ ] **Step 1: Update the fixture and write the failing tests**

In `port-change.test.ts`, add to `fakes` (after `restorePortEnv`), and replace `writePort`:

```ts
        override: async env => {
            steps.push('override')
            return { ok: true, composePaths: [...env.composePaths, `${env.dir}/hostd.ports.yml`], service: 'web', target: 3000 }
        },
        removeOverride: async () => { steps.push('remove override') },
        writePort: async (port, compose) => { steps.push(compose ? `registry ${port} ${compose.join(',')}` : `registry ${port}`); return { ok: true } },
```

Change the first test's expected steps to:

```ts
        assert.deepEqual(steps, ['check 5012', 'env WEB_PORT=5012', 'override', 'published', 'registry 5012 docker-compose.yml,hostd.ports.yml', 'running?', 'up', 'vhost'])
```

Change the refusal at line 71 to `message: notPublishedProblem('/var/www/acme', 5012)`, and the thrown-`published` test at line 140 to:

```ts
        assert.deepEqual(steps.slice(-3), ['published', 'restore env "WEB_PORT=5010\\n"', 'remove override'])
```

Add, after the `bare` fixture, a project whose environment already lists the override:

```ts
// A site created (or moved) since hostd.ports.yml: the override already names ${WEB_PORT}, so a move only
// rewrites .env
const withOverride = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:a/acme.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, compose: [docker-compose.yml, hostd.ports.yml] }
`).projects.get('acme')!
```

and these tests inside `describe('changePort', ...)`:

```ts
    it('leaves an override that is already there alone', async () => {
        const { deps, steps } = fakes()
        assert.equal((await changePort(withOverride, 'live', 5012, deps)).ok, true)
        assert.deepEqual(steps, ['check 5012', 'env WEB_PORT=5012', 'published', 'registry 5012', 'running?', 'up', 'vhost'])
    })

    it('checks and recreates with the override in the compose list', async () => {
        const seen: string[][] = []
        const { deps } = fakes({
            published: async env => { seen.push(env.composePaths); return { ok: true, ports: [5012] } },
            up: async env => { seen.push(env.composePaths); return { ok: true } },
        })
        await changePort(bare, 'live', 5012, deps)
        assert.deepEqual(seen, [
            ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'],
            ['/var/www/acme/docker-compose.yml', '/var/www/acme/hostd.ports.yml'],
        ])
    })

    it('refuses when the override cannot be built, putting .env back', async () => {
        const problem = 'hostd cannot tell which service is the site (web, worker); give the others an image it recognises as a database, or publish a port from the site\'s service only'
        const { deps, steps } = fakes({ override: async () => { steps.push('override'); return { ok: false, problem } } })
        assert.deepEqual(await changePort(acme, 'live', 5012, deps), { ok: false, code: 'invalid-project', message: problem })
        assert.deepEqual(steps, ['check 5012', 'env WEB_PORT=5012', 'override', 'restore env "WEB_PORT=5010\\n"'])
    })

    it('takes the override and its compose entry away again when the recreate fails', async () => {
        const { deps, steps } = fakes({ up: async () => { steps.push('up'); return steps.filter(step => step === 'up').length === 1 ? { ok: false, message: 'up exited with code 1' } : { ok: true } } })
        assert.equal((await changePort(acme, 'live', 5012, deps)).ok, false)
        assert.deepEqual(steps.slice(4), ['registry 5012 docker-compose.yml,hostd.ports.yml', 'running?', 'up', 'restore env "WEB_PORT=5010\\n"', 'registry 5010 docker-compose.yml', 'remove override', 'up'])
    })
```

Then run the file (Step 2) and, for every other existing test whose expected `steps` array now differs, update it by the same three rules only: `'override'` follows the `env` step for `acme`/`bare`; the new-port `registry` step carries `docker-compose.yml,hostd.ports.yml`; the undo's `registry <old>` step carries `docker-compose.yml` and is followed by `'remove override'`. Do not change any other expectation.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && node --import tsx --test src/agent/port-change.test.ts`
Expected: FAIL: `override` is never called.

- [ ] **Step 3: Implement in `port-change.ts`**

1. Update the opening comment's step list to say the override is written: "check the port, write it into .env, write hostd.ports.yml if the environment has none, make sure compose publishes it, ...".
2. Imports: add `import { posix } from 'node:path'` and `import { isPortOverride, type PortOverrideResult } from './port-override.ts'`.
3. In `PortChangeDeps`, replace `writePort` and add the two new deps:

```ts
    // Writes hostd.ports.yml for an environment whose compose list does not have it yet (a site created
    // or enrolled before it), answering the full list, override last
    override: (environment: EnvironmentEntry) => Promise<PortOverrideResult>
    removeOverride: (environment: EnvironmentEntry) => Promise<void>
    // Writes the registry and refreshes the agent's copy of it, so the vhost rewrite reads the new port.
    // compose, relative to the environment's dir, is written in the same edit when given.
    writePort: (port: number, compose?: string[]) => Promise<{ ok: true } | { ok: false, problem: string }>
```

4. In `changePort`, beside `registryWritten`, add:

```ts
    // The environment as the rest of the change runs it: with hostd.ports.yml in its list once written
    let moved = environment
    let overrideWritten = false
    const relative = (entry: EnvironmentEntry) => entry.composePaths.map(path => posix.relative(entry.dir, path))
```

5. In `undo`, change the registry restore to pass the old list when the override was added, and remove the file right after it:

```ts
        if (registryWritten) {
            await attempt(`the registry could not be put back to ${old}`, async () => {
                const restored = await deps.writePort(old, overrideWritten ? relative(environment) : undefined)
                return restored.ok ? null : restored.problem
            })
        }
        if (overrideWritten) {
            await attempt('hostd.ports.yml could not be removed', async () => { await deps.removeOverride(environment); return null })
        }
```

(the containers and vhost undo steps stay as they are, after these; the containers come back up with `environment`, the old list).

6. At the top of the `try` block, before `deps.published`:

```ts
        if (!environment.composePaths.some(isPortOverride)) {
            // Counted as written before the call, like the registry below: a write that throws may
            // still have left the file, and removing a file that is not there is harmless
            overrideWritten = true
            const override = await deps.override(environment)
            if (!override.ok) {
                overrideWritten = false
                await undo()
                return refuse('invalid-project', override.problem)
            }
            moved = { ...environment, composePaths: override.composePaths }
        }
```

7. In the rest of the `try` block, use `moved` for `deps.published(moved)`, `deps.running(moved)` and the forward `deps.up(moved)`; change the refusal to `notPublishedProblem(environment.dir, port)`; and change the forward registry write to `deps.writePort(port, overrideWritten ? relative(moved) : undefined)`.

- [ ] **Step 4: Wire it in `agent.ts`**

In `port()`, add to the object passed to `changePort` (after `restorePortEnv`):

```ts
                override: entry => provision.portOverride({ dir: entry.dir, composePaths: entry.composePaths }, project.portEnv),
                removeOverride: entry => provision.removePortOverride(entry.dir),
```

and change `writePort` to:

```ts
                writePort: async (value, compose) => {
                    const written = await this.deps.writer.write({ kind: 'set-port', id: project.id, environment, port: value, ...(compose ? { compose } : {}) })
                    if (!written.ok) return written
                    await this.deps.refreshRegistry()
                    return { ok: true }
                },
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd hostd && npm run typecheck && npm test`
Expected: all pass. The agent test "gives the recreate a shorter timeout" still passes, since `fakeProvisionDeps` answers the override.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/agent/port-change.ts hostd/src/agent/port-change.test.ts hostd/src/agent/agent.ts
git commit -m "Add hostd.ports.yml when a port change moves an older site" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Deploys rebuild the override from the commit going out

**Files:**
- Modify: `hostd/src/agent/deploy.ts` (`DeployDeps` at line 67, `runDeploy` after the `nameDockerfiles` step at line ~345)
- Modify: `hostd/src/agent/deploy.test.ts` (setup at lines 57-230)
- Modify: `hostd/src/agent/index.ts` (the `deployDeps` object)

**Interfaces:**
- Consumes: `isPortOverride`, `PortOverrideResult` (Task 2); `writeOwnedFile` and `buildPortOverride` in `index.ts` (Task 4).
- Produces: `DeployDeps.portOverride: (location: ComposeLocation, portEnv: string) => Promise<PortOverrideResult>`.

- [ ] **Step 1: Update the fixture and write the failing tests**

In `deploy.test.ts`:

1. Import `import type { PortOverrideResult } from './port-override.ts'`.
2. Add a fixture beside `REGISTRY_YAML_OVERRIDE`:

```ts
// A site hostd created: its compose list ends with the override hostd writes, which the repo never has
const REGISTRY_YAML_PORTS = `
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
        compose: [ docker-compose.yml, hostd.ports.yml ]
        branch: main
        domain: acme.com
        port: 5010
        deployed: abc1234
`
```

3. Add `overrideResult?: PortOverrideResult` to `SetupOptions`.
4. Add to `deps` in `setup`:

```ts
        portOverride: async (location, portEnv) => {
            calls.push(`override ${location.dir} ${portEnv}`)
            return options.overrideResult ?? { ok: true, composePaths: location.composePaths, service: 'web', target: 3000 }
        },
```

5. Add tests beside the compose-carry tests (line ~355):

```ts
    // Rebuilt rather than carried, so a commit that adds a service publishing a host port, or moves the
    // site's container port, is covered at this deploy and not only at the next port change
    it('rebuilds hostd.ports.yml in the new tree before it is owned and built', async () => {
        const context = setup({ registryYaml: REGISTRY_YAML_PORTS, existsPaths: ['/var/www/acme/.git', '/var/www/acme.next/docker-compose.yml'] })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'ok', record.reason ?? '')
        const override = context.calls.indexOf('override /var/www/acme.next WEB_PORT')
        assert.ok(override !== -1, context.calls.join(', '))
        assert.ok(override < context.calls.findIndex(call => call.startsWith('own ')), context.calls.join(', '))
    })

    it('fails the deploy before building when the override cannot be rebuilt', async () => {
        const problem = 'web does not say which port it listens on; add expose: ["3000"] (the port inside the container) to it in the compose file'
        const context = setup({
            registryYaml: REGISTRY_YAML_PORTS, existsPaths: ['/var/www/acme/.git', '/var/www/acme.next/docker-compose.yml'],
            overrideResult: { ok: false, problem },
        })
        const record = await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.equal(record.outcome, 'failed')
        assert.equal(record.reason, `the port could not be published: ${problem}`)
        assert.ok(!context.calls.some(call => call.includes('build')), context.calls.join(', '))
        assert.ok(!context.calls.includes('maintenance on'))
    })

    it('leaves an environment without hostd.ports.yml as it was', async () => {
        const context = setup({ registryYaml: REGISTRY_YAML_OVERRIDE, existsPaths: ['/var/www/acme/.git', '/var/www/acme.next/docker-compose.yml'] })
        await runDeploy(context.project(), context.environment(), { ...request, commit: TIP }, context.deps)
        assert.ok(!context.calls.some(call => call.startsWith('override ')))
    })
```

How the fixture records a build (`calls` entries for runner calls) is set in `setup`'s runner around line 180. If a build is recorded under a name that does not contain `build`, match that name in the second test instead.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && node --import tsx --test src/agent/deploy.test.ts`
Expected: FAIL: no `override` call.

- [ ] **Step 3: Implement in `deploy.ts`**

1. Change `import type { Runner } from './compose.ts'` to `import type { ComposeLocation, Runner } from './compose.ts'` and add `import { isPortOverride, type PortOverrideResult } from './port-override.ts'`.
2. Add to `DeployDeps`, after `fs`:

```ts
    // Rebuilds hostd.ports.yml in the new tree from the commit going out (port-override.ts)
    portOverride: (location: ComposeLocation, portEnv: string) => Promise<PortOverrideResult>
```

3. In `runDeploy`, straight after the `nameDockerfiles` block and before the ownership comment:

```ts
        // hostd.ports.yml is rebuilt from the commit going out, over the copy carryComposeFiles brought
        // across: a commit that adds a service publishing a host port, or moves the site's container
        // port, is then covered at this deploy, not at the next port change. Before own, so the file is
        // owned with the rest of the tree, and before the build, so a refusal leaves the site untouched.
        if (nextEnvironment.composePaths.some(isPortOverride)) {
            const override = await deps.portOverride({ dir: trees.next, composePaths: nextEnvironment.composePaths }, project.portEnv)
            if (!override.ok) {
                await deps.fs.rmdir(trees.next).catch(() => {})
                return fail(`the port could not be published: ${override.problem}`)
            }
            deps.log(`deploy ${project.id} ${environment.name} ${commit.slice(0, 7)}: published ${environment.port} to ${override.service}:${override.target}`)
        }
```

- [ ] **Step 4: Wire production in `index.ts`**

Add to `deployDeps`, after `runner`:

```ts
        portOverride: (location, portEnv) => buildPortOverride(location, portEnv, runner, writeOwnedFile),
```

`writeOwnedFile` must be defined above `deployDeps` (Task 4 put it above `provision`, which comes first).

- [ ] **Step 5: Run the tests and the typecheck**

Run: `cd hostd && npm run typecheck && npm test`
Expected: all pass. If any other test builds a `DeployDeps` object of its own (search: `grep -rn "DeployDeps = {" hostd/src`), add the same `portOverride` recorder there.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/agent/deploy.ts hostd/src/agent/deploy.test.ts hostd/src/agent/index.ts
git commit -m "Rebuild hostd.ports.yml on every deploy" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The create request, the New site form and the runbook

**Files:**
- Modify: `hostd/src/shared/protocol.ts:407-418` (`parseCreateExtras`' compose rule)
- Modify: `hostd/src/shared/protocol.test.ts:119`
- Modify: `app/(portal)/portal/newSite/schema.ts:17-38`
- Create: `app/(portal)/portal/newSite/schema.test.ts`
- Modify: `app/(portal)/portal/newSite/NewSite.tsx:326`
- Modify: `hostd/RUNBOOK.md:68-90`

**Interfaces:**
- Consumes: `PORT_OVERRIDE_FILE`, `MAX_COMPOSE_FILES` from `shared/registry.ts`.

- [ ] **Step 1: Write the failing tests**

In `protocol.test.ts`, change line 119's expectation to `'bad-request: compose must name 1 to 7 files'` and add after it:

```ts
        const eight = Array.from({ length: 8 }, (_, index) => `c${index}.yml`)
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: eight } }), 'bad-request: compose must name 1 to 7 files')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: ['docker-compose.yml', 'deploy/hostd.ports.yml'] } }),
            'bad-request: hostd.ports.yml is the file hostd writes; name your own compose files')
```

Create `app/(portal)/portal/newSite/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { newSiteSchema } from './schema'

// Only the compose rule is under test here; the other fields are whatever parses
const compose = (list: string[]) => newSiteSchema.shape.compose.safeParse(list)

describe('the compose list', () => {
    it('leaves room for the file hostd writes', () => {
        expect(compose(Array.from({ length: 7 }, (_, index) => `c${index}.yml`)).success).toBe(true)
        const eight = compose(Array.from({ length: 8 }, (_, index) => `c${index}.yml`))
        expect(eight.success).toBe(false)
        expect(eight.error?.issues[0]?.message).toBe('List at most 7 compose files.')
    })

    it('refuses the name hostd writes, in any folder', () => {
        const result = compose(['docker-compose.yml', 'deploy/hostd.ports.yml'])
        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.message).toBe('hostd.ports.yml is the file hostd writes; name your own compose files.')
    })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd hostd && node --import tsx --test src/shared/protocol.test.ts`, then `npx vitest run "app/(portal)/portal/newSite/schema.test.ts"` from the repo root.
Expected: both FAIL.

- [ ] **Step 3: Implement**

In `protocol.ts`, add `PORT_OVERRIDE_FILE` to the import from `./registry.ts` (the multi-line import at line 6), add `import { posix } from 'node:path'` at the top, and change the compose rule in `parseCreateExtras` to:

```ts
    if (raw.compose !== undefined) {
        const list = raw.compose
        // One short of the registry's limit: hostd adds hostd.ports.yml to every list it creates
        const most = MAX_COMPOSE_FILES - 1
        if (!Array.isArray(list) || list.length === 0 || list.length > most) {
            return { ok: false, message: `compose must name 1 to ${most} files` }
        }
        for (const file of list) {
            if (typeof file !== 'string') return { ok: false, message: 'compose is malformed' }
            const problem = relativePathProblem(file)
            if (problem) return { ok: false, message: `compose file ${file}: ${problem}` }
            if (posix.basename(file) === PORT_OVERRIDE_FILE) {
                return { ok: false, message: `${PORT_OVERRIDE_FILE} is the file hostd writes; name your own compose files` }
            }
        }
        if (new Set(list).size !== list.length) return { ok: false, message: 'compose names a file twice' }
        extras.compose = list as string[]
    }
```

In `schema.ts`, replace `const MAX_COMPOSE_FILES = 8` with:

```ts
// One short of hostd's limit of 8: hostd adds hostd.ports.yml, the file that publishes the site's port,
// to every list it creates
const MAX_COMPOSE_FILES = 7
const PORT_OVERRIDE_FILE = 'hostd.ports.yml'
```

and add a refine to `composeFile`, after the segments rule:

```ts
    .refine(path => path.split('/').at(-1) !== PORT_OVERRIDE_FILE, `${PORT_OVERRIDE_FILE} is the file hostd writes; name your own compose files.`)
```

In `NewSite.tsx` line 326, replace the hint string with:

```tsx
                            : 'The port the site listens on. hostd publishes it to the site\'s service on 127.0.0.1, whatever the compose file says.'}
```

- [ ] **Step 4: Update the runbook**

In `hostd/RUNBOOK.md`, replace the two paragraphs and the numbered list from "hostd writes it into the environment's root `.env`" down to "5. Change the port in Settings." with:

```markdown
hostd writes it into the environment's root `.env` as `WEB_PORT=<port>` (or the variable the registry
entry's `portEnv` names), and publishes it itself: every environment it creates gets a compose file of
hostd's own, `hostd.ports.yml`, listed last in its compose list. It gives the site's service
`ports: !override ["127.0.0.1:${WEB_PORT}:<container port>"]` and every other service `ports: !reset []`,
so whatever the repo's compose file publishes, the panel's port is the only host port the site has.
The container port is the one the repo's first mapping resolves to, or its `expose` entry. Services still
reach each other by service name. Every deploy rebuilds the file from the commit going out.

hostd refuses (and a deploy fails before building) when it cannot tell which service is the site, when
that service names no container port (add `expose: ["3000"]` to it), or when it uses
`network_mode: host`. Do not edit `hostd.ports.yml` by hand: the next deploy rewrites it.

To move an existing site onto a port the panel chose:

1. If the domain is still served by a hand-written vhost, adopt it from the Domains tab. A port change
   refuses an environment whose domain hostd has no vhost file for (`<domain> is served by a
   hand-written vhost; ...`), since Apache would go on proxying to the old port.
2. Change the port in Settings. For a site without `hostd.ports.yml` yet, this writes it and adds it to
   the environment's compose list, then recreates the containers.
```

- [ ] **Step 5: Run the tests and check for em dashes**

Run: `cd hostd && npm test`, then `npx vitest run "app/(portal)/portal/newSite"` from the repo root.
Expected: all pass.

Run: `python -c "import sys;[print(f) for f in sys.argv[1:] if '\u2014' in open(f,encoding='utf-8').read()]" hostd/RUNBOOK.md "app/(portal)/portal/newSite/NewSite.tsx" "app/(portal)/portal/newSite/schema.ts"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add hostd/src/shared/protocol.ts hostd/src/shared/protocol.test.ts "app/(portal)/portal/newSite/schema.ts" "app/(portal)/portal/newSite/schema.test.ts" "app/(portal)/portal/newSite/NewSite.tsx" hostd/RUNBOOK.md
git commit -m "Keep hostd.ports.yml hostd's own in the create form and runbook" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Whole-branch check

- [ ] **Step 1: Run everything**

Run: `cd hostd && npm run typecheck && npm test`, then from the repo root `npx tsc --noEmit -p .` and `npx vitest run`.
Expected: all clean. A portal test pinned to the old New site port hint would fail here; update it to the new hint.

- [ ] **Step 2: Check the compose tags against the real Compose**

On the dedi (`ssh koda`), in a scratch folder, confirm Compose merges the tags as the spec says (the host runs v5.1.3, the agent v5.1.4; `config` pulls nothing):

```bash
ssh koda 'mkdir -p /tmp/ports-check && cd /tmp/ports-check && printf "services:\n  web:\n    image: nginx\n    ports: [\"3000:80\"]\n  db:\n    image: mongo:7\n    ports: [\"27017:27017\"]\n" > docker-compose.yml && printf "services:\n  \"db\":\n    ports: !reset []\n  \"web\":\n    ports: !override [\"127.0.0.1:\${WEB_PORT}:80\"]\n" > hostd.ports.yml && echo WEB_PORT=5999 > .env && docker compose -f docker-compose.yml -f hostd.ports.yml config --format json | python3 -c "import json,sys;s=json.load(sys.stdin)[\"services\"];print(s[\"web\"][\"ports\"], s[\"db\"].get(\"ports\"))"; rm -rf /tmp/ports-check'
```

Expected: the web service shows one port, `host_ip: 127.0.0.1`, `published: "5999"`, `target: 80`, and db shows `None`. If that is not the output, stop and report it: the override text in Task 1 has to change.

- [ ] **Step 3: Em dash check over every changed file**

Run: `git diff --name-only origin/Master... | xargs python -c "import sys;[print(f) for f in sys.argv[1:] if '\u2014' in open(f,encoding='utf-8').read()]"`
Expected: no output, or only files whose em dashes are in code comments (check each one printed).
