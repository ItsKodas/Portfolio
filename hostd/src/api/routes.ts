// api's HTTP surface. Every request is authenticated first; every project request passes the policy
// before the agent hears of it; every change, every stream opened and every refusal is audited.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROJECT_ID, CLIENT_ID, SERVICE_NAME, isRecord, describeError } from '../shared/formats.ts'
import {
    LIFECYCLE_ACTIONS, MAX_TAIL, DEFAULT_TAIL, MAX_REQUEST_BYTES, MAX_COMMITS, DEFAULT_COMMITS,
    SNAPSHOT_ID, RUN_ID, parseConfigureArgs,
    type AgentReply, type AgentRequest, type LifecycleAction, type LogsArgs, type ProjectStatus, type Refusal,
    type RefusalCode, type ProvisionCreateArgs, type ProvisionAddEnvironmentArgs,
} from '../shared/protocol.ts'
import {
    ENVIRONMENTS, CERTIFICATE_MODES, CREDENTIAL_NAME, hostnamesOf,
    type CertificateMode, type EnvironmentEntry, type EnvironmentName, type ProjectEntry, type Registry,
} from '../shared/registry.ts'
import { envPathProblem } from '../shared/envfiles.ts'
import { parseSchedule } from '../shared/backups.ts'
import { normaliseHostname } from '../shared/hostnames.ts'
import { authenticate, actorLabel, type Actor, type Caller } from './auth.ts'
import { authorize, visibleProjects, type PolicyVerb } from './policy.ts'
import { AgentUnavailableError, type AgentClient } from './agent-client.ts'
import { MAX_AUDIT_READ, type AuditLog, type AuditOutcome } from './audit.ts'
import { domainKey, newRecord, type DomainRecord } from './domain-state.ts'
import { newToken } from './verify.ts'
import { probeSite, rolledBackReason, wentDark, type Answer } from './adopt-check.ts'
import { sseEvent, SSE_KEEPALIVE } from './sse.ts'
import type { ScheduleStore } from './schedule.ts'

// The slice of DomainStore the routes use, and the one method they want off the Verifier. Structural
// rather than the classes themselves, for the same reason verifier.ts's RecordStore is: a test hands
// over a fake without a filesystem or a network, and the real classes satisfy both shapes unchanged.
export type DomainRoutesStore = {
    get(key: string): DomainRecord | undefined
    all(): DomainRecord[]
    forEnvironment(project: string, environment: EnvironmentName): DomainRecord[]
    put(record: DomainRecord): Promise<void>
    remove(key: string): Promise<void>
    // The boot loop runs this every ten seconds; the configure route runs it once more, straight after a
    // write that moved a hostname, so the very next request answers about the names the registry holds
    // now rather than the ones it held before. It adds what the registry names and deletes what it does
    // not, and never touches a record that already exists, so an extra call is only ever early, never
    // different.
    reconcile(registry: Registry, now: string): Promise<void>
}
export type DomainVerifier = { checkNow(key: string): Promise<void> }

export type ApiDeps = {
    token: string
    registry: () => Registry
    // Re-reads the registry file if its modification time has moved, the same check the boot loop's own
    // poll makes. Called after a write this process just carried out itself, so that write is visible to
    // the very next request rather than waiting for the next poll, up to POLL_MS later. See the agent's
    // own refreshRegistry (agent.ts, provision.ts, deploy.ts) for the other half of this: the agent
    // refreshes its copy after a write it makes; this is api doing the same after a write it relayed.
    refreshRegistry: () => Promise<boolean>
    agent: AgentClient
    audit: AuditLog
    domains: DomainRoutesStore
    verifier: DomainVerifier
    now?: () => number
    keepaliveMs?: number
    schedules?: ScheduleStore
    // How the adopt route asks a hostname whether it is still answering, before and after it replaces
    // the vhost. The global fetch in production; a test hands over its own, since the whole point of
    // this dependency is that it leaves the process. See adopt-check.ts for why the check is api's and
    // not the agent's.
    fetch?: typeof fetch
}

export type Route =
    | { verb: 'list' }
    | { verb: 'health' }
    | { verb: 'audit-all' }
    | { verb: 'credentials' }
    | { verb: 'status', project: string }
    | { verb: 'lifecycle', project: string, action: LifecycleAction }
    | { verb: 'logs', project: string }
    | { verb: 'audit', project: string }
    | { verb: 'create' }
    | { verb: 'delete', project: string }
    | { verb: 'add-environment', project: string }
    | { verb: 'settings', project: string }
    | { verb: 'branches', project: string }
    | { verb: 'remove-environment', project: string, environment: EnvironmentName }
    | { verb: 'env-list', project: string, environment: EnvironmentName }
    | { verb: 'env-file', project: string, environment: EnvironmentName, path: string }
    | { verb: 'deploy', project: string, environment: EnvironmentName }
    | { verb: 'rollback', project: string, environment: EnvironmentName }
    | { verb: 'branch', project: string, environment: EnvironmentName }
    | { verb: 'deploys', project: string, environment: EnvironmentName }
    | { verb: 'commits', project: string, environment: EnvironmentName }
    | { verb: 'backups', project: string }
    | { verb: 'backup-run', project: string }
    | { verb: 'backup-run-status', project: string, run: string }
    | { verb: 'backup-delete', project: string, snapshot: string }
    | { verb: 'backup-download', project: string, snapshot: string }
    | { verb: 'backup-schedule', project: string, write: boolean }
    | { verb: 'domains-list', project: string, environment: EnvironmentName }
    | { verb: 'domain-add', project: string, environment: EnvironmentName }
    | { verb: 'domain-remove', project: string, environment: EnvironmentName, hostname: string }
    | { verb: 'domain-verify', project: string, environment: EnvironmentName, hostname: string }
    | { verb: 'adopt-preview', project: string, environment: EnvironmentName }
    | { verb: 'adopt', project: string, environment: EnvironmentName }
    | { verb: 'not-found' }
    | { verb: 'method-not-allowed' }

const AGENT_STATUS: Record<RefusalCode, number> = {
    'bad-request': 400,
    'capability-disabled': 403,
    'unknown-project': 404,
    'unknown-service': 404,
    'unknown-environment': 404,
    'invalid-project': 409,
    busy: 409,
    failed: 502,
    unavailable: 503,
}

const DEFAULT_AUDIT_LIMIT = 100
const KEEPALIVE_MS = 25_000

export function matchRoute(method: string, pathname: string): Route {
    const parts = pathname.split('/').filter(part => part !== '')
    const only = (wanted: string, route: Route): Route => (method === wanted ? route : { verb: 'method-not-allowed' })

    if (parts.length === 1 && parts[0] === 'projects') {
        if (method === 'GET') return { verb: 'list' }
        if (method === 'POST') return { verb: 'create' }
        return { verb: 'method-not-allowed' }
    }
    if (parts.length === 1 && parts[0] === 'audit') return only('GET', { verb: 'audit-all' })
    if (parts.length === 1 && parts[0] === 'health') return only('GET', { verb: 'health' })
    if (parts.length === 1 && parts[0] === 'credentials') return only('GET', { verb: 'credentials' })
    if (parts[0] !== 'projects' || parts.length < 2) return { verb: 'not-found' }

    const project = parts[1] ?? ''
    if (!PROJECT_ID.test(project)) return { verb: 'not-found' }

    if (parts.length === 2) {
        if (method === 'GET') return { verb: 'status', project }
        if (method === 'DELETE') return { verb: 'delete', project }
        return { verb: 'method-not-allowed' }
    }

    const segment = parts[2] ?? ''

    if (parts.length === 3) {
        if ((LIFECYCLE_ACTIONS as readonly string[]).includes(segment)) return only('POST', { verb: 'lifecycle', project, action: segment as LifecycleAction })
        if (segment === 'logs') return only('GET', { verb: 'logs', project })
        if (segment === 'audit') return only('GET', { verb: 'audit', project })
        if (segment === 'environments') return only('POST', { verb: 'add-environment', project })
        if (segment === 'backups') {
            if (method === 'GET') return { verb: 'backups', project }
            if (method === 'POST') return { verb: 'backup-run', project }
            return { verb: 'method-not-allowed' }
        }
        if (segment === 'settings') return only('PUT', { verb: 'settings', project })
        // Project level, not under an environment: repo is a project-level field and both environments
        // draw from the one list.
        if (segment === 'branches') return only('GET', { verb: 'branches', project })
        return { verb: 'not-found' }
    }

    if (segment === 'environments') {
        if (parts.length !== 4) return { verb: 'not-found' }
        const environment = parts[3] ?? ''
        if (!(ENVIRONMENTS as readonly string[]).includes(environment)) return { verb: 'not-found' }
        return only('DELETE', { verb: 'remove-environment', project, environment: environment as EnvironmentName })
    }

    if (segment === 'backups') {
        const next = parts[3] ?? ''
        if (parts.length === 4) {
            // Named before the hex check below, so a snapshot can never be called 'schedule'.
            if (next === 'schedule') {
                if (method === 'GET') return { verb: 'backup-schedule', project, write: false }
                if (method === 'PUT') return { verb: 'backup-schedule', project, write: true }
                return { verb: 'method-not-allowed' }
            }
            if (!SNAPSHOT_ID.test(next)) return { verb: 'not-found' }
            return only('DELETE', { verb: 'backup-delete', project, snapshot: next })
        }
        if (parts.length === 5) {
            if (next === 'runs') {
                const run = parts[4] ?? ''
                if (!RUN_ID.test(run)) return { verb: 'not-found' }
                return only('GET', { verb: 'backup-run-status', project, run })
            }
            if (!SNAPSHOT_ID.test(next) || parts[4] !== 'download') return { verb: 'not-found' }
            return only('GET', { verb: 'backup-download', project, snapshot: next })
        }
        return { verb: 'not-found' }
    }

    // Everything under one environment: the deploy actions, and /env with a path inside it.
    if ((ENVIRONMENTS as readonly string[]).includes(segment)) {
        const environment = segment as EnvironmentName
        if (parts.length === 4) {
            switch (parts[3]) {
                case 'env': return only('GET', { verb: 'env-list', project, environment })
                case 'deploy': return only('POST', { verb: 'deploy', project, environment })
                case 'rollback': return only('POST', { verb: 'rollback', project, environment })
                case 'branch': return only('PUT', { verb: 'branch', project, environment })
                case 'deploys': return only('GET', { verb: 'deploys', project, environment })
                case 'commits': return only('GET', { verb: 'commits', project, environment })
                case 'domains':
                    if (method === 'GET') return { verb: 'domains-list', project, environment }
                    if (method === 'POST') return { verb: 'domain-add', project, environment }
                    return { verb: 'method-not-allowed' }
                case 'adopt':
                    if (method === 'GET') return { verb: 'adopt-preview', project, environment }
                    if (method === 'POST') return { verb: 'adopt', project, environment }
                    return { verb: 'method-not-allowed' }
                default: return { verb: 'not-found' }
            }
        }

        // One hostname of this environment: removing it, or asking for it to be checked now. The name
        // is not validated here, only carried: the handler normalises it and answers 404 for anything
        // this environment does not actually serve, which is the same answer either way.
        if (parts[3] === 'domains') {
            const hostname = parts[4] ?? ''
            if (parts.length === 5) return only('DELETE', { verb: 'domain-remove', project, environment, hostname })
            if (parts.length === 6 && parts[5] === 'verify') return only('POST', { verb: 'domain-verify', project, environment, hostname })
            return { verb: 'not-found' }
        }
        if (parts[3] !== 'env') return { verb: 'not-found' }
        if (method !== 'GET' && method !== 'PUT') return { verb: 'method-not-allowed' }
        return { verb: 'env-file', project, environment, path: parts.slice(4).join('/') }
    }

    return { verb: 'not-found' }
}

