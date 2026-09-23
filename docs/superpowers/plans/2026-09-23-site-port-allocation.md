# Choosing a Site's Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The admin picks each environment's port (5000 to 65535) in the portal, hostd refuses a port another environment or any host service holds, and hostd writes the port into the site's `.env` as `WEB_PORT`.

**Architecture:** One pure rule in `hostd/src/shared/ports.ts` decides whether a port is free, fed by a set of listening ports that the agent reads from the host through a throwaway `--network host` container (plus Docker's published ports). Create and a new port-change verb write `<portEnv>=<port>` into the environment's root `.env`, check `docker compose config` publishes it, and roll back on failure. The portal gets a Port field in the New site modal and a port control per environment in Settings, both backed by a live check endpoint.

**Tech Stack:** hostd is Node 22 + TypeScript run by tsx, tested with `node:test`. The portal is Next.js 15 + React 18 + zod, tested with Vitest and Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-23-site-port-allocation-design.md`

## Global Constraints

- Never use em dashes (U+2014) in page copy, UI text, docs, commit messages or PR text. Comments in code may use them. Check new docs and UI strings with Python, not a bash `$'\u2014'` grep.
- Ports: whole numbers from 5000 to 65535 (`PORT_RANGE = { from: 5000, to: 65535 }`).
- The port variable is the registry's `portEnv` (default `WEB_PORT`), written into the environment's root `.env`.
- hostd never assumes a port is free: a failed host probe refuses with code `unavailable`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Match the surrounding code: 4-space indent, no semicolons, single quotes, explanatory comments in the house voice.
- hostd tests: `cd hostd && npm test` (all) or `node --import tsx --test <file>` (one). `cd hostd && npm run typecheck` must pass.
- Portal tests: `npx vitest run <path>` from the repo root. `npx tsc --noEmit` must pass.

## File map

hostd:
- Modify `hostd/src/shared/ports.ts`: `PORT_RANGE`, `portProblem`, sync `choosePort`, `OwnPort`, `PortVerdict`.
- Create `hostd/src/agent/host-ports.ts`: `parseProcNetTcp`, `probeArgv`, `createHostPortReader`.
- Modify `hostd/src/agent/docker.ts`: drop `dockerPortCheck` (replaced by the reader).
- Modify `hostd/src/agent/env-files.ts`: `readEnvFileIfPresent`.
- Create `hostd/src/agent/port-env.ts`: `withEnvValue`, `writePortEnv`, `restorePortEnv`.
- Modify `hostd/src/agent/compose.ts`: `ports` on `ResolvedService`, `publishedPortsOf`, `resolvePublished`, `published` from `resolveNewProject`.
- Modify `hostd/src/agent/provision.ts`: `checkPort`, `setPortEnv` deps; write and check the port on create and add-environment.
- Modify `hostd/src/shared/protocol.ts`: `port` on create, `ports` and `port` verbs.
- Modify `hostd/src/shared/registry-write.ts`: `set-port` change.
- Create `hostd/src/agent/port-change.ts`: `changePort`.
- Modify `hostd/src/agent/agent.ts`: `ports` and `port` handlers.
- Modify `hostd/src/agent/index.ts`: wiring.
- Modify `hostd/src/api/routes.ts`: `GET /ports`, `PUT /projects/:id/:env/port`, `port` in create body.
- Modify `hostd/RUNBOOK.md`: how a site publishes its port.

Portal:
- Create `server/hostd/ports.ts`: `checkPort`, `setPort`.
- Modify `server/hostd/create.ts`: `port` on `NewSite`.
- Create `app/(portal)/portal/sites/portActions.ts`: `checkPortAction`.
- Create `app/(portal)/portal/sites/usePortCheck.ts`: debounced check hook.
- Modify `app/(portal)/portal/newSite/schema.ts`, `actions.ts`, `NewSite.tsx`: the Port field.
- Create `app/(portal)/portal/sites/[id]/portControl.tsx`; modify `settings.tsx` and `actions.ts` (`setPortAction`).

---

### Task 1: The port rules

**Files:**
- Modify: `hostd/src/shared/ports.ts` (whole file)
- Modify: `hostd/src/shared/ports.test.ts` (whole file)
- Modify: `hostd/src/agent/docker.ts` (remove `dockerPortCheck` and the `PortCheck` import; keep `publishedHostPorts`)
- Modify: `hostd/src/agent/docker.test.ts` (remove the `dockerPortCheck` describe block and its import)
- Modify: `hostd/src/agent/index.ts:11,202` (the `choosePort` wiring)

**Interfaces:**
- Produces:
  - `PORT_RANGE: { from: 5000, to: 65535 }`
  - `type OwnPort = { project: string, environment: EnvironmentName }`
  - `type PortVerdict = { ok: true } | { ok: false, code: 'bad-request' | 'unavailable', problem: string }`
  - `portProblem(port: number, registry: Registry, listening: ReadonlySet<number>, own?: OwnPort, range?: PortRange): string | null`
  - `choosePort(registry: Registry, listening: ReadonlySet<number>, range?: PortRange): { ok: true, port: number } | { ok: false, problem: string }` (now synchronous)

- [ ] **Step 1: Write the failing tests**

Replace `hostd/src/shared/ports.test.ts` with:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseRegistry } from './registry.ts'
import { choosePort, portProblem, PORT_RANGE } from './ports.ts'

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

const nothing = new Set<number>()

describe('PORT_RANGE', () => {
    it('is 5000 and up', () => {
        assert.deepEqual(PORT_RANGE, { from: 5000, to: 65535 })
    })
})

describe('portProblem', () => {
    it('allows a port nothing holds', () => {
        assert.equal(portProblem(5002, registry, nothing), null)
    })

    it('refuses a port below 5000 or above 65535, or one that is not a whole number', () => {
        for (const port of [4999, 65536, 5000.5, Number.NaN]) {
            assert.equal(portProblem(port, registry, nothing), 'port must be a whole number from 5000 to 65535')
        }
    })

    it('names the environment that already holds a port', () => {
        assert.equal(portProblem(5001, registry, nothing), 'port 5001 is taken by acme (test)')
    })

    it('refuses a port something on the host is listening on', () => {
        assert.equal(portProblem(5004, registry, new Set([5004])), 'port 5004 is in use on the host')
    })

    // The environment being changed is running on its own port, so the host listing has it too.
    it('lets an environment keep its own port', () => {
        assert.equal(portProblem(5000, registry, new Set([5000]), { project: 'acme', environment: 'live' }), null)
    })

    it('still refuses its sibling environment\'s port', () => {
        assert.equal(portProblem(5001, registry, nothing, { project: 'acme', environment: 'live' }), 'port 5001 is taken by acme (test)')
    })
})

describe('choosePort', () => {
    it('gives the lowest port the registry is not using', () => {
        assert.deepEqual(choosePort(registry, nothing), { ok: true, port: 5002 })
    })

    it('skips a port something is already listening on, even when the registry does not know it', () => {
        assert.deepEqual(choosePort(registry, new Set([5002, 5003])), { ok: true, port: 5004 })
    })

    it('refuses when the range is full, naming the range', () => {
        const result = choosePort(registry, new Set([5002]), { from: 5000, to: 5002 })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /5000 to 5002/)
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && node --import tsx --test src/shared/ports.test.ts`
Expected: FAIL (`portProblem` is not exported, `PORT_RANGE` is 5999).

- [ ] **Step 3: Write the implementation**

Replace `hostd/src/shared/ports.ts` with:

```ts
// Which ports an environment may have. Two sources of truth, because either alone is wrong: the registry
// knows about environments that are not running, and the host itself knows about everything listening
// right now, hostd's own sites and every other service on the machine alike. The agent reads the second
// one (see host-ports.ts) and hands it in here as a plain set, so this file stays a pure rule that the
// create, the port change and the portal's live check all share.

import type { EnvironmentName, Registry } from './registry.ts'

export const PORT_RANGE = { from: 5000, to: 65535 }
export type PortRange = { from: number, to: number }

// The environment a port is being chosen FOR, when it already has one. Its own current port is not
// "taken": it is the port it is running on, so the host listing has it too, and saving a form without
// changing the port must not be refused for that.
export type OwnPort = { project: string, environment: EnvironmentName }

// What the agent's checkPort answers. unavailable is the host could not be read at all, which is never
// the same as "free": a caller refuses on it rather than guessing.
export type PortVerdict = { ok: true } | { ok: false, code: 'bad-request' | 'unavailable', problem: string }

function holderOf(registry: Registry, port: number, own?: OwnPort): string | null {
    for (const project of registry.projects.values()) {
        for (const environment of project.environments.values()) {
            if (environment.port !== port) continue
            if (own && project.id === own.project && environment.name === own.environment) continue
            return `${project.id} (${environment.name})`
        }
    }
    return null
}

function ownPort(registry: Registry, own?: OwnPort): number | null {
    if (!own) return null
    return registry.projects.get(own.project)?.environments.get(own.environment)?.port ?? null
}

export function portProblem(
    port: number, registry: Registry, listening: ReadonlySet<number>, own?: OwnPort, range: PortRange = PORT_RANGE,
): string | null {
    if (!Number.isInteger(port) || port < range.from || port > range.to) {
        return `port must be a whole number from ${range.from} to ${range.to}`
    }
    if (port === ownPort(registry, own)) return null
    const holder = holderOf(registry, port, own)
    if (holder) return `port ${port} is taken by ${holder}`
    if (listening.has(port)) return `port ${port} is in use on the host`
    return null
}

export function choosePort(registry: Registry, listening: ReadonlySet<number>, range: PortRange = PORT_RANGE) {
    for (let port = range.from; port <= range.to; port++) {
        if (portProblem(port, registry, listening, undefined, range) === null) return { ok: true as const, port }
    }
    return { ok: false as const, problem: `no free port ${range.from} to ${range.to}` }
}
```

In `hostd/src/agent/docker.ts`: delete the `import type { PortCheck } from '../shared/ports.ts'` line and the whole `dockerPortCheck` function with its comment block. Change the first header comment line's last sentence so it no longer mentions port checks if it does. In `hostd/src/agent/docker.test.ts`: remove `dockerPortCheck` from the import list and delete the `describe('dockerPortCheck', ...)` block.

In `hostd/src/agent/index.ts`: change the ports import to `import { choosePort } from '../shared/ports.ts'` (unchanged), import `publishedHostPorts` from `./docker.ts` in place of `dockerPortCheck`, and replace the `choosePort:` line and its comment with:

```ts
        // Docker's published ports alone for now; host-ports.ts adds everything else listening on the host.
        choosePort: async () => choosePort(store.current(), publishedHostPorts(await docker.listAllContainers())),
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd hostd && node --import tsx --test src/shared/ports.test.ts src/agent/docker.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/ports.ts hostd/src/shared/ports.test.ts hostd/src/agent/docker.ts hostd/src/agent/docker.test.ts hostd/src/agent/index.ts
git commit -m "Share one rule for which ports hostd may hand out, from 5000 up

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Reading the host's listening ports

**Files:**
- Create: `hostd/src/agent/host-ports.ts`
- Create: `hostd/src/agent/host-ports.test.ts`
- Modify: `hostd/src/agent/index.ts` (the `choosePort` wiring from Task 1)

**Interfaces:**
- Consumes: `Runner`, `RunResult`, `tail` from `./compose.ts`; `choosePort` from Task 1.
- Produces:
  - `type Listening = { ok: true, ports: ReadonlySet<number> } | { ok: false, problem: string }`
  - `parseProcNetTcp(text: string): Set<number>`
  - `probeArgv(image: string, name: string): string[]`
  - `createHostPortReader(deps: HostPortDeps): () => Promise<Listening>`
  - `type HostPortDeps = { runner: Runner, container: string, published: () => Promise<Set<number>>, newName?: () => string, now?: () => number, cacheMs?: number }`

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/agent/host-ports.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createHostPortReader, parseProcNetTcp, probeArgv } from './host-ports.ts'
import type { Runner, RunResult } from './compose.ts'

const IMAGE = `sha256:${'c'.repeat(64)}`

// Real rows, trimmed: sshd on 22 (0016), something on 5004 (138C) and 127.0.0.1:5001 (1389) listening,
// and an established connection from 5006 (138E) that is not a listener.
const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 00000000:138C 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1389 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 3 1 0000000000000000 100 0 0 10 0
   3: 0100007F:138E 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 4 1 0000000000000000 20 4 30 10 -1
`
const TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1396 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1 0000000000000000 100 0 0 10 0
`

function recorder(results: Array<Partial<RunResult>>) {
    const calls: Array<{ command: string, args: string[] }> = []
    const runner: Runner = async (command, args) => {
        calls.push({ command, args })
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...(results.shift() ?? {}) }
    }
    return { runner, calls }
}

describe('parseProcNetTcp', () => {
    it('keeps only listening sockets, IPv4 and IPv6, decoding their hex ports', () => {
        assert.deepEqual([...parseProcNetTcp(TCP + TCP6)].sort((a, b) => a - b), [22, 5001, 5004, 5014])
    })

    it('answers nothing for text that is not a listing', () => {
        assert.equal(parseProcNetTcp('cat: can\'t open\n').size, 0)
    })
})

describe('probeArgv', () => {
    it('runs cat in the host network namespace, from a local image, with nothing extra', () => {
        assert.deepEqual(probeArgv(IMAGE, 'hostd-port-probe-1'), [
            'run', '--rm', '--name', 'hostd-port-probe-1', '--network', 'host', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--pull', 'never', '--entrypoint', 'cat', IMAGE, '/proc/net/tcp', '/proc/net/tcp6',
        ])
    })
})

describe('createHostPortReader', () => {
    const published = async () => new Set([5007])

    it('looks up its own image once, probes, and adds Docker\'s published ports', async () => {
        const { runner, calls } = recorder([{ stdout: `${IMAGE}\n` }, { stdout: TCP + TCP6 }])
        const read = createHostPortReader({ runner, container: 'hostd-agent', published, newName: () => 'probe-1' })
        const seen = await read()
        assert.equal(seen.ok, true)
        assert.deepEqual([...(seen.ok ? seen.ports : [])].sort((a, b) => a - b), [22, 5001, 5004, 5007, 5014])
        assert.deepEqual(calls[0], { command: 'docker', args: ['inspect', '--format', '{{.Image}}', 'hostd-agent'] })
        assert.deepEqual(calls[1], { command: 'docker', args: probeArgv(IMAGE, 'probe-1') })
    })

    it('answers one reading for calls close together', async () => {
        let now = 0
        const { runner, calls } = recorder([{ stdout: IMAGE }, { stdout: TCP }, { stdout: TCP }])
        const read = createHostPortReader({ runner, container: 'hostd-agent', published, now: () => now, cacheMs: 2000 })
        await read()
        await read()
        assert.equal(calls.length, 2)
        now = 5000
        await read()
        // The image is not looked up again, only the probe runs
        assert.equal(calls.length, 3)
    })

    it('fails, and removes the container, when the probe times out', async () => {
        const { runner, calls } = recorder([{ stdout: IMAGE }, { timedOut: true, exitCode: null }, {}])
        const read = createHostPortReader({ runner, container: 'hostd-agent', published, newName: () => 'probe-2' })
        const seen = await read()
        assert.deepEqual(seen, { ok: false, problem: 'could not read the host\'s ports: the probe timed out' })
        assert.deepEqual(calls[2], { command: 'docker', args: ['rm', '-f', 'probe-2'] })
    })

    it('fails when the probe exits non-zero', async () => {
        const { runner } = recorder([{ stdout: IMAGE }, { exitCode: 125, stderr: 'Unable to find image' }, {}])
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published })()
        assert.equal(seen.ok, false)
        assert.match(seen.ok ? '' : seen.problem, /could not read the host's ports: Unable to find image/)
    })

    // A host always has something listening (sshd at least), so an empty listing is a broken probe.
    it('fails on an empty listing rather than calling every port free', async () => {
        const { runner } = recorder([{ stdout: IMAGE }, { stdout: '' }])
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published })()
        assert.deepEqual(seen, { ok: false, problem: 'could not read the host\'s ports: the listing was empty' })
    })

    it('fails when its own image cannot be read', async () => {
        const { runner } = recorder([{ exitCode: 1, stderr: 'No such object: hostd-agent' }])
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published })()
        assert.equal(seen.ok, false)
        assert.match(seen.ok ? '' : seen.problem, /hostd-agent's image could not be read/)
    })

    it('fails when Docker\'s published ports cannot be read', async () => {
        const { runner } = recorder([{ stdout: IMAGE }, { stdout: TCP }])
        const broken = async (): Promise<Set<number>> => { throw new Error('socket closed') }
        const seen = await createHostPortReader({ runner, container: 'hostd-agent', published: broken })()
        assert.deepEqual(seen, { ok: false, problem: 'could not read Docker\'s published ports: socket closed' })
    })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && node --import tsx --test src/agent/host-ports.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

Create `hostd/src/agent/host-ports.ts`:

```ts
// Every TCP port listening on the host, read from the host's own network namespace. The agent has
// network_mode: none, so it cannot probe the host by binding: it would only ever see its own empty
// namespace. What it does have is Docker, so it runs a throwaway container in the host's namespace
// (--network host) that reads /proc/net/tcp and tcp6 and exits. That lists Apache, databases, and
// anything else a person started by hand, which is exactly what Docker's own published-port view
// cannot see.
//
// The container runs the agent's own image, looked up from the agent's own container, so nothing is
// ever pulled (the agent is offline) and a rebuild never leaves this on a stale tag. Docker's published
// ports are added on top: with the userland proxy off a published port has no listener of its own, and
// a container that is still starting has its port reserved before anything listens on it.

import { randomBytes } from 'node:crypto'

import { describeError } from '../shared/formats.ts'
import { tail, type Runner } from './compose.ts'

export const PROBE_TIMEOUT_MS = 10_000
const INSPECT_TIMEOUT_MS = 15_000
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/
const LISTEN = '0A'

export type Listening = { ok: true, ports: ReadonlySet<number> } | { ok: false, problem: string }

export type HostPortDeps = {
    runner: Runner
    // The agent's own container, whose image the probe runs
    container: string
    // Docker's published ports, read fresh on every call
    published: () => Promise<Set<number>>
    newName?: () => string
    now?: () => number
    // How long one reading answers every caller. The portal's live check asks for a suggestion and a
    // verdict back to back, and that should cost one probe, not two.
    cacheMs?: number
}

// Rows are `sl local rem st ...`, local is HEXADDR:HEXPORT. The header row has no colon-separated port
// and is skipped by the state check, as is anything that is not a listing at all.
export function parseProcNetTcp(text: string): Set<number> {
    const ports = new Set<number>()
    for (const line of text.split('\n')) {
        const fields = line.trim().split(/\s+/)
        if (fields.length < 4 || fields[3] !== LISTEN) continue
        const local = fields[1] ?? ''
        const hex = local.slice(local.lastIndexOf(':') + 1)
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) continue
        ports.add(Number.parseInt(hex, 16))
    }
    return ports
}

