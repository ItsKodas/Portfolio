// api's HTTP surface. Every request is authenticated first; every project request passes the policy
// before the agent hears of it; every change, every stream opened and every refusal is audited.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROJECT_ID, CLIENT_ID, SERVICE_NAME, isRecord, describeError } from '../shared/formats.ts'
import {
    LIFECYCLE_ACTIONS, MAX_TAIL, DEFAULT_TAIL, MAX_REQUEST_BYTES, MAX_COMMITS, DEFAULT_COMMITS,
    SNAPSHOT_ID, RUN_ID,
    type AgentReply, type AgentRequest, type LifecycleAction, type LogsArgs, type ProjectStatus, type RefusalCode,
    type ProvisionCreateArgs, type ProvisionAddEnvironmentArgs,
} from '../shared/protocol.ts'
import {
    ENVIRONMENTS, CERTIFICATE_MODES,
    type CertificateMode, type EnvironmentName, type ProjectEntry, type Registry,
} from '../shared/registry.ts'
import { envPathProblem } from '../shared/envfiles.ts'
import { parseSchedule } from '../shared/backups.ts'
import { authenticate, actorLabel, type Actor, type Caller } from './auth.ts'
import { authorize, visibleProjects, type PolicyVerb } from './policy.ts'
import { AgentUnavailableError, type AgentClient } from './agent-client.ts'
import { MAX_AUDIT_READ, type AuditLog, type AuditOutcome } from './audit.ts'
import { sseEvent, SSE_KEEPALIVE } from './sse.ts'
import type { ScheduleStore } from './schedule.ts'

export type ApiDeps = {
    token: string
    registry: () => Registry
    agent: AgentClient
    audit: AuditLog
    now?: () => number
    keepaliveMs?: number
    schedules?: ScheduleStore
}

export type Route =
    | { verb: 'list' }
    | { verb: 'health' }
    | { verb: 'audit-all' }
    | { verb: 'status', project: string }
    | { verb: 'lifecycle', project: string, action: LifecycleAction }
    | { verb: 'logs', project: string }
    | { verb: 'audit', project: string }
    | { verb: 'create' }
    | { verb: 'delete', project: string }
    | { verb: 'add-environment', project: string }
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
                default: return { verb: 'not-found' }
            }
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
    if (!onlyKeys(value, ['id', 'client', 'name', 'repo', 'branch', 'domain', 'certificate'])) {
        return { ok: false, message: 'create takes only id, client, name, repo, branch, domain and certificate' }
    }
    // Validated against the same grammar as everywhere else an id is trusted, not just typeof: an
    // unvalidated id is what would otherwise end up as the project field of an audit entry below.
    if (typeof value.id !== 'string' || !PROJECT_ID.test(value.id)) return { ok: false, message: 'id is malformed' }
    if (typeof value.client !== 'string' || !CLIENT_ID.test(value.client)) return { ok: false, message: 'client is malformed' }
    if (typeof value.name !== 'string') return { ok: false, message: 'name is malformed' }
    if (typeof value.repo !== 'string') return { ok: false, message: 'repo is malformed' }
    if (typeof value.branch !== 'string') return { ok: false, message: 'branch is malformed' }
    const domain = value.domain
    if (domain !== null && typeof domain !== 'string') return { ok: false, message: 'domain is malformed' }
    const certificate = value.certificate
    if (certificate !== null && !(CERTIFICATE_MODES as readonly string[]).includes(certificate as string)) return { ok: false, message: 'certificate is malformed' }
    return {
        ok: true,
        args: {
            action: 'create', id: value.id, client: value.client, name: value.name, repo: value.repo, branch: value.branch,
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
        const respondAgentAction = async (verb: 'provision' | 'env' | 'deploy' | 'backup', reply: AgentReply, project: string, target: string) => {
            if (reply.ok) {
                await audit(who, { project, verb, target, outcome: 'ok' })
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
            return respondAgentAction('provision', reply, project, target)
        }

        // Deploy, rollback and branch all start work on the operator's behalf, so all three are
        // admin-only (the 'deploy' policy verb) and all three are audited, refusals included. The
        // target says which environment, because live and test are different sites.
        const startDeploy = async (
            project: string, target: string, args: Extract<AgentRequest, { verb: 'deploy' }>['args'],
        ): Promise<void> => {
            const entry = await authorizeProject(project, 'deploy', target)
            if (!entry) return
            const reply = await callAgentAudited({ verb: 'deploy', project, args }, project, 'deploy', target)
            if (!reply) return
            return respondAgentAction('deploy', reply, project, target)
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
                return sendJson(res, 200, reply)
            }

            case 'audit-all': {
                if (caller.actor.kind !== 'admin') return refuseRoute(403, 'admin-only', 'only the admin can read the whole audit log', null, 'audit')
                const limit = parseLimit(url.searchParams)
                if (limit === null) return sendJson(res, 400, { ok: false, code: 'bad-request', message: `limit must be 1 to ${MAX_AUDIT_READ}` })
                return sendJson(res, 200, { ok: true, events: await deps.audit.read({ limit }) })
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
                return respondAgentAction('provision', reply, parsed.args.id, target)
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
                return respondAgentAction('provision', reply, route.project, target)
            }

            case 'remove-environment':
                return removeProject(route.project, route.environment)

            case 'env-list': {
                const target = route.environment
                const project = await authorizeProject(route.project, 'env', target)
                if (!project) return

                const reply = await callAgentAudited(
                    { verb: 'env', project: route.project, args: { action: 'list', environment: route.environment } },
                    route.project, 'env', target,
                )
                if (!reply) return
                return respondAgentAction('env', reply, route.project, target)
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
                    return respondAgentAction('env', reply, route.project, target)
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
                return respondAgentAction('env', reply, route.project, target)
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
                return respondAgentAction('deploy', reply, route.project, named)
            }

            case 'deploys':
                return readDeploy(route.project, `${route.environment} deploys`, { action: 'history', environment: route.environment })

            case 'commits': {
                const target = `${route.environment} commits`
                const limit = parseCommitsLimit(url.searchParams)
                if (limit === null) return refuseRoute(400, 'bad-request', `limit must be a whole number from 1 to ${MAX_COMMITS}`, route.project, 'deploy', target)
                return readDeploy(route.project, target, { action: 'commits', environment: route.environment, limit })
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
                    { verb: 'backup', project: route.project, args: { action: 'run', tag: 'manual' } },
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
                return respondAgentAction('backup', reply, route.project, target)
            }

            case 'backup-download': {
                const target = route.snapshot
                if (!(await decide(route.project, 'backup-read', target))) return

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
                let failed = false
                try {
                    for await (const chunk of downloadStream.body) {
                        if (!res.write(chunk)) await waitForDrain(res)
                        if (res.destroyed) break
                    }
                } catch (error) {
                    failed = true
                    // The client already left (res.destroyed) is not a failure worth a log line; a dead
                    // agent connection or socket reset mid-transfer is.
                    if (!res.destroyed) console.error(`[api] ${new Date().toISOString()} backup download for ${route.project} failed: ${describeError(error)}`)
                } finally {
                    res.off('close', stop)
                    downloadStream.close()
                    // A truncated archive must never look like a complete one. Ending the response
                    // cleanly here would tell the client the download succeeded, and they would only
                    // find out at restore time. Destroying it instead leaves the chunked encoding
                    // incomplete, which every HTTP client reports as a failed transfer rather than a
                    // short but valid file. Destroying an already-destroyed response is harmless.
                    if (failed) res.destroy()
                    else res.end()
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