export function parseLogsQuery(params: URLSearchParams): { ok: true, args: LogsArgs } | { ok: false, message: string } {
    const service = params.get('service')
    if (!service || !SERVICE_NAME.test(service)) return { ok: false, message: 'service is required and must be a compose service name' }

    const tailRaw = params.get('tail')
    const tail = tailRaw === null ? DEFAULT_TAIL : /^\d{1,5}$/.test(tailRaw) ? Number(tailRaw) : NaN
    if (!Number.isInteger(tail) || tail > MAX_TAIL) return { ok: false, message: `tail must be a whole number from 0 to ${MAX_TAIL}` }

    const sinceRaw = params.get('since')
    let since: number | null = null
    if (sinceRaw !== null) {
        const seconds = /^\d+(\.\d+)?$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw) / 1000
        if (!Number.isFinite(seconds) || seconds < 0) return { ok: false, message: 'since must be Unix seconds or an RFC 3339 timestamp' }
        since = seconds
    }

    const follow = parseFlag(params.get('follow'))
    if (follow === null) return { ok: false, message: 'follow must be 1 or 0' }
    return { ok: true, args: { service, tail, since, follow } }
}

// A query flag: absent means off, anything unspellable is null so the caller can refuse it rather than
// quietly reading a typo as false.
export function parseFlag(raw: string | null): boolean | null {
    if (raw === null || raw === '0' || raw === 'false') return false
    if (raw === '1' || raw === 'true') return true
    return null
}

function parseLimit(params: URLSearchParams): number | null {
    const raw = params.get('limit')
    if (raw === null) return DEFAULT_AUDIT_LIMIT
    const limit = /^\d{1,4}$/.test(raw) ? Number(raw) : 0
    return limit >= 1 && limit <= MAX_AUDIT_READ ? limit : null
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

// Reads the body with a hard cap enforced as bytes arrive, not from a trusted Content-Length: the same
// 64 KB the agent's own wire protocol allows itself, so nothing a client can post to api is bigger than
// what would reach the agent anyway. Note this bounds the whole JSON envelope, not just an env file's
// text: MAX_ENV_BYTES in envfiles.ts is also 64 KB, but of the file's raw text, and JSON-escaping that
// text (quotes, backslashes, newlines) can inflate it past this envelope cap before MAX_ENV_BYTES is
// ever checked. An admin editing a large env file hits this refusal first; its message says so.
//
// On the over-limit path this deliberately does not call req.destroy(): req and res share one socket,
// and destroying it here would destroy the response before refuseRoute ever gets to write to it,
// turning a 400 into a dead socket (at worst ERR_STREAM_DESTROYED). Removing the listeners is enough:
// once flowing (data has already been read), a Readable with no 'data' listener just discards further
// chunks instead of buffering them, so the rest of the body drains in the background while the caller
// writes its response on the still-live socket.
function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true, raw: string } | { ok: false, message: string }> {
    return new Promise(resolve => {
        const chunks: Buffer[] = []
        let bytes = 0
        let settled = false
        const finish = (result: { ok: true, raw: string } | { ok: false, message: string }) => {
            if (settled) return
            settled = true
            req.off('data', onData)
            req.off('end', onEnd)
            req.off('error', onError)
            // A no-op listener stays attached for the life of the drain below: with none at all, an
            // aborted request emitting 'error' while nothing is listening is unhandled, and Node throws.
            req.on('error', () => {})
            resolve(result)
        }
        const onData = (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > maxBytes) {
                finish({ ok: false, message: `the request body must be ${maxBytes} bytes (${Math.floor(maxBytes / 1024)} KB) or fewer` })
                return
            }
            chunks.push(chunk)
        }
        const onEnd = () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') })
        const onError = () => finish({ ok: false, message: 'the request body could not be read' })
        req.on('data', onData)
        req.on('end', onEnd)
        req.on('error', onError)
    })
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, message: string }> {
    const body = await readBody(req, maxBytes)
    if (!body.ok) return body
    if (body.raw === '') return { ok: false, message: 'a request body is required' }
    let parsed: unknown
    try {
        parsed = JSON.parse(body.raw)
    } catch {
        return { ok: false, message: 'the request body is not JSON' }
    }
    if (!isRecord(parsed)) return { ok: false, message: 'the request body must be a JSON object' }
    return { ok: true, value: parsed }
}

function parseCreateBody(value: Record<string, unknown>): { ok: true, args: ProvisionCreateArgs } | { ok: false, message: string } {
    if (!onlyKeys(value, ['id', 'client', 'name', 'repo', 'credential', 'branch', 'domain', 'certificate'])) {
        return { ok: false, message: 'create takes only id, client, name, repo, credential, branch, domain and certificate' }
    }
    // Validated against the same grammar as everywhere else an id is trusted, not just typeof: an
    // unvalidated id is what would otherwise end up as the project field of an audit entry below.
    if (typeof value.id !== 'string' || !PROJECT_ID.test(value.id)) return { ok: false, message: 'id is malformed' }
    if (typeof value.client !== 'string' || !CLIENT_ID.test(value.client)) return { ok: false, message: 'client is malformed' }
    if (typeof value.name !== 'string') return { ok: false, message: 'name is malformed' }
    if (typeof value.repo !== 'string') return { ok: false, message: 'repo is malformed' }
    if (value.credential !== undefined && (typeof value.credential !== 'string' || !CREDENTIAL_NAME.test(value.credential))) {
        return { ok: false, message: 'credential must be 1 to 32 lowercase letters, digits or underscores' }
    }
    if (typeof value.branch !== 'string') return { ok: false, message: 'branch is malformed' }
    const domain = value.domain
    if (domain !== null && typeof domain !== 'string') return { ok: false, message: 'domain is malformed' }
    const certificate = value.certificate
    if (certificate !== null && !(CERTIFICATE_MODES as readonly string[]).includes(certificate as string)) return { ok: false, message: 'certificate is malformed' }
    return {
        ok: true,
        args: {
            action: 'create', id: value.id, client: value.client, name: value.name, repo: value.repo,
            ...(value.credential === undefined ? {} : { credential: value.credential as string }),
            branch: value.branch,
            domain: domain as string | null, certificate: certificate as CertificateMode | null,
        },
    }
}

function parseAddEnvironmentBody(value: Record<string, unknown>): { ok: true, args: ProvisionAddEnvironmentArgs } | { ok: false, message: string } {
    if (!onlyKeys(value, ['branch', 'domain', 'certificate'])) {
        return { ok: false, message: 'add-environment takes only branch, domain and certificate' }
    }
    if (typeof value.branch !== 'string') return { ok: false, message: 'branch is malformed' }
    const domain = value.domain
    if (domain !== null && typeof domain !== 'string') return { ok: false, message: 'domain is malformed' }
    const certificate = value.certificate
    if (certificate !== null && !(CERTIFICATE_MODES as readonly string[]).includes(certificate as string)) return { ok: false, message: 'certificate is malformed' }
    return { ok: true, args: { action: 'add-environment', environment: 'test', branch: value.branch, domain: domain as string | null, certificate: certificate as CertificateMode | null } }
}