export function probeArgv(image: string, name: string): string[] {
    return [
        'run', '--rm', '--name', name, '--network', 'host', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--pull', 'never', '--entrypoint', 'cat', image, '/proc/net/tcp', '/proc/net/tcp6',
    ]
}

export function createHostPortReader(deps: HostPortDeps): () => Promise<Listening> {
    const newName = deps.newName ?? (() => `hostd-port-probe-${randomBytes(4).toString('hex')}`)
    const now = deps.now ?? Date.now
    const cacheMs = deps.cacheMs ?? 2000
    let image: string | null = null
    let cached: { at: number, reading: Promise<Listening> } | null = null

    async function ownImage(): Promise<string | { problem: string }> {
        if (image) return image
        const result = await deps.runner('docker', ['inspect', '--format', '{{.Image}}', deps.container], INSPECT_TIMEOUT_MS)
        const id = result.stdout.trim()
        if (result.exitCode !== 0 || !IMAGE_ID.test(id)) {
            return { problem: `could not read the host's ports: ${deps.container}'s image could not be read: ${tail(result.stderr.trim(), 300)}` }
        }
        image = id
        return id
    }

    async function read(): Promise<Listening> {
        const found = await ownImage()
        if (typeof found !== 'string') return { ok: false, problem: found.problem }

        const name = newName()
        const result = await deps.runner('docker', probeArgv(found, name), PROBE_TIMEOUT_MS)
        if (result.timedOut || result.exitCode !== 0) {
            // --rm only removes a container that exits; one killed with its CLI is left behind otherwise
            await deps.runner('docker', ['rm', '-f', name], INSPECT_TIMEOUT_MS).catch(() => undefined)
            const why = result.timedOut ? 'the probe timed out' : tail(result.stderr.trim(), 300)
            return { ok: false, problem: `could not read the host's ports: ${why}` }
        }
        const ports = parseProcNetTcp(result.stdout)
        if (ports.size === 0) return { ok: false, problem: 'could not read the host\'s ports: the listing was empty' }

        try {
            for (const port of await deps.published()) ports.add(port)
        } catch (error) {
            return { ok: false, problem: `could not read Docker's published ports: ${describeError(error)}` }
        }
        return { ok: true, ports }
    }

    return () => {
        if (cached && now() - cached.at < cacheMs) return cached.reading
        const reading = read()
        cached = { at: now(), reading }
        // A failed reading is not kept: the next caller should try again rather than inherit it
        void reading.then(seen => { if (!seen.ok && cached?.reading === reading) cached = null })
        return reading
    }
}
```

Check `describeError` is exported from `hostd/src/shared/formats.ts` (it is used by provision.ts) and `tail` from `compose.ts` (it is).

In `hostd/src/agent/index.ts`, import `createHostPortReader` from `./host-ports.ts`, and after `const runner = createSpawnRunner()` add:

```ts
    // Every port listening on the host, for choosing and checking ports. See host-ports.ts.
    const listening = createHostPortReader({
        runner,
        container: process.env.HOSTD_AGENT_CONTAINER ?? 'hostd-agent',
        published: async () => publishedHostPorts(await docker.listAllContainers()),
    })
```

Replace the Task 1 `choosePort:` line with:

```ts
        // A refusal rather than a guess when the host cannot be read: see host-ports.ts.
        choosePort: async () => {
            const seen = await listening()
            return seen.ok ? choosePort(store.current(), seen.ports) : { ok: false, problem: seen.problem }
        },
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd hostd && node --import tsx --test src/agent/host-ports.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/host-ports.ts hostd/src/agent/host-ports.test.ts hostd/src/agent/index.ts
git commit -m "Read every port listening on the dedi before handing one out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Writing the port into .env and reading what compose publishes

**Files:**
- Modify: `hostd/src/agent/env-files.ts` (add `readEnvFileIfPresent` after `readEnvFile`)
- Create: `hostd/src/agent/port-env.ts`
- Create: `hostd/src/agent/port-env.test.ts`
- Modify: `hostd/src/agent/compose.ts` (`ResolvedService.ports`, `publishedPortsOf`, `resolvePublished`, `resolveNewProject`)
- Modify: `hostd/src/agent/compose.test.ts` (new cases)

**Interfaces:**
- Consumes: `readEnvFile`, `writeEnvFile`, `EnvFs` from `env-files.ts`; `EnvironmentEntry` from registry.
- Produces:
  - `readEnvFileIfPresent(environment: EnvironmentEntry, relative: string, fs?: EnvFs): Promise<{ ok: true, text: string | null } | { ok: false, problem: string }>`
  - `PORT_ENV_FILE = '.env'`
  - `withEnvValue(text: string, key: string, value: string): string`
  - `writePortEnv(environment: EnvironmentEntry, key: string, port: number, fs?: EnvFs): Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }>`
  - `restorePortEnv(environment: EnvironmentEntry, previous: string | null, fs?: EnvFs): Promise<{ ok: true } | { ok: false, problem: string }>`
  - `publishedPortsOf(resolved: ResolvedCompose): number[]`
  - `resolvePublished(location: ComposeLocation, run: Runner): Promise<{ ok: true, ports: number[] } | { ok: false, problem: string }>`
  - `resolveNewProject(...)` now answers `{ ok: true, services, published: number[] }`

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/agent/port-env.test.ts`. Build the fake `EnvFs` inline (a `Map` of path to text, same shape as `fakeEnvFs` in `provision.test.ts`, whose `realpath` answers the path unchanged):

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { restorePortEnv, withEnvValue, writePortEnv } from './port-env.ts'
import type { EnvFs } from './env-files.ts'
import type { EnvironmentEntry } from '../shared/registry.ts'

function fakeFs(tree: Record<string, string> = {}) {
    const files = new Map(Object.entries(tree))
    const fs: EnvFs = {
        async readdir() { return [] },
        async readFile(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: ${path}`)
            return text
        },
        async writeFile(path, text) { files.set(path, text) },
        async rename(from, to) { files.set(to, files.get(from)!); files.delete(from) },
        async stat(path) {
            const text = files.get(path)
            if (text === undefined) throw new Error(`ENOENT: ${path}`)
            return { size: text.length }
        },
        async realpath(path) { return path },
    }
    return { fs, files }
}

const live: EnvironmentEntry = {
    name: 'live', dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml'], branch: 'main', domain: null,
    aliases: [], port: 5010, certificate: null, deployed: null, websockets: false, flexibleSsl: false,
}

describe('withEnvValue', () => {
    it('replaces the key where it is, leaving every other line alone', () => {
        assert.equal(withEnvValue('A=1\nWEB_PORT=3000\nB=2\n', 'WEB_PORT', '5012'), 'A=1\nWEB_PORT=5012\nB=2\n')
    })

    it('reads an export prefix and spaces around = as the same key, and drops later copies', () => {
        assert.equal(withEnvValue('export WEB_PORT = 3000\nWEB_PORT=1\n', 'WEB_PORT', '5012'), 'WEB_PORT=5012\n')
    })

    it('appends the key when it is missing, on a line of its own', () => {
        assert.equal(withEnvValue('A=1', 'WEB_PORT', '5012'), 'A=1\nWEB_PORT=5012\n')
        assert.equal(withEnvValue('', 'WEB_PORT', '5012'), 'WEB_PORT=5012\n')
    })

    it('does not touch a key that merely starts with the same letters', () => {
        assert.equal(withEnvValue('WEB_PORT_ADMIN=9\n', 'WEB_PORT', '5012'), 'WEB_PORT_ADMIN=9\nWEB_PORT=5012\n')
    })
})

describe('writePortEnv', () => {
    it('writes the port into the root .env and answers what was there', async () => {
        const { fs, files } = fakeFs({ '/var/www/acme/.env': 'A=1\nWEB_PORT=3000\n' })
        assert.deepEqual(await writePortEnv(live, 'WEB_PORT', 5012, fs), { ok: true, previous: 'A=1\nWEB_PORT=3000\n' })
        assert.equal(files.get('/var/www/acme/.env'), 'A=1\nWEB_PORT=5012\n')
    })

    it('creates .env when there is none, answering null for what was there', async () => {
        const { fs, files } = fakeFs()
        assert.deepEqual(await writePortEnv(live, 'APP_PORT', 5012, fs), { ok: true, previous: null })
        assert.equal(files.get('/var/www/acme/.env'), 'APP_PORT=5012\n')
    })
})

