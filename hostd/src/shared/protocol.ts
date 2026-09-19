// The only language the agent speaks. One JSON request line per connection, answered by one JSON line,
// or by a header line followed by a stream. Parsing is strict on purpose: the agent is root, so anything
// it does not recognise, including an extra field, is refused rather than ignored.

import { PROJECT_ID, SERVICE_NAME, isRecord } from './formats.ts'
import { isComposeService, type Capability, type ProjectEntry, type Registry } from './registry.ts'

export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_TAIL = 5000
export const DEFAULT_TAIL = 200
export const LIFECYCLE_ACTIONS = ['start', 'stop', 'restart'] as const
export type LifecycleAction = typeof LIFECYCLE_ACTIONS[number]

export type LogsArgs = { service: string, tail: number, since: number | null, follow: boolean }
export type HealthRequest = { verb: 'health' }
export type StatusRequest = { verb: 'status', project: string }
export type LifecycleRequest = { verb: 'lifecycle', project: string, args: { action: LifecycleAction } }
export type LogsRequest = { verb: 'logs', project: string, args: LogsArgs }
export type ProjectRequest = StatusRequest | LifecycleRequest | LogsRequest
export type AgentRequest = HealthRequest | ProjectRequest
export type Verb = AgentRequest['verb']

export type RefusalCode =
    | 'bad-request' | 'unknown-project' | 'invalid-project' | 'capability-disabled'
    | 'unknown-service' | 'busy' | 'failed' | 'unavailable'
export type Refusal = { ok: false, code: RefusalCode, message: string, output?: string }

export function refuse(code: RefusalCode, message: string, output?: string): Refusal {
    return output === undefined ? { ok: false, code, message } : { ok: false, code, message, output }
}

export type ServiceStatus = {
    service: string
    role: 'site' | 'database'
    state: string
    health: string | null
    startedAt: string | null
    restartCount: number | null
    image: string | null
}
export type HealthReply = { ok: true, warnings: string[], invalid: Record<string, string> }
export type StatusReply = { ok: true, services: ServiceStatus[] }
export type LifecycleReply = { ok: true, output: string }
export type StreamHeader = { ok: true, stream: true }
export type AgentReply = HealthReply | StatusReply | LifecycleReply | Refusal
export type LogLine = { stream: 'stdout' | 'stderr', ts: string | null, text: string, truncated: boolean }

// Status is visible to anyone who may see the project at all; everything else needs its capability.
export const VERB_CAPABILITY: Record<Verb, Capability | null> = {
    health: null,
    status: null,
    lifecycle: 'lifecycle',
    logs: 'logs',
}

type Parsed = { ok: true, request: AgentRequest } | Refusal

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

function projectOf(raw: Record<string, unknown>): string | null {
    return typeof raw.project === 'string' && PROJECT_ID.test(raw.project) ? raw.project : null
}

function parseLogsArgs(args: unknown): LogsArgs | Refusal {
    if (!isRecord(args) || !onlyKeys(args, ['service', 'tail', 'since', 'follow'])) {
        return refuse('bad-request', 'logs takes only args.service, args.tail, args.since and args.follow')
    }
    if (typeof args.service !== 'string' || !SERVICE_NAME.test(args.service)) return refuse('bad-request', 'service is malformed')
    const tail = args.tail === undefined ? DEFAULT_TAIL : args.tail
    if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 0 || tail > MAX_TAIL) {
        return refuse('bad-request', `tail must be a whole number from 0 to ${MAX_TAIL}`)
    }
    const since = args.since === undefined || args.since === null ? null : args.since
    if (since !== null && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) {
        return refuse('bad-request', 'since must be a non-negative number of seconds')
    }
    const follow = args.follow === undefined ? false : args.follow
    if (typeof follow !== 'boolean') return refuse('bad-request', 'follow must be true or false')
    return { service: args.service, tail, since: since as number | null, follow }
}

export function parseAgentRequest(line: string): Parsed {
    if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) return refuse('bad-request', 'request is too large')
    let raw: unknown
    try {
        raw = JSON.parse(line)
    } catch {
        return refuse('bad-request', 'request is not JSON')
    }
    if (!isRecord(raw)) return refuse('bad-request', 'request must be a JSON object')

    switch (raw.verb) {
        case 'health':
            if (!onlyKeys(raw, ['verb'])) return refuse('bad-request', 'health takes no other fields')
            return { ok: true, request: { verb: 'health' } }

        case 'status': {
            if (!onlyKeys(raw, ['verb', 'project'])) return refuse('bad-request', 'status takes only project')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            return { ok: true, request: { verb: 'status', project } }
        }

        case 'lifecycle': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'lifecycle takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            if (!isRecord(raw.args) || !onlyKeys(raw.args, ['action'])) return refuse('bad-request', 'lifecycle takes only args.action')
            const action = raw.args.action
            if (typeof action !== 'string' || !(LIFECYCLE_ACTIONS as readonly string[]).includes(action)) {
                return refuse('bad-request', 'action must be start, stop or restart')
            }
            return { ok: true, request: { verb: 'lifecycle', project, args: { action: action as LifecycleAction } } }
        }

        case 'logs': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'logs takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            const args = parseLogsArgs(raw.args)
            if ('ok' in args) return args
            return { ok: true, request: { verb: 'logs', project, args } }
        }

        default:
            return refuse('bad-request', 'unknown verb')
    }
}

// The agent's own check, applied to every project verb regardless of what api decided. It cannot know
// who the actor is, so ownership is not here; everything that depends only on the registry is.
export function checkStructure(
    registry: Registry,
    request: ProjectRequest,
    guardInvalid: ReadonlyMap<string, string>,
): { ok: true, project: ProjectEntry } | Refusal {
    const id = request.project
    const registryProblem = registry.invalid.get(id)
    if (registryProblem !== undefined) return refuse('invalid-project', `${id} is invalid: ${registryProblem}`)
    const project = registry.projects.get(id)
    if (!project) return refuse('unknown-project', `${id} is not registered`)
    const guardProblem = guardInvalid.get(id)
    if (guardProblem !== undefined) return refuse('invalid-project', `${id} is invalid: ${guardProblem}`)

    const capability = VERB_CAPABILITY[request.verb]
    if (capability && !project.capabilities.has(capability)) return refuse('capability-disabled', `${capability} is not enabled for ${id}`)

    if (request.verb === 'logs') {
        const service = request.args.service
        const entry = Object.hasOwn(project.services, service) ? project.services[service] : undefined
        if (!entry || !isComposeService(entry)) return refuse('unknown-service', `${service} is not a registered service of ${id}`)
    }
    return { ok: true, project }
}
