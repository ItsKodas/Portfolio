// The agent: boot gate, then the storage guard over every project, then the socket. It runs as root with
// the Docker socket, so it listens on nothing but a Unix socket shared with api.

import { createServer, createConnection } from 'node:net'
import { chmod, chown, mkdir, rm, stat } from 'node:fs/promises'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { RegistryWriter } from '../shared/registry-write.ts'
import { choosePort, listeningOnHost } from '../shared/ports.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'
import { createDockerApi } from './docker.ts'
import { createSpawnRunner, resolveNewProject } from './compose.ts'
import { GuardTracker } from './guard-tracker.ts'
import { createFetchClient, socketConnect } from './fetch-client.ts'
import { Agent } from './agent.ts'
import type { ProvisionDeps } from './provision.ts'
import { handleConnection } from './server.ts'

const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/projects.yaml'
const SOCKET_PATH = process.env.HOSTD_AGENT_SOCKET ?? '/run/hostd/agent.sock'
const SOCKET_GID = Number(process.env.HOSTD_SOCKET_GID ?? '1000')
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const FETCH_SOCKET_PATH = process.env.HOSTD_FETCH_SOCKET ?? '/run/hostd/fetch.sock'
const WWW = '/var/www'
// Bind-mounted read-only from the pre-phase-2 host path (hostd/projects.yaml), which the upgrade moves
// to hostd/registry/projects.yaml. Its presence here means that move never happened, so starting would
// otherwise run the new agent against whatever is left in the phase 1 location. See RUNBOOK.md.
const OLD_REGISTRY_FILE = '/etc/hostd-legacy/projects.yaml'
const POLL_MS = 10_000
// Compose files can change without the registry changing, so the guard also runs on a timer.
const GUARD_EVERY_MS = 10 * 60_000
// Projects that are already invalid are re-checked much sooner, so a fix shows up in /projects in about a
// minute instead of waiting out the full sweep. Only failing projects pay for the extra compose runs.
const INVALID_EVERY_MS = 60_000
// Roughly 75 seconds in total, as in mailops: long enough for a daemon still starting after a reboot.
const BOOT_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000]