describe('restorePortEnv', () => {
    it('puts back what was there', async () => {
        const { fs, files } = fakeFs({ '/var/www/acme/.env': 'WEB_PORT=5012\n' })
        assert.deepEqual(await restorePortEnv(live, 'WEB_PORT=3000\n', fs), { ok: true })
        assert.equal(files.get('/var/www/acme/.env'), 'WEB_PORT=3000\n')
    })

    // EnvFs has no unlink, so a file that did not exist before is left empty rather than removed
    it('empties a .env that did not exist before', async () => {
        const { fs, files } = fakeFs({ '/var/www/acme/.env': 'WEB_PORT=5012\n' })
        await restorePortEnv(live, null, fs)
        assert.equal(files.get('/var/www/acme/.env'), '')
    })
})
```

Add to `hostd/src/agent/compose.test.ts` (import `publishedPortsOf` and `resolveNewProject` from `./compose.ts` alongside the existing imports; reuse the file's existing fake-runner style):

```ts
describe('publishedPortsOf', () => {
    it('answers every host port any service publishes, as numbers, skipping ranges and unpublished ones', () => {
        const resolved = {
            name: 'acme',
            services: {
                web: { ports: [{ target: 3000, published: '5012', host_ip: '127.0.0.1', protocol: 'tcp' }] },
                api: { ports: [{ target: 4000, published: 5013 }, { target: 9229 }, { target: 80, published: '6000-6002' }] },
                db: {},
            },
        }
        assert.deepEqual(publishedPortsOf(resolved), [5012, 5013])
    })
})

