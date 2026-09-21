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
import { ScheduleStore } from './schedule.ts'
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
// One minute, as the design says: often enough that a due schedule starts promptly, cheap enough to poll
// forever.
const SCHEDULE_TICK_MS = 60_000
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
    const healthAgent = createAgentClient(socketConnect(AGENT_SOCKET), { callTimeoutMs: 15_000 })
    const agentAnswers = async () => {
        try {
            await healthAgent.call({ verb: 'health' })
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

    const schedules = new ScheduleStore(join(STATE_DIR, 'schedules.json'), undefined, log)
    await schedules.load()

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
    const agent = createAgentClient(socketConnect(AGENT_SOCKET))
    const handler = createHandler({
        token: TOKEN,
        registry: () => store.current(),
        // Lets a route that just carried out a write catch the store up before it answers, instead of
        // waiting for this same refresh to come round on the poll below, up to POLL_MS later.
        refreshRegistry: () => store.refresh(),
        // The hoisted client above, not a second one: the backup schedule tick at the foot of this file
        // calls the agent too, and both must share one connection path.
        agent,
        audit,
        schedules,
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
    let lastTick = Date.now()
    let lastWarnings = ''
    for (;;) {
        const warnings = [...store.warnings(), ...audit.warnings(), ...schedules.warnings(), ...(agentWarning ? [agentWarning] : [])]
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
        // One minute, as the design says. A slot that fell due while api was down is caught by isDue
        // comparing against the last run rather than against the tick, so this also covers startup.
        if (Date.now() - lastTick >= SCHEDULE_TICK_MS) {
            lastTick = Date.now()
            try {
                const registry = store.current()
                // due() only ever considers a project in the schedules map with a mode other than off, so
                // asking about the rest cannot change the outcome and would only spawn a restic snapshots
                // subprocess a minute for nothing.
                const candidates = [...registry.projects.values()]
                    .filter(project => project.capabilities.has('backups') && schedules.get(project.id).mode !== 'off')
                const lastRuns = new Map<string, number | null>()
                const unreadable = new Set<string>()
                for (const project of candidates) {
                    // Isolated per project: a stuck restic lock or a slow snapshots listing on one large
                    // repository must not abandon every other project's schedule for the rest of the tick.
                    try {
                        const reply = await agent.call({ verb: 'backup', project: project.id, args: { action: 'list' } })
                        const newest = reply.ok && 'runs' in reply ? reply.runs[0] : undefined
                        lastRuns.set(project.id, newest ? Date.parse(newest.startedAt) : null)
                    } catch (error) {
                        // One project the agent cannot describe must not stop the others being considered, and
                        // must not be treated as never-run: the grace window would then start a run on
                        // unknown history, duplicating a backup that had in fact just succeeded.
                        unreadable.add(project.id)
                        log(`WARN could not read ${project.id}'s backup history: ${describeError(error)}`)
                    }
                }
                for (const { id, schedule } of schedules.due(registry, projectId => lastRuns.get(projectId) ?? null, Date.now())) {
                    if (unreadable.has(id)) continue
                    // Isolated per project, like the list loop above: starting one project's backup calls
                    // restic.snapshots(repo) again inside the agent, the same slow call this can time out
                    // on, and that must not cost every project ordered behind it its slot for this tick.
                    try {
                        const started = await agent.call({ verb: 'backup', project: id, args: { action: 'run', tag: 'scheduled', keep: schedule.keep } })
                        // A refusal here is ordinary: another backup may hold the dedi-wide lock, and the next
                        // tick tries again because the slot is still unsatisfied.
                        if (!started.ok) log(`scheduled backup for ${id} was not started: ${started.message}`)
                        else log(`scheduled backup for ${id} started`)
                    } catch (error) {
                        log(`WARN scheduled backup for ${id} could not be started: ${describeError(error)}`)
                    }
                }
            } catch (error) {
                // Last resort: the loop above now isolates every per-project failure itself, so this guards
                // only the tick's own bookkeeping, such as store.current() throwing.
                log(`WARN the backup schedule tick failed: ${describeError(error)}`)
            }
        }
    }
}

main().catch(error => fail([describeError(error)]))