// Shared by both delete routes: the whole-project one and the single-environment one. Typing the name
// back is the only thing standing between a stray click and an irreversible-looking unregister, so a
// missing or mismatched name refuses before the agent ever hears about it.
function parseConfirmBody(value: Record<string, unknown>): { ok: true, name: string } | { ok: false, message: string } {
    if (!onlyKeys(value, ['name'])) return { ok: false, message: 'delete takes only name' }
    if (typeof value.name !== 'string') return { ok: false, message: 'name is malformed' }
    return { ok: true, name: value.name }
}

function parseBranchBody(value: Record<string, unknown>): { ok: true, branch: string } | { ok: false, message: string } {
    if (!onlyKeys(value, ['branch'])) return { ok: false, message: 'switching branch takes only branch' }
    // The grammar itself is checked by the agent and again by the registry writer, which is where the one
    // rule about what a branch may be lives; this only refuses a shape the agent could not read.
    if (typeof value.branch !== 'string') return { ok: false, message: 'branch is malformed' }
    return { ok: true, branch: value.branch }
}

// Bounded far below the audit log's own limit: this is a page of a commit list, not an export.
function parseCommitsLimit(params: URLSearchParams): number | null {
    const raw = params.get('limit')
    if (raw === null) return DEFAULT_COMMITS
    const limit = /^\d{1,4}$/.test(raw) ? Number(raw) : 0
    return limit >= 1 && limit <= MAX_COMMITS ? limit : null
}

// Normalised here rather than merely type-checked: normaliseHostname is the one thing in hostd that
// decides what a hostname is, and the name this returns is what goes into the registry, into the vhost
// and into the domain record's key, so all three agree on one spelling of it.
function parseHostnameBody(value: Record<string, unknown>): { ok: true, hostname: string } | { ok: false, message: string } {
    if (!onlyKeys(value, ['hostname'])) return { ok: false, message: 'adding a domain takes only hostname' }
    const hostname = normaliseHostname(value.hostname)
    if (hostname === null) return { ok: false, message: 'hostname must be a hostname, with no scheme, port or path' }
    return { ok: true, hostname }
}

// Adoption replaces a file that is serving a live site right now, so it asks for the same confirmation
// a delete does: the project's name, typed back.
function parseAdoptBody(value: Record<string, unknown>): { ok: true, confirm: string } | { ok: false, message: string } {
    if (!onlyKeys(value, ['confirm'])) return { ok: false, message: 'adopting takes only confirm' }
    if (typeof value.confirm !== 'string') return { ok: false, message: 'confirm is malformed' }
    return { ok: true, confirm: value.confirm }
}

// Ten minutes. Long enough that an idle hostd with nothing to change is not perpetually unhealthy, short
// enough that a unit which died this morning is named before the day's first domain action hangs on it.
// Exported so the agent's own end of this figure can be tested against the threshold it is read with:
// the two live in different processes, and what went wrong here once was that they disagreed about
// whether railAge was an age or a timestamp, which no test on either side alone could see.
export const RAIL_STALE_MS = 10 * 60_000

// Named once, listing the environments, rather than once per hostname: a site with three aliases would
// otherwise produce three copies of the same sentence about the same certificate.
function environmentsAwaitingCertbot(registry: Registry): string[] {
    const waiting: string[] = []
    for (const project of registry.projects.values()) {
        if (!project.capabilities.has('domains')) continue
        for (const environment of project.environments.values()) {
            if (environment.certificate === 'letsencrypt') waiting.push(`${project.id} ${environment.name}`)
        }
    }
    return waiting
}

function parseEnvWriteBody(value: Record<string, unknown>): { ok: true, text: string } | { ok: false, message: string } {
    if (!onlyKeys(value, ['text'])) return { ok: false, message: 'writing an env file takes only text' }
    if (typeof value.text !== 'string') return { ok: false, message: 'text is malformed' }
    return { ok: true, text: value.text }
}

// One project's environments as this actor may see them, live first, then test. Answered from the
// registry rather than the agent, because the registry is what knows them and api is the only process
// that knows who is asking.
//
// The operator sees the entry as it is: they own the machine. A client sees their own site and nothing
// about the machine underneath it, so dir and composePaths (paths on the dedi) and port (a host port)
// are left out entirely rather than nulled, which is also what makes them absent once this is JSON.
// branch does go to a client: the deploy-read policy verb already lets them read that branch's deploy
// history and its commit list for their own site, so withholding the name here would protect nothing,
// and switching it stays admin-only either way. The portal deciding not to show a client a branch is a
// question for the portal's own copy, not a reason for this to lie about the site.
//
// A project registered in the single-environment shape (dir and upstream, no environments block) still
// has exactly one live environment here: parseRegistry synthesises it, with nulls for the fields that
// shape cannot carry. There is no such thing as a valid project with no environments.
function environmentsFor(project: ProjectEntry, actor: Actor): Array<Record<string, unknown>> {
    return [...project.environments.values()].map(environment => ({
        name: environment.name,
        ...(actor.kind === 'admin'
            ? { dir: environment.dir, composePaths: environment.composePaths, port: environment.port }
            : {}),
        branch: environment.branch,
        domain: environment.domain,
        certificate: environment.certificate,
        websockets: environment.websockets,
        deployed: environment.deployed,
    }))
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
}

function waitForDrain(res: ServerResponse): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            res.off('drain', done)
            res.off('close', done)
            resolve()
        }
        res.on('drain', done)
        res.on('close', done)
    })
}