describe('resolveNewProject published', () => {
    it('answers the published ports beside the guessed services', async () => {
        const stdout = JSON.stringify({ name: 'acme', services: { web: { image: 'node:22', ports: [{ target: 3000, published: '5012' }] } } })
        const run: Runner = async () => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
        const result = await resolveNewProject({ dir: '/var/www/acme', composePaths: ['/var/www/acme/docker-compose.yml'] }, 'acme', run)
        assert.deepEqual(result, { ok: true, services: { web: { role: 'site' } }, published: [5012] })
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/agent/port-env.test.ts src/agent/compose.test.ts`
Expected: FAIL (module not found, `publishedPortsOf` not exported).

- [ ] **Step 3: Write the implementation**

In `hostd/src/agent/env-files.ts`, after `readEnvFile`, add:

```ts
// readEnvFile, except that a file that is not there is an answer (null) rather than a failure. The port
// writer needs the difference: it creates .env when a repo has none, and puts back exactly what was there
// when a port change is undone.
export async function readEnvFileIfPresent(
    environment: EnvironmentEntry, relative: string, fs: EnvFs = nodeFs,
): Promise<{ ok: true, text: string | null } | { ok: false, problem: string }> {
    try {
        await fs.stat(posix.join(environment.dir, relative))
    } catch {
        return { ok: true, text: null }
    }
    return readEnvFile(environment, relative, fs)
}
```

Create `hostd/src/agent/port-env.ts`:

```ts
// The one line of a site's .env that hostd owns: <portEnv>=<port>. The site's compose file publishes it
// (ports: ["127.0.0.1:${WEB_PORT}:3000"]), which is how the port chosen in the portal is the port the
// site actually binds. The root .env, because that is the file compose reads for interpolation when it
// runs with --project-directory set to the environment's folder, as every compose call hostd makes does.
// Writes go through env-files.ts, so this stays inside the same boundary every other env write does.

import type { EnvironmentEntry } from '../shared/registry.ts'
import { readEnvFileIfPresent, writeEnvFile, type EnvFs } from './env-files.ts'

export const PORT_ENV_FILE = '.env'

// key is always an ENV_NAME (capitals, digits, underscores; see registry.ts's parsePortEnv), so it is safe
// to put straight into a pattern. An `export` prefix and spaces around = are the same key to compose, and
// a later copy of it would win over the one written here, so later copies are dropped.
export function withEnvValue(text: string, key: string, value: string): string {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
    let found = false
    const lines: string[] = []
    for (const line of text.split('\n')) {
        if (!pattern.test(line)) {
            lines.push(line)
            continue
        }
        if (!found) lines.push(`${key}=${value}`)
        found = true
    }
    if (found) return lines.join('\n')
    const body = text === '' || text.endsWith('\n') ? text : `${text}\n`
    return `${body}${key}=${value}\n`
}

export async function writePortEnv(
    environment: EnvironmentEntry, key: string, port: number, fs?: EnvFs,
): Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }> {
    const read = await readEnvFileIfPresent(environment, PORT_ENV_FILE, fs)
    if (!read.ok) return read
    const written = await writeEnvFile(environment, PORT_ENV_FILE, withEnvValue(read.text ?? '', key, String(port)), fs)
    return written.ok ? { ok: true, previous: read.text } : written
}

// EnvFs has no unlink, so a .env this created is emptied rather than removed. An empty .env reads the
// same as a missing one to compose.
export async function restorePortEnv(
    environment: EnvironmentEntry, previous: string | null, fs?: EnvFs,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    return writeEnvFile(environment, PORT_ENV_FILE, previous ?? '', fs)
}
```

In `hostd/src/agent/compose.ts`:

1. Add to `ResolvedService`:

```ts
    // As `docker compose config --format json` writes them: published is a string ("5012", or a range
    // like "6000-6002") or, from some compose versions, a number. Absent when the port is not published.
    ports?: Array<{ target?: number, published?: string | number, host_ip?: string, protocol?: string }>
```

2. After `resolveCompose`, add:

```ts
// Every single host port some service publishes. A range is skipped: hostd hands out one port per
// environment, and a range cannot be the one the portal chose.
export function publishedPortsOf(resolved: ResolvedCompose): number[] {
    const ports: number[] = []
    for (const service of Object.values(resolved.services)) {
        for (const port of service.ports ?? []) {
            const published = typeof port.published === 'number' ? String(port.published) : port.published
            if (published !== undefined && /^\d{1,5}$/.test(published)) ports.push(Number(published))
        }
    }
    return ports
}

// What an environment already on disk publishes, for a port change: the same config call create makes.
export async function resolvePublished(
    location: ComposeLocation, run: Runner,
): Promise<{ ok: true, ports: number[] } | { ok: false, problem: string }> {
    const result = await resolveCompose(location, run)
    return result.ok ? { ok: true, ports: publishedPortsOf(result.resolved) } : result
}
```

3. Change `resolveNewProject`'s return type to `Promise<{ ok: true, services: Record<string, GuessedService>, published: number[] } | { ok: false, problem: string }>` and its last line to `return { ok: true, services, published: publishedPortsOf(result.resolved) }`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd hostd && node --import tsx --test src/agent/port-env.test.ts src/agent/compose.test.ts && npm run typecheck`
Expected: tests PASS. Typecheck may fail in `provision.ts`/`index.ts`/test fakes over `published`; if it does, that is fixed in Task 4. If typecheck fails for any other reason, fix it here.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/agent/env-files.ts hostd/src/agent/port-env.ts hostd/src/agent/port-env.test.ts hostd/src/agent/compose.ts hostd/src/agent/compose.test.ts
git commit -m "Write a site's port into its .env and read the ports its compose file publishes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Create and add-environment write the port and check it is published

**Files:**
- Modify: `hostd/src/shared/protocol.ts` (`ProvisionCreateArgs.port`, `CREATE_KEYS`, `CreateExtras`, `parseCreateExtras`)
- Modify: `hostd/src/shared/protocol.test.ts` (new cases)
- Modify: `hostd/src/agent/provision.ts` (`ProvisionDeps`, `ProvisionAttempt`, `provisionOnDisk`, `createProject`, `addEnvironment`)
- Modify: `hostd/src/agent/provision.test.ts` (setup defaults, order assertions, new cases)
- Modify: `hostd/src/agent/agent.test.ts:440-460` (`fakeProvisionDeps`)
- Modify: `hostd/src/agent/index.ts` (wire `checkPort`, `setPortEnv`)
- Modify: `hostd/src/api/routes.test.ts` (create carries `port`)

**Interfaces:**
- Consumes: `portProblem`, `PortVerdict`, `OwnPort`, `PORT_RANGE` (Task 1); `listening` reader (Task 2); `writePortEnv`, `resolveNewProject` published (Task 3).
- Produces:
  - `ProvisionCreateArgs.port?: number`
  - `ProvisionDeps.checkPort: (port: number, own?: OwnPort) => Promise<PortVerdict>`
  - `ProvisionDeps.setPortEnv: (environment: EnvironmentEntry, key: string, port: number) => Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }>`
  - `ProvisionDeps.resolve` answers `published: number[]` on success
  - `notPublishedProblem(key: string, port: number): string` exported from `provision.ts`

- [ ] **Step 1: Write the failing tests**

In `hostd/src/shared/protocol.test.ts`, add:

```ts
describe('create port', () => {
    const base = { action: 'create', id: 'bakery', name: 'Bakery', repo: 'git@github.com:a/b.git', branch: 'main', domain: null, certificate: null }

    it('carries a port through', () => {
        const parsed = parseAgentRequest(JSON.stringify({ verb: 'provision', args: { ...base, port: 5012 } }))
        assert.equal(parsed.ok, true)
        assert.equal(parsed.ok && parsed.request.verb === 'provision' ? (parsed.request.args as { port?: number }).port : null, 5012)
    })

    it('refuses a port outside 5000 to 65535 or one that is not a whole number', () => {
        for (const port of [80, 70000, 5012.5, '5012']) {
            const parsed = parseAgentRequest(JSON.stringify({ verb: 'provision', args: { ...base, port } }))
            assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'port must be a whole number from 5000 to 65535' })
        }
    })
})
```

In `hostd/src/agent/provision.test.ts`:

1. In `setup()`, add to `SetupOptions`: `checkResult?: PortVerdict` and `setPortResult?: { ok: true, previous: string | null } | { ok: false, problem: string }` (import `PortVerdict` from `../shared/ports.ts`). Add `const portEnvCalls: Array<{ dir: string, key: string, port: number }> = []` and return it from `setup`. Add to `deps`:

```ts
        checkPort: async () => {
            calls.push('checkPort')
            return options.checkResult ?? { ok: true }
        },
        setPortEnv: async (environment, key, port) => {
            calls.push('setPortEnv')
            portEnvCalls.push({ dir: environment.dir, key, port })
            return options.setPortResult ?? { ok: true, previous: null }
        },
```

2. Change the default `resolveResult` in `setup()` to `{ ok: true, services: { web: { role: 'site' } }, published: [5100] }`, and add `published: [5100]` to every other `resolveResult: { ok: true, ... }` in the file (`grep -n "resolveResult: { ok: true" hostd/src/agent/provision.test.ts`). The default `portResult` hands out 5100.

3. Every `assert.deepEqual(calls, [...])` whose list has `'clone'` followed by more steps now has `'setPortEnv'` straight after `'clone'` (before `'owner'`): for example `['exists', 'choosePort', 'mkdir', 'clone', 'setPortEnv', 'owner', 'own', 'resolve', 'write']`. Find them with `grep -n "assert.deepEqual(calls" hostd/src/agent/provision.test.ts`. A list that stops at `'clone'` (clone failed) is unchanged.

4. Add these tests inside `describe('createProject', ...)`:

```ts
    it('writes the chosen port into .env under WEB_PORT before resolving', async () => {
        const { deps, portEnvCalls, calls } = setup()
        await createProject(createArgs(), deps)
        assert.deepEqual(portEnvCalls, [{ dir: '/var/www/bakery', key: 'WEB_PORT', port: 5100 }])
        assert.ok(calls.indexOf('setPortEnv') < calls.indexOf('resolve'))
    })

    it('uses the port it was given, checked, instead of choosing one', async () => {
        const { deps, calls, portEnvCalls, registryFiles } = setup({ resolveResult: { ok: true, services: { web: { role: 'site' } }, published: [5012] } })
        const reply = await createProject(createArgs({ port: 5012 }), deps)
        assert.equal(reply.ok, true)
        assert.ok(calls.includes('checkPort'))
        assert.ok(!calls.includes('choosePort'))
        assert.equal(portEnvCalls[0]?.port, 5012)
        assert.equal(parseRegistry(registryFiles.get(REGISTRY_PATH)!).projects.get('bakery')?.environments.get('live')?.port, 5012)
    })

    it('refuses a port the check refuses, before touching the disk', async () => {
        const { deps, calls } = setup({ checkResult: { ok: false, code: 'bad-request', problem: 'port 5004 is in use on the host' } })
        const reply = await createProject(createArgs({ port: 5004 }), deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'port 5004 is in use on the host' })
        assert.ok(!calls.includes('mkdir'))
    })

    it('refuses as unavailable when the host could not be read', async () => {
        const { deps } = setup({ checkResult: { ok: false, code: 'unavailable', problem: 'could not read the host\'s ports: the probe timed out' } })
        const reply = await createProject(createArgs({ port: 5012 }), deps)
        assert.equal(reply.ok === false && reply.code, 'unavailable')
    })

    it('rolls back when no service publishes the port', async () => {
        const { deps, rmdirs, calls } = setup({ resolveResult: { ok: true, services: { web: { role: 'site' } }, published: [3000] } })
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'invalid-project', message: notPublishedProblem('WEB_PORT', 5100) })
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
        assert.ok(!calls.includes('write'))
    })

    it('rolls back when .env cannot be written', async () => {
        const { deps, rmdirs } = setup({ setPortResult: { ok: false, problem: 'the env file could not be written: EACCES' } })
        const reply = await createProject(createArgs(), deps)
        assert.deepEqual(reply, { ok: false, code: 'failed', message: 'the env file could not be written: EACCES' })
        assert.deepEqual(rmdirs, ['/var/www/bakery'])
    })
```

Import `notPublishedProblem` from `./provision.ts`.

5. Add inside the add-environment describe block:

```ts
    it('writes the test environment\'s own port over the one copied from live', async () => {
        const { deps, portEnvCalls } = setup()
        const reply = await addEnvironment(project(), args(), deps)
        assert.equal(reply.ok, true)
        assert.deepEqual(portEnvCalls, [{ dir: '/var/www/acme-test', key: 'WEB_PORT', port: 5100 }])
    })
```

(`project()` and `args()` are the helpers the existing add-environment tests use.)

In `hostd/src/agent/agent.test.ts` `fakeProvisionDeps`, add `checkPort: async () => ({ ok: true }),` and `setPortEnv: async () => ({ ok: true, previous: null }),` and change `resolve` to answer `{ ok: true, services: { web: { role: 'site' } }, published: [5100] }`.

In `hostd/src/api/routes.test.ts`, add near the other create tests:

```ts
    it('carries a port through to the agent', async () => {
        agent.reply = () => ({ ok: true, project: { id: 'newsite', state: 'needs-setup' }, envFiles: [] })
        const response = await request('/projects', { method: 'POST', actor: 'admin', body: { ...CREATE_BODY, domain: null, certificate: null, port: 5012 } })
        assert.equal(response.status, 200)
        assert.equal((agent.calls[0] as { args: { port?: number } }).args.port, 5012)
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/shared/protocol.test.ts src/agent/provision.test.ts src/api/routes.test.ts`
Expected: FAIL (port not parsed, `checkPort` and `setPortEnv` never called, `notPublishedProblem` not exported).

- [ ] **Step 3: Write the implementation**

`hostd/src/shared/protocol.ts`:

- Add to `ProvisionCreateArgs`, after `flexibleSsl`:

```ts
    // The live environment's port. Absent means hostd chooses the lowest free one, which is what the
    // runbook's hand calls and every create before this field got.
    port?: number
```

- Add `'port'` to the end of `CREATE_KEYS`, and `'port'` to the `CreateExtras` pick.
- Import `PORT_RANGE` from `./ports.ts`. In `parseCreateExtras`, before the final return, add:

```ts
    if (raw.port !== undefined) {
        // The range only: whether a port is free is the agent's to say, against the registry and the host
        if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < PORT_RANGE.from || raw.port > PORT_RANGE.to) {
            return { ok: false, message: `port must be a whole number from ${PORT_RANGE.from} to ${PORT_RANGE.to}` }
        }
        extras.port = raw.port
    }
```

`ports.ts` imports only types from `registry.ts`, so there is no import cycle.

`hostd/src/agent/provision.ts`:

- Import `type OwnPort, type PortVerdict` from `../shared/ports.ts` and `DEFAULT_PORT_ENV` from `../shared/registry.ts`.
- Add to `ProvisionDeps`, after `choosePort`:

```ts
    // Whether a port the operator named is free: the same rule choosePort applies, against the registry
    // and a fresh reading of the host. own is the environment the port is for, whose current port is not
    // counted against it.
    checkPort: (port: number, own?: OwnPort) => Promise<PortVerdict>
    // Writes <key>=<port> into the environment's root .env (port-env.ts), answering what was there. A
    // dependency rather than a direct call, so a test never writes to a real /var/www.
    setPortEnv: (environment: EnvironmentEntry, key: string, port: number) => Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }>
```

- Change the `resolve` dep's success type to `{ ok: true, services: Record<string, GuessedService>, published: number[] }`.
- Add after `invalidRegistryProblem`:

```ts
// Said the same way by create, add-environment and a port change, so the operator always learns what the
// compose file has to say, not only that it did not say it.
export function notPublishedProblem(key: string, port: number): string {
    return `no service publishes port ${port}; publish \${${key}} in the compose file, like "127.0.0.1:\${${key}}:3000"`
}
```

- Add to `ProvisionAttempt`:

```ts
    // The port this environment gets. provisionOnDisk writes it into .env straight after the clone
    // (after afterClone, so it wins over a .env copied from live) and refuses unless compose publishes it.
    port: number
    portEnv: string
```

- In `provisionOnDisk`, after the `afterClone` block and before `const like = await deps.owner(...)`, add:

```ts
        // Before own, so .env is covered by it, and before resolve, which interpolates it
        const portWritten = await deps.setPortEnv(
            { name: 'live', dir, composePaths, branch: attempt.branch, domain: null, aliases: [], port: attempt.port, certificate: null, deployed: null, websockets: false, flexibleSsl: false },
            attempt.portEnv, attempt.port,
        )
        if (!portWritten.ok) {
            await rollback('writing the port failed')
            return refuse('failed', portWritten.problem)
        }
```

  (`setPortEnv` only reads `dir` from the entry; the placeholder fields keep its type honest.)

- In `provisionOnDisk`, after the `Object.keys(resolved.services).length === 0` check, add:

```ts
        if (!resolved.published.includes(attempt.port)) {
            await rollback(`compose does not publish port ${attempt.port}`)
            return refuse('invalid-project', notPublishedProblem(attempt.portEnv, attempt.port))
        }
```

- In `createProject`, replace:

```ts
    const port = await deps.choosePort()
    if (!port.ok) return refuse('unavailable', port.problem)
```

  with:

```ts
    let port: { ok: true, port: number }
    if (args.port === undefined) {
        const chosen = await deps.choosePort()
        if (!chosen.ok) return refuse('unavailable', chosen.problem)
        port = chosen
    } else {
        // Checked here, under the agent's provisioning lock, whatever the portal's live check said
        const verdict = await deps.checkPort(args.port)
        if (!verdict.ok) return refuse(verdict.code, verdict.problem)
        port = { ok: true, port: args.port }
    }
```

  and pass `port: port.port, portEnv: DEFAULT_PORT_ENV,` in the `provisionOnDisk({ ... })` call (a new project has no `portEnv` key yet, so it gets the default).

- In `addEnvironment`, pass `port: port.port, portEnv: project.portEnv,` in its `provisionOnDisk({ ... })` call.

`hostd/src/agent/index.ts`: import `portProblem` from `../shared/ports.ts` and `writePortEnv` from `./port-env.ts`, and add to `provision` after `choosePort`:

```ts
        checkPort: async (port, own) => {
            const seen = await listening()
            if (!seen.ok) return { ok: false, code: 'unavailable', problem: seen.problem }
            const problem = portProblem(port, store.current(), seen.ports, own)
            return problem ? { ok: false, code: 'bad-request', problem } : { ok: true }
        },
        setPortEnv: (environment, key, port) => writePortEnv(environment, key, port),
```

`hostd/src/api/routes.ts`: `parseCreateBody` already spreads `extras.extras`, and `CREATE_KEYS` now has `port`, so nothing else changes there.

- [ ] **Step 4: Run all hostd tests and typecheck**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS. If an existing test breaks because of `published` or the call order, fix the fixture as Step 1 describes, never the rule.

- [ ] **Step 5: Commit**

```bash
git add hostd/src
git commit -m "Write each new environment's port into its .env and require compose to publish it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: A live port check (agent `ports` verb and `GET /ports`)

**Files:**
- Modify: `hostd/src/shared/protocol.ts` (`PortsRequest`, `PortsReply`, `VERB_CAPABILITY`, `parseAgentRequest`)
- Modify: `hostd/src/shared/protocol.test.ts`
- Modify: `hostd/src/agent/agent.ts` (`handle`, new `ports` method)
- Modify: `hostd/src/agent/agent.test.ts`
- Modify: `hostd/src/api/routes.ts` (`Route`, `matchRoute`, handler, `parsePortsQuery`)
- Modify: `hostd/src/api/routes.test.ts`

**Interfaces:**
- Consumes: `ProvisionDeps.choosePort`, `ProvisionDeps.checkPort` (Task 4).
- Produces:
  - `type PortsArgs = { port: number | null, own: OwnPort | null }`
  - `type PortsRequest = { verb: 'ports', args: PortsArgs }`
  - `type PortsReply = { ok: true, suggested: number, problem: string | null }`
  - HTTP: `GET /ports?port=5012&project=acme&environment=live` answers `PortsReply`. `project` and `environment` go together or not at all. Admin only (403 otherwise).

- [ ] **Step 1: Write the failing tests**

`hostd/src/shared/protocol.test.ts`:

```ts
describe('ports', () => {
    it('parses a check with and without a port and an own environment', () => {
        assert.deepEqual(parseAgentRequest('{"verb":"ports","args":{"port":null,"own":null}}'), { ok: true, request: { verb: 'ports', args: { port: null, own: null } } })
        assert.deepEqual(
            parseAgentRequest('{"verb":"ports","args":{"port":5012,"own":{"project":"acme","environment":"live"}}}'),
            { ok: true, request: { verb: 'ports', args: { port: 5012, own: { project: 'acme', environment: 'live' } } } },
        )
    })

    it('refuses anything else', () => {
        for (const line of [
            '{"verb":"ports"}',
            '{"verb":"ports","args":{"port":"5012","own":null}}',
            '{"verb":"ports","args":{"port":null,"own":{"project":"acme","environment":"prod"}}}',
            '{"verb":"ports","args":{"port":null,"own":null,"extra":1}}',
        ]) assert.equal(parseAgentRequest(line).ok, false)
    })
})
```

`hostd/src/agent/agent.test.ts` (uses `fakeProvisionDeps` from Task 4):

```ts
describe('ports', () => {
    const ask = (port: number | null, own: { project: string, environment: 'live' | 'test' } | null = null): AgentRequest => ({ verb: 'ports', args: { port, own } })

    it('suggests the lowest free port when asked about none', async () => {
        const { agent } = setup({ provision: fakeProvisionDeps({ choosePort: async () => ({ ok: true, port: 5012 }) }) })
        assert.deepEqual(replyOf(await agent.handle(ask(null))), { ok: true, suggested: 5012, problem: null })
    })

    it('says what is wrong with the port it was asked about, as an answer rather than a refusal', async () => {
        const provision = fakeProvisionDeps({ checkPort: async () => ({ ok: false, code: 'bad-request', problem: 'port 5004 is in use on the host' }) })
        const { agent } = setup({ provision })
        assert.deepEqual(replyOf(await agent.handle(ask(5004))), { ok: true, suggested: 5100, problem: 'port 5004 is in use on the host' })
    })

    it('passes the environment the port is for, so its own port is not counted', async () => {
        const seen: unknown[] = []
        const provision = fakeProvisionDeps({ checkPort: async (port, own) => { seen.push([port, own]); return { ok: true } } })
        const { agent } = setup({ provision })
        await agent.handle(ask(5010, { project: 'acme', environment: 'live' }))
        assert.deepEqual(seen, [[5010, { project: 'acme', environment: 'live' }]])
    })

    it('refuses as unavailable when the host could not be read', async () => {
        const provision = fakeProvisionDeps({ choosePort: async () => ({ ok: false, problem: 'could not read the host\'s ports: the probe timed out' }) })
        const { agent } = setup({ provision })
        assert.deepEqual(replyOf(await agent.handle(ask(null))), { ok: false, code: 'unavailable', message: 'could not read the host\'s ports: the probe timed out' })
    })
})
```

`hostd/src/api/routes.test.ts`:

```ts
describe('GET /ports', () => {
    it('routes at the top level and allows only GET', () => {
        assert.deepEqual(matchRoute('GET', '/ports'), { verb: 'ports' })
        assert.equal(matchRoute('POST', '/ports').verb, 'method-not-allowed')
    })

    it('asks the agent about the port and the environment it is for', async () => {
        agent.reply = () => ({ ok: true, suggested: 5012, problem: null })
        const response = await request('/ports?port=5010&project=acme&environment=live', { actor: 'admin' })
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true, suggested: 5012, problem: null })
        assert.deepEqual(agent.calls, [{ verb: 'ports', args: { port: 5010, own: { project: 'acme', environment: 'live' } } }])
    })

    it('asks about no port when none is given', async () => {
        agent.reply = () => ({ ok: true, suggested: 5012, problem: null })
        await request('/ports', { actor: 'admin' })
        assert.deepEqual(agent.calls, [{ verb: 'ports', args: { port: null, own: null } }])
    })

    it('refuses a malformed query without asking the agent', async () => {
        for (const query of ['?port=abc', '?port=5012&project=acme', '?environment=live', '?project=acme&environment=prod']) {
            const response = await request(`/ports${query}`, { actor: 'admin' })
            assert.equal(response.status, 400)
        }
        assert.deepEqual(agent.calls, [])
    })

    it('refuses a client, and never calls the agent', async () => {
        const response = await request('/ports')
        assert.equal(response.status, 403)
        assert.deepEqual(agent.calls, [])
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/shared/protocol.test.ts src/agent/agent.test.ts src/api/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

`hostd/src/shared/protocol.ts`:

- Import `type OwnPort` from `./ports.ts`.
- After `CredentialsRequest`:

```ts
// Whether a port is free, for the portal's live check, and the lowest one that is. No project: this is a
// question about the machine. own names the environment the port is for, whose current port is its own.
// Advice only: a create or a port change checks again, under the provisioning lock.
export type PortsArgs = { port: number | null, own: OwnPort | null }
export type PortsRequest = { verb: 'ports', args: PortsArgs }
```

- `AgentRequest` gains `| PortsRequest`. After `CredentialsReply`: `export type PortsReply = { ok: true, suggested: number, problem: string | null }`, and add `PortsReply` to `AgentReply`.
- `VERB_CAPABILITY` gains `ports: null,` with the comment `// Null for the same reason credentials is: api's policy makes it admin-only.`
- In `parseAgentRequest`, after the `credentials` case:

```ts
        case 'ports': {
            if (!onlyKeys(raw, ['verb', 'args'])) return refuse('bad-request', 'ports takes only args')
            if (!isRecord(raw.args) || !onlyKeys(raw.args, ['port', 'own'])) return refuse('bad-request', 'ports takes only args.port and args.own')
            const { port, own } = raw.args
            // Any whole port number: the range is part of the answer (portProblem says it), not a refusal
            if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
                return refuse('bad-request', 'port must be null or a whole number from 1 to 65535')
            }
            if (own !== null && (!isRecord(own) || !onlyKeys(own, ['project', 'environment'])
                || typeof own.project !== 'string' || !PROJECT_ID.test(own.project)
                || !(ENVIRONMENTS as readonly unknown[]).includes(own.environment))) {
                return refuse('bad-request', 'own must be null or a project and one of its environments')
            }
            return { ok: true, request: { verb: 'ports', args: { port: port as number | null, own: own as OwnPort | null } } }
        }
```

`hostd/src/agent/agent.ts`:

- Import `type PortsArgs, type PortsReply` from protocol.
- In `handle`, after the `credentials` line: `if (request.verb === 'ports') return reply(await this.ports(request.args))`. It has to come before the `!('project' in request)` check, which otherwise sends it to `provisionCreate`.
- Add the method (next to `credentials`):

```ts
    // The portal's live check. Not under the provisioning lock: it changes nothing, and a create that
    // is running would otherwise make the form say "busy" while the operator is typing. A port that is
    // not free is an answer, not a refusal; only a host that could not be read is refused.
    private async ports(args: PortsArgs): Promise<PortsReply | Refusal> {
        if (!this.deps.provision) return refuse('unavailable', 'provisioning is not configured')
        const suggested = await this.deps.provision.choosePort()
        if (!suggested.ok) return refuse('unavailable', suggested.problem)
        if (args.port === null) return { ok: true, suggested: suggested.port, problem: null }
        const verdict = await this.deps.provision.checkPort(args.port, args.own ?? undefined)
        if (verdict.ok) return { ok: true, suggested: suggested.port, problem: null }
        if (verdict.code === 'unavailable') return refuse('unavailable', verdict.problem)
        return { ok: true, suggested: suggested.port, problem: verdict.problem }
    }
```

`hostd/src/api/routes.ts`:

- `Route` gains `| { verb: 'ports' }`. In `matchRoute`, beside `/credentials`: `if (parts.length === 1 && parts[0] === 'ports') return only('GET', { verb: 'ports' })`.
- Add a query parser beside `parseCommitsLimit` (import `type PortsArgs` from protocol):

```ts
// Both halves of own or neither: a port checked for "some environment" would not know which port is its own.
function parsePortsQuery(params: URLSearchParams): { ok: true, args: PortsArgs } | { ok: false, message: string } {
    const raw = params.get('port')
    if (raw !== null && !/^\d{1,5}$/.test(raw)) return { ok: false, message: 'port must be a number' }
    const project = params.get('project')
    const environment = params.get('environment')
    if ((project === null) !== (environment === null)) return { ok: false, message: 'project and environment go together' }
    if (project !== null && !PROJECT_ID.test(project)) return { ok: false, message: 'project is malformed' }
    if (environment !== null && !(ENVIRONMENTS as readonly string[]).includes(environment)) return { ok: false, message: 'environment must be live or test' }
    return {
        ok: true,
        args: {
            port: raw === null ? null : Number(raw),
            own: project !== null && environment !== null ? { project, environment: environment as EnvironmentName } : null,
        },
    }
}
```

- Handler, next to `case 'credentials'`:

```ts
            case 'ports': {
                // Gated like credentials: a question about the machine, answered for the operator's forms
                if (caller.actor.kind !== 'admin') return refuseRoute(403, 'admin-only', 'only the admin can check ports', null, 'provision')
                const parsed = parsePortsQuery(url.searchParams)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, null, 'provision')
                const reply = await callAgent({ verb: 'ports', args: parsed.args })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, null, 'provision')
                return sendJson(res, 200, reply)
            }
```

  Check `refuseRoute`'s parameter list against the `credentials` case and match it exactly.

- [ ] **Step 4: Run all hostd tests and typecheck**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src
git commit -m "Answer whether a port is free, and the lowest one that is, for the portal's forms

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The registry's set-port change

**Files:**
- Modify: `hostd/src/shared/registry-write.ts` (`Change`, `edit`)
- Modify: `hostd/src/shared/registry-write.test.ts`

**Interfaces:**
- Produces: `Change` member `{ kind: 'set-port', id: string, environment: EnvironmentName, port: number }`.

- [ ] **Step 1: Write the failing tests**

Add to `hostd/src/shared/registry-write.test.ts` (use the file's `BASE` fixture and `applyChange`, as the `set-flag` tests do; check `BASE` gives `acme` a live environment and some other project a port you can collide with, and adjust the numbers to match):

```ts
describe('set-port', () => {
    it('writes the environment\'s port', () => {
        const result = applyChange(BASE, { kind: 'set-port', id: 'acme', environment: 'live', port: 5099 })
        assert.equal(result.ok, true)
        assert.equal(parseRegistry(result.ok ? result.text : '').projects.get('acme')?.environments.get('live')?.port, 5099)
    })

    it('refuses an environment that does not exist', () => {
        assert.equal(applyChange(BASE, { kind: 'set-port', id: 'acme', environment: 'test', port: 5099 }).ok, false)
    })

    // One rule about sharing a port, parseRegistry's, not a second copy here
    it('refuses a port another project already has', () => {
        const other = parseRegistry(BASE)
        const taken = [...other.projects.values()].find(project => project.id !== 'acme')!.environments.get('live')!.port
        assert.equal(applyChange(BASE, { kind: 'set-port', id: 'acme', environment: 'live', port: taken }).ok, false)
    })
})
```

Match `applyChange`'s real result shape (read the existing `set-branch` tests first).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd hostd && node --import tsx --test src/shared/registry-write.test.ts`
Expected: FAIL (a TS error on the unknown kind, or the default branch refusing it).

- [ ] **Step 3: Write the implementation**

In `Change`, after `set-flag`:

```ts
    // The environment's port, which the vhost proxies to and the site's .env publishes. Whether it is
    // free on the host is the agent's check; whether it is unique in the registry is parseRegistry's.
    | { kind: 'set-port', id: string, environment: EnvironmentName, port: number }
```

In `edit`, after the `set-flag` case:

```ts
        case 'set-port': {
            // A live-only entry keeps its port inside upstream, so it is reshaped first, as a branch
            // save does: see toEnvironments for what that conversion carries and what it does not.
            if (!doc.hasIn(['projects', change.id, 'environments']) && has(change.id) && change.environment === 'live') {
                const converted = toEnvironments(doc, change.id)
                if (converted) return converted
            }
            if (!doc.hasIn(['projects', change.id, 'environments', change.environment])) {
                return { problem: `${change.id} has no ${change.environment} environment` }
            }
            doc.setIn(['projects', change.id, 'environments', change.environment, 'port'], change.port)
            return null
        }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd hostd && node --import tsx --test src/shared/registry-write.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src/shared/registry-write.ts hostd/src/shared/registry-write.test.ts
git commit -m "Let the registry writer change an environment's port

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Changing a port (agent `port` verb and `PUT /projects/:id/:env/port`)

**Files:**
- Create: `hostd/src/agent/port-change.ts`
- Create: `hostd/src/agent/port-change.test.ts`
- Modify: `hostd/src/shared/protocol.ts` (`PortRequest`, `ProjectRequest`, `VERB_CAPABILITY`, parser, `checkStructure`)
- Modify: `hostd/src/shared/protocol.test.ts`
- Modify: `hostd/src/agent/agent.ts` (`port` case, `changePortOf` method)
- Modify: `hostd/src/agent/agent.test.ts`
- Modify: `hostd/src/api/routes.ts` (`Route`, `matchRoute`, handler, `parsePortBody`)
- Modify: `hostd/src/api/routes.test.ts`

**Interfaces:**
- Consumes: `PortVerdict`, `OwnPort` (Task 1); `writePortEnv`, `restorePortEnv` (Task 3); `resolvePublished` (Task 3); `notPublishedProblem` (Task 4); `set-port` (Task 6); `upArgv`, `locationIn`, `composeNameOf` from `deploy-compose.ts`; `LIFECYCLE_TIMEOUT_MS` from `compose.ts`.
- Produces:
  - `type PortRequest = { verb: 'port', project: string, args: { environment: EnvironmentName, port: number } }`
  - `changePort(project: ProjectEntry, environment: EnvironmentName, port: number, deps: PortChangeDeps): Promise<{ ok: true, output: string } | Refusal>`
  - HTTP: `PUT /projects/:id/:env/port` with body `{ "port": 5012 }`, admin only, audited under `configure` as `<env> port <port>`. Answers `{ ok: true, output }`.

- [ ] **Step 1: Write the failing tests**

Create `hostd/src/agent/port-change.test.ts`:

```ts
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { changePort, type PortChangeDeps } from './port-change.ts'
import { notPublishedProblem } from './provision.ts'
import { parseRegistry } from '../shared/registry.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:a/acme.git
    services: { web: { role: site } }
    environments:
      live: { dir: /var/www/acme, port: 5010, domain: acme.com }
`)
const acme = registry.projects.get('acme')!

function fakes(overrides: Partial<PortChangeDeps> = {}) {
    const steps: string[] = []
    const deps: PortChangeDeps = {
        checkPort: async port => { steps.push(`check ${port}`); return { ok: true } },
        setPortEnv: async (_env, key, port) => { steps.push(`env ${key}=${port}`); return { ok: true, previous: 'WEB_PORT=5010\n' } },
        restorePortEnv: async (_env, previous) => { steps.push(`restore env ${JSON.stringify(previous)}`); return { ok: true } },
        published: async () => { steps.push('published'); return { ok: true, ports: [5012] } },
        writePort: async port => { steps.push(`registry ${port}`); return { ok: true } },
        running: async () => { steps.push('running?'); return true },
        up: async () => { steps.push('up'); return { ok: true } },
        rewriteVhost: async () => { steps.push('vhost'); return null },
        ...overrides,
    }
    return { deps, steps }
}

describe('changePort', () => {
    it('checks, writes .env, confirms compose publishes it, writes the registry, recreates, rewrites the vhost', async () => {
        const { deps, steps } = fakes()
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: true, output: 'acme live now uses port 5012, and its containers were recreated on it' })
        assert.deepEqual(steps, ['check 5012', 'env WEB_PORT=5012', 'published', 'registry 5012', 'running?', 'up', 'vhost'])
    })

    it('does nothing for the port it already has', async () => {
        const { deps, steps } = fakes()
        assert.deepEqual(await changePort(acme, 'live', 5010, deps), { ok: true, output: 'acme live already uses port 5010' })
        assert.deepEqual(steps, [])
    })

    it('refuses a port the check refuses, touching nothing', async () => {
        const { deps, steps } = fakes({ checkPort: async () => ({ ok: false, code: 'bad-request', problem: 'port 5004 is in use on the host' }) })
        assert.deepEqual(await changePort(acme, 'live', 5004, deps), { ok: false, code: 'bad-request', message: 'port 5004 is in use on the host' })
        assert.deepEqual(steps, [])
    })

    it('puts .env back when compose does not publish the port', async () => {
        const { deps, steps } = fakes({ published: async () => ({ ok: true, ports: [3000] }) })
        assert.deepEqual(await changePort(acme, 'live', 5012, deps), { ok: false, code: 'bad-request', message: notPublishedProblem('WEB_PORT', 5012) })
        assert.deepEqual(steps.slice(-1), ['restore env "WEB_PORT=5010\\n"'])
    })

    it('puts .env back when the registry refuses the port', async () => {
        const { deps, steps } = fakes({ writePort: async () => ({ ok: false, problem: 'port 5012 is also used by other' }) })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: false, code: 'bad-request', message: 'port 5012 is also used by other' })
        assert.deepEqual(steps.slice(-1), ['restore env "WEB_PORT=5010\\n"'])
    })

    it('undoes everything and brings the old port back up when the recreate fails', async () => {
        let ups = 0
        const { deps, steps } = fakes({ up: async () => { steps.push('up'); ups += 1; return ups === 1 ? { ok: false, message: 'up exited with code 1' } : { ok: true } } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok ? '' : reply.message, /up exited with code 1/)
        assert.deepEqual(steps.slice(-4), ['up', 'restore env "WEB_PORT=5010\\n"', 'registry 5010', 'up'])
    })

    it('undoes everything when the vhost cannot be rewritten', async () => {
        let rewrites = 0
        const { deps, steps } = fakes({ rewriteVhost: async () => { steps.push('vhost'); rewrites += 1; return rewrites === 1 ? 'Apache refused the file' : null } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.equal(reply.ok, false)
        assert.match(reply.ok ? '' : reply.message, /Apache refused the file/)
        assert.deepEqual(steps.slice(-5), ['vhost', 'restore env "WEB_PORT=5010\\n"', 'registry 5010', 'up', 'vhost'])
    })

    it('does not start an environment that is not running', async () => {
        const { deps, steps } = fakes({ running: async () => { steps.push('running?'); return false } })
        const reply = await changePort(acme, 'live', 5012, deps)
        assert.deepEqual(reply, { ok: true, output: 'acme live now uses port 5012. It was not running, so it takes the port when it next starts' })
        assert.ok(!steps.includes('up'))
    })
})
```

`hostd/src/shared/protocol.test.ts`:

```ts
describe('port', () => {
    it('parses a port change for one environment', () => {
        assert.deepEqual(
            parseAgentRequest('{"verb":"port","project":"acme","args":{"environment":"live","port":5012}}'),
            { ok: true, request: { verb: 'port', project: 'acme', args: { environment: 'live', port: 5012 } } },
        )
    })

    it('refuses a port outside the range, and an unknown environment', () => {
        assert.equal(parseAgentRequest('{"verb":"port","project":"acme","args":{"environment":"live","port":80}}').ok, false)
        assert.equal(parseAgentRequest('{"verb":"port","project":"acme","args":{"environment":"prod","port":5012}}').ok, false)
    })
})
```

`hostd/src/agent/agent.test.ts` (check the fixture `registry` at the top of the file gives `acme` a live environment with a port; use whatever port it has in place of 5010 in the "already" case if it differs):

```ts
describe('port', () => {
    const change = (port: number, environment: 'live' | 'test' = 'live'): AgentRequest => ({ verb: 'port', project: 'acme', args: { environment, port } })

    it('refuses when provisioning is not configured', async () => {
        const { agent } = setup()
        assert.deepEqual(replyOf(await agent.handle(change(5012))), { ok: false, code: 'unavailable', message: 'provisioning is not configured' })
    })

    it('refuses an environment the project does not have', async () => {
        const { agent } = setup({ provision: fakeProvisionDeps() })
        assert.equal((replyOf(await agent.handle(change(5012, 'test'))) as { code?: string }).code, 'unknown-environment')
    })

    it('refuses while another provisioning action holds the lock', async () => {
        let release!: () => void
        const slow = fakeProvisionDeps({ checkPort: () => new Promise(resolve => { release = () => resolve({ ok: true }) }) })
        const { agent } = setup({ provision: slow })
        const first = agent.handle(change(5012))
        assert.deepEqual(replyOf(await agent.handle(change(5013))), { ok: false, code: 'busy', message: 'another provisioning action is in progress' })
        release()
        await first
    })
})
```

`hostd/src/api/routes.test.ts`:

```ts
describe('PUT /projects/:id/:env/port', () => {
    it('routes under the environment and allows only PUT', () => {
        assert.deepEqual(matchRoute('PUT', '/projects/acme/live/port'), { verb: 'port', project: 'acme', environment: 'live' })
        assert.equal(matchRoute('GET', '/projects/acme/live/port').verb, 'method-not-allowed')
    })

    it('asks the agent to change the port', async () => {
        agent.reply = () => ({ ok: true, output: 'acme live now uses port 5012' })
        const response = await request('/projects/acme/live/port', { method: 'PUT', actor: 'admin', body: { port: 5012 } })
        assert.equal(response.status, 200)
        assert.deepEqual(agent.calls, [{ verb: 'port', project: 'acme', args: { environment: 'live', port: 5012 } }])
    })

    it('refuses a body that is not one port', async () => {
        for (const body of [{}, { port: '5012' }, { port: 5012, extra: true }]) {
            const response = await request('/projects/acme/live/port', { method: 'PUT', actor: 'admin', body })
            assert.equal(response.status, 400)
        }
        assert.deepEqual(agent.calls, [])
    })

    it('answers a client as though the project were not there', async () => {
        const response = await request('/projects/acme/live/port', { method: 'PUT', body: { port: 5012 } })
        assert.equal(response.status, 404)
        assert.deepEqual(agent.calls, [])
    })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd hostd && node --import tsx --test src/agent/port-change.test.ts src/shared/protocol.test.ts src/agent/agent.test.ts src/api/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `hostd/src/agent/port-change.ts`:

```ts
// Moving an environment to another port. Six steps, in this order, because each is only undoable while
// the ones after it have not happened: check the port, write it into .env, make sure compose publishes it,
// write the registry, recreate the containers (which rereads .env), and rewrite the vhost to proxy there.
// A failure puts back every step before it, so the site is never left listening on one port while Apache
// proxies to another. The recreate is a few seconds of downtime, which the portal says before it asks.

import { notPublishedProblem } from './provision.ts'
import { refuse, type Refusal } from '../shared/protocol.ts'
import type { OwnPort, PortVerdict } from '../shared/ports.ts'
import type { EnvironmentEntry, EnvironmentName, ProjectEntry } from '../shared/registry.ts'

export type PortChangeDeps = {
    checkPort: (port: number, own: OwnPort) => Promise<PortVerdict>
    setPortEnv: (environment: EnvironmentEntry, key: string, port: number) => Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }>
    restorePortEnv: (environment: EnvironmentEntry, previous: string | null) => Promise<{ ok: true } | { ok: false, problem: string }>
    published: (environment: EnvironmentEntry) => Promise<{ ok: true, ports: number[] } | { ok: false, problem: string }>
    // Writes the registry and refreshes the agent's copy of it, so the vhost rewrite reads the new port
    writePort: (port: number) => Promise<{ ok: true } | { ok: false, problem: string }>
    running: (environment: EnvironmentEntry) => Promise<boolean>
    up: (environment: EnvironmentEntry) => Promise<{ ok: true } | { ok: false, message: string }>
    // A problem, or null when the vhost is rewritten or there is no hostd vhost to rewrite
    rewriteVhost: () => Promise<string | null>
}

export async function changePort(
    project: ProjectEntry, name: EnvironmentName, port: number, deps: PortChangeDeps,
): Promise<{ ok: true, output: string } | Refusal> {
    const environment = project.environments.get(name)
    if (!environment) return refuse('unknown-environment', `${project.id} has no ${name} environment`)
    const where = `${project.id} ${name}`
    const old = environment.port
    if (port === old) return { ok: true, output: `${where} already uses port ${port}` }

    const verdict = await deps.checkPort(port, { project: project.id, environment: name })
    if (!verdict.ok) return refuse(verdict.code, verdict.problem)

    const written = await deps.setPortEnv(environment, project.portEnv, port)
    if (!written.ok) return refuse('failed', written.problem)
    // Each undo is best effort and says what it could not do, so the operator knows what to put right
    const undone: string[] = []
    const restoreEnv = async () => {
        const restored = await deps.restorePortEnv(environment, written.previous)
        if (!restored.ok) undone.push(`.env could not be put back: ${restored.problem}`)
    }
    const restoreRegistry = async () => {
        const restored = await deps.writePort(old)
        if (!restored.ok) undone.push(`the registry could not be put back to ${old}: ${restored.problem}`)
    }
    const failed = (message: string) => refuse('failed', undone.length === 0 ? message : `${message} ${undone.join('. ')}.`)

    const published = await deps.published(environment)
    if (!published.ok) {
        await restoreEnv()
        return refuse('invalid-project', published.problem)
    }
    if (!published.ports.includes(port)) {
        await restoreEnv()
        return refuse('bad-request', notPublishedProblem(project.portEnv, port))
    }

    const registered = await deps.writePort(port)
    if (!registered.ok) {
        await restoreEnv()
        return refuse('bad-request', registered.problem)
    }

    const running = await deps.running(environment)
    if (running) {
        const up = await deps.up(environment)
        if (!up.ok) {
            await restoreEnv()
            await restoreRegistry()
            const back = await deps.up(environment)
            if (!back.ok) undone.push(`the containers could not be brought back up on ${old}: ${back.message}`)
            return failed(`${where} could not be recreated on port ${port}: ${up.message}. It was moved back to ${old}.`)
        }
    }

    const vhostProblem = await deps.rewriteVhost()
    if (vhostProblem !== null) {
        await restoreEnv()
        await restoreRegistry()
        if (running) {
            const back = await deps.up(environment)
            if (!back.ok) undone.push(`the containers could not be brought back up on ${old}: ${back.message}`)
        }
        const again = await deps.rewriteVhost()
        if (again !== null) undone.push(`the vhost could not be put back: ${again}`)
        return failed(`the vhost for ${where} could not be rewritten: ${vhostProblem} It was moved back to ${old}.`)
    }

    return {
        ok: true,
        output: running
            ? `${where} now uses port ${port}, and its containers were recreated on it`
            : `${where} now uses port ${port}. It was not running, so it takes the port when it next starts`,
    }
}
```

`hostd/src/shared/protocol.ts`:

- After `PortsRequest`: `export type PortRequest = { verb: 'port', project: string, args: { environment: EnvironmentName, port: number } }` with the comment `// Moving one environment to another port. Admin only, by api's policy (configure).`
- Add `| PortRequest` to `ProjectRequest`. Add `port: null,` to `VERB_CAPABILITY` with the comment `// Null, like configure: api's policy makes it admin-only.`
- In `parseAgentRequest`, after `branches`:

```ts
        case 'port': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'port takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            if (!isRecord(raw.args) || !onlyKeys(raw.args, ['environment', 'port'])) return refuse('bad-request', 'port takes only args.environment and args.port')
            const { environment, port } = raw.args
            if (!(ENVIRONMENTS as readonly unknown[]).includes(environment)) return refuse('bad-request', 'environment must be live or test')
            if (typeof port !== 'number' || !Number.isInteger(port) || port < PORT_RANGE.from || port > PORT_RANGE.to) {
                return refuse('bad-request', `port must be a whole number from ${PORT_RANGE.from} to ${PORT_RANGE.to}`)
            }
            return { ok: true, request: { verb: 'port', project, args: { environment: environment as EnvironmentName, port } } }
        }
```

- In `checkStructure`, change the environment check's condition to `(request.verb === 'env' || request.verb === 'deploy' || request.verb === 'port')`.

`hostd/src/agent/agent.ts`:

- Imports: `changePort` from `./port-change.ts`; `writePortEnv`, `restorePortEnv` from `./port-env.ts`; `resolvePublished`, `LIFECYCLE_TIMEOUT_MS`, `tail` from `./compose.ts`; `upArgv`, `locationIn`, `composeNameOf` from `./deploy-compose.ts` (merge with the existing import lines).
- In the `switch` in `handle`: `case 'port': return reply(await this.port(checked.project, request.args.environment, request.args.port))`.
- Add the method after `configure`:

```ts
    // Under the provisioning lock, because the port check reads the same registry snapshot a create does:
    // a create and a port change racing could otherwise both take one free port.
    private async port(project: ProjectEntry, environment: EnvironmentName, port: number): Promise<AgentReply> {
        const provision = this.deps.provision
        if (!provision) return refuse('unavailable', 'provisioning is not configured')
        if (this.provisioningBusy) return refuse('busy', 'another provisioning action is in progress')
        this.provisioningBusy = true
        try {
            return await changePort(project, environment, port, {
                checkPort: provision.checkPort,
                setPortEnv: (entry, key, value) => writePortEnv(entry, key, value, this.deps.envFs),
                restorePortEnv: (entry, previous) => restorePortEnv(entry, previous, this.deps.envFs),
                published: entry => resolvePublished({ dir: entry.dir, composePaths: entry.composePaths }, this.deps.runner),
                writePort: async value => {
                    const written = await this.deps.writer.write({ kind: 'set-port', id: project.id, environment, port: value })
                    if (!written.ok) return written
                    await this.deps.refreshRegistry()
                    return { ok: true }
                },
                running: async entry => (await this.deps.docker.listProjectContainers(composeNameOf(entry)))
                    .some(container => container.State === 'running'),
                // The same up a deploy's swap runs, in the environment's own folder: compose recreates
                // exactly the containers whose ports changed, and never builds or pulls.
                up: async entry => {
                    const result = await this.deps.runner('docker', upArgv(locationIn(entry, entry.dir), composeNameOf(entry)), LIFECYCLE_TIMEOUT_MS)
                    if (result.timedOut) return { ok: false, message: 'up timed out' }
                    if (result.exitCode !== 0) return { ok: false, message: `up exited with code ${result.exitCode}: ${tail(result.stderr.trim(), 300)}` }
                    return { ok: true }
                },
                rewriteVhost: async () => (await this.rewriteMovedVhost(project.id, environment)).problem,
            })
        } finally {
            this.provisioningBusy = false
        }
    }
```

  `writer.write` answers `{ ok: true } | { ok: false, problem }`; if its real type differs, map it to `{ ok: false, problem }` here.

`hostd/src/api/routes.ts`:

- `Route` gains `| { verb: 'port', project: string, environment: EnvironmentName }`. In the per-environment `switch (parts[3])`: `case 'port': return only('PUT', { verb: 'port', project, environment })`.
- Beside `parseBranchBody`:

```ts
function parsePortBody(value: Record<string, unknown>): { ok: true, port: number } | { ok: false, message: string } {
    if (!onlyKeys(value, ['port'])) return { ok: false, message: 'changing a port takes only port' }
    // The range and whether it is free are the agent's to say; this only refuses a shape it could not read
    if (typeof value.port !== 'number' || !Number.isInteger(value.port)) return { ok: false, message: 'port must be a whole number' }
    return { ok: true, port: value.port }
}
```

- Handler, after `case 'branch'`:

```ts
            case 'port': {
                // configure's policy: admin only, whatever the project's capabilities, like every other
                // change to the registry entry itself
                const target = `${route.environment} port`
                const entry = await authorizeProject(route.project, 'configure', target)
                if (!entry) return

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, route.project, 'configure', target)
                const parsed = parsePortBody(body.value)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, route.project, 'configure', target)

                const named = `${target} ${parsed.port}`
                const reply = await callAgentAudited(
                    { verb: 'port', project: route.project, args: { environment: route.environment, port: parsed.port } },
                    route.project, 'configure', named,
                )
                if (!reply) return
                // The registry changed, so api's copy catches up before answering, as a branch switch does
                return respondAgentAction('configure', reply, route.project, named, true)
            }
```

- [ ] **Step 4: Run all hostd tests and typecheck**

Run: `cd hostd && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hostd/src
git commit -m "Move an environment to another port, putting everything back if a step fails

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Portal calls for checking and changing a port

**Files:**
- Create: `server/hostd/ports.ts`
- Create: `server/hostd/ports.test.ts`
- Modify: `server/hostd/create.ts` (`NewSite.port`)
- Modify: `server/hostd/create.test.ts` (the request carries `port`)

**Interfaces:**
- Produces:
  - `type PortCheck = { suggested: number, problem: string | null }`
  - `checkPort(config, caller, query: { port?: number, own?: { project: string, environment: 'live' | 'test' } }, fetchImpl?): Promise<HostdResult<PortCheck>>`
  - `setPort(config, caller, id: string, environment: 'live' | 'test', port: number, fetchImpl?): Promise<HostdResult<{ output: string }>>`
  - `PORT_MIN = 5000`, `PORT_MAX = 65535`
  - `NewSite.port: number`

- [ ] **Step 1: Write the failing tests**

Create `server/hostd/ports.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { checkPort, setPort } from './ports'

const config = { url: 'http://hostd-api:8080', token: 'a'.repeat(32) }
const admin = { actor: 'admin', user: 'koda@horizons.gg' }

function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string, method?: string, body?: unknown }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: init.body })
        return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    return { fetchImpl, calls }
}

describe('checkPort', () => {
    it('asks for a suggestion alone', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, suggested: 5012, problem: null })
        const result = await checkPort(config, admin, {}, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/ports')
        expect(result).toEqual({ ok: true, value: { suggested: 5012, problem: null } })
    })

    it('asks about a port for one environment', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, suggested: 5012, problem: 'port 5004 is in use on the host' })
        await checkPort(config, admin, { port: 5004, own: { project: 'acme', environment: 'live' } }, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/ports?port=5004&project=acme&environment=live')
    })
})

