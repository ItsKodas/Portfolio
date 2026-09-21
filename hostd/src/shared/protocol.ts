// The only language the agent speaks. One JSON request line per connection, answered by one JSON line,
// or by a header line followed by a stream. Parsing is strict on purpose: the agent is root, so anything
// it does not recognise, including an extra field, is refused rather than ignored.

import { PROJECT_ID, SERVICE_NAME, isRecord } from './formats.ts'
import {
    isComposeService, environmentOf, ENVIRONMENTS, CERTIFICATE_MODES, GIT_REF,
    type Capability, type CertificateMode, type EnvironmentName, type ProjectEntry, type Registry,
} from './registry.ts'
import type { Commit } from './fetch-protocol.ts'
import type { DeployRecord, DeployTrigger } from './deploys.ts'
import type { EnvFileList } from './envfiles.ts'
import type { SystemUsage } from './system.ts'

export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_TAIL = 5000
export const DEFAULT_TAIL = 200
// The bound on one statuses request. api only ever asks for the projects one actor can see, so this is
// far above any real registry; it is here because the list arrives over the wire, and nothing that
// arrives over the wire is unbounded.
export const MAX_STATUS_PROJECTS = 200
export const LIFECYCLE_ACTIONS = ['start', 'stop', 'restart'] as const
export type LifecycleAction = typeof LIFECYCLE_ACTIONS[number]

export type LogsArgs = { service: string, tail: number, since: number | null, follow: boolean }
export type HealthRequest = { verb: 'health' }
export type StatusRequest = { verb: 'status', project: string }
// Several projects in one request, so a dashboard showing every site costs one call rather than one per
// site. It names the projects rather than meaning "all of them": the agent has no idea who is asking, so
// api is what decides which ones an actor may see, exactly as it does for every other verb.
export type StatusesRequest = { verb: 'statuses', projects: string[] }
export type LifecycleRequest = { verb: 'lifecycle', project: string, args: { action: LifecycleAction } }
export type LogsRequest = { verb: 'logs', project: string, args: LogsArgs }

// Creating a project has nothing to check structurally yet, so it carries no project id: there is no
// registry entry for checkStructure to look up. Every other provision action names the project it acts on.
export type ProvisionCreateArgs = {
    action: 'create'
    id: string
    client: string
    name: string
    repo: string
    branch: string
    domain: string | null
    certificate: CertificateMode | null
}
export type ProvisionAddEnvironmentArgs = {
    action: 'add-environment'
    environment: 'test'
    branch: string
    domain: string | null
    certificate: CertificateMode | null
}
export type ProvisionRemoveArgs = { action: 'remove', environment: EnvironmentName | null }
export type ProvisionCreateRequest = { verb: 'provision', args: ProvisionCreateArgs }
export type ProvisionOnProjectRequest = { verb: 'provision', project: string, args: ProvisionAddEnvironmentArgs | ProvisionRemoveArgs }
export type ProvisionRequest = ProvisionCreateRequest | ProvisionOnProjectRequest

export type EnvListArgs = { action: 'list', environment: EnvironmentName }
export type EnvReadArgs = { action: 'read', environment: EnvironmentName, path: string }
export type EnvWriteArgs = { action: 'write', environment: EnvironmentName, path: string, text: string }
export type EnvArgs = EnvListArgs | EnvReadArgs | EnvWriteArgs
export type EnvRequest = { verb: 'env', project: string, args: EnvArgs }

// How many commits one commits request may ask for. Bounded here as well as in the fetcher, because
// this is what a portal page can ask for and the fetcher's own bound is far higher.
export const MAX_COMMITS = 100
export const DEFAULT_COMMITS = 30

export type DeployStartArgs = { action: 'deploy', environment: EnvironmentName }
export type DeployRollbackArgs = { action: 'rollback', environment: EnvironmentName }
export type DeployBranchArgs = { action: 'set-branch', environment: EnvironmentName, branch: string }
export type DeployHistoryArgs = { action: 'history', environment: EnvironmentName }
export type DeployCommitsArgs = { action: 'commits', environment: EnvironmentName, limit: number }
export type DeployArgs = DeployStartArgs | DeployRollbackArgs | DeployBranchArgs | DeployHistoryArgs | DeployCommitsArgs
export type DeployRequest = { verb: 'deploy', project: string, args: DeployArgs }

