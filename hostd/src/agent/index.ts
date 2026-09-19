// The agent: boot gate, then the storage guard over every project, then the socket. It runs as root with
// the Docker socket, so it listens on nothing but a Unix socket shared with api.

import { createServer } from 'node:net'
import { chmod, chown, rm, stat } from 'node:fs/promises'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'
import { createDockerApi } from './docker.ts'
import { createSpawnRunner } from './compose.ts'
import { GuardTracker } from './guard-tracker.ts'
import { Agent } from './agent.ts'
import { handleConnection } from './server.ts'

const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/projects.yaml'
const SOCKET_PATH = process.env.HOSTD_AGENT_SOCKET ?? '/run/hostd/agent.sock'
const SOCKET_GID = Number(process.env.HOSTD_SOCKET_GID ?? '1000')
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const WWW = '/var/www'
const POLL_MS = 10_000
// Compose files can change without the registry changing, so the guard also runs on a timer.
const GUARD_EVERY_MS = 10 * 60_000
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

    const warnings = () => [
        ...store.warnings(),
        ...[...store.current().invalid].map(([id, problem]) => `project ${id} is invalid: ${problem}`),
        ...guard.warnings(),
    ]

    const agent = new Agent({
        registry: () => store.current(),
        guardInvalid: () => guard.current(),
        warnings,
        docker,
        runner,
        recheck: project => guard.check(project),
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
        const changed = await store.refresh()
        if (changed) log('registry reloaded')
        if (changed || Date.now() - lastGuardRun >= GUARD_EVERY_MS) {
            await guard.checkAll(store.current())
            lastGuardRun = Date.now()
        }
    }
}

main().catch(error => fail([describeError(error)]))