describe('setPort', () => {
    it('puts the port for one environment', async () => {
        const { fetchImpl, calls } = fakeFetch({ ok: true, output: 'acme live now uses port 5012' })
        const result = await setPort(config, admin, 'acme', 'live', 5012, fetchImpl)
        expect(calls[0].url).toBe('http://hostd-api:8080/projects/acme/live/port')
        expect(calls[0].method).toBe('PUT')
        expect(JSON.parse(calls[0].body as string)).toEqual({ port: 5012 })
        expect(result).toEqual({ ok: true, value: { output: 'acme live now uses port 5012' } })
    })

    it('refuses a port outside 5000 to 65535 before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({})
        expect(await setPort(config, admin, 'acme', 'live', 3000, fetchImpl))
            .toEqual({ ok: false, code: 'bad-request', message: 'Use a port from 5000 to 65535.' })
        expect(calls).toHaveLength(0)
    })

    it('refuses a malformed id before asking', async () => {
        const { fetchImpl, calls } = fakeFetch({})
        expect((await setPort(config, admin, '../x', 'live', 5012, fetchImpl)).ok).toBe(false)
        expect(calls).toHaveLength(0)
    })
})
```

In `server/hostd/create.test.ts`, add `port: 5012` to the site fixture the tests post, and assert it reaches the body: `expect(JSON.parse(calls[0].body as string).port).toBe(5012)`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run server/hostd/ports.test.ts server/hostd/create.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `server/hostd/ports.ts`:

```ts
// A site's port: whether one is free (the forms' live check) and moving an environment to another. hostd
// decides both, against its registry and everything listening on the dedi; this only refuses what it
// already knows hostd would.

