// api's HTTP surface. Every request is authenticated first; every project request passes the policy
// before the agent hears of it; every change, every stream opened and every refusal is audited.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROJECT_ID, SERVICE_NAME, describeError } from '../shared/formats.ts'
import {
    LIFECYCLE_ACTIONS, MAX_TAIL, DEFAULT_TAIL,
    type AgentReply, type AgentRequest, type LifecycleAction, type LogsArgs, type RefusalCode,
} from '../shared/protocol.ts'
import type { Registry } from '../shared/registry.ts'
import { authenticate, actorLabel, type Caller } from './auth.ts'
import { authorize, visibleProjects, type PolicyVerb } from './policy.ts'
import { AgentUnavailableError, type AgentClient } from './agent-client.ts'
import { MAX_AUDIT_READ, type AuditLog, type AuditOutcome } from './audit.ts'
import { sseEvent, SSE_KEEPALIVE } from './sse.ts'

export type ApiDeps = {
    token: string
    registry: () => Registry
    agent: AgentClient
    audit: AuditLog
    now?: () => number
    keepaliveMs?: number
}

export type Route =
    | { verb: 'list' }
    | { verb: 'audit-all' }
    | { verb: 'status', project: string }
    | { verb: 'lifecycle', project: string, action: LifecycleAction }
    | { verb: 'logs', project: string }
    | { verb: 'audit', project: string }
    | { verb: 'not-found' }
    | { verb: 'method-not-allowed' }

const AGENT_STATUS: Record<RefusalCode, number> = {
    'bad-request': 400,
    'capability-disabled': 403,
    'unknown-project': 404,
    'unknown-service': 404,
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
    if (parts.length === 1 && parts[0] === 'projects') return only('GET', { verb: 'list' })
    if (parts.length === 1 && parts[0] === 'audit') return only('GET', { verb: 'audit-all' })
    if (parts[0] !== 'projects' || parts.length < 2 || parts.length > 3) return { verb: 'not-found' }
    const project = parts[1] ?? ''
    if (!PROJECT_ID.test(project)) return { verb: 'not-found' }
    if (parts.length === 2) return only('GET', { verb: 'status', project })
    const action = parts[2] ?? ''
    if ((LIFECYCLE_ACTIONS as readonly string[]).includes(action)) return only('POST', { verb: 'lifecycle', project, action: action as LifecycleAction })
    if (action === 'logs') return only('GET', { verb: 'logs', project })
    if (action === 'audit') return only('GET', { verb: 'audit', project })
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

    const followRaw = params.get('follow')
    if (followRaw !== null && !['0', '1', 'true', 'false'].includes(followRaw)) return { ok: false, message: 'follow must be 1 or 0' }
    return { ok: true, args: { service, tail, since, follow: followRaw === '1' || followRaw === 'true' } }
}

function parseLimit(params: URLSearchParams): number | null {
    const raw = params.get('limit')
    if (raw === null) return DEFAULT_AUDIT_LIMIT
    const limit = /^\d{1,4}$/.test(raw) ? Number(raw) : 0
    return limit >= 1 && limit <= MAX_AUDIT_READ ? limit : null
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

        const decide = async (project: string, verb: PolicyVerb, target: string | null) => {
            const decision = authorize(deps.registry(), caller.actor, project, verb)
            if (!decision.ok) await refuseRoute(decision.status, decision.code, decision.message, project, verb, target)
            return decision.ok
        }

        const callAgent = async (request: AgentRequest): Promise<AgentReply | null> => {
            try {
                return await deps.agent.call(request)
            } catch (error) {
                if (!(error instanceof AgentUnavailableError)) throw error
                sendJson(res, 503, { ok: false, code: 'agent-unavailable', message: error.message })
                return null
            }
        }

        switch (route.verb) {
            case 'not-found':
                return refuseRoute(404, 'not-found', 'no such route', null, 'unknown', url.pathname.slice(0, 200))

            case 'method-not-allowed':
                return refuseRoute(405, 'method-not-allowed', `${req.method} is not allowed here`, null, 'unknown', url.pathname.slice(0, 200))

            case 'list': {
                const health = await callAgent({ verb: 'health' })
                if (!health) return
                const invalid = health.ok && 'invalid' in health ? health.invalid : {}
                const registry = deps.registry()
                const projects: Array<Record<string, unknown>> = visibleProjects(registry, caller.actor).map(project => {
                    const reason = Object.hasOwn(invalid, project.id) ? invalid[project.id] : undefined
                    return {
                        id: project.id,
                        name: project.name,
                        capabilities: [...project.capabilities],
                        valid: reason === undefined,
                        ...(reason === undefined ? {} : { reason }),
                    }
                })
                if (caller.actor.kind === 'admin') {
                    for (const [id, reason] of registry.invalid) projects.push({ id, valid: false, reason })
                }
                return sendJson(res, 200, { ok: true, projects })
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
                if (!(await decide(route.project, 'status', null))) return
                const reply = await callAgent({ verb: 'status', project: route.project })
                if (!reply) return
                if (!reply.ok) return refuseRoute(AGENT_STATUS[reply.code], reply.code, reply.message, route.project, 'status')
                return sendJson(res, 200, reply)
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