const log = (message: string) => console.log(`[agent] ${new Date().toISOString()} ${message}`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fail(failures: string[]): never {
    for (const failure of failures) log(`FATAL ${failure}`)
    process.exit(1)
}

async function main(): Promise<void> {
    if (!Number.isInteger(SOCKET_GID) || SOCKET_GID < 0) fail([`HOSTD_SOCKET_GID must be a group id, not ${process.env.HOSTD_SOCKET_GID}`])

    const store = new RegistryStore(REGISTRY_FILE)
    const failures: string[] = []
    try {
        await store.load()
    } catch (error) {
        failures.push(`the registry ${REGISTRY_FILE} could not be loaded: ${explainRegistryError(error)}`)
    }
    try {
        if (!(await stat(WWW)).isDirectory()) failures.push(`${WWW} is not a directory`)
    } catch {
        failures.push(`${WWW} is not mounted`)
    }
    try {
        if ((await stat(OLD_REGISTRY_FILE)).isFile()) {
            failures.push('hostd/projects.yaml still exists on the host; move it to hostd/registry/projects.yaml before starting (see RUNBOOK.md)')
        }
    } catch {
        // Not a file: either it never existed, or the bind mount auto-created an empty directory
        // because the host source was missing, which is exactly what a completed upgrade looks like.
    }
    if (failures.length > 0) fail(failures)

    const docker = createDockerApi()
    let reachable = await docker.ping()
    for (const delay of BOOT_BACKOFF_MS) {
        if (reachable) break
        log(`the Docker socket is not answering, retrying in ${delay / 1000}s`)
        await sleep(delay)
        reachable = await docker.ping()
    }
    if (!reachable) fail(['the Docker socket is not answering'])

    const runner = createSpawnRunner()
    const guard = new GuardTracker(runner)
    await guard.checkAll(store.current())

    // A raw connect probe, not a call through FetchClient: there is no fetcher verb that means "are you
    // there", and a failed connect (ENOENT, ECONNREFUSED) resolves at once, so this never needs a timeout.
    const fetcherReachable = () => new Promise<boolean>(resolve => {
        const socket = createConnection(FETCH_SOCKET_PATH)
        const finish = (ok: boolean) => { socket.destroy(); resolve(ok) }
        socket.once('connect', () => finish(true))
        socket.once('error', () => finish(false))
    })
    const checkFetcher = async (): Promise<string | null> => (
        (await fetcherReachable())
            ? null
            : `the fetcher socket ${FETCH_SOCKET_PATH} is not answering (has hostd-fetcher started?); provisioning and env editing are unavailable until it is`
    )
    // Named and tracked exactly like the agent's other boot-time checks, but never fatal: lifecycle and
    // logs are what the deployed site depends on today, and they need nothing the fetcher provides.
    let fetcherProblem = await checkFetcher()

    const writer = new RegistryWriter(REGISTRY_FILE)
    const fetcher = createFetchClient(socketConnect(FETCH_SOCKET_PATH))
    const exists = async (path: string): Promise<boolean> => {
        try {
            await stat(path)
            return true
        } catch {
            return false
        }
    }
    const provision: ProvisionDeps = {
        registry: () => store.current(),
        writer,
        fetcher,
        // The store only reloads on its own 10 second timer, so a create issued just after another one
        // could otherwise still see the port that create just took and pick it again. parseRegistry
        // would refuse that write rather than corrupt the registry, but refreshing first avoids turning
        // an ordinary race into a spurious failure.
        choosePort: async () => {
            await store.refresh()
            return choosePort(store.current(), listeningOnHost)
        },
        mkdir: dir => mkdir(dir),
        rmdir: dir => rm(dir, { recursive: true, force: true }),
        exists,
        resolve: (dir, composePath) => resolveNewProject({ dir, composePath }, runner),
        log,
    }

    const warnings = () => [
        ...store.warnings(),
        ...[...store.current().invalid].map(([id, problem]) => `project ${id} is invalid: ${problem}`),
        ...guard.warnings(),
        ...(fetcherProblem ? [fetcherProblem] : []),
    ]

    const agent = new Agent({
        registry: () => store.current(),
        guardInvalid: () => guard.current(),
        warnings,
        docker,
        runner,
        recheck: project => guard.check(project),
        provision,
    })

    await rm(SOCKET_PATH, { force: true })
    // The socket is created 0660 rather than chmodded afterwards, so there is no moment when it is wider.
    process.umask(0o117)
    const server = createServer(socket => {
        handleConnection(socket, agent, log).catch(error => log(`connection failed: ${describeError(error)}`))
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(SOCKET_PATH, resolve)
    })
    await chown(SOCKET_PATH, 0, SOCKET_GID)
    await chmod(SOCKET_PATH, 0o660)
    log(`listening on ${SOCKET_PATH}`)

    let lastGuardRun = Date.now()
    let lastInvalidRun = lastGuardRun
    let lastWarnings = ''
    for (;;) {
        const current = warnings()
        // Logged when they change rather than every poll, so the log shows transitions, not noise.
        if (current.join('\n') !== lastWarnings) {
            for (const warning of current) log(`WARN ${warning}`)
            if (current.length === 0 && lastWarnings !== '') log('all warnings cleared')
            lastWarnings = current.join('\n')
        }
        await writeStatus(STATUS_FILE, buildStatus(current, new Date()))
            .catch(error => log(`could not write status: ${describeError(error)}`))
        await sleep(POLL_MS)
        fetcherProblem = await checkFetcher()
        const changed = await store.refresh()
        if (changed) log('registry reloaded')
        if (changed || Date.now() - lastGuardRun >= GUARD_EVERY_MS) {
            await guard.checkAll(store.current())
            lastGuardRun = Date.now()
            // The sweep covered the invalid projects too, so their own timer starts again from here.
            lastInvalidRun = lastGuardRun
        } else if (Date.now() - lastInvalidRun >= INVALID_EVERY_MS) {
            await guard.recheckInvalid(store.current())
            lastInvalidRun = Date.now()
        }
    }
}

main().catch(error => fail([describeError(error)]))