import 'server-only'

import type { Caller } from './actor'
import { hostdRequest, type HostdResult } from './client'
import type { HostdConfig } from './config'

export const PORT_MIN = 5000
export const PORT_MAX = 65535

export type PortCheck = { suggested: number, problem: string | null }
type Environment = 'live' | 'test'

// Matches hostd's registry id rule
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

// Longer than hostd's own call to the agent: a port change recreates the site's containers first.
const PORT_TIMEOUT_MS = 180_000

export async function checkPort(
    config: HostdConfig,
    caller: Caller,
    query: { port?: number, own?: { project: string, environment: Environment } },
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<PortCheck>> {
    const params = new URLSearchParams()
    if (query.port !== undefined) params.set('port', String(query.port))
    if (query.own) {
        params.set('project', query.own.project)
        params.set('environment', query.own.environment)
    }
    const search = params.size > 0 ? `?${params}` : ''
    const result = await hostdRequest<PortCheck>(config, caller, `/ports${search}`, {}, fetchImpl)
    return result.ok ? { ok: true, value: { suggested: result.value.suggested, problem: result.value.problem } } : result
}

export async function setPort(
    config: HostdConfig,
    caller: Caller,
    id: string,
    environment: Environment,
    port: number,
    fetchImpl: typeof fetch = fetch,
): Promise<HostdResult<{ output: string }>> {
    if (!PROJECT_ID.test(id)) return { ok: false, code: 'not-found', message: 'no such project' }
    if (!Number.isInteger(port) || port < PORT_MIN || port > PORT_MAX) {
        return { ok: false, code: 'bad-request', message: `Use a port from ${PORT_MIN} to ${PORT_MAX}.` }
    }
    const result = await hostdRequest<{ output: string }>(
        config,
        caller,
        `/projects/${id}/${environment}/port`,
        { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port }) },
        fetchImpl,
        PORT_TIMEOUT_MS,
    )
    return result.ok ? { ok: true, value: { output: result.value.output } } : result
}
```

In `server/hostd/create.ts`, add to `NewSite` after `flexibleSsl`:

```ts
    // The live environment's port. hostd checks it is free and writes it into the site's .env.
    port: number
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run server/hostd/ports.test.ts server/hostd/create.test.ts`
Expected: PASS. `npx tsc --noEmit` fails in `newSite/actions.ts` (no `port` yet); that is fixed in Task 9.

- [ ] **Step 5: Commit**

```bash
git add server/hostd/ports.ts server/hostd/ports.test.ts server/hostd/create.ts server/hostd/create.test.ts
git commit -m "Add the portal's calls for checking and changing a site's port

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The Port field in the New site form