export function createHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
    const now = deps.now ?? Date.now

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const started = now()
        const url = new URL(req.url ?? '/', 'http://hostd')
        const route = matchRoute(req.method ?? 'GET', url.pathname)

        const audit = (
            who: { actor: string, user: string },
            fields: { project: string | null, verb: string, target: string | null, outcome: AuditOutcome, reason?: string, output?: string },
        ) => deps.audit.append({ ts: new Date(started).toISOString(), ...who, durationMs: now() - started, ...fields })

        const auth = authenticate(req.headers, deps.token)
        if (!auth.ok) {
            await audit({ actor: auth.label, user: auth.user }, { project: null, verb: route.verb, target: url.pathname.slice(0, 200), outcome: 'refused', reason: auth.code })
            return sendJson(res, auth.status, { ok: false, code: auth.code, message: auth.message })
        }
        const caller: Caller = auth.caller
        const who = { actor: actorLabel(caller.actor), user: caller.user }

        const refuseRoute = async (status: number, code: string, message: string, project: string | null, verb: string, target: string | null = null) => {
            await audit(who, { project, verb, target, outcome: 'refused', reason: code })
            sendJson(res, status, { ok: false, code, message })
        }

        // The policy check every project route runs first: refuses and audits exactly like refuseRoute
        // when the actor may not do this at all, otherwise hands back the project entry the routes that
        // need one (a delete needs its name; provision's create has none to look up in the first place,
        // see the 'create' case below).
        const authorizeProject = async (project: string, verb: PolicyVerb, target: string | null): Promise<ProjectEntry | null> => {
            const decision = authorize(deps.registry(), caller.actor, project, verb)
            if (!decision.ok) {
                await refuseRoute(decision.status, decision.code, decision.message, project, verb, target)
                return null
            }
            return decision.project
        }

        const decide = async (project: string, verb: PolicyVerb, target: string | null) => (await authorizeProject(project, verb, target)) !== null

        const callAgent = async (request: AgentRequest): Promise<AgentReply | null> => {
            try {
                return await deps.agent.call(request)
            } catch (error) {
                if (!(error instanceof AgentUnavailableError)) throw error
                sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                return null
            }
        }

        // provision and env are both mutations (or, for env, a read of something secret-adjacent), so
        // unlike plain status reads a dropped agent connection here is audited, the same way lifecycle
        // and logs already audit it.
        const callAgentAudited = async (request: AgentRequest, project: string, verb: string, target: string | null): Promise<AgentReply | null> => {
            try {
                return await deps.agent.call(request)
            } catch (error) {
                if (!(error instanceof AgentUnavailableError)) throw error
                await audit(who, { project, verb, target, outcome: 'failed', reason: error.message })
                sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                return null
            }
        }

        // provision and env share one reply shape at the HTTP boundary: an ok reply passes straight
        // through and is audited as ok, a refusal maps through AGENT_STATUS and is audited as failed or
        // refused. Neither ever puts the agent's reply body itself into the audit entry, only the
        // target and (on a refusal) the code or message, so an env file's text can only ever reach the
        // caller's own response, never the audit trail.
        //
        // refreshRegistry is true only for a reply from a write that just changed the registry file
        // synchronously: provision, configure, and the branch switch (which is audited under the
        // 'deploy' verb, like deploy and rollback, but unlike them writes the registry before it answers
        // rather than minutes afterwards). It is false for env, which never touches the registry, and
        // for starting a deploy or rollback, which answer the instant the work begins while `deployed`
        // is only written once it finishes: refreshing then would just re-read the copy this request
        // already has. Each call site below says which it is.
        //
        // Only runs on the ok path, and only after the audit: a refusal must never refresh (nothing
        // changed), and the write already happened, so a refresh failure is logged and swallowed rather
        // than turned into an error response for a save that in fact succeeded.
        // backup is false for the same reason env is: a backup run or delete changes the repository on
        // the backup disk, never the registry file.
        //
        // `after` is bookkeeping this process owns that has to happen on the ok path once the registry is
        // level again, and only configure passes one (see the settings case). Swallowed and logged exactly
        // like the refresh above and for the same reason: the write it follows has already happened, so
        // failing the response would tell the caller a save did not happen when it did.
        const respondAgentAction = async (
            verb: 'provision' | 'env' | 'deploy' | 'backup' | 'configure',
            reply: AgentReply, project: string, target: string, refreshRegistry: boolean,
            after?: () => Promise<void>,
        ) => {
            if (reply.ok) {
                await audit(who, { project, verb, target, outcome: 'ok' })
                if (refreshRegistry) {
                    try {
                        await deps.refreshRegistry()
                    } catch (error) {
                        console.error(`[api] ${new Date().toISOString()} registry refresh after ${verb} ${target} failed: ${describeError(error)}`)
                    }
                }
                if (after) {
                    try {
                        await after()
                    } catch (error) {
                        console.error(`[api] ${new Date().toISOString()} domain state after ${verb} ${target} failed: ${describeError(error)}`)
                    }
                }
                return sendJson(res, 200, reply)
            }
            const outcome: AuditOutcome = reply.code === 'failed' ? 'failed' : 'refused'
            await audit(who, { project, verb, target, outcome, reason: outcome === 'failed' ? reply.message : reply.code })
            return sendJson(res, AGENT_STATUS[reply.code], reply)
        }

        // Shared by DELETE /projects/:id (environment null, the whole project) and
        // DELETE /projects/:id/environments/:env (one environment): the confirmation is the safety
        // mechanism of both, so it lives in exactly one place rather than two copies that could drift.
        const removeProject = async (project: string, environment: EnvironmentName | null): Promise<void> => {
            const target = environment ? `${project} remove ${environment}` : `${project} remove`
            const entry = await authorizeProject(project, 'provision', target)
            if (!entry) return

            const body = await readJsonBody(req, MAX_REQUEST_BYTES)
            if (!body.ok) return refuseRoute(400, 'bad-request', body.message, project, 'provision', target)
            const parsed = parseConfirmBody(body.value)
            if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, project, 'provision', target)
            if (parsed.name !== entry.name) {
                return refuseRoute(400, 'bad-request', 'name must match the project name to confirm deletion', project, 'provision', target)
            }

            const reply = await callAgentAudited({ verb: 'provision', project, args: { action: 'remove', environment } }, project, 'provision', target)
            if (!reply) return
            return respondAgentAction('provision', reply, project, target, true)
        }

        // Deploy, rollback and branch all start work on the operator's behalf, so all three are
        // admin-only (the 'deploy' policy verb) and all three are audited, refusals included. The
        // target says which environment, because live and test are different sites.
        //
        // Neither deploy nor rollback refreshes the registry: deploy-runner.ts answers the instant the
        // deploy starts, and `deployed` is only written once it finishes, minutes later, long after this
        // reply is on the wire. A refresh here would just re-read the copy this request already has. The
        // branch switch below is different: it writes the registry before it answers, so it does refresh.
        const startDeploy = async (
            project: string, target: string, args: Extract<AgentRequest, { verb: 'deploy' }>['args'],
        ): Promise<void> => {
            const entry = await authorizeProject(project, 'deploy', target)
            if (!entry) return
            const reply = await callAgentAudited({ verb: 'deploy', project, args }, project, 'deploy', target)
            if (!reply) return
            return respondAgentAction('deploy', reply, project, target, false)
        }

        // The history and the commit list are plain reads, and the owner may make them: audited only
        // when they are refused, exactly like status.
        const readDeploy = async (
            project: string, target: string, args: Extract<AgentRequest, { verb: 'deploy' }>['args'],
        ): Promise<void> => {
            if (!(await decide(project, 'deploy-read', target))) return
            const reply = await callAgent({ verb: 'deploy', project, args })
            if (!reply) return
            if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, project, 'deploy', target)
            return sendJson(res, 200, reply)
        }

        // Everything under /domains and /adopt needs the environment as the registry has it: the alias
        // list a change is applied to, the primary a client may not take away, and the certificate mode
        // the answer joins on. An environment the registry does not have is refused here rather than by
        // the agent, because there is nothing to ask about.
        const domainEnvironment = async (
            project: string, environment: EnvironmentName, verb: PolicyVerb, target: string,
        ): Promise<{ entry: ProjectEntry, environment: EnvironmentEntry } | null> => {
            const entry = await authorizeProject(project, verb, target)
            if (!entry) return null
            const found = entry.environments.get(environment)
            if (!found) {
                await refuseRoute(404, 'unknown-environment', `${project} has no ${environment} environment`, project, 'domains', target)
                return null
            }
            return { entry, environment: found }
        }

        // One token per ENVIRONMENT, never one per hostname. agent/vhost.ts renders a single token into
        // the <Location> blocks of a vhost that serves the primary and every alias, so every hostname of
        // the environment has to prove itself against that one value; a token minted per hostname would
        // leave every alias failing against a vhost carrying only the primary's, which looks exactly like
        // a DNS fault and gets debugged in the wrong place. It is still stored per record, so the
        // verifier can read a token without a join. An existing one is reused rather than replaced:
        // rewriting the vhost with a fresh token would invalidate a verification already in flight.
        //
        // A newly minted one is written to the store before it is returned, and that is what makes the
        // adopt preview byte-accurate on a FIRST adoption, which is every one of the five live sites.
        // Minting without persisting meant GET /adopt rendered the file with one token and POST /adopt
        // wrote it with another, so the file the operator read and confirmed differed from the file that
        // was put down, in all four of its security-relevant lines.
        const tokenFor = async (project: string, environment: EnvironmentName): Promise<string> => {
            const records = deps.domains.forEnvironment(project, environment)
            const existing = records.find(record => record.token !== null)?.token
            if (existing != null) return existing
            const token = newToken()
            for (const record of records) await deps.domains.put({ ...record, token })
            return token
        }

        // What a written vhost does to the records behind it. The hostnames named here start their 72
        // hour countdown; the rest only pick up the token, because rewriting the vhost proves nothing new
        // about a hostname that was already answering.
        //
        // firstSeenAt moves to now along with the state, which is not redundant: a record the registry
        // has named for days carries an old one, and pending is measured from firstSeenAt, so leaving it
        // alone would fail the hostname on its very first check. The same trap verifier.ts's checkNow
        // documents for reviving a failed record.
        const recordWritten = async (
            project: string, environment: EnvironmentName, token: string, pending: string[], primary: string | null,
        ): Promise<void> => {
            const stamp = new Date(now()).toISOString()
            const existing = new Map(deps.domains.forEnvironment(project, environment).map(record => [record.hostname, record]))
            for (const hostname of pending) {
                const record = existing.get(hostname) ?? newRecord(project, environment, hostname, hostname === primary, stamp)
                existing.delete(hostname)
                await deps.domains.put({ ...record, state: 'pending', token, error: null, attempts: 0, firstSeenAt: stamp })
            }
            for (const record of existing.values()) {
                if (record.token === token) continue
                await deps.domains.put({ ...record, token })
            }
        }

        // What configure did to Apache, written down here rather than left to be guessed at.
        //
        // When an environment's address moves onto a vhost hostd already owns, the agent rewrites that
        // file and says which hostnames it now serves. Without this the moved hostname would only reach
        // the store through reconcile, as an unmanaged record with no token, which is the store's way of
        // saying "hostd has written no vhost for this name". It just did. The row would read as a
        // hand-served site, "Check again" would do nothing (the verifier skips a record with no token),
        // and the operator's only way out would be the adopt button on a site with nothing to adopt.
        //
        // EVERYTHING this needs out of the store is read BEFORE reconcile, and that ordering is the whole
        // of it. reconcile deletes the records of hostnames the registry no longer names, which is exactly
        // the address that just moved away, and on an environment with no aliases that record is the only
        // place the environment's token lives. Read the token afterwards and it is already gone, so the
        // moved hostname stays unmanaged with no token: the very fault this exists to prevent, in the one
        // shape every site on this machine is in today. The same goes for which hostnames were already
        // being served, which is decided from the records as they were before any of this ran.
        //
        // reconcile then runs before the records are written rather than after. Either order leaves the
        // same records behind (it adds what the registry names, deletes what it does not, and never
        // touches a record that already exists), but running it first takes the old hostname away now
        // instead of ten seconds from now, so the very next request does not show two primaries.
        const recordConfigured = async (project: string, reply: AgentReply): Promise<void> => {
            if (!reply.ok) return
            const rewritten = 'written' in reply && Array.isArray(reply.written) ? reply.written : []

            // The token the environment already has, and never a fresh one, which is why tokenFor is not
            // used here: the agent rewrote that file with the token it already carried, so minting another
            // would leave the verifier probing for a value Apache does not serve and failing a site that
            // is working perfectly well. An environment with no token to be found is left out below, since
            // this process cannot prove anything about those names and saying so beats saying the wrong
            // thing.
            const tokens = new Map<EnvironmentName, string>()
            // And which hostnames hostd was already serving. Anything else starts its 72 hour countdown;
            // these do not, because the rewrite kept the token, so an alias that was answering a moment
            // ago still is and has nothing new to prove. Making it pending would put "not verified yet" on
            // a client's screen for a name that never stopped working.
            const already = new Map<EnvironmentName, Set<string>>()
            for (const wrote of rewritten) {
                const records = deps.domains.forEnvironment(project, wrote.environment)
                const token = records.find(record => record.token !== null)?.token
                if (token != null) tokens.set(wrote.environment, token)
                already.set(wrote.environment, new Set(
                    records.filter(record => record.state !== 'unmanaged').map(record => record.hostname),
                ))
            }

            // On every configure that came back ok, not only one that rewrote a vhost: an address that
            // moved on an environment hostd does NOT serve still changes which hostnames should have
            // records, and it is worth being right about that now rather than within ten seconds. It
            // writes nothing when nothing changed, which is what a routine capability save is.
            await deps.domains.reconcile(deps.registry(), new Date(now()).toISOString())

            for (const wrote of rewritten) {
                const token = tokens.get(wrote.environment)
                if (token === undefined) continue
                const served = already.get(wrote.environment) ?? new Set<string>()
                const fresh = wrote.hostnames.filter(hostname => !served.has(hostname))
                // The registry, which reconcile does not touch, so this one is safe to read here.
                const entry = deps.registry().projects.get(project)?.environments.get(wrote.environment)
                await recordWritten(project, wrote.environment, token, fresh, entry?.domain ?? null)
            }
        }

        // One environment's hostnames as this actor may see them. The certificate mode is joined on from
        // the registry entry, which holds the only copy of it: it belongs to the environment rather than
        // to any one hostname, and domain state has no business keeping a second copy that could drift.
        // vhost.output is Apache's own words about a configuration it refused, so it goes to the operator
        // and not to a client. The token goes to nobody at all: it belongs to the vhost, and hostd is the
        // only thing with any use for it.
        const domainsFor = (entry: ProjectEntry, environment: EnvironmentEntry): Array<Record<string, unknown>> =>
            deps.domains.forEnvironment(entry.id, environment.name).map(record => ({
                hostname: record.hostname,
                primary: record.primary,
                state: record.state,
                certificate: environment.certificate,
                checkedAt: record.checkedAt,
                error: record.error,
                vhost: record.vhost === null ? null
                    : caller.actor.kind === 'admin' ? record.vhost : { ok: record.vhost.ok },
            }))

        // What the last vhost write did to this environment, stamped on every record of it. The agent
        // carries Apache's own words back on a refusal and then puts the previous file in place itself,
        // so this is the only record anything keeps of a write that was rolled back: the /health alarm
        // the design names, the operator's "what Apache said" pane, and needsYou's second branch all
        // read it, and all three were unreachable while nothing ever wrote it. Cleared on the next write
        // that succeeds, because the rollback is then over and the alarm should go with it.
        const recordVhost = async (project: string, environment: EnvironmentName, vhost: DomainRecord['vhost']): Promise<void> => {
            for (const record of deps.domains.forEnvironment(project, environment)) {
                if (record.vhost === null && vhost === null) continue
                await deps.domains.put({ ...record, vhost })
            }
        }

        const refuseDomains = async (reply: Refusal, project: string, target: string) => {
            const outcome: AuditOutcome = reply.code === 'failed' ? 'failed' : 'refused'
            await audit(who, { project, verb: 'domains', target, outcome, reason: outcome === 'failed' ? reply.message : reply.code })
            return sendJson(res, AGENT_STATUS[reply.code], reply)
        }

        // Every domain change answers the same thing: the environment's list as it now stands, which is
        // what the panel redraws from. `record` runs only on an ok reply, because nothing was written to
        // the host when the agent refused, and a record saying otherwise would be a lie the verifier then
        // spends 72 hours trying to prove.
        const respondDomains = async (
            reply: AgentReply, entry: ProjectEntry, environment: EnvironmentEntry, target: string, record: () => Promise<void>,
        ) => {
            if (!reply.ok) {
                // Only 'failed' means the host was reached and Apache refused what it was given; every
                // other code is a refusal before anything was written, and saying a vhost was rolled
                // back about one of those would raise an alarm about a file nothing touched.
                if (reply.code === 'failed') await recordVhost(entry.id, environment.name, { ok: false, output: reply.output ?? '' })
                return refuseDomains(reply, entry.id, target)
            }
            await record()
            await recordVhost(entry.id, environment.name, null)
            await audit(who, { project: entry.id, verb: 'domains', target, outcome: 'ok' })
            return sendJson(res, 200, { ok: true, domains: domainsFor(entry, environment) })
        }

        switch (route.verb) {
            case 'not-found':
                return refuseRoute(404, 'not-found', 'no such route', null, 'unknown', url.pathname.slice(0, 200))

            case 'method-not-allowed':
                return refuseRoute(405, 'method-not-allowed', `${req.method} is not allowed here`, null, 'unknown', url.pathname.slice(0, 200))

            case 'list': {
                // Off by default, so this stays the cheap listing every other caller wants: names, and
                // whether an entry is valid, without a Docker read per project. The dashboard, which
                // draws a live badge per site, asks for status=1 and gets the lot in this one request
                // instead of one more request per site.
                const wantStatus = parseFlag(url.searchParams.get('status'))
                if (wantStatus === null) return refuseRoute(400, 'bad-request', 'status must be 1 or 0', null, 'list')

                const health = await callAgent({ verb: 'health' })
                if (!health) return
                const invalid = health.ok && 'invalid' in health ? health.invalid : {}
                const registry = deps.registry()
                const entries = visibleProjects(registry, caller.actor)

                // Asked for by id, and only for the projects this actor can already see: the agent has no
                // idea who is asking, so nothing here may widen what the list itself shows.
                let statuses: Map<string, ProjectStatus> | null = null
                if (wantStatus && entries.length > 0) {
                    const reply = await callAgent({ verb: 'statuses', projects: entries.map(project => project.id) })
                    if (!reply) return
                    if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, null, 'list')
                    statuses = new Map(('projects' in reply ? reply.projects : []).map(status => [status.project, status]))
                }
                // The id is already the entry's own field, so the copy inside the agent's answer is
                // dropped rather than repeated.
                const statusOf = (id: string): Record<string, unknown> => {
                    const found = statuses?.get(id)
                    if (!found) return { status: { ok: false, code: 'failed', message: `the agent returned no status for ${id}` } }
                    const { project: _id, ...status } = found
                    return { status }
                }

                const projects: Array<Record<string, unknown>> = entries.map(project => {
                    const reason = Object.hasOwn(invalid, project.id) ? invalid[project.id] : undefined
                    return {
                        id: project.id,
                        name: project.name,
                        capabilities: [...project.capabilities],
                        // The operator sees the entry as it is: they own the machine. A client has no use
                        // for the URL of a repository they cannot reach, and it is the kind of detail that
                        // belongs to the machine rather than to their site, so it is absent rather than
                        // null, exactly as environmentsFor withholds dir, composePaths and port.
                        ...(caller.actor.kind === 'admin' ? { repo: project.repo, credential: project.credential } : {}),
                        environments: environmentsFor(project, caller.actor),
                        valid: reason === undefined,
                        ...(reason === undefined ? {} : { reason }),
                        ...(wantStatus ? statusOf(project.id) : {}),
                    }
                })
                if (caller.actor.kind === 'admin') {
                    // An entry the registry itself could not parse has no services to ask about, and the
                    // agent would only refuse it, so its reason is answered from here.
                    for (const [id, reason] of registry.invalid) {
                        projects.push({
                            id, valid: false, reason,
                            ...(wantStatus ? { status: { ok: false, code: 'invalid-project', message: `${id} is invalid: ${reason}` } } : {}),
                        })
                    }
                }
                return sendJson(res, 200, { ok: true, projects })
            }

            case 'health': {
                // Admin only: these are the operator's figures for the whole machine, and they say
                // nothing about any one client's site.
                if (caller.actor.kind !== 'admin') return refuseRoute(403, 'admin-only', 'only the admin can read hostd\'s health', null, 'health')
                const reply = await callAgent({ verb: 'health' })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, null, 'health')
                // railAge is carried by the health reply and by nothing else, so it is what narrows this
                // to one: an agent that answered a health request with something else is a failure, not
                // a reading of the machine.
                if (!('railAge' in reply)) return refuseRoute(502, 'failed', 'the agent did not answer the health request with health', null, 'health')

                // Everything the agent could not see. Domain state lives in api, so these four warnings
                // can only be added here, on top of the agent's own.
                const warnings = [...reply.warnings]
                // A rolled-back vhost is recorded on every record of the environment, because the file
                // is the environment's rather than any one hostname's. Collected and said once, for the
                // same reason the Let's Encrypt line below is: a site with three aliases would
                // otherwise repeat one sentence about one file three times.
                const rolledBack = new Set<string>()
                for (const record of deps.domains.all()) {
                    if (record.state === 'broken') warnings.push(`${record.hostname} stopped answering (${record.project} ${record.environment})`)
                    if (record.vhost && !record.vhost.ok) rolledBack.add(`${record.project} ${record.environment}`)
                }
                for (const environment of rolledBack) warnings.push(`the vhost for ${environment} was rolled back`)
                // An environment set to letsencrypt is serving the Origin certificate until 4b lands. Said once,
                // naming the environments, rather than once per hostname.
                const waiting = environmentsAwaitingCertbot(deps.registry())
                if (waiting.length) warnings.push(`waiting for Let's Encrypt support: ${waiting.join(', ')}`)
                // The rail not answering means no domain action can work at all, and every one of them will look
                // like a hang rather than a failure until somebody tries one. railAge comes off the agent's health
                // reply (Task 10), because lastSuccessAt lives in the agent and only api serves /health.
                if (reply.railAge === null || reply.railAge > RAIL_STALE_MS) {
                    warnings.push('the Apache host unit has not answered; no domain change can take effect')
                }
                return sendJson(res, 200, { ...reply, warnings })
            }

            case 'audit-all': {
                if (caller.actor.kind !== 'admin') return refuseRoute(403, 'admin-only', 'only the admin can read the whole audit log', null, 'audit')
                const limit = parseLimit(url.searchParams)
                if (limit === null) return sendJson(res, 400, { ok: false, code: 'bad-request', message: `limit must be 1 to ${MAX_AUDIT_READ}` })
                return sendJson(res, 200, { ok: true, events: await deps.audit.read({ limit }) })
            }

            case 'credentials': {
                // Gated like audit-all rather than through authorize: there is no project in this
                // question, so there is no ownership to decide. The list fills the Settings form, which
                // is the operator's alone end to end.
                if (caller.actor.kind !== 'admin') return refuseRoute(403, 'admin-only', 'only the admin can read the credential list', null, 'configure')
                const reply = await callAgent({ verb: 'credentials' })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, null, 'configure')
                return sendJson(res, 200, reply)
            }

            case 'audit': {
                if (!(await decide(route.project, 'audit', null))) return
                const limit = parseLimit(url.searchParams)
                if (limit === null) return sendJson(res, 400, { ok: false, code: 'bad-request', message: `limit must be 1 to ${MAX_AUDIT_READ}` })
                return sendJson(res, 200, { ok: true, events: await deps.audit.read({ project: route.project, limit }) })
            }

            case 'status': {
                // The one page about one site asks here, so the environments ride along with the
                // services rather than making that page fetch the whole list to find them again. The
                // services come from the agent and the environments from the registry: two sources, one
                // answer, which is api's job and nothing the agent could do for itself.
                const project = await authorizeProject(route.project, 'status', null)
                if (!project) return
                const reply = await callAgent({ verb: 'status', project: route.project })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, route.project, 'status')
                return sendJson(res, 200, { ...reply, environments: environmentsFor(project, caller.actor) })
            }

            case 'create': {
                // There is no existing project for authorize() to look up (the id has not been claimed
                // yet), so the ownership machinery in policy.ts does not apply here: the rule is simply
                // that only the admin may provision at all, the same admin-only rule authorize() applies
                // to every other provision and env request.
                if (caller.actor.kind !== 'admin') return refuseRoute(404, 'not-found', 'no such route', null, 'provision', null)

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, null, 'provision', null)
                const parsed = parseCreateBody(body.value)
                if (!parsed.ok) {
                    const id = typeof body.value.id === 'string' && PROJECT_ID.test(body.value.id) ? body.value.id : null
                    return refuseRoute(400, 'bad-request', parsed.message, id, 'provision', null)
                }

                const target = `${parsed.args.id} create`
                const reply = await callAgentAudited({ verb: 'provision', args: parsed.args }, parsed.args.id, 'provision', target)
                if (!reply) return
                return respondAgentAction('provision', reply, parsed.args.id, target, true)
            }

            case 'delete':
                return removeProject(route.project, null)

            case 'add-environment': {
                const target = `${route.project} add-environment`
                const project = await authorizeProject(route.project, 'provision', target)
                if (!project) return

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, route.project, 'provision', target)
                const parsed = parseAddEnvironmentBody(body.value)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, route.project, 'provision', target)

                const reply = await callAgentAudited(
                    { verb: 'provision', project: route.project, args: parsed.args },
                    route.project, 'provision', target,
                )
                if (!reply) return
                return respondAgentAction('provision', reply, route.project, target, true)
            }

            case 'remove-environment':
                return removeProject(route.project, route.environment)

            case 'settings': {
                const target = 'settings'
                const entry = await authorizeProject(route.project, 'configure', target)
                if (!entry) return

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, route.project, 'configure', target)
                // Shapes and grammar both live in parseConfigureArgs, the agent's own body parser: this
                // just bridges its Refusal onto the { ok: false, message } shape the other body parsers
                // in this file use, so writing a second copy of the same checks is not needed here.
                const args = parseConfigureArgs(body.value)
                if ('ok' in args) return refuseRoute(400, 'bad-request', args.message, route.project, 'configure', target)

                const reply = await callAgentAudited({ verb: 'configure', project: route.project, args }, route.project, 'configure', target)
                if (!reply) return
                // After the registry refresh, because reconcile inside this reads the registry to decide
                // which hostnames should have records at all.
                return respondAgentAction('configure', reply, route.project, target, true,
                    () => recordConfigured(route.project, reply))
            }

            case 'branches': {
                // Reuses 'configure' rather than a new policy verb: admin-only with a deliberately null
                // capability, which is right here for the same reason it is right there. The list fills
                // the operator's Settings form; a client has no use for it, and requiring the deploy
                // capability would leave the dropdown empty on exactly the site an operator is setting
                // deploys up on.
                const target = 'branches'
                const entry = await authorizeProject(route.project, 'configure', target)
                if (!entry) return
                const reply = await callAgent({ verb: 'branches', project: route.project })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, route.project, 'configure', target)
                return sendJson(res, 200, reply)
            }

            case 'env-list': {
                const target = route.environment
                const project = await authorizeProject(route.project, 'env', target)
                if (!project) return

                const reply = await callAgentAudited(
                    { verb: 'env', project: route.project, args: { action: 'list', environment: route.environment } },
                    route.project, 'env', target,
                )
                if (!reply) return
                return respondAgentAction('env', reply, route.project, target, false)
            }

            case 'env-file': {
                // Includes the environment, not just the path: this is the audit trail for access to
                // secrets, and 'live' and 'test' each have their own .env, so the target has to say
                // which one, the same way env-list's target (just the environment) reads as one
                // namespace with this one. Truncated the same way 'not-found' already truncates a raw
                // pathname, since route.path comes straight from the URL.
                const target = `${route.environment}/${route.path}`.slice(0, 200)
                const project = await authorizeProject(route.project, 'env', target)
                if (!project) return

                // Lexical only, same as envfiles.ts's own comment says: the agent checks the same path
                // again itself, against the real filesystem, once it knows which environment folder it
                // resolves relative to. That is not duplication to remove, it is the only place a
                // symlink planted inside the environment folder can be caught.
                const pathProblem = envPathProblem(route.path)
                if (pathProblem) return refuseRoute(400, 'bad-request', pathProblem, route.project, 'env', target)

                if (req.method === 'GET') {
                    const reply = await callAgentAudited(
                        { verb: 'env', project: route.project, args: { action: 'read', environment: route.environment, path: route.path } },
                        route.project, 'env', target,
                    )
                    if (!reply) return
                    return respondAgentAction('env', reply, route.project, target, false)
                }

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, route.project, 'env', target)
                const parsed = parseEnvWriteBody(body.value)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, route.project, 'env', target)

                const reply = await callAgentAudited(
                    { verb: 'env', project: route.project, args: { action: 'write', environment: route.environment, path: route.path, text: parsed.text } },
                    route.project, 'env', target,
                )
                if (!reply) return
                return respondAgentAction('env', reply, route.project, target, false)
            }

            case 'deploy':
                return startDeploy(route.project, `${route.environment} deploy`, { action: 'deploy', environment: route.environment })

            case 'rollback':
                return startDeploy(route.project, `${route.environment} rollback`, { action: 'rollback', environment: route.environment })

            case 'branch': {
                const target = `${route.environment} branch`
                const entry = await authorizeProject(route.project, 'deploy', target)
                if (!entry) return

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, route.project, 'deploy', target)
                const parsed = parseBranchBody(body.value)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, route.project, 'deploy', target)

                // The branch is in the target from here on: this is the audit trail for what a site
                // tracks, and "branch" alone would not say what it was changed to.
                const named = `${target} ${parsed.branch}`.slice(0, 200)
                const reply = await callAgentAudited(
                    { verb: 'deploy', project: route.project, args: { action: 'set-branch', environment: route.environment, branch: parsed.branch } },
                    route.project, 'deploy', named,
                )
                if (!reply) return
                // Unlike deploy and rollback above, a branch switch writes the registry synchronously
                // (the agent's own set-branch calls its refreshRegistry for exactly this reason, in
                // agent.ts), so api's copy needs catching up here too.
                return respondAgentAction('deploy', reply, route.project, named, true)
            }

            case 'deploys':
                return readDeploy(route.project, `${route.environment} deploys`, { action: 'history', environment: route.environment })

            case 'commits': {
                const target = `${route.environment} commits`
                const limit = parseCommitsLimit(url.searchParams)
                if (limit === null) return refuseRoute(400, 'bad-request', `limit must be a whole number from 1 to ${MAX_COMMITS}`, route.project, 'deploy', target)
                return readDeploy(route.project, target, { action: 'commits', environment: route.environment, limit })
            }

            case 'domains-list': {
                const found = await domainEnvironment(route.project, route.environment, 'domains-read', route.environment)
                if (!found) return
                return sendJson(res, 200, { ok: true, domains: domainsFor(found.entry, found.environment) })
            }

            case 'domain-add': {
                const found = await domainEnvironment(route.project, route.environment, 'domains', route.environment)
                if (!found) return
                const { entry, environment } = found

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, entry.id, 'domains', route.environment)
                const parsed = parseHostnameBody(body.value)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, entry.id, 'domains', route.environment)
                const { hostname } = parsed
                if (hostnamesOf(environment).includes(hostname)) {
                    return refuseRoute(400, 'bad-request', `${entry.id} ${environment.name} already serves ${hostname}`, entry.id, 'domains', hostname)
                }

                // Task 8's set-aliases writes the registry and rewrites the vhost in this one call, so
                // there is nothing else to do here. The whole resulting list goes over rather than the
                // one new name, which is what makes a retry after a half-failure land in the same place
                // instead of adding the alias twice.
                const token = await tokenFor(entry.id, environment.name)
                const reply = await callAgentAudited(
                    {
                        verb: 'domains', project: entry.id,
                        args: { action: 'set-aliases', environment: environment.name, aliases: [...environment.aliases, hostname], token },
                    },
                    entry.id, 'domains', hostname,
                )
                if (!reply) return
                return respondDomains(reply, entry, environment, hostname, () =>
                    recordWritten(entry.id, environment.name, token, [hostname], environment.domain))
            }

            case 'domain-remove': {
                const target = route.hostname.slice(0, 200)
                const found = await domainEnvironment(route.project, route.environment, 'domains', target)
                if (!found) return
                const { entry, environment } = found

                const hostname = normaliseHostname(route.hostname)
                if (hostname === null || !hostnamesOf(environment).includes(hostname)) {
                    return refuseRoute(404, 'not-found', `${entry.id} ${environment.name} does not serve that hostname`, entry.id, 'domains', target)
                }
                // The primary is the site's own address, and the vhost is rendered around it: taking it
                // away would leave a site with nothing to serve. The only route to that is removing the
                // environment itself, which is a provision action and asks for the name typed back.
                if (hostname === environment.domain) {
                    return refuseRoute(
                        400, 'bad-request',
                        `${hostname} is the primary domain of ${entry.id} ${environment.name}; remove the environment to remove it`,
                        entry.id, 'domains', target,
                    )
                }

                const token = await tokenFor(entry.id, environment.name)
                const reply = await callAgentAudited(
                    {
                        verb: 'domains', project: entry.id,
                        args: { action: 'set-aliases', environment: environment.name, aliases: environment.aliases.filter(alias => alias !== hostname), token },
                    },
                    entry.id, 'domains', hostname,
                )
                if (!reply) return
                return respondDomains(reply, entry, environment, hostname, () =>
                    deps.domains.remove(domainKey(entry.id, environment.name, hostname)))
            }

            case 'domain-verify': {
                const target = route.hostname.slice(0, 200)
                const found = await domainEnvironment(route.project, route.environment, 'domains', target)
                if (!found) return
                const { entry, environment } = found

                const hostname = normaliseHostname(route.hostname)
                const key = hostname === null ? null : domainKey(entry.id, environment.name, hostname)
                if (key === null || deps.domains.get(key) === undefined) {
                    return refuseRoute(404, 'not-found', `${entry.id} ${environment.name} has no record of that hostname`, entry.id, 'domains', target)
                }

                // The check itself is the verifier's, timeout and all; this only brings one record's turn
                // forward, and reads back what the check left behind. Nothing is written to the host to
                // check a name, so the agent hears nothing about this at all.
                await deps.verifier.checkNow(key)
                const record = deps.domains.get(key)
                await audit(who, { project: entry.id, verb: 'domains', target: hostname ?? target, outcome: 'ok', output: record?.state ?? 'gone' })
                const domain = domainsFor(entry, environment).find(answer => answer.hostname === hostname)
                return sendJson(res, 200, { ok: true, domain: domain ?? null })
            }

            case 'adopt-preview': {
                const found = await domainEnvironment(route.project, route.environment, 'domains', route.environment)
                if (!found) return
                const { entry, environment } = found
                // The same token adopt will write, so the file an operator reads here is the file adopt
                // puts down rather than one differing from it in every security-relevant line.
                const reply = await callAgent({
                    verb: 'domains', project: entry.id,
                    args: { action: 'preview', environment: environment.name, token: await tokenFor(entry.id, environment.name) },
                })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, entry.id, 'domains', route.environment)
                return sendJson(res, 200, reply)
            }

            case 'adopt': {
                const found = await domainEnvironment(route.project, route.environment, 'domains', route.environment)
                if (!found) return
                const { entry, environment } = found
                const target = environment.domain ?? route.environment

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, entry.id, 'domains', target)
                const parsed = parseAdoptBody(body.value)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, entry.id, 'domains', target)
                // The name, not the id: the id is in the URL the operator is already on, so typing it
                // back would confirm nothing about which site they meant.
                if (parsed.confirm !== entry.name) {
                    return refuseRoute(400, 'bad-request', 'confirm must match the project name to adopt this site', entry.id, 'domains', target)
                }

                const token = await tokenFor(entry.id, environment.name)
                // adopt takes the files to disable rather than finding them itself, so the preview is
                // what chooses them, with the token the adopt will carry. The agent re-establishes every
                // claim against sites-enabled as it is before it moves anything, so a preview that has
                // gone stale in between is refused there rather than acted on.
                const preview = await callAgentAudited(
                    { verb: 'domains', project: entry.id, args: { action: 'preview', environment: environment.name, token } },
                    entry.id, 'domains', target,
                )
                if (!preview) return
                if (!preview.ok) return refuseDomains(preview, entry.id, target)
                if (!('preview' in preview)) {
                    return refuseRoute(502, 'failed', 'the agent did not answer the preview with one', entry.id, 'domains', target)
                }

                // Whatever the preview found, including nothing. An environment nobody hand-wrote a file
                // for has nothing to displace, and adopt is the only route to a vhost hostd owns: were
                // an empty list refused here, a newly provisioned site would sit with a domain in the
                // registry and no vhost forever.
                const { claims, adoptable } = preview.preview
                if (!adoptable) {
                    // Every reason of every file, rather than a count or the first one: the operator's
                    // next move is to edit those files by hand, and each reason names a different edit.
                    const blocked = claims
                        .filter(claim => claim.unsupported.length > 0)
                        .map(claim => `${claim.path}: ${claim.unsupported.join(' ')}`)
                    return refuseRoute(400, 'bad-request', `these cannot be adopted as they stand. ${blocked.join(' ')}`, entry.id, 'domains', target)
                }

                const disable = claims.map(claim => claim.path)

                // The baseline, and it is taken HERE, before anything on the host moves. Without it the
                // check after the reload cannot tell "still broken" from "newly broken", and would
                // refuse an adoption meant to fix a site that was already down.
                //
                // Skipped, and the whole check with it, when there is nothing to put back. Rolling an
                // adoption back means restoring the operator's own file; on an environment that had none
                // (a newly provisioned site, which is the only other shape adopt takes) the only
                // rollback available would leave the hostname with no vhost at all, which is worse than
                // whatever the probe is complaining about. Skipped too when the environment has no
                // domain, which the agent refuses on its own a moment later.
                const checking = environment.domain !== null && disable.length > 0 ? environment.domain : null
                const before: Answer | null = checking === null ? null : await probeSite(deps.fetch ?? fetch, checking)

                const reply = await callAgentAudited(
                    {
                        verb: 'domains', project: entry.id,
                        args: { action: 'adopt', environment: environment.name, token, disable },
                    },
                    entry.id, 'domains', target,
                )
                if (!reply) return

                // The rail said the configtest passed and the reload succeeded. That is exactly what it
                // said when thebackroom.dev went dark, so it is not the last word: ask the hostname.
                if (reply.ok && checking !== null && before !== null) {
                    const after = await probeSite(deps.fetch ?? fetch, checking)
                    if (wentDark(before, after)) {
                        const undo = await callAgentAudited(
                            { verb: 'domains', project: entry.id, args: { action: 'restore', environment: environment.name, restore: disable } },
                            entry.id, 'domains', target,
                        )
                        if (!undo) return
                        const problem = undo.ok ? null : undo.message
                        // Answered as a 'failed' refusal rather than a 200, and routed through
                        // respondDomains so recordVhost fires: that is what puts the environment on
                        // /health's alarm and turns needsYou true in the portal. The hostnames are
                        // deliberately NOT recorded as written, because after the rollback hostd's
                        // vhost is gone and there is nothing for the verifier to prove against.
                        const message = rolledBackReason(checking, before, after, disable, problem)
                        // Apache's own words only when there are any: this rollback's failure output,
                        // never the adopt's, which was a configtest that passed and says nothing.
                        const rolledBack: Refusal = undo.ok || undo.output === undefined
                            ? { ok: false, code: 'failed', message }
                            : { ok: false, code: 'failed', message, output: undo.output }
                        return respondDomains(rolledBack, entry, environment, target, async () => {})
                    }
                }

                // The hostnames the agent says it wrote, rather than the registry's own copy: api polls
                // the registry every ten seconds, and the reply is what the vhost actually carries. The
                // Array.isArray test is what tells this reply's single `written` apart from configure's
                // list of them, which is the other member of AgentReply carrying a field of that name.
                const written = 'written' in reply && !Array.isArray(reply.written)
                    ? reply.written.hostnames
                    : hostnamesOf(environment)
                return respondDomains(reply, entry, environment, target, () =>
                    recordWritten(entry.id, environment.name, token, written, environment.domain))
            }

            case 'lifecycle': {
                const { project, action } = route
                if (!(await decide(project, 'lifecycle', action))) return
                let reply: AgentReply
                try {
                    reply = await deps.agent.call({ verb: 'lifecycle', project, args: { action } })
                } catch (error) {
                    if (!(error instanceof AgentUnavailableError)) throw error
                    await audit(who, { project, verb: 'lifecycle', target: action, outcome: 'failed', reason: error.message })
                    return sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                }
                if (reply.ok) {
                    const output = 'output' in reply ? reply.output : ''
                    await audit(who, { project, verb: 'lifecycle', target: action, outcome: 'ok', output })
                    return sendJson(res, 200, { ok: true, output })
                }
                const outcome: AuditOutcome = reply.code === 'failed' ? 'failed' : 'refused'
                await audit(who, {
                    project, verb: 'lifecycle', target: action, outcome,
                    reason: outcome === 'failed' ? reply.message : reply.code,
                    ...(reply.output === undefined ? {} : { output: reply.output }),
                })
                return sendJson(res, AGENT_STATUS[reply.code], reply)
            }

            case 'logs': {
                const parsed = parseLogsQuery(url.searchParams)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.message, route.project, 'logs')
                const { args } = parsed
                const target = `${args.service}${args.follow ? ' follow' : ''}`
                if (!(await decide(route.project, 'logs', target))) return

                let stream: Awaited<ReturnType<AgentClient['stream']>>
                try {
                    stream = await deps.agent.stream({ verb: 'logs', project: route.project, args })
                } catch (error) {
                    if (!(error instanceof AgentUnavailableError)) throw error
                    await audit(who, { project: route.project, verb: 'logs', target, outcome: 'failed', reason: error.message })
                    return sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                }
                if (!stream.ok) return refuseRoute(AGENT_STATUS[stream.code], stream.code, stream.message, route.project, 'logs', target)
                await audit(who, { project: route.project, verb: 'logs', target, outcome: 'ok' })

                res.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-store',
                    connection: 'keep-alive',
                    'x-accel-buffering': 'no',
                })
                const logStream = stream
                const stop = () => logStream.close()
                res.on('close', stop)
                const keepalive = setInterval(() => res.write(SSE_KEEPALIVE), deps.keepaliveMs ?? KEEPALIVE_MS)
                try {
                    for await (const line of logStream.lines) {
                        if (!res.write(sseEvent('line', line))) await waitForDrain(res)
                        if (res.destroyed) break
                    }
                    res.write(sseEvent('end', {}))
                } catch (error) {
                    console.error(`[api] ${new Date().toISOString()} log stream for ${route.project} failed: ${describeError(error)}`)
                    res.write(sseEvent('error', { message: 'the log stream failed' }))
                } finally {
                    clearInterval(keepalive)
                    res.off('close', stop)
                    logStream.close()
                    res.end()
                }
                return
            }

            case 'backups': {
                if (!(await decide(route.project, 'backup-read', null))) return
                const reply = await callAgent({ verb: 'backup', project: route.project, args: { action: 'list' } })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, route.project, 'backup')
                return sendJson(res, 200, reply)
            }

            case 'backup-run': {
                const target = 'run'
                const entry = await authorizeProject(route.project, 'backup', target)
                if (!entry) return
                const reply = await callAgentAudited(
                    // The actor's kind, never the user: it labels the run in the history the portal draws
                    // for the client, so their own backups are not all recorded as the operator's. The
                    // agent makes no decision on it (see BackupRunArgs), and which user it was stays in
                    // the audit entry this route writes.
                    { verb: 'backup', project: route.project, args: { action: 'run', tag: 'manual', actor: caller.actor.kind } },
                    route.project, 'backup', target,
                )
                if (!reply) return
                if (reply.ok) {
                    await audit(who, { project: route.project, verb: 'backup', target, outcome: 'ok' })
                    // Answered as soon as the run has started, not once it finishes: a backup takes
                    // minutes and api's own call timeout is 150 seconds. The outcome lands in the history
                    // the portal polls through GET .../backups/runs/:run.
                    return sendJson(res, 202, { ok: true, run: 'started' in reply && 'run' in reply.started ? reply.started.run : '' })
                }
                const outcome: AuditOutcome = reply.code === 'failed' ? 'failed' : 'refused'
                await audit(who, { project: route.project, verb: 'backup', target, outcome, reason: outcome === 'failed' ? reply.message : reply.code })
                return sendJson(res, AGENT_STATUS[reply.code], reply)
            }

            case 'backup-run-status': {
                if (!(await decide(route.project, 'backup-read', route.run))) return
                const reply = await callAgent({ verb: 'backup', project: route.project, args: { action: 'get-run', run: route.run } })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, route.project, 'backup', route.run)
                return sendJson(res, 200, reply)
            }

            case 'backup-delete': {
                const target = route.snapshot
                const entry = await authorizeProject(route.project, 'backup', target)
                if (!entry) return
                const reply = await callAgentAudited(
                    { verb: 'backup', project: route.project, args: { action: 'delete', snapshot: route.snapshot } },
                    route.project, 'backup', target,
                )
                if (!reply) return
                return respondAgentAction('backup', reply, route.project, target, false)
            }

            case 'backup-download': {
                const target = route.snapshot
                // `backup`, not `backup-read`, as the design's Endpoints section puts it: downloading is
                // the one operation that moves an entire database off the dedi, and it is already audited
                // as a mutation. Both verbs map to the same capability today, so this changes nothing
                // until a read-only role exists, which is exactly when getting it wrong would bite.
                if (!(await decide(route.project, 'backup', target))) return

                let stream: Awaited<ReturnType<AgentClient['download']>>
                try {
                    stream = await deps.agent.download({ verb: 'backup', project: route.project, args: { action: 'download', snapshot: route.snapshot } })
                } catch (error) {
                    if (!(error instanceof AgentUnavailableError)) throw error
                    await audit(who, { project: route.project, verb: 'backup', target, outcome: 'failed', reason: error.message })
                    return sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                }
                if (!stream.ok) return refuseRoute(AGENT_STATUS[stream.code], stream.code, stream.message, route.project, 'backup', target)
                // A download is a read of the client's own data, but it is audited like a mutation: it is
                // the one read in this file that moves the client's actual backup bytes off the dedi.
                await audit(who, { project: route.project, verb: 'backup', target, outcome: 'ok' })

                res.writeHead(200, {
                    'content-type': 'application/gzip',
                    // The client sees a file named for their site and the day they took it, never a
                    // snapshot id or a path on the dedi.
                    'content-disposition': `attachment; filename="${route.project}-${new Date().toISOString().slice(0, 10)}.tar.gz"`,
                    'cache-control': 'no-store',
                })
                const downloadStream = stream
                const stop = () => downloadStream.close()
                res.on('close', stop)
                let failure: string | null = null
                try {
                    for await (const chunk of downloadStream.body) {
                        if (!res.write(chunk)) await waitForDrain(res)
                        if (res.destroyed) break
                    }
                } catch (error) {
                    failure = describeError(error)
                    // The client already left (res.destroyed) is not a failure worth a log line; a dead
                    // agent connection or socket reset mid-transfer is.
                    if (!res.destroyed) console.error(`[api] ${new Date().toISOString()} backup download for ${route.project} failed: ${failure}`)
                } finally {
                    res.off('close', stop)
                    downloadStream.close()
                    if (failure !== null) {
                        // The entry above records the authorization decision, which was made before a
                        // byte moved; without this one a download that broke mid-transfer would read back
                        // as a clean success, so the operator's own record would agree with the truncated
                        // archive rather than expose it. The reason is the transport's own message: the
                        // client's bytes never appear in it. It is written before the destroy below
                        // because destroying the response is what tells the client the transfer broke:
                        // anything that reads the log on that signal, the portal included, would
                        // otherwise race this append and find only the entry from before the transfer.
                        // append never throws, so awaiting it here cannot cost the destroy.
                        await audit(who, { project: route.project, verb: 'backup', target, outcome: 'failed', reason: failure })
                        // A truncated archive must never look like a complete one. Ending the response
                        // cleanly would tell the client the download succeeded, and they would only find
                        // out at restore time. Destroying it instead leaves the chunked encoding
                        // incomplete, which every HTTP client reports as a failed transfer rather than a
                        // short but valid file. Destroying an already-destroyed response is harmless.
                        res.destroy()
                    } else {
                        res.end()
                    }
                }
                return
            }

            case 'backup-schedule': {
                if (!deps.schedules) {
                    return refuseRoute(503, 'unavailable', 'backup schedules are not configured', route.project, 'backup', 'schedule')
                }
                const target = 'schedule'
                const entry = await authorizeProject(route.project, route.write ? 'backup' : 'backup-read', target)
                if (!entry) return
                if (!route.write) return sendJson(res, 200, { ok: true, schedule: deps.schedules.get(route.project) })

                const body = await readJsonBody(req, MAX_REQUEST_BYTES)
                if (!body.ok) return refuseRoute(400, 'bad-request', body.message, route.project, 'backup', target)
                // The ceiling is the operator's, from the registry, so a client can ask for less than it
                // and never more. Clamped rather than refused, and the reply says what it settled on, so
                // the portal can show the clamped values rather than pretending the request was honoured.
                const parsed = parseSchedule(body.value, entry.backups.maxKeep)
                if (!parsed.ok) return refuseRoute(400, 'bad-request', parsed.problem, route.project, 'backup', target)

                await deps.schedules.set(route.project, parsed.schedule)
                await audit(who, { project: route.project, verb: 'backup', target, outcome: 'ok' })
                return sendJson(res, 200, { ok: true, schedule: parsed.schedule })
            }
        }
    }

    return (req, res) => {
        handle(req, res).catch(error => {
            console.error(`[api] ${new Date().toISOString()} ${req.method} ${req.url} failed: ${describeError(error)}`)
            if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: 'internal error' })
            else res.destroy()
        })
    }
}