export type ProjectRequest = StatusRequest | LifecycleRequest | LogsRequest | ProvisionOnProjectRequest | EnvRequest | DeployRequest
export type AgentRequest = HealthRequest | StatusesRequest | ProvisionCreateRequest | ProjectRequest
export type Verb = AgentRequest['verb']

export type RefusalCode =
    | 'bad-request' | 'unknown-project' | 'invalid-project' | 'capability-disabled'
    | 'unknown-service' | 'unknown-environment' | 'busy' | 'failed' | 'unavailable'
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
// system carries figures only. Nothing in it is a check, and none of its problems reach warnings, so a
// busy machine never makes hostd unhealthy (see system.ts).
export type HealthReply = { ok: true, warnings: string[], invalid: Record<string, string>, system: SystemUsage }
export type StatusReply = { ok: true, services: ServiceStatus[] }
// One project's status inside a statuses reply. A project the agent refuses (unregistered, invalid, or a
// Docker read that failed) carries its refusal here instead of failing the whole batch: the dashboard
// must still draw the other sites.
export type ProjectStatus =
    | { project: string, ok: true, services: ServiceStatus[] }
    | { project: string, ok: false, code: RefusalCode, message: string }
export type StatusesReply = { ok: true, projects: ProjectStatus[] }
export type LifecycleReply = { ok: true, output: string }
// Provisioning never starts a site on its own: an operator still has to fill in the env files this
// names before lifecycle start makes sense, which is what state carries across the wire.
export type ProvisionReply = { ok: true, project: { id: string, state: 'needs-setup' }, envFiles: EnvFileList }
export type EnvListReply = { ok: true, files: EnvFileList }
export type EnvReadReply = { ok: true, text: string }
// A deploy is minutes of building and api's own call timeout is 150 seconds, so a deploy, a rollback and
// a branch switch all answer as soon as the work has started. The outcome lands in the history below.
export type DeployStartedReply = { ok: true, started: { environment: EnvironmentName, trigger: DeployTrigger } }
export type DeployHistoryReply = {
    ok: true
    environment: EnvironmentName
    branch: string | null
    deployed: string | null
    paused: boolean
    consecutiveFailures: number
    deploys: DeployRecord[]
}
export type DeployCommitsReply = { ok: true, commits: Commit[] }
export type StreamHeader = { ok: true, stream: true }
export type AgentReply =
    | HealthReply | StatusReply | StatusesReply | LifecycleReply | ProvisionReply | EnvListReply | EnvReadReply
    | DeployStartedReply | DeployHistoryReply | DeployCommitsReply | Refusal
export type LogLine = { stream: 'stdout' | 'stderr', ts: string | null, text: string, truncated: boolean }