**Files:**
- Create: `app/(portal)/portal/sites/portActions.ts`
- Create: `app/(portal)/portal/sites/usePortCheck.ts`
- Modify: `app/(portal)/portal/newSite/schema.ts` (`port`)
- Modify: `app/(portal)/portal/newSite/actions.ts` (pass `port`)
- Modify: `app/(portal)/portal/newSite/actions.test.ts`
- Modify: `app/(portal)/portal/newSite/NewSite.tsx`
- Modify: `app/(portal)/portal/newSite/NewSite.test.tsx`

**Interfaces:**
- Consumes: `checkPort`, `PORT_MIN`, `PORT_MAX` (Task 8).
- Produces:
  - `checkPortAction(port: number | null, own: { project: string, environment: string } | null): Promise<PortCheckResult>`
  - `type PortCheckResult = { ok: true, suggested: number, problem: string | null } | { ok: false, error: string }`
  - `usePortCheck(value: string, own: { project: string, environment: string } | null, options?: { skip?: boolean, delayMs?: number }): { suggested: number | null, problem: string | null, error: string | null, checking: boolean }`
  - `NewSiteInput.port: string`, `NewSiteValues.port: number`

- [ ] **Step 1: Write the failing tests**

In `app/(portal)/portal/newSite/NewSite.test.tsx`:

- Add a mock beside the `./actions` one, and a default in `beforeEach`:

```ts
const checkPortAction = vi.fn()
vi.mock('../sites/portActions', () => ({ checkPortAction: (...args: unknown[]) => checkPortAction(...args) }))
```

```ts
    checkPortAction.mockImplementation(async (port: number | null) => ({
        ok: true, suggested: 5012, problem: port === 5004 ? 'port 5004 is in use on the host' : null,
    }))
```

- Add tests:

```ts
    it('fills the port in with the lowest free one', async () => {
        await open()
        expect(await screen.findByDisplayValue('5012')).toBe(screen.getByLabelText('Port'))
    })

    it('says a taken port is taken, and does not send it', async () => {
        await open()
        await screen.findByDisplayValue('5012')
        await userEvent.clear(screen.getByLabelText('Port'))
        await userEvent.type(screen.getByLabelText('Port'), '5004')
        expect(await screen.findByText('port 5004 is in use on the host')).toBeInTheDocument()
        await userEvent.type(screen.getByLabelText('Name'), 'Bakery')
        await userEvent.type(screen.getByLabelText('Repo'), 'git@github.com:ItsKodas/bakery.git')
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))
        expect(createSiteAction).not.toHaveBeenCalled()
    })

    it('refuses a port below 5000', async () => {
        await open()
        await screen.findByDisplayValue('5012')
        await userEvent.clear(screen.getByLabelText('Port'))
        await userEvent.type(screen.getByLabelText('Port'), '3000')
        await userEvent.click(screen.getByRole('button', { name: 'Create site' }))
        expect(screen.getByText('Use a port from 5000 to 65535.')).toBeInTheDocument()
    })
```

- In the existing test that checks what `createSiteAction` receives, add `port: '5012'` to the expected payload (the form sends its raw input; the action parses it). Wait for `findByDisplayValue('5012')` before submitting in that test.

In `app/(portal)/portal/newSite/actions.test.ts`, add `port: '5012'` to the valid input fixture and assert `createProject` receives `port: 5012`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(portal)/portal/newSite"`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Create `app/(portal)/portal/sites/portActions.ts`:

```ts
'use server'

// The live port check behind the New site form and the Settings tab. The operator's alone, as both forms
// are; hostd refuses anyone else too (hostd/src/api/routes.ts).

import { readHostd } from '@/server/hostd/config'
import { forAdmin } from '@/server/hostd/errors'
import { checkPort } from '@/server/hostd/ports'
import { callerFromSession } from '@/server/hostd/session'

export type PortCheckResult = { ok: true, suggested: number, problem: string | null } | { ok: false, error: string }

const ENVIRONMENTS = ['live', 'test'] as const

export async function checkPortAction(
    port: number | null,
    own: { project: string, environment: string } | null,
): Promise<PortCheckResult> {
    if (port !== null && !Number.isInteger(port)) return { ok: false, error: 'That is not a port.' }
    const environment = own ? ENVIRONMENTS.find(name => name === own.environment) : undefined
    if (own && (!environment || typeof own.project !== 'string')) return { ok: false, error: 'That is not something this form can do.' }

    const who = await callerFromSession()
    if (!who) return { ok: false, error: 'Your session has expired. Sign in again.' }
    if (who.clientId !== null) return { ok: false, error: 'This is not set up yet.' }

    const problems: string[] = []
    const config = readHostd(process.env, problems)
    if (problems.length) return { ok: false, error: problems.join('; ') }

    const result = await checkPort(config, who.caller, {
        ...(port !== null ? { port } : {}),
        ...(own && environment ? { own: { project: own.project, environment } } : {}),
    })
    if (!result.ok) return { ok: false, error: forAdmin(result.code, result.message) }
    return { ok: true, suggested: result.value.suggested, problem: result.value.problem }
}
```

Create `app/(portal)/portal/sites/usePortCheck.ts`:

```ts
'use client'

// Asks hostd about the port in a field as the operator types, a moment after they stop. Only a whole
// number from 5000 up is asked about: anything else is the form's own validation to say, without a round
// trip. The suggestion comes back with every answer, including the first one for an empty field.

import { useEffect, useState } from 'react'

import { checkPortAction } from './portActions'

type Own = { project: string, environment: string } | null
export type PortCheckState = { suggested: number | null, problem: string | null, error: string | null, checking: boolean }

export function usePortCheck(value: string, own: Own, options: { skip?: boolean, delayMs?: number } = {}): PortCheckState {
    const { skip = false, delayMs = 400 } = options
    const [state, setState] = useState<PortCheckState>({ suggested: null, problem: null, error: null, checking: false })
    const project = own?.project ?? null
    const environment = own?.environment ?? null

    useEffect(() => {
        if (skip) {
            setState(prev => ({ ...prev, problem: null, error: null, checking: false }))
            return
        }
        const trimmed = value.trim()
        const port = /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 5000 && Number(trimmed) <= 65535 ? Number(trimmed) : null
        // A value that is there but not a port in range: no question to ask about it, only the suggestion
        if (trimmed !== '' && port === null) setState(prev => ({ ...prev, problem: null }))

        let live = true
        setState(prev => ({ ...prev, checking: true }))
        const timer = setTimeout(() => {
            checkPortAction(port, project && environment ? { project, environment } : null)
                .then(result => {
                    if (!live) return
                    if (result.ok) setState({ suggested: result.suggested, problem: result.problem, error: null, checking: false })
                    else setState(prev => ({ ...prev, error: result.error, checking: false }))
                })
                .catch(() => { if (live) setState(prev => ({ ...prev, error: 'The port could not be checked.', checking: false })) })
        }, trimmed === '' ? 0 : delayMs)
        return () => {
            live = false
            clearTimeout(timer)
        }
    }, [value, project, environment, skip, delayMs])

    return state
}
```

In `app/(portal)/portal/newSite/schema.ts`, add to `newSiteSchema` after `certificate`:

