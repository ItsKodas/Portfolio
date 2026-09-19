// api: boot gate, then HTTP on the private hostd network. Holds the API token and nothing else of value.

import { createServer } from 'node:http'
import { join } from 'node:path'
import { RegistryStore, explainRegistryError } from '../shared/registry-store.ts'
import { buildStatus, writeStatus } from '../shared/status.ts'
import { describeError } from '../shared/formats.ts'
import { createAgentClient, socketConnect } from './agent-client.ts'
import { AuditLog } from './audit.ts'
import { createHandler } from './routes.ts'

const TOKEN = process.env.HOSTD_API_TOKEN ?? ''
const REGISTRY_FILE = process.env.HOSTD_REGISTRY_FILE ?? '/etc/hostd/projects.yaml'
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
    const pruned = await audit.prune()
    if (pruned.length > 0) log(`pruned audit files: ${pruned.join(', ')}`)

    // Lifecycle calls get the full timeout; only the health probe above uses the short one.
    const handler = createHandler({
        token: TOKEN,
        registry: () => store.current(),
        agent: createAgentClient(socketConnect(AGENT_SOCKET)),
        audit,
    })
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(PORT, '0.0.0.0', resolve))
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

        if (await store.refresh()) log('registry reloaded')
        if (Date.now() - lastAgentCheck >= AGENT_CHECK_MS) {
            agentWarning = (await agentAnswers()) ? null : `the agent is not answering on ${AGENT_SOCKET}`
            lastAgentCheck = Date.now()
        }
        if (Date.now() - lastPrune >= PRUNE_MS) {
            const removed = await audit.prune()
            if (removed.length > 0) log(`pruned audit files: ${removed.join(', ')}`)
            lastPrune = Date.now()
        }
    }
}

main().catch(error => fail([describeError(error)]))