// Status is visible to anyone who may see the project at all; everything else needs its capability.
export const VERB_CAPABILITY: Record<Verb, Capability | null> = {
    health: null,
    status: null,
    statuses: null,
    lifecycle: 'lifecycle',
    logs: 'logs',
    provision: 'provision',
    env: 'env',
    // Reading the history and the commit list is the half of this a client may use; api's policy is
    // where that split lives, because only api knows who is asking.
    deploy: 'deploy',
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

function parseProvisionCreate(raw: Record<string, unknown>): Parsed {
    if (!onlyKeys(raw, ['verb', 'args'])) return refuse('bad-request', 'provision create takes only args')
    const args = raw.args as Record<string, unknown>
    if (!onlyKeys(args, ['action', 'id', 'client', 'name', 'repo', 'branch', 'domain', 'certificate'])) {
        return refuse('bad-request', 'create takes only id, client, name, repo, branch, domain and certificate')
    }
    if (typeof args.id !== 'string') return refuse('bad-request', 'id is malformed')
    if (typeof args.client !== 'string') return refuse('bad-request', 'client is malformed')
    if (typeof args.name !== 'string') return refuse('bad-request', 'name is malformed')
    if (typeof args.repo !== 'string') return refuse('bad-request', 'repo is malformed')
    if (typeof args.branch !== 'string') return refuse('bad-request', 'branch is malformed')
    const domain = args.domain
    if (domain !== null && typeof domain !== 'string') return refuse('bad-request', 'domain is malformed')
    const certificate = args.certificate
    if (certificate !== null && !(CERTIFICATE_MODES as readonly string[]).includes(certificate as string)) return refuse('bad-request', 'certificate is malformed')
    return {
        ok: true,
        request: {
            verb: 'provision',
            args: {
                action: 'create', id: args.id, client: args.client, name: args.name, repo: args.repo, branch: args.branch,
                domain: domain as string | null, certificate: certificate as CertificateMode | null,
            },
        },
    }
}

function parseProvisionAddEnvironment(raw: Record<string, unknown>): Parsed {
    if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'provision takes only project and args')
    const project = projectOf(raw)
    if (!project) return refuse('bad-request', 'project is malformed')
    const args = raw.args as Record<string, unknown>
    if (!onlyKeys(args, ['action', 'environment', 'branch', 'domain', 'certificate'])) {
        return refuse('bad-request', 'add-environment takes only environment, branch, domain and certificate')
    }
    if (args.environment !== 'test') return refuse('bad-request', 'environment must be test')
    if (typeof args.branch !== 'string') return refuse('bad-request', 'branch is malformed')
    const domain = args.domain
    if (domain !== null && typeof domain !== 'string') return refuse('bad-request', 'domain is malformed')
    const certificate = args.certificate
    if (certificate !== null && !(CERTIFICATE_MODES as readonly string[]).includes(certificate as string)) return refuse('bad-request', 'certificate is malformed')
    return {
        ok: true,
        request: {
            verb: 'provision', project,
            args: { action: 'add-environment', environment: 'test', branch: args.branch, domain: domain as string | null, certificate: certificate as CertificateMode | null },
        },
    }
}

function parseProvisionRemove(raw: Record<string, unknown>): Parsed {
    if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'provision takes only project and args')
    const project = projectOf(raw)
    if (!project) return refuse('bad-request', 'project is malformed')
    const args = raw.args as Record<string, unknown>
    if (!onlyKeys(args, ['action', 'environment'])) return refuse('bad-request', 'remove takes only environment')
    const environment = args.environment
    if (environment !== null && !(ENVIRONMENTS as readonly string[]).includes(environment as string)) {
        return refuse('bad-request', 'environment must be live, test or null')
    }
    return {
        ok: true,
        request: { verb: 'provision', project, args: { action: 'remove', environment: environment as EnvironmentName | null } },
    }
}

function parseProvisionRequest(raw: Record<string, unknown>): Parsed {
    if (!isRecord(raw.args) || typeof raw.args.action !== 'string') return refuse('bad-request', 'provision requires args.action')
    switch (raw.args.action) {
        case 'create': return parseProvisionCreate(raw)
        case 'add-environment': return parseProvisionAddEnvironment(raw)
        case 'remove': return parseProvisionRemove(raw)
        default: return refuse('bad-request', 'action must be create, add-environment or remove')
    }
}

function parseEnvArgs(raw: unknown): EnvArgs | Refusal {
    if (!isRecord(raw)) return refuse('bad-request', 'env requires args')
    const environment = raw.environment
    if (typeof environment !== 'string' || !(ENVIRONMENTS as readonly string[]).includes(environment)) {
        return refuse('bad-request', 'environment must be live or test')
    }
    if (raw.action === 'list') {
        if (!onlyKeys(raw, ['action', 'environment'])) return refuse('bad-request', 'list takes only environment')
        return { action: 'list', environment: environment as EnvironmentName }
    }
    if (raw.action === 'read') {
        if (!onlyKeys(raw, ['action', 'environment', 'path'])) return refuse('bad-request', 'read takes only environment and path')
        if (typeof raw.path !== 'string') return refuse('bad-request', 'path is malformed')
        return { action: 'read', environment: environment as EnvironmentName, path: raw.path }
    }
    if (raw.action === 'write') {
        if (!onlyKeys(raw, ['action', 'environment', 'path', 'text'])) return refuse('bad-request', 'write takes only environment, path and text')
        if (typeof raw.path !== 'string') return refuse('bad-request', 'path is malformed')
        if (typeof raw.text !== 'string') return refuse('bad-request', 'text is malformed')
        return { action: 'write', environment: environment as EnvironmentName, path: raw.path, text: raw.text }
    }
    return refuse('bad-request', 'action must be list, read or write')
}

