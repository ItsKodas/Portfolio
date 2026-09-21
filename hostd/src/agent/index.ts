// The agent: boot gate, then the storage guard over every project, then the socket. It runs as root with
// the Docker socket, so it listens on nothing but a Unix socket shared with api.

import { createServer, createConnection } from 'node:net'
import { chmod, chown, mkdir, readdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { RegistryWriter } from '../shared/registry-write.ts'
import { choosePort } from '../shared/ports.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { readSystemUsage, systemSource, DEFAULT_SYSTEM_DISK_PATH } from '../shared/system.ts'
import { describeError } from '../shared/formats.ts'
import { createDockerApi, dockerPortCheck } from './docker.ts'
import { createSpawnRunner, resolveNewProject } from './compose.ts'
import { GuardTracker } from './guard-tracker.ts'
import { createFetchClient, socketConnect } from './fetch-client.ts'
import { Agent } from './agent.ts'
import type { ProvisionDeps } from './provision.ts'
import { currentTip, type DeployDeps } from './deploy.ts'
import { DeployStore } from './deploy-state.ts'
import { DeployRunner } from './deploy-runner.ts'
import { DeployPoller } from './deploy-poller.ts'
import { handleConnection } from './server.ts'
import { ApacheRail, type RailFs } from './apache-rail.ts'
import type { DomainsConfig, DomainsDeps } from './domains.ts'
import type { VhostFile } from './sites-enabled.ts'

const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/registry/projects.yaml'
const SOCKET_PATH = process.env.HOSTD_AGENT_SOCKET ?? '/run/hostd/agent.sock'
const SOCKET_GID = Number(process.env.HOSTD_SOCKET_GID ?? '1000')
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const FETCH_SOCKET_PATH = process.env.HOSTD_FETCH_SOCKET ?? '/run/hostd-fetch/fetch.sock'
// Which filesystem health reports as the system disk. The default is the host's /var/www, bind-mounted
// here at the same path, so the figure is the host's disk rather than this container's own overlay.
const SYSTEM_DISK_PATH = process.env.HOSTD_SYSTEM_DISK_PATH ?? DEFAULT_SYSTEM_DISK_PATH
// The deploy history and the pause state. On its own volume, because it has to survive a restart: an
// environment paused after three failed builds would otherwise start rebuilding every two minutes again.
const DEPLOY_STATE_FILE = process.env.HOSTD_DEPLOY_STATE_FILE ?? '/var/lib/hostd/deploys.json'
// The flags Apache reads to serve the holding page. Bind-mounted from the host's own /run, which is a
// tmpfs, so a reboot can never leave a site behind a maintenance page nobody remembers putting up.
const MAINTENANCE_DIR = process.env.HOSTD_MAINTENANCE_DIR ?? '/run/hostd/maintenance'
// Where the rail leaves its request and reads its result. Bind-mounted from the host, same as the
// maintenance flags above: the systemd path unit that actually runs Apache commands lives there, not here.
const APACHE_RAIL_DIR = process.env.HOSTD_APACHE_RAIL_DIR ?? '/etc/hostd/apache'
// Where a written vhost lives, and where Apache's own sites-enabled already has whatever an operator
// hand-wrote before hostd existed: adoption reads the latter, never writes it.
const APACHE_INCLUDE_DIR = process.env.HOSTD_APACHE_INCLUDE_DIR ?? '/etc/apache2/hostd'
const APACHE_SITES_ENABLED = process.env.HOSTD_APACHE_SITES_ENABLED ?? '/etc/apache2/sites-enabled'
// The origin certificate every vhost's :443 block names. Not defaulted to a real path: a missing value is
// caught by the boot gate below rather than silently producing a vhost Apache will refuse.
const ORIGIN_CERT = process.env.HOSTD_ORIGIN_CERT ?? ''
const ORIGIN_KEY = process.env.HOSTD_ORIGIN_KEY ?? ''
const ACME_WEBROOT = process.env.HOSTD_ACME_WEBROOT ?? '/var/www/hostd-acme'
// The holding page's DocumentRoot, which is NOT MAINTENANCE_DIR above: that one holds the per-environment
// flag files a deploy writes and clears, this one holds the page Apache actually serves while a flag is
// up. Crossing them makes the holding page silently never appear during a deploy.
const MAINTENANCE_ROOT = process.env.HOSTD_MAINTENANCE_ROOT ?? '/var/www/hostd-maintenance'
const WWW = '/var/www'
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
    // A vhost that names a certificate file which is not there fails Apache's configtest, so every
    // domain action would fail at the last step with an error about SSL rather than about configuration.
    // Better to refuse to start and say which file.
    for (const [name, path] of [['HOSTD_ORIGIN_CERT', ORIGIN_CERT], ['HOSTD_ORIGIN_KEY', ORIGIN_KEY]]) {
        if (!path) {
            failures.push(`${name} is not set, and the domains capability needs it`)
            continue
        }
        try {
            if (!(await stat(path)).isFile()) failures.push(`${name} (${path}) is not a file`)
        } catch {
            failures.push(`${name} (${path}) does not exist`)
        }
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
        // provision.ts calls this itself, before it reads registry(), so the id, domain and port checks
        // it makes in one call all see the same fresh snapshot.
        refreshRegistry: async () => { await store.refresh() },
        writer,
        fetcher,
        // A fresh dockerPortCheck per call, so it takes its own snapshot of every container's published
        // ports rather than reusing one from an earlier provisioning action.
        choosePort: async () => choosePort(store.current(), dockerPortCheck(docker)),
        mkdir: dir => mkdir(dir),
        rmdir: dir => rm(dir, { recursive: true, force: true }),
        exists,
        resolve: (expectedName, dir, composePath, collidesWith) => resolveNewProject({ dir, composePaths: [composePath] }, expectedName, runner, collidesWith),
        runner,
        log,
    }

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
            mkdir: async dir => { await mkdir(dir, { recursive: true }) },
            rmdir: dir => rm(dir, { recursive: true, force: true }),
            move: (from, to) => rename(from, to),
            // What df calls available: the blocks a deploy could actually use, excluding the ones the
            // filesystem reserves for root.
            freeBytes: async path => {
                const info = await statfs(path)
                return info.bavail * info.bsize
            },
            setMaintenance: async key => {
                await mkdir(MAINTENANCE_DIR, { recursive: true })
                await writeFile(posix.join(MAINTENANCE_DIR, key), '')
            },
            clearMaintenance: key => rm(posix.join(MAINTENANCE_DIR, key), { force: true }),
        },
        now: Date.now,
        sleep: async ms => { await sleep(ms) },
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

    // The agent's end of the host rail: a file dropped for a systemd path unit on the host to pick up,
    // since this process has no network namespace of its own to reach Apache through.
    const railFs: RailFs = {
        writeFile: (path, text) => writeFile(path, text, 'utf8'),
        rename: (from, to) => rename(from, to),
        readFile: path => readFile(path, 'utf8'),
        unlink: path => unlink(path),
    }
    const rail = new ApacheRail(APACHE_RAIL_DIR, railFs)
    const domainsConfig: DomainsConfig = {
        includeDir: APACHE_INCLUDE_DIR,
        sitesEnabled: APACHE_SITES_ENABLED,
        originCert: ORIGIN_CERT,
        originKey: ORIGIN_KEY,
        acmeWebroot: ACME_WEBROOT,
        // The right way round: the flag files a deploy writes, and the holding page Apache serves while
        // one is up, are two different directories (see MAINTENANCE_DIR and MAINTENANCE_ROOT above).
        maintenanceFlagDir: MAINTENANCE_DIR,
        maintenancePageDir: MAINTENANCE_ROOT,
    }
    const domainsDeps: DomainsDeps = {
        rail,
        readFile: async path => {
            try {
                return await readFile(path, 'utf8')
            } catch (error) {
                // A first write has no previous file. That is the ordinary case, not an error.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
                throw error
            }
        },
        listSitesEnabled: async () => {
            const names = await readdir(APACHE_SITES_ENABLED).catch(() => [])
            const files: VhostFile[] = []
            for (const name of names) {
                if (!name.endsWith('.conf')) continue
                const path = posix.join(APACHE_SITES_ENABLED, name)
                files.push({ path, text: await readFile(path, 'utf8') })
            }
            return files
        },
        // The same writer provisioning already uses, so a domain write and a provisioning write can
        // never both read the registry text and lose one another's change.
        writeRegistry: change => writer.write(change),
        reloadRegistry: async () => { await store.refresh(); return store.current() },
        config: domainsConfig,
    }

    const warnings = () => [
        ...store.warnings(),
        ...deployStore.warnings(),
        ...[...store.current().invalid].map(([id, problem]) => `project ${id} is invalid: ${problem}`),
        ...guard.warnings(),
        ...(fetcherProblem ? [fetcherProblem] : []),
    ]

    const source = systemSource()
    const agent = new Agent({
        registry: () => store.current(),
        guardInvalid: () => guard.current(),
        warnings,
        docker,
        runner,
        // Read fresh on every health request rather than polled and cached: both readings are a syscall
        // apiece, and a figure the portal draws as live should not be a minute old.
        system: () => readSystemUsage(source, SYSTEM_DISK_PATH),
        recheck: project => guard.check(project),
        provision,
        deploys: { runner: deployRunner, store: deployStore, deps: deployDeps },
        domains: domainsDeps,
        // An age, which is what /health compares against its staleness threshold, not the timestamp the
        // rail records: the two are one line apart here and the whole alarm depends on which is which.
        railAge: () => rail.ageOfLastSuccess(),
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
        // Cheap when nothing is due: an environment is only asked about once its 2 minutes are up, and a
        // deploy this starts is never awaited, so a build cannot hold up the loop or the other sites.
        await deployPoller.tick()
    }
}

main().catch(error => fail([describeError(error)]))
