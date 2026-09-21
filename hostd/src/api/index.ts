// api: boot gate, then HTTP on the private hostd network. Holds the API token and nothing else of value.

import { createServer } from 'node:http'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import type { Registry } from '../shared/registry.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'
import { createAgentClient, socketConnect } from './agent-client.ts'
import { AuditLog } from './audit.ts'
import { DomainStore, type DomainRecord } from './domain-state.ts'
import { Verifier, type VerifyTarget } from './verifier.ts'
import { createHandler } from './routes.ts'

const TOKEN = process.env.HOSTD_API_TOKEN ?? ''
const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/registry/projects.yaml'
const AGENT_SOCKET = process.env.HOSTD_AGENT_SOCKET ?? '/run/hostd/agent.sock'
const STATE_DIR = process.env.HOSTD_STATE_DIR ?? '/state'
const STATUS_FILE = process.env.HOSTD_STATUS_FILE ?? '/tmp/hostd-status.json'
const PORT = 8080
const POLL_MS = 10_000
const AGENT_CHECK_MS = 60_000
const PRUNE_MS = 24 * 60 * 60_000
const MIN_TOKEN_LENGTH = 32
const BOOT_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000]

const log = (message: string) => console.log(`[api] ${new Date().toISOString()} ${message}`)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// What a hostname is verified against, which is a function of the environment's certificate mode rather
// than of anything the record itself carries.
//
// cloudflare-origin means the name is expected to be proxied, so https is asked for and Cloudflare's own
// certificate is what answers it: that is what makes a TLS failure readable as "the proxy is off".
// letsencrypt means the name points straight at this dedi, and until 4b lands the vhost still presents
// the Origin certificate, which no public trust store will accept; https would fail every such check for
// a reason that has nothing to do with the client's DNS. Port 80 answers the token before it redirects
// (see agent/vhost.ts), so http is what proves an unproxied name. A mode nobody has chosen is read as
// proxied, because every site on this machine is today.
function verifyTarget(registry: () => Registry, record: DomainRecord): VerifyTarget {
    const certificate = registry().projects.get(record.project)?.environments.get(record.environment)?.certificate ?? null
    return certificate === 'letsencrypt' ? { scheme: 'http', proxied: false } : { scheme: 'https', proxied: true }
}

function fail(failures: string[]): never {
    for (const failure of failures) log(`FATAL ${failure}`)
    process.exit(1)
}

async function main(): Promise<void> {
    const failures: string[] = []
    if (TOKEN.length < MIN_TOKEN_LENGTH) {
        failures.push(`HOSTD_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters; generate one on the dedi with: openssl rand -hex 32`)
    }
    const store = new RegistryStore(REGISTRY_FILE)
    try {
        await store.load()
    } catch (error) {
        failures.push(`the registry ${REGISTRY_FILE} could not be loaded: ${explainRegistryError(error)}`)
    }
    if (failures.length > 0) fail(failures)

    // A short timeout for health checks, so a wedged agent is reported promptly.
    const agent = createAgentClient(socketConnect(AGENT_SOCKET), { callTimeoutMs: 15_000 })
    const agentAnswers = async () => {
        try {
            await agent.call({ verb: 'health' })
            return true
        } catch {
            return false
        }
    }
    let reachable = await agentAnswers()
    for (const delay of BOOT_BACKOFF_MS) {
        if (reachable) break
        log(`the agent is not answering on ${AGENT_SOCKET}, retrying in ${delay / 1000}s`)
        await sleep(delay)
        reachable = await agentAnswers()
    }
    if (!reachable) fail([`the agent is not answering on ${AGENT_SOCKET}`])

    const audit = new AuditLog(join(STATE_DIR, 'audit'))
    try {
        const pruned = await audit.prune()
        if (pruned.length > 0) log(`pruned audit files: ${pruned.join(', ')}`)
    } catch (error) {
        log(`WARN audit prune failed at boot: ${describeError(error)}`)
    }

    // Domain state is api's own, and it is reconciled against the registry before the first request:
    // every hostname the registry names has a record from here on, whether or not this process has ever
    // written a vhost for it.
    const domains = new DomainStore(join(STATE_DIR, 'domains.json'), { readFile: path => readFile(path, 'utf8'), writeFile, rename, mkdir })
    try {
        await domains.load()
        await domains.reconcile(store.current(), new Date().toISOString())
    } catch (error) {
        log(`WARN domain state could not be loaded: ${describeError(error)}`)
    }
    const verifier = new Verifier(domains, fetch, record => verifyTarget(() => store.current(), record), message => log(`WARN ${message}`))
    verifier.start()

    // Lifecycle calls get the full timeout; only the health probe above uses the short one.
    const handler = createHandler({
        token: TOKEN,
        registry: () => store.current(),
        agent: createAgentClient(socketConnect(AGENT_SOCKET)),
        audit,
        domains,
        verifier,
    })
    const server = createServer(handler)
    // A bind failure (say the port is already taken) must fail boot with a named FATAL line, through the
    // same fail() path as every other boot check, rather than crash as an uncaught exception.
    await new Promise<void>((resolve, reject) => {
        const onBootError = (error: Error) => reject(error)
        server.once('error', onBootError)
        server.listen(PORT, '0.0.0.0', () => {
            server.removeListener('error', onBootError)
            resolve()
        })
    })
    // After boot, a server-level error (not a per-request failure) is unusual but not fatal: warn and
    // keep serving whatever connections still work.
    server.on('error', error => log(`WARN api server error: ${describeError(error)}`))
    log(`listening on :${PORT}`)

    let agentWarning: string | null = null
    let lastAgentCheck = Date.now()
    let lastPrune = Date.now()
    let lastWarnings = ''
    for (;;) {
        const warnings = [...store.warnings(), ...audit.warnings(), ...(agentWarning ? [agentWarning] : [])]
        if (warnings.join('\n') !== lastWarnings) {
            for (const warning of warnings) log(`WARN ${warning}`)
            if (warnings.length === 0 && lastWarnings !== '') log('all warnings cleared')
            lastWarnings = warnings.join('\n')
        }
        await writeStatus(STATUS_FILE, buildStatus(warnings, new Date()))
            .catch(error => log(`could not write status: ${describeError(error)}`))
        await sleep(POLL_MS)

        try {
            if (await store.refresh()) log('registry reloaded')
        } catch (error) {
            log(`WARN registry refresh failed: ${describeError(error)}`)
        }
        // Every pass, not only the ones that changed the file: a record written by a domain route lands
        // between two reads, and this is what brings the two level again. reconcile writes nothing when
        // there is nothing to change, and never touches a record that already exists.
        try {
            await domains.reconcile(store.current(), new Date().toISOString())
        } catch (error) {
            log(`WARN domain state could not be reconciled: ${describeError(error)}`)
        }
        if (Date.now() - lastAgentCheck >= AGENT_CHECK_MS) {
            try {
                agentWarning = (await agentAnswers()) ? null : `the agent is not answering on ${AGENT_SOCKET}`
            } catch (error) {
                agentWarning = `agent health check failed: ${describeError(error)}`
            }
            lastAgentCheck = Date.now()
        }
        if (Date.now() - lastPrune >= PRUNE_MS) {
            try {
                const removed = await audit.prune()
                if (removed.length > 0) log(`pruned audit files: ${removed.join(', ')}`)
            } catch (error) {
                log(`WARN audit prune failed: ${describeError(error)}`)
            }
            lastPrune = Date.now()
        }
    }
}

main().catch(error => fail([describeError(error)]))
