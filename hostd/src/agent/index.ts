// The agent: boot gate, then the storage guard over every project, then the socket. It runs as root with
// the Docker socket, so it listens on nothing but a Unix socket shared with api.

import { createServer, createConnection } from 'node:net'
import { createWriteStream } from 'node:fs'
import { chmod, chown, cp, mkdir, readdir, readFile, rename, rm, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { RegistryWriter } from '../shared/registry-write.ts'
import { choosePort } from '../shared/ports.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { readSystemUsage, systemSource, DEFAULT_SYSTEM_DISK_PATH } from '../shared/system.ts'
import { describeError } from '../shared/formats.ts'
import { ENVIRONMENTS } from '../shared/registry.ts'
import { deployKey } from '../shared/deploys.ts'
import { createDockerApi, dockerPortCheck } from './docker.ts'
import { createSpawnRunner, resolveNewProject } from './compose.ts'
import { GuardTracker } from './guard-tracker.ts'
import { createFetchClient, socketConnect } from './fetch-client.ts'
import { Agent } from './agent.ts'
import type { ProvisionDeps } from './provision.ts'
import { currentTip, type DeployDeps } from './deploy.ts'
import { ownTree } from './own-tree.ts'
import { DeployStore } from './deploy-state.ts'
import { DeployRunner } from './deploy-runner.ts'
import { DeployPoller } from './deploy-poller.ts'
import { createResticRunner, createRestic, nodeSpawnStream, repoPath } from './restic.ts'
import { BackupStore } from './backup-state.ts'
import { BackupRunner, type BackupRunnerDeps } from './backup-runner.ts'
import type { BackupFs } from './backup-run.ts'
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
// The backup repository root and the run history that sits beside it, on their own volume for the same
// reason the deploy state is: both have to survive a restart.
const BACKUP_DIR = process.env.HOSTD_BACKUP_DIR ?? '/backups'
const BACKUP_STATE_FILE = process.env.HOSTD_BACKUP_STATE_FILE ?? '/var/lib/hostd/backups.json'
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
// Once a week per repository. Prunes are expensive and take the repository lock, so they are worth
// running rarely rather than on every tick.
const PRUNE_MS = 7 * 24 * 60 * 60_000
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
    // Without it restic cannot open or create a single repository, so every backup fails at init and a
    // project only finds out when it wants one back. An .env.agent that exists but was never filled in is
    // exactly what example.env.agent ships, which is why this is checked rather than assumed. Whether it
    // is set is said here and nowhere else, and the value itself never reaches a log line.
    if ((process.env.RESTIC_PASSWORD ?? '') === '') {
        failures.push('RESTIC_PASSWORD is not set; copy example.env.agent to .env.agent and fill it in, or every backup fails at restic init')
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
    const ownerOf = async (path: string): Promise<{ uid: number, gid: number, mode: number }> => {
        const info = await stat(path)
        // Masked to the nine permission bits, the same reasoning registry-write.ts's own chmod carries:
        // stat can report more than that (the regular-file bit, a stray setuid bit), none of which
        // belongs on a mode this hands straight to chmod.
        return { uid: info.uid, gid: info.gid, mode: info.mode & 0o777 }
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
        // The same two implementations deploy's fs below is given, so a freshly provisioned tree and a
        // freshly deployed one end up owned and moded by exactly the same rule.
        owner: ownerOf,
        own: (dir, like) => ownTree(dir, like),
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
            owner: ownerOf,
            own: (dir, like) => ownTree(dir, like),
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

    const source = systemSource()
    const backupFs: BackupFs = {
        mkdir: async dir => { await mkdir(dir, { recursive: true }) },
        writeStream: path => {
            const sink = createWriteStream(path)
            const done = new Promise<void>((resolve, reject) => {
                sink.on('finish', resolve)
                sink.on('error', reject)
            })
            return { sink, done }
        },
        remove: async path => { await rm(path, { recursive: true, force: true }) },
        copy: async (from, to) => { await cp(from, to, { recursive: true }) },
        exists,
    }
    const backupStore = new BackupStore(BACKUP_STATE_FILE, undefined, log)
    await backupStore.load()
    // restic needs its own runner, built with createResticRunner(): the docker runner's allowlist
    // deliberately omits RESTIC_PASSWORD, since compose interpolates ${VAR} into client compose files and
    // must never see it. The docker runner is still what dump plans use for sqlite3 and compose stop/start.
    const resticRunner = createResticRunner()
    const restic = createRestic(resticRunner, nodeSpawnStream())
    const backupDeps: BackupRunnerDeps = {
        backupDir: BACKUP_DIR,
        restic,
        docker,
        runner,
        fs: backupFs,
        disk: async () => (await readSystemUsage(source, BACKUP_DIR)).disk,
        now: () => Date.now(),
        log,
        store: backupStore,
        // Both environments: a deploy of either renames a directory beside the one being backed up, and the
        // live tree is what a backup reads.
        deployRunning: id => ENVIRONMENTS.some(environment => deployRunner.isRunning(deployKey(id, environment))),
    }
    const backupRunner = new BackupRunner(backupDeps)

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
        // A backup history that could not be read empties every project's run history and disables the
        // failed-scheduled-backup signal that reads it, so it has to be said out loud rather than
        // silently tolerated.
        ...backupStore.warnings(),
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
        // Read fresh on every health request rather than polled and cached: both readings are a syscall
        // apiece, and a figure the portal draws as live should not be a minute old.
        system: () => readSystemUsage(source, SYSTEM_DISK_PATH),
        recheck: project => guard.check(project),
        // The same writer instance provision and deploy already use above: configure needs nothing from
        // the fetcher socket, so unlike those two it is never gated behind fetcherProblem/'unavailable'.
        writer,
        // The same reload provision and deploy pass themselves, so a configure write is visible to the
        // next request rather than waiting on the store's own timer.
        refreshRegistry: async () => { await store.refresh() },
        provision,
        deploys: { runner: deployRunner, store: deployStore, deps: deployDeps },
        backups: {
            runner: backupRunner,
            store: backupStore,
            restic,
            backupDir: BACKUP_DIR,
            // Six bytes of hex, which is what RUN_ID accepts.
            newRunId: () => randomBytes(6).toString('hex'),
            backupDisk: async () => (await readSystemUsage(source, BACKUP_DIR)).disk,
        },
        domains: domainsDeps,
        // An age, which is what /health compares against its staleness threshold, not the timestamp the
        // rail records: the two are one line apart here and the whole alarm depends on which is which.
        railAge: () => rail.ageOfLastSuccess(),
        // The same client provision and deploy already hold: branches needs nothing else from it, so it
        // is never gated behind fetcherProblem/'unavailable' any more than configure is behind the
        // registry writer above.
        fetcher,
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
    // When each repository was last pruned, rather than one timestamp for a whole sweep: at most one
    // project is pruned per loop iteration (see below), so each one carries its own weekly clock. A
    // project never pruned counts from boot.
    const bootedAt = Date.now()
    const lastPruned = new Map<string, number>()
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
        // Prunes are expensive and take the repository lock, so they never run while a backup might want
        // it, and exactly one project is pruned per iteration rather than all of them in a sweep.
        // Everything above runs on this same loop: a sweep would stop the registry refresh, the guard
        // checks, the deploy poller and the status file until it finished, each prune bounded only by the
        // one hour restic timeout, and the healthcheck calls the agent unhealthy once the status file is
        // 180 seconds old. One per iteration means isBusy() is re-checked for each project, on the
        // iteration that prunes it, rather than once for a whole sweep. A repository's clock only
        // advances when its turn actually comes, so a busy runner defers a prune by iterations, not by a
        // week.
        if (!backupRunner.isBusy()) {
            const due = [...store.current().projects.values()].find(project =>
                project.capabilities.has('backups') && Date.now() - (lastPruned.get(project.id) ?? bootedAt) >= PRUNE_MS)
            if (due) {
                lastPruned.set(due.id, Date.now())
                const repo = repoPath(BACKUP_DIR, due.id)
                // A project that has never been backed up has no repository, and pruning one that is not
                // there fails every week for no reason at all.
                if (await exists(posix.join(repo, 'config'))) {
                    const pruned = await restic.prune(repo)
                    if (!pruned.ok) log(`WARN prune of ${due.id} failed: ${pruned.reason}`)
                }
            }
        }
    }
}

main().catch(error => fail([describeError(error)]))
