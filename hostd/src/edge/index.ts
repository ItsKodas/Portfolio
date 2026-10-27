// The edge process: the only thing that holds the Nginx Proxy Manager credentials and writes to NPM. The
// agent reaches it over a Unix socket in a volume shared with nothing else (api never gets it).

import { createServer } from 'node:net'
import { chmod, chown, rm } from 'node:fs/promises'
import { NpmClient } from './npm-client.ts'
import { handleEdge, handleEdgeConnection } from './server.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'

const SOCKET_PATH = process.env.HOSTD_EDGE_SOCKET ?? '/run/hostd-edge/edge.sock'
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const SOCKET_GID = Number(process.env.HOSTD_SOCKET_GID ?? '1000')
const POLL_MS = 10_000

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
    if (failures.length > 0) fail(failures)

    const npm = new NpmClient({
        url: process.env.HOSTD_NPM_URL ?? 'http://192.168.0.5:81/api',
        identity: identity as string,
        secret: secret as string,
    })
    const deps = { npm, upstreamHost: process.env.HOSTD_UPSTREAM_HOST ?? '192.168.0.8', npmAge: () => npm.ageOfLastSuccess() }

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
    log(`listening on ${SOCKET_PATH}`)

    for (;;) {
        await writeStatus(STATUS_FILE, buildStatus([], new Date()))
            .catch(error => log(`could not write status: ${describeError(error)}`))
        await sleep(POLL_MS)
    }
}

main().catch(error => fail([describeError(error)]))