function parseDeployArgs(raw: unknown): DeployArgs | Refusal {
    if (!isRecord(raw)) return refuse('bad-request', 'deploy requires args')
    const environment = raw.environment
    if (typeof environment !== 'string' || !(ENVIRONMENTS as readonly string[]).includes(environment)) {
        return refuse('bad-request', 'environment must be live or test')
    }
    const name = environment as EnvironmentName

    if (raw.action === 'deploy' || raw.action === 'rollback' || raw.action === 'history') {
        if (!onlyKeys(raw, ['action', 'environment'])) return refuse('bad-request', `${raw.action} takes only environment`)
        return { action: raw.action, environment: name }
    }
    if (raw.action === 'set-branch') {
        if (!onlyKeys(raw, ['action', 'environment', 'branch'])) return refuse('bad-request', 'set-branch takes only environment and branch')
        if (typeof raw.branch !== 'string' || !GIT_REF.test(raw.branch)) return refuse('bad-request', 'branch must be a plain branch name')
        return { action: 'set-branch', environment: name, branch: raw.branch }
    }
    if (raw.action === 'commits') {
        if (!onlyKeys(raw, ['action', 'environment', 'limit'])) return refuse('bad-request', 'commits takes only environment and limit')
        const limit = raw.limit === undefined ? DEFAULT_COMMITS : raw.limit
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_COMMITS) {
            return refuse('bad-request', `limit must be a whole number from 1 to ${MAX_COMMITS}`)
        }
        return { action: 'commits', environment: name, limit }
    }
    return refuse('bad-request', 'action must be deploy, rollback, set-branch, history or commits')
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

        case 'statuses': {
            if (!onlyKeys(raw, ['verb', 'projects'])) return refuse('bad-request', 'statuses takes only projects')
            if (!Array.isArray(raw.projects)) return refuse('bad-request', 'projects must be a list')
            if (raw.projects.length > MAX_STATUS_PROJECTS) return refuse('bad-request', `statuses takes at most ${MAX_STATUS_PROJECTS} projects`)
            const projects: string[] = []
            for (const value of raw.projects) {
                if (typeof value !== 'string' || !PROJECT_ID.test(value)) return refuse('bad-request', 'a project id is malformed')
                // Deduplicated here rather than in the handler, so a caller cannot multiply the Docker
                // work by repeating one id. The list is short enough that a scan beats a Set.
                if (!projects.includes(value)) projects.push(value)
            }
            return { ok: true, request: { verb: 'statuses', projects } }
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

        case 'provision':
            return parseProvisionRequest(raw)

        case 'env': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'env takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            const args = parseEnvArgs(raw.args)
            if ('ok' in args) return args
            return { ok: true, request: { verb: 'env', project, args } }
        }

        case 'deploy': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'deploy takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            const args = parseDeployArgs(raw.args)
            if ('ok' in args) return args
            return { ok: true, request: { verb: 'deploy', project, args } }
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
    // Every other verb reads the compose file or its mounts, directly or by asking the agent to touch
    // them, so a project the guard has just failed must stay refused. Removing a project touches no files
    // at all, so it is safe regardless, and a guard failure is exactly the kind of problem that makes an
    // operator want to unregister the project in the first place.
    const removingProject = request.verb === 'provision' && request.args.action === 'remove'
    const guardProblem = guardInvalid.get(id)
    if (guardProblem !== undefined && !removingProject) return refuse('invalid-project', `${id} is invalid: ${guardProblem}`)

    const capability = VERB_CAPABILITY[request.verb]
    if (capability && !project.capabilities.has(capability)) return refuse('capability-disabled', `${capability} is not enabled for ${id}`)

    if (request.verb === 'logs') {
        const service = request.args.service
        const entry = Object.hasOwn(project.services, service) ? project.services[service] : undefined
        if (!entry || !isComposeService(entry)) return refuse('unknown-service', `${service} is not a registered service of ${id}`)
    }
    if ((request.verb === 'env' || request.verb === 'deploy') && !environmentOf(project, request.args.environment)) {
        return refuse('unknown-environment', `${id} has no ${request.args.environment} environment`)
    }
    return { ok: true, project }
}
