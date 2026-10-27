// The edge process: the only thing that holds the Nginx Proxy Manager credentials and writes to NPM. The
// agent reaches it over a Unix socket in a volume shared with nothing else (api never gets it).

import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { appendFile, chmod, chown, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { NpmClient, npmConnection } from './npm-client.ts'
import { handleEdge, handleEdgeConnection } from './server.ts'
import { holdingHandler } from './holding-http.ts'
import { routesOf, startSyslog, type Route } from './syslog.ts'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'

const SOCKET_PATH = process.env.HOSTD_EDGE_SOCKET ?? '/run/hostd-edge/edge.sock'
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const SOCKET_GID = Number(process.env.HOSTD_SOCKET_GID ?? '1000')
const POLL_MS = 10_000
const UPSTREAM_HOST = process.env.HOSTD_UPSTREAM_HOST ?? '192.168.0.8'
const HTTP_PORT = Number(process.env.HOSTD_EDGE_HTTP_PORT ?? '8790')
const SYSLOG_PORT = Number(process.env.HOSTD_EDGE_SYSLOG_PORT ?? '5514')
const NPM_ADDRESS = process.env.HOSTD_NPM_ADDRESS ?? '192.168.0.6'
const ACCESS_LOG_DIR = process.env.HOSTD_ACCESS_LOG_DIR ?? '/var/log/hostd'
// The agent's setting for where holding pages live (agent/index.ts)
const MAINTENANCE_ROOT = process.env.HOSTD_MAINTENANCE_ROOT ?? '/var/www/hostd-maintenance'
const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/registry/projects.yaml'
const REGISTRY_CHECK_MS = 5_000
const ROUTES_REBUILD_MS = 60_000

const log = (message: string) => console.log(`[edge] ${new Date().toISOString()} ${message}`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fail(failures: string[]): never {
    for (const failure of failures) log(`FATAL ${failure}`)
    process.exit(1)
}

async function main(): Promise<void> {
    const failures: string[] = []
    const identity = process.env.HOSTD_NPM_IDENTITY
    const secret = process.env.HOSTD_NPM_SECRET
    // Names only: the secret itself is never printed.
    if (!identity) failures.push('HOSTD_NPM_IDENTITY is not set')
    if (!secret) failures.push('HOSTD_NPM_SECRET is not set')
    if (!Number.isInteger(SOCKET_GID) || SOCKET_GID < 0) failures.push(`HOSTD_SOCKET_GID must be a group id, not ${process.env.HOSTD_SOCKET_GID}`)
    // HOSTD_NPM_FLAVOUR is npm (stock NPM, the default) or npmplus. A typo must stop edge rather than
    // fall back to stock NPM, whose writes NPMplus refuses and whose login it does not answer the same way.
    const connection = npmConnection(process.env)
    failures.push(...connection.problems)
    if (failures.length > 0) fail(failures)

    const npm = new NpmClient({
        url: connection.url,
        identity: identity as string,
        secret: secret as string,
        flavour: connection.flavour,
    })
    const deps = { npm, upstreamHost: UPSTREAM_HOST, flavour: connection.flavour, npmAge: () => npm.ageOfLastSuccess() }
    log(`talking to ${connection.flavour === 'npmplus' ? 'NPMplus' : 'NPM'} at ${connection.url}`)

    await rm(SOCKET_PATH, { force: true })
    // Created 0660 rather than chmodded afterwards, so there is no moment when it is wider.
    process.umask(0o117)
    const server = createServer(socket => {
        handleEdgeConnection(socket, request => handleEdge(request, deps), log)
            .catch(error => log(`connection failed: ${describeError(error)}`))
    })
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(SOCKET_PATH, resolve)
    })
    await chown(SOCKET_PATH, 0, SOCKET_GID)
    await chmod(SOCKET_PATH, 0o660)
    // Back to the default now the socket exists, so the log files and directories edge writes below get
    // ordinary permissions rather than the socket's.
    process.umask(0o022)
    log(`listening on ${SOCKET_PATH}`)

    // hostname -> owner, from the registry. A registry that stops parsing keeps the last good map.
    const store = new RegistryStore(REGISTRY_FILE)
    try {
        await store.load()
    } catch (error) {
        fail([`the registry ${REGISTRY_FILE} could not be loaded: ${explainRegistryError(error)}`])
    }
    let route: Route = routesOf(store.current())
    let lastRejection: string | null = null
    const refreshRoutes = async (force: boolean) => {
        const changed = await store.refresh()
        const rejection = store.rejected()
        if (rejection !== null && rejection !== lastRejection) log(`WARN registry reload rejected, keeping the last good routes: ${rejection}`)
        lastRejection = rejection
        if (changed || force) route = routesOf(store.current())
    }
    setInterval(() => { refreshRoutes(false).catch(error => log(`registry check failed: ${describeError(error)}`)) }, REGISTRY_CHECK_MS).unref()
    setInterval(() => { refreshRoutes(true).catch(error => log(`registry check failed: ${describeError(error)}`)) }, ROUTES_REBUILD_MS).unref()

    // Both bind the upstream address only, never every interface: NPM is the one caller.
    const holding = createHttpServer(holdingHandler(MAINTENANCE_ROOT, async path => {
        try {
            return await readFile(path, 'utf8')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
        }
    }))
    await new Promise<void>((resolve, reject) => {
        holding.once('error', reject)
        holding.listen(HTTP_PORT, UPSTREAM_HOST, resolve)
    })
    log(`holding pages on ${UPSTREAM_HOST}:${HTTP_PORT}`)

    let appendFailures = 0
    // A port that cannot be bound is as fatal as the holding listener's: edge running on with nothing
    // receiving the logs would look healthy while every site's analytics went quiet.
    await startSyslog({
        host: UPSTREAM_HOST,
        port: SYSLOG_PORT,
        allowed: NPM_ADDRESS,
        logDir: ACCESS_LOG_DIR,
        route: () => route,
        append: async (path, line) => {
            await mkdir(dirname(path), { recursive: true })
            await appendFile(path, line)
        },
        // Counted and logged sparingly, so a full disk does not become a full journal as well
        onError: error => {
            appendFailures++
            if (appendFailures === 1 || appendFailures % 1000 === 0) log(`access log write failed (${appendFailures} so far): ${describeError(error)}`)
        },
        onSocketError: error => log(`access log receiver error: ${describeError(error)}`),
    }).catch(error => fail([`access logs could not listen on udp ${UPSTREAM_HOST}:${SYSLOG_PORT}: ${describeError(error)}`]))
    log(`access logs on udp ${UPSTREAM_HOST}:${SYSLOG_PORT} from ${NPM_ADDRESS}`)

    for (;;) {
        await writeStatus(STATUS_FILE, buildStatus([], new Date()))
            .catch(error => log(`could not write status: ${describeError(error)}`))
        await sleep(POLL_MS)
    }
}

main().catch(error => fail([describeError(error)]))