```ts
    // hostd's own range (hostd/src/shared/ports.ts). Whether the port is free is asked live, and hostd
    // checks it again when the site is created.
    port: z.string().trim()
        .regex(/^\d{1,5}$/, 'Use a port from 5000 to 65535.')
        .transform(Number)
        .refine(port => port >= 5000 && port <= 65535, 'Use a port from 5000 to 65535.'),
```

In `app/(portal)/portal/newSite/actions.ts`, add `port: site.port,` to the `createProject` call.

In `app/(portal)/portal/newSite/NewSite.tsx`:

- Import `usePortCheck` from `'../sites/usePortCheck'`.
- `blank()` gains `port: ''`.
- In `NewSiteDialog`, add state and the hook:

```tsx
    // Whether the port still follows hostd's suggestion, which it does until it is typed into
    const [portTyped, setPortTyped] = useState(false)
    const portCheck = usePortCheck(values.port, null)

    useEffect(() => {
        if (!portTyped && portCheck.suggested !== null) setValues(prev => ({ ...prev, port: String(portCheck.suggested) }))
    }, [portTyped, portCheck.suggested])
```

- In `submit`, after `if (!parsed.success) return`, add `if (portCheck.problem || portCheck.checking) return`.
- In the Address section, after the Domain/Certificate pair, add:

```tsx
                    <Field
                        label="Port"
                        inputMode="numeric"
                        hint={portCheck.error
                            ? `The dedi's ports could not be checked: ${portCheck.error}`
                            : 'The port the site listens on, written into its .env as WEB_PORT. Its compose file has to publish ${WEB_PORT}.'}
                        value={values.port}
                        onChange={event => { setPortTyped(true); set('port', event.target.value) }}
                        error={portCheck.problem ?? problem('port')}
                    />
```

  Check `Field` passes `inputMode` through to the input (read `ui/Field/Field.tsx`); drop the prop if it does not.
- The Create button's `disabled` gains `|| portCheck.checking`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run "app/(portal)/portal/newSite" && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)/portal/sites/portActions.ts" "app/(portal)/portal/sites/usePortCheck.ts" "app/(portal)/portal/newSite"
git commit -m "Pick the port in the New site form, checked live against the dedi

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Changing the port from Settings

**Files:**
- Create: `app/(portal)/portal/sites/[id]/portControl.tsx`
- Create: `app/(portal)/portal/sites/[id]/portControl.test.tsx`
- Modify: `app/(portal)/portal/sites/[id]/settings.tsx` (render `PortControl` in place of the `port {env.port}` line)
- Modify: `app/(portal)/portal/sites/[id]/settings.test.tsx` (mock the new modules)
- Modify: `app/(portal)/portal/sites/[id]/actions.ts` (`setPortAction`)
- Modify: `app/(portal)/portal/sites/[id]/actions.test.ts`

**Interfaces:**
- Consumes: `setPort` (Task 8), `usePortCheck` (Task 9).
- Produces:
  - `setPortAction(id: string, environment: string, port: number): Promise<SiteActionResult>`
  - `PortControl({ id, environment, port }: { id: string, environment: string, port: number })`

- [ ] **Step 1: Write the failing tests**

Create `app/(portal)/portal/sites/[id]/portControl.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setPortAction = vi.fn()
const checkPortAction = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => refresh() }) }))
vi.mock('./actions', () => ({ setPortAction: (...args: unknown[]) => setPortAction(...args) }))
vi.mock('../portActions', () => ({ checkPortAction: (...args: unknown[]) => checkPortAction(...args) }))

const { PortControl } = await import('./portControl')

beforeEach(() => {
    vi.clearAllMocks()
    checkPortAction.mockImplementation(async (port: number | null) => ({
        ok: true, suggested: 5012, problem: port === 5011 ? 'port 5011 is taken by other (live)' : null,
    }))
    setPortAction.mockResolvedValue({ ok: true, message: 'live now uses port 5013.' })
})

describe('the port control', () => {
    it('shows the environment\'s port, and does not offer to save it unchanged', () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        expect(screen.getByLabelText('live port')).toHaveValue('5010')
        expect(screen.getByRole('button', { name: 'Change port' })).toBeDisabled()
        expect(checkPortAction).not.toHaveBeenCalled()
    })

    it('checks a new port for this environment and says when it is taken', async () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5011')
        expect(await screen.findByText('port 5011 is taken by other (live)')).toBeInTheDocument()
        expect(checkPortAction).toHaveBeenLastCalledWith(5011, { project: 'acme', environment: 'live' })
        expect(screen.getByRole('button', { name: 'Change port' })).toBeDisabled()
    })

    it('says saving restarts the site, then saves', async () => {
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5013')
        expect(screen.getByText(/recreates this environment's containers/)).toBeInTheDocument()
        const button = screen.getByRole('button', { name: 'Change port' })
        await vi.waitFor(() => expect(button).toBeEnabled())
        await userEvent.click(button)
        expect(setPortAction).toHaveBeenCalledWith('acme', 'live', 5013)
        expect(await screen.findByText('live now uses port 5013.')).toBeInTheDocument()
        expect(refresh).toHaveBeenCalled()
    })

    it('shows hostd\'s refusal', async () => {
        setPortAction.mockResolvedValue({ ok: false, error: 'no service publishes port 5013' })
        render(<PortControl id="acme" environment="live" port={5010} />)
        await userEvent.clear(screen.getByLabelText('live port'))
        await userEvent.type(screen.getByLabelText('live port'), '5013')
        const button = screen.getByRole('button', { name: 'Change port' })
        await vi.waitFor(() => expect(button).toBeEnabled())
        await userEvent.click(button)
        expect(await screen.findByText('no service publishes port 5013')).toBeInTheDocument()
    })
})
```

In `app/(portal)/portal/sites/[id]/settings.test.tsx`: add `setPortAction: vi.fn()` to the `./actions` mock factory, and add `vi.mock('../portActions', () => ({ checkPortAction: async () => ({ ok: true, suggested: 5012, problem: null }) }))`. Add a test:

```tsx
    it('shows each environment\'s port in its own control', () => {
        render(<SiteSettingsForm {...props} />)
        expect(screen.getByLabelText('live port')).toHaveValue('5011')
    })
```

In `app/(portal)/portal/sites/[id]/actions.test.ts`, follow the file's pattern for `setBranchAction` and add tests for `setPortAction`: a client is refused without calling hostd, an unknown environment or a non-integer port is refused, and the admin's call reaches `setPort` with `('acme', 'live', 5013)`, answering `{ ok: true, message: 'live now uses port 5013. <hostd output>.' }`. Mock `@/server/hostd/ports` the way the file mocks the other `@/server/hostd/*` modules.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run "app/(portal)/portal/sites/[id]"`
Expected: FAIL.

- [ ] **Step 3: Write the implementation**

In `app/(portal)/portal/sites/[id]/actions.ts`, import `setPort` from `@/server/hostd/ports` and add after `setBranchAction`:

```ts
// Moving an environment to another port recreates its containers, so it is its own action rather than
// part of the Settings save, which never starts or stops anything. The operator's alone, as every other
// change to the registry entry is.
export async function setPortAction(id: string, environment: string, port: number): Promise<SiteActionResult> {
    const name = environmentOf(environment)
    if (!name || typeof port !== 'number' || !Number.isInteger(port)) return { ok: false, error: 'That is not something this page can do.' }

    const allowed = await allow(id, true)
    if (!allowed.ok) return allowed

    const result = await setPort(allowed.config, allowed.caller, id, name, port)
    if (!result.ok) return refused(`port ${name} on ${id}`, allowed.isAdmin, result)

    revalidatePath(`/portal/sites/${id}`)
    return { ok: true, message: `${name} now uses port ${port}. ${result.value.output}.` }
}
```

Create `app/(portal)/portal/sites/[id]/portControl.tsx`:

```tsx
'use client'

// One environment's port. Its own control rather than a field in the Settings save: changing it
// recreates the environment's containers, and nothing else on that form starts or stops anything.

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/ui/Button/Button'
import { Callout } from '@/ui/Callout/Callout'
import { Field } from '@/ui/Field/Field'
import { usePortCheck } from '../usePortCheck'
import { setPortAction, type SiteActionResult } from './actions'
import styles from './site.module.css'

export function PortControl({ id, environment, port }: { id: string, environment: string, port: number }) {
    const router = useRouter()
    const [value, setValue] = useState(String(port))
    const [pending, setPending] = useState(false)
    const [said, setSaid] = useState<SiteActionResult | null>(null)

    const trimmed = value.trim()
    const unchanged = trimmed === String(port)
    const inRange = /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 5000 && Number(trimmed) <= 65535
    const check = usePortCheck(value, { project: id, environment }, { skip: unchanged })
    const problem = unchanged ? null : !inRange ? 'Use a port from 5000 to 65535.' : check.problem

    async function save() {
        setSaid(null)
        setPending(true)
        try {
            const result = await setPortAction(id, environment, Number(trimmed))
            setSaid(result)
            if (result.ok) router.refresh()
        } catch {
            setSaid({ ok: false, error: 'That did not work. Try reloading the page.' })
        } finally {
            setPending(false)
        }
    }

    return (
        <div>
            <Field
                label={`${environment} port`}
                inputMode="numeric"
                value={value}
                onChange={event => { setValue(event.target.value); setSaid(null) }}
                error={problem ?? undefined}
                hint={check.error ? `The dedi's ports could not be checked: ${check.error}` : undefined}
            />
            {!unchanged && (
                <p className={styles.note}>
                    Changing it rewrites WEB_PORT in the site's .env, recreates this environment's containers and points its vhost at the new port. The site is down for a few seconds.
                </p>
            )}
            <Button disabled={unchanged || problem !== null || check.checking || pending} onClick={save}>
                {pending ? 'Changing...' : 'Change port'}
            </Button>
            {said && (said.ok
                ? <Callout title="Port changed">{said.message}</Callout>
                : <Callout tone="crit" title="The port was not changed">{said.error}</Callout>)}
        </div>
    )
}
```

  Match `Field`'s real `error` and `hint` prop types (read `ui/Field/Field.tsx`); drop `inputMode` if `Field` does not pass it through. The note names the real variable only when the site uses the default; that is fine because the portal does not know `portEnv`, and hostd's refusal names the real one.

In `settings.tsx`, import `PortControl` from `'./portControl'` and replace:

```tsx
                        {env.port !== undefined && <p className={styles.envMeta}>port {env.port}</p>}
```

with:

```tsx
                        {env.port !== undefined && <PortControl id={id} environment={env.name} port={env.port} />}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run "app/(portal)/portal/sites" && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "app/(portal)/portal/sites/[id]"
git commit -m "Change an environment's port from the Settings tab

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Runbook, spec touch-ups and full verification

**Files:**
- Modify: `hostd/RUNBOOK.md` (new section)
- Modify: `docs/superpowers/specs/2026-09-23-site-port-allocation-design.md` (match what was built)

- [ ] **Step 1: Write the runbook section**

Add a section to `hostd/RUNBOOK.md` after the credentials section, titled `## A site's port`, saying:

- hostd owns each environment's port. The portal picks it (New site form, or Settings for a site that exists), from 5000 to 65535, and refuses a port another environment has or anything on the dedi is listening on.
- hostd writes it into the environment's root `.env` as `WEB_PORT=<port>` (or the variable the registry entry's `portEnv` names). The site's compose file has to publish it, for example `ports: ["127.0.0.1:${WEB_PORT}:3000"]`. Create, add-environment and a port change all refuse a compose file that does not.
- To move an existing site that hard codes its port: change its compose file to `${WEB_PORT}`, deploy that, then pick the port in Settings.
- How the check sees host services: the agent runs a throwaway `--network host` container from its own image that reads `/proc/net/tcp` and `/proc/net/tcp6`. If that fails, provisioning and port changes are refused; check `docker compose logs agent` and that `docker image inspect hostd-agent` works.
- A quick check from the dedi that the probe sees what `ss` sees: `sudo ss -Hltn | awk '{print $4}' | sed 's/.*://' | sort -un` should match the listening ports the agent reads.

No em dashes. Check with Python:

```bash
python -c "import sys;t=open('hostd/RUNBOOK.md',encoding='utf-8').read();print('emdash' if '\u2014' in t else 'clean')"
```

- [ ] **Step 2: Bring the spec in line with the build**

In the spec: the host probe runs through the `docker` CLI (`docker run --rm --network host ... cat /proc/net/tcp /proc/net/tcp6`), not new `DockerApi` calls. The port change route is `PUT /projects/:id/:env/port`, matching the other per-environment routes. `GET /ports` also takes `project` and `environment`. Check the spec for em dashes the same way.

- [ ] **Step 3: Run everything**

Run: `cd hostd && npm test && npm run typecheck`
Expected: every test passes, no type errors.

Run (repo root): `npm test && npx tsc --noEmit && npm run lint`
Expected: every test passes, no type or lint errors.

- [ ] **Step 4: Scan the diff for em dashes outside comments**

```bash
git diff Master --name-only | python -c "import sys,io;[print(p.strip()) for p in sys.stdin if p.strip() and not p.strip().endswith(('.ts','.tsx')) and '\u2014' in io.open(p.strip(),encoding='utf-8',errors='ignore').read()]"
```

Expected: no output. For `.ts`/`.tsx` files, check the new UI strings and messages by eye: em dashes are allowed only in comments.

- [ ] **Step 5: Commit**

```bash
git add hostd/RUNBOOK.md docs/superpowers/specs/2026-09-23-site-port-allocation-design.md
git commit -m "Document how a site publishes the port hostd gives it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
