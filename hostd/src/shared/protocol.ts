// The only language the agent speaks. One JSON request line per connection, answered by one JSON line,
// or by a header line followed by a stream. Parsing is strict on purpose: the agent is root, so anything
// it does not recognise, including an extra field, is refused rather than ignored.

import { CLIENT_ID, DIR_NAME, PROJECT_ID, SERVICE_NAME, isRecord, relativePathProblem } from './formats.ts'
import {
    isComposeService, environmentOf, ENVIRONMENTS, ENVIRONMENT_FLAGS, CAPABILITIES, CERTIFICATE_MODES, GIT_REF, CREDENTIAL_NAME, MAX_COMPOSE_FILES,
    type Capability, type CertificateMode, type EnvironmentFlag, type EnvironmentName, type Keep, type ProjectEntry, type Registry,
} from './registry.ts'
import { normaliseHostname } from './hostnames.ts'
import { PORT_RANGE, type OwnPort } from './ports.ts'
import type { Commit } from './fetch-protocol.ts'
import type { DeployRecord, DeployTrigger } from './deploys.ts'
import type { EnvFileList } from './envfiles.ts'
import type { SystemUsage } from './system.ts'
import { BACKUP_ACTORS, BACKUP_TAGS, type BackupActor, type BackupRecord, type BackupTag, type Snapshot } from './backups.ts'

export const MAX_REQUEST_BYTES = 64 * 1024
// A download's body is framed: a decimal byte count on its own line, then exactly that many bytes, and a
// final `0\n` terminator the agent writes only once its source has exited cleanly. The terminator is what
// makes completeness something the reader is told rather than something it infers from a socket closing,
// which on a Unix stream socket carries no failure information at all.
//
// The cap bounds what one frame may claim, for the same reason logframes.ts caps a Docker log frame: no
// real chunk comes anywhere near it, so a larger length means the bytes are not what we think they are,
// and buffering towards it would exhaust memory. The writer splits oversize chunks to respect it, so the
// two sides can never disagree about what is sane.
export const MAX_BODY_FRAME_BYTES = 16 * 1024 * 1024
export const BODY_TERMINATOR = '0\n'
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
    // Absent for a site the operator runs for themselves, which then belongs to no client
    client?: string
    name: string
    repo: string
    // Optional, unlike repo: a project created without one uses the default token, which is every
    // project on the operator's own GitHub account.
    credential?: string
    branch: string
    domain: string | null
    certificate: CertificateMode | null
    // The folder's name under /var/www. Absent means the id.
    dir?: string
    // Relative to that folder, in compose's merge order. Absent means docker-compose.yml alone.
    compose?: string[]
    // Absent means none, which is what every create before this field got
    capabilities?: Capability[]
    websockets?: boolean
    flexibleSsl?: boolean
    // The live environment's port. Absent means hostd chooses the lowest free one, which is what the
    // runbook's hand calls and every create before this field got.
    port?: number
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

// Restic's own short ids are hex, and this is checked here, where every other request shape is checked,
// so a malformed id can never reach a repository path or a command.
export const SNAPSHOT_ID = /^[0-9a-f]{8,64}$/
// The agent's own run id, which it generates; validated on the way back in for the same reason.
export const RUN_ID = /^[0-9a-f]{8,32}$/

// actor says which kind of caller asked, so a client's own backup is not recorded as the operator's. It
// is a label for the run history and never a permission: the agent enforces the capability, the locks,
// the manual cap, the cooldown and the disk for itself whatever arrives here, and a scheduled run is
// recorded as hostd regardless of what was sent.
export type BackupRunArgs = { action: 'run', tag: BackupTag, keep?: Keep, actor?: BackupActor }
export type BackupListArgs = { action: 'list' }
export type BackupGetRunArgs = { action: 'get-run', run: string }
export type BackupDeleteArgs = { action: 'delete', snapshot: string }
export type BackupDownloadArgs = { action: 'download', snapshot: string }
export type BackupArgs = BackupRunArgs | BackupListArgs | BackupGetRunArgs | BackupDeleteArgs | BackupDownloadArgs
export type BackupRequest = { verb: 'backup', project: string, args: BackupArgs }

export type BackupStartedReply = { ok: true, started: { run: string, tag: BackupTag } }
export type BackupListReply = { ok: true, snapshots: Snapshot[], runs: BackupRecord[], running: boolean }
export type BackupRunReply = { ok: true, run: BackupRecord | null, running: boolean }

// The registry's own ceiling on maxDomains. A list longer than this cannot be valid for any project, so
// it is refused here before the registry is even read; the real per-project cap is checked in the agent,
// which is what knows which project this is.
export const MAX_ALIASES = 20

export type DomainsWriteArgs = { action: 'write', environment: EnvironmentName, token: string }
export type DomainsRemoveArgs = { action: 'remove', environment: EnvironmentName }
// Carries a token, exactly like write, because api mints and stores one token per hostname and passes
// the SAME token to preview and to adopt: that is what makes the previewed file byte-accurate against
// what adopt will actually write, rather than differing from it in every security-relevant line.
export type DomainsPreviewArgs = { action: 'preview', environment: EnvironmentName, token: string }
export type DomainsAdoptArgs = { action: 'adopt', environment: EnvironmentName, token: string, disable: string[] }
// Adoption undone: the vhost hostd wrote goes away and the files adopt moved aside come back, in one
// reload. `restore` carries the same sites-enabled paths adopt was given as `disable`.
//
// It exists because an adoption can pass Apache's configtest, reload cleanly, be reported a success and
// still take the site off the internet, which is exactly what thebackroom.dev did. Whether that happened
// can only be decided by asking the hostname, and the agent runs network_mode: none, so api is what
// asks and this is what api calls when the answer is worse than it was. No token, because nothing is
// rendered: this call only takes files away and puts files back.
export type DomainsRestoreArgs = { action: 'restore', environment: EnvironmentName, restore: string[] }
// set-aliases is how an alias is added or removed. It carries the whole list the environment should end
// up with rather than one hostname and a direction, because the agent writes the registry and then
// rewrites the vhost from it: a list makes the pair idempotent, so a retry after a half-failure lands in
// the same place instead of adding the alias twice. It carries the token too, because the vhost is
// rewritten in the same call and the token has to survive that rewrite.
export type DomainsSetAliasesArgs = { action: 'set-aliases', environment: EnvironmentName, aliases: string[], token: string }
export type DomainsArgs =
    DomainsWriteArgs | DomainsRemoveArgs | DomainsPreviewArgs | DomainsAdoptArgs | DomainsRestoreArgs | DomainsSetAliasesArgs
export type DomainsRequest = { verb: 'domains', project: string, args: DomainsArgs }

// The domains verb's own replies. Defined here rather than in agent/domains.ts, which is what builds
// them, because everything else this wire speaks lives here too, and shared/ must never import from
// agent/: agent/domains.ts imports these back from this file instead.
export type DomainsWritten = { ok: true, written: { hostnames: string[], path: string } }
export type AdoptPreview = {
    ok: true
    preview: {
        proposed: string
        // text is the claiming file verbatim. The handful of directives this parser reads are not the
        // whole of what a hand-written vhost does, and adoption replaces the file rather than merging
        // with it, so the operator is shown all of it before they confirm. Spelled out here rather than
        // imported, because shared/ must never import from agent/.
        //
        // unsupported is every reason this file cannot be adopted, and an empty list means none was
        // found. A list rather than one string because a file can be several kinds of unadoptable at
        // once, which is exactly what thebackroom.dev was, and being told them one at a time is how an
        // outage lasts an afternoon.
        claims: { path: string, text: string, names: string[], unsupported: string[] }[]
        extraNames: string[]
        // Paths in sites-enabled that could not be opened at all, so nothing is known about them, not
        // even whether they name one of these hostnames. Usually a symlink whose target has gone. They
        // block no write, since a file Apache cannot read serves nothing, but they do fail Apache's
        // configuration test, so the operator is shown them before adopting rather than after.
        unreadable: string[]
        adoptable: boolean
        // Whether the proposed vhost serves the site on port 80 for a CDN in Flexible mode, because a file
        // being replaced answered port 80 only. Adopting switches the environment's Flexible SSL on.
        flexibleSsl: boolean
    }
}

// Editing the registry entry itself: capabilities, repo, each environment's branch and each
// environment's domain. Absent fields are left alone, and a null repo or branch clears that key.
export type ConfigureArgs = {
    capabilities?: Capability[]
    repo?: string | null
    // The name of one of the fetcher's tokens, never a token. null clears the key, which puts the
    // project back on the default GITHUB_TOKEN.
    credential?: string | null
    branches?: Partial<Record<EnvironmentName, string | null>>
    // No null member, unlike branches: this gives an environment an address or moves it to another one,
    // and never takes one away. Moving it rewrites the vhost hostd owns (see the agent's configure), so
    // the caller is expected to have confirmed it with whoever asked for it.
    domains?: Partial<Record<EnvironmentName, string>>
    // Whether each environment's vhost passes WebSocket upgrades through. Changing it rewrites the vhost
    // hostd owns, if it owns one yet; an environment still served by hand only has it recorded, for the
    // adoption that writes hostd's file to render.
    websockets?: Partial<Record<EnvironmentName, boolean>>
    // Whether each environment's origin serves the site on port 80 for a CDN in Flexible mode, rather than
    // redirecting it to https. Rewrites the vhost exactly as websockets does.
    flexibleSsl?: Partial<Record<EnvironmentName, boolean>>
}
export type ConfigureRequest = { verb: 'configure', project: string, args: ConfigureArgs }

// A project's own repo, read for the portal's Settings form to offer branches from. No environment: repo
// is a project-level field and both environments draw from the one list.
export type BranchesRequest = { verb: 'branches', project: string }

// Which credential names the fetcher holds, for the Settings form's Account select. No project: this is
// a fact about the machine, not about a site.
export type CredentialsRequest = { verb: 'credentials' }

// Whether a port is free, for the portal's live check, and the lowest one that is. No project: this is a
// question about the machine. own names the environment the port is for, whose current port is its own.
// Advice only: a create or a port change checks again, under the provisioning lock.
export type PortsArgs = { port: number | null, own: OwnPort | null }
export type PortsRequest = { verb: 'ports', args: PortsArgs }

export type ProjectRequest =
    | StatusRequest | LifecycleRequest | LogsRequest | ProvisionOnProjectRequest | EnvRequest | DeployRequest
    | BackupRequest | DomainsRequest | ConfigureRequest | BranchesRequest
export type AgentRequest = HealthRequest | StatusesRequest | ProvisionCreateRequest | CredentialsRequest | PortsRequest | ProjectRequest
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
// railAge is how long ago the rail last heard back from the Apache host unit, in milliseconds, carried
// out of the agent process so api can serve it at /health. An age and never a timestamp: api compares it
// against a staleness threshold, and a timestamp would be larger than any threshold, so the alarm would
// fire forever. null means the rail has never once heard back, not that it recently failed. Task 14 uses this to warn when the host unit has gone quiet, which nothing else surfaces before
// a domain action hangs for 30 seconds and then fails.
export type HealthReply = { ok: true, warnings: string[], invalid: Record<string, string>, system: SystemUsage, railAge: number | null }
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
export type BranchesReply = { ok: true, branches: string[] }
export type CredentialsReply = { ok: true, credentials: string[] }
export type PortsReply = { ok: true, suggested: number, problem: string | null }
// What configure put on the host, one entry per environment whose address moved onto a vhost hostd
// already owned. Deliberately the same hostnames-and-path shape DomainsWritten carries, with the
// environment added because configure takes several at once: api turns both into the same records, so a
// second spelling of the same fact would only give the two paths a way to drift.
//
// An empty list is the answer that matters most. It means hostd serves no vhost for that environment, so
// nothing about what Apache is serving has changed and no hostname has anything new to prove.
export type ConfigureWritten = { environment: EnvironmentName, hostnames: string[], path: string }
export type ConfigureReply = { ok: true, output: string, written: ConfigureWritten[] }
export type StreamHeader = { ok: true, stream: true }
export type AgentReply =
    | HealthReply | StatusReply | StatusesReply | LifecycleReply | ProvisionReply | EnvListReply | EnvReadReply
    | DeployStartedReply | DeployHistoryReply | DeployCommitsReply | BranchesReply | CredentialsReply | PortsReply | ConfigureReply
    | BackupStartedReply | BackupListReply | BackupRunReply
    | DomainsWritten | AdoptPreview | Refusal
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
    backup: 'backups',
    domains: 'domains',
    // Null, and this is load bearing. Gating the verb that edits capabilities on a capability would mean
    // a project with none could never be given any, which is exactly the project that needs this. What
    // guards it is api's policy, where it is admin-only.
    configure: null,
    // Null for the same reason: the list exists to fill the Settings form's branch field, and requiring a
    // capability would leave it empty on exactly the site an operator is setting deploys up on. Guarded
    // the same way configure is, by api's policy rather than by a capability.
    branches: null,
    // Null for the same reason branches is: it fills the Settings form, and api's policy is what makes
    // it admin-only.
    credentials: null,
    // Null for the same reason: api's policy makes it admin-only.
    ports: null,
}

type Parsed = { ok: true, request: AgentRequest } | Refusal

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

const isWholeCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0

// The client's retention, already clamped to the project ceiling by api. The agent re-clamps when it
// applies it, so this only has to reject a shape that is not a Keep at all.
function isKeep(value: unknown): value is Keep {
    return isRecord(value) && onlyKeys(value, ['daily', 'weekly', 'monthly'])
        && isWholeCount(value.daily) && isWholeCount(value.weekly) && isWholeCount(value.monthly)
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

// The keys a create may carry, said once for both parsers of it: api's HTTP body and the agent's own
// request line.
export const CREATE_KEYS = [
    'id', 'client', 'name', 'repo', 'credential', 'branch', 'domain', 'certificate',
    'dir', 'compose', 'capabilities', 'websockets', 'flexibleSsl', 'port',
] as const

type CreateExtras = Pick<ProvisionCreateArgs, 'client' | 'dir' | 'compose' | 'capabilities' | 'websockets' | 'flexibleSsl' | 'port'>

// The optional half of a create, shared by both parsers and by the agent's own check so the three cannot
// drift. Each field is either absent or fully valid by the time it comes back: grammar here, and what is
// on disk and in the registry is still createProject's to check.
export function parseCreateExtras(raw: Record<string, unknown>): { ok: true, extras: CreateExtras } | { ok: false, message: string } {
    const extras: CreateExtras = {}
    if (raw.client !== undefined) {
        if (typeof raw.client !== 'string' || !CLIENT_ID.test(raw.client)) return { ok: false, message: 'client is malformed' }
        extras.client = raw.client
    }
    if (raw.dir !== undefined) {
        if (typeof raw.dir !== 'string' || !DIR_NAME.test(raw.dir)) {
            return { ok: false, message: 'dir must be one folder name: lowercase letters, digits, hyphens and underscores' }
        }
        extras.dir = raw.dir
    }
    if (raw.compose !== undefined) {
        const list = raw.compose
        if (!Array.isArray(list) || list.length === 0 || list.length > MAX_COMPOSE_FILES) {
            return { ok: false, message: `compose must name 1 to ${MAX_COMPOSE_FILES} files` }
        }
        for (const file of list) {
            if (typeof file !== 'string') return { ok: false, message: 'compose is malformed' }
            const problem = relativePathProblem(file)
            if (problem) return { ok: false, message: `compose file ${file}: ${problem}` }
        }
        if (new Set(list).size !== list.length) return { ok: false, message: 'compose names a file twice' }
        extras.compose = list as string[]
    }
    if (raw.capabilities !== undefined) {
        const list = raw.capabilities
        if (!Array.isArray(list) || !list.every(item => (CAPABILITIES as readonly unknown[]).includes(item))) {
            return { ok: false, message: `capabilities must be drawn from ${CAPABILITIES.join(', ')}` }
        }
        if (new Set(list).size !== list.length) return { ok: false, message: 'capabilities names one twice' }
        extras.capabilities = list as Capability[]
    }
    for (const flag of ['websockets', 'flexibleSsl'] as const) {
        if (raw[flag] === undefined) continue
        if (typeof raw[flag] !== 'boolean') return { ok: false, message: `${flag} must be true or false` }
        extras[flag] = raw[flag] as boolean
    }
    if (raw.port !== undefined) {
        // The range only: whether a port is free is the agent's to say, against the registry and the host
        if (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < PORT_RANGE.from || raw.port > PORT_RANGE.to) {
            return { ok: false, message: `port must be a whole number from ${PORT_RANGE.from} to ${PORT_RANGE.to}` }
        }
        extras.port = raw.port
    }
    return { ok: true, extras }
}

function parseProvisionCreate(raw: Record<string, unknown>): Parsed {
    if (!onlyKeys(raw, ['verb', 'args'])) return refuse('bad-request', 'provision create takes only args')
    const args = raw.args as Record<string, unknown>
    if (!onlyKeys(args, ['action', ...CREATE_KEYS])) {
        return refuse('bad-request', `create takes only ${CREATE_KEYS.join(', ')}`)
    }
    if (typeof args.id !== 'string') return refuse('bad-request', 'id is malformed')
    const extras = parseCreateExtras(args)
    if (!extras.ok) return refuse('bad-request', extras.message)
    if (typeof args.name !== 'string') return refuse('bad-request', 'name is malformed')
    if (typeof args.repo !== 'string') return refuse('bad-request', 'repo is malformed')
    if (args.credential !== undefined && (typeof args.credential !== 'string' || !CREDENTIAL_NAME.test(args.credential))) {
        return refuse('bad-request', 'credential must be 1 to 32 lowercase letters, digits or underscores')
    }
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
                action: 'create', id: args.id, name: args.name, repo: args.repo,
                ...(args.credential !== undefined ? { credential: args.credential as string } : {}),
                branch: args.branch, domain: domain as string | null, certificate: certificate as CertificateMode | null,
                ...extras.extras,
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

function parseBackupArgs(raw: unknown): BackupArgs | Refusal {
    if (!isRecord(raw)) return refuse('bad-request', 'backup needs args')
    if (raw.action === 'run') {
        if (!onlyKeys(raw, ['action', 'tag', 'keep', 'actor'])) return refuse('bad-request', 'run takes only action, tag, keep and actor')
        if (!(BACKUP_TAGS as readonly unknown[]).includes(raw.tag)) return refuse('bad-request', 'backup run needs a tag of manual or scheduled')
        // keep is the client's retention, which api clamped to the registry ceiling before it ever got
        // here; the agent re-clamps when it applies it.
        if (raw.keep !== undefined && !isKeep(raw.keep)) return refuse('bad-request', 'keep must hold whole daily, weekly and monthly counts')
        // Checked like every other field, even though nothing is decided on it, so only the two words the
        // portal draws can ever reach a record the client reads back.
        if (raw.actor !== undefined && !(BACKUP_ACTORS as readonly unknown[]).includes(raw.actor)) {
            return refuse('bad-request', `actor must be one of ${BACKUP_ACTORS.join(', ')}`)
        }
        return {
            action: 'run', tag: raw.tag as BackupTag,
            ...(raw.keep !== undefined ? { keep: raw.keep as Keep } : {}),
            ...(raw.actor !== undefined ? { actor: raw.actor as BackupActor } : {}),
        }
    }
    if (raw.action === 'list') {
        if (!onlyKeys(raw, ['action'])) return refuse('bad-request', 'list takes only action')
        return { action: 'list' }
    }
    if (raw.action === 'get-run') {
        if (!onlyKeys(raw, ['action', 'run'])) return refuse('bad-request', 'get-run takes only action and run')
        if (typeof raw.run !== 'string' || !RUN_ID.test(raw.run)) return refuse('bad-request', 'get-run needs a run id')
        return { action: 'get-run', run: raw.run }
    }
    if (raw.action === 'delete' || raw.action === 'download') {
        if (!onlyKeys(raw, ['action', 'snapshot'])) return refuse('bad-request', `${raw.action} takes only action and snapshot`)
        if (typeof raw.snapshot !== 'string' || !SNAPSHOT_ID.test(raw.snapshot)) return refuse('bad-request', 'a snapshot id must be hex')
        return { action: raw.action, snapshot: raw.snapshot }
    }
    return refuse('bad-request', 'backup action must be run, list, get-run, delete or download')
}

// Hex only, and bounded. This string is interpolated into a <Location> and into a header value in the
// vhost, so it is the one value from api that reaches Apache's configuration. Nothing that could be read
// as a path, a quote or a directive is allowed to be a token.
export const DOMAIN_TOKEN = /^[0-9a-f]{6,64}$/
// The only directory an adopt may disable a file in. Checked here as well as in the agent, because this
// is where a value from api first becomes something a root process will act on.
const SITES_ENABLED = '/etc/apache2/sites-enabled/'

export function parseDomainsArgs(args: unknown): { ok: true, args: DomainsArgs } | Refusal {
    if (!isRecord(args)) return refuse('bad-request', 'domains args must be an object')
    const environment = args.environment
    if (typeof environment !== 'string' || !(ENVIRONMENTS as readonly string[]).includes(environment)) {
        return refuse('bad-request', `environment must be one of ${ENVIRONMENTS.join(', ')}`)
    }
    const name = environment as EnvironmentName

    const token = (): string | null => (typeof args.token === 'string' && DOMAIN_TOKEN.test(args.token) ? args.token : null)

    switch (args.action) {
        case 'write': {
            if (!onlyKeys(args, ['action', 'environment', 'token'])) return refuse('bad-request', 'write takes only environment and token')
            const value = token()
            if (value === null) return refuse('bad-request', 'token must be lowercase hex')
            return { ok: true, args: { action: 'write', environment: name, token: value } }
        }
        case 'remove':
            if (!onlyKeys(args, ['action', 'environment'])) return refuse('bad-request', 'remove takes only environment')
            return { ok: true, args: { action: 'remove', environment: name } }
        case 'preview': {
            if (!onlyKeys(args, ['action', 'environment', 'token'])) return refuse('bad-request', 'preview takes only environment and token')
            const value = token()
            if (value === null) return refuse('bad-request', 'token must be lowercase hex')
            return { ok: true, args: { action: 'preview', environment: name, token: value } }
        }
        case 'adopt': {
            if (!onlyKeys(args, ['action', 'environment', 'token', 'disable'])) {
                return refuse('bad-request', 'adopt takes only environment, token and disable')
            }
            const value = token()
            if (value === null) return refuse('bad-request', 'token must be lowercase hex')
            const disable = args.disable
            // An empty list is allowed, and deliberately so: adopt is the only route to a vhost hostd
            // owns, and an environment nobody has hand-written a file for has nothing to displace. What
            // adopt means is "hostd owns this environment's vhost from now on, moving aside whatever
            // was in the way, if anything", not "there must have been something in the way".
            if (!Array.isArray(disable)) return refuse('bad-request', 'disable must be a list of files to move aside')
            for (const path of disable) {
                if (typeof path !== 'string' || !path.startsWith(SITES_ENABLED) || path.includes('/..') || path.includes('/.')) {
                    return refuse('bad-request', 'every disable entry must be a plain path inside sites-enabled')
                }
            }
            return { ok: true, args: { action: 'adopt', environment: name, token: value, disable: disable as string[] } }
        }
        case 'restore': {
            if (!onlyKeys(args, ['action', 'environment', 'restore'])) {
                return refuse('bad-request', 'restore takes only environment and restore')
            }
            const restore = args.restore
            // An empty list is allowed for the same reason adopt's is: an adoption that displaced
            // nothing is still an adoption, and undoing it still means taking hostd's own vhost away.
            if (!Array.isArray(restore)) return refuse('bad-request', 'restore must be a list of files to put back')
            for (const path of restore) {
                if (typeof path !== 'string' || !path.startsWith(SITES_ENABLED) || path.includes('/..') || path.includes('/.')) {
                    return refuse('bad-request', 'every restore entry must be a plain path inside sites-enabled')
                }
            }
            return { ok: true, args: { action: 'restore', environment: name, restore: restore as string[] } }
        }
        case 'set-aliases': {
            if (!onlyKeys(args, ['action', 'environment', 'aliases', 'token'])) {
                return refuse('bad-request', 'set-aliases takes only environment, aliases and token')
            }
            const value = token()
            if (value === null) return refuse('bad-request', 'token must be lowercase hex')
            const list = args.aliases
            if (!Array.isArray(list)) return refuse('bad-request', 'aliases must be a list of hostnames')
            // maxDomains caps at 20 per project, so a longer list cannot be valid for any project and is
            // refused before the registry is even read. The real per-project cap is checked in the agent,
            // which is what knows which project this is.
            if (list.length > MAX_ALIASES) return refuse('bad-request', `at most ${MAX_ALIASES} aliases`)
            const aliases: string[] = []
            for (const entry of list) {
                const host = normaliseHostname(entry)
                if (host === null) return refuse('bad-request', 'every alias must be a hostname')
                if (aliases.includes(host)) return refuse('bad-request', `${host} is listed twice`)
                aliases.push(host)
            }
            return { ok: true, args: { action: 'set-aliases', environment: name, aliases, token: value } }
        }
        default:
            return refuse('bad-request', 'domains action must be write, remove, preview, adopt, restore or set-aliases')
    }
}

// Shapes and grammar both: api's route reuses this rather than checking the shape a second time, so a
// body it could not read is refused in exactly one place. See policy.ts and routes.ts in api for how the
// route bridges this Refusal shape onto its own parsers' { ok: false, message }.
export function parseConfigureArgs(raw: unknown): ConfigureArgs | Refusal {
    if (!isRecord(raw) || !onlyKeys(raw, ['capabilities', 'repo', 'credential', 'branches', 'domains', 'websockets', 'flexibleSsl'])) {
        return refuse('bad-request', 'configure takes only capabilities, repo, credential, branches, domains, websockets and flexibleSsl')
    }

    let capabilities: Capability[] | undefined
    if (raw.capabilities !== undefined) {
        if (!Array.isArray(raw.capabilities) || !raw.capabilities.every(value => typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value))) {
            return refuse('bad-request', 'capabilities must be a list of known capabilities')
        }
        capabilities = raw.capabilities as Capability[]
    }

    let repo: string | null | undefined
    if (raw.repo !== undefined) {
        if (raw.repo !== null && typeof raw.repo !== 'string') return refuse('bad-request', 'repo is malformed')
        repo = raw.repo as string | null
    }

    let credential: string | null | undefined
    if (raw.credential !== undefined) {
        if (raw.credential !== null && (typeof raw.credential !== 'string' || !CREDENTIAL_NAME.test(raw.credential))) {
            return refuse('bad-request', 'credential must be 1 to 32 lowercase letters, digits or underscores')
        }
        credential = raw.credential as string | null
    }

    let branches: Partial<Record<EnvironmentName, string | null>> | undefined
    if (raw.branches !== undefined) {
        if (!isRecord(raw.branches)) return refuse('bad-request', 'branches is malformed')
        const parsed: Partial<Record<EnvironmentName, string | null>> = {}
        for (const [name, branch] of Object.entries(raw.branches)) {
            if (!(ENVIRONMENTS as readonly string[]).includes(name)) return refuse('bad-request', `${name} is not an environment`)
            if (branch !== null && (typeof branch !== 'string' || !GIT_REF.test(branch))) {
                return refuse('bad-request', `${name} branch must be null or a plain branch name`)
            }
            parsed[name as EnvironmentName] = branch
        }
        branches = parsed
    }

    let domains: Partial<Record<EnvironmentName, string>> | undefined
    if (raw.domains !== undefined) {
        if (!isRecord(raw.domains)) return refuse('bad-request', 'domains is malformed')
        const parsed: Partial<Record<EnvironmentName, string>> = {}
        for (const [name, domain] of Object.entries(raw.domains)) {
            if (!(ENVIRONMENTS as readonly string[]).includes(name)) return refuse('bad-request', `${name} is not an environment`)
            // Unlike branches, null is not a value here: an address can be given or moved, never taken
            // away.
            // normaliseHostname is the one place that decides what a hostname is, and it answers the
            // single spelling the registry should hold whichever way the operator typed it.
            const host = normaliseHostname(domain)
            if (host === null) return refuse('bad-request', `${name} domain must be a hostname`)
            parsed[name as EnvironmentName] = host
        }
        domains = parsed
    }

    // Both render-only switches share one shape: a mapping of environment to true or false.
    const flags: Partial<Record<EnvironmentFlag, Partial<Record<EnvironmentName, boolean>>>> = {}
    for (const key of ENVIRONMENT_FLAGS) {
        const value = raw[key]
        if (value === undefined) continue
        if (!isRecord(value)) return refuse('bad-request', `${key} is malformed`)
        const parsed: Partial<Record<EnvironmentName, boolean>> = {}
        for (const [name, enabled] of Object.entries(value)) {
            if (!(ENVIRONMENTS as readonly string[]).includes(name)) return refuse('bad-request', `${name} is not an environment`)
            if (typeof enabled !== 'boolean') return refuse('bad-request', `${name} ${key} must be true or false`)
            parsed[name as EnvironmentName] = enabled
        }
        flags[key] = parsed
    }

    return {
        ...(capabilities !== undefined ? { capabilities } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(credential !== undefined ? { credential } : {}),
        ...(branches !== undefined ? { branches } : {}),
        ...(domains !== undefined ? { domains } : {}),
        ...flags,
    }
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

        case 'credentials': {
            if (!onlyKeys(raw, ['verb'])) return refuse('bad-request', 'credentials takes no other keys')
            return { ok: true, request: { verb: 'credentials' } }
        }

        case 'ports': {
            if (!onlyKeys(raw, ['verb', 'args'])) return refuse('bad-request', 'ports takes only args')
            if (!isRecord(raw.args) || !onlyKeys(raw.args, ['port', 'own'])) return refuse('bad-request', 'ports takes only args.port and args.own')
            const { port, own } = raw.args
            // Any whole port number: the range is part of the answer (portProblem says it), not a refusal
            if (port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
                return refuse('bad-request', 'port must be null or a whole number from 1 to 65535')
            }
            if (own !== null && (!isRecord(own) || !onlyKeys(own, ['project', 'environment'])
                || typeof own.project !== 'string' || !PROJECT_ID.test(own.project)
                || !(ENVIRONMENTS as readonly unknown[]).includes(own.environment))) {
                return refuse('bad-request', 'own must be null or a project and one of its environments')
            }
            return { ok: true, request: { verb: 'ports', args: { port: port as number | null, own: own as OwnPort | null } } }
        }

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

        case 'backup': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'backup takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            const args = parseBackupArgs(raw.args)
            if ('ok' in args) return args
            return { ok: true, request: { verb: 'backup', project, args } }
        }

        case 'domains': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'domains takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            const parsed = parseDomainsArgs(raw.args)
            if (!parsed.ok) return parsed
            return { ok: true, request: { verb: 'domains', project, args: parsed.args } }
        }

        case 'configure': {
            if (!onlyKeys(raw, ['verb', 'project', 'args'])) return refuse('bad-request', 'configure takes only project and args')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            const args = parseConfigureArgs(raw.args)
            if ('ok' in args) return args
            return { ok: true, request: { verb: 'configure', project, args } }
        }

        case 'branches': {
            if (!onlyKeys(raw, ['verb', 'project'])) return refuse('bad-request', 'branches takes only project')
            const project = projectOf(raw)
            if (!project) return refuse('bad-request', 'project is malformed')
            return { ok: true, request: { verb: 'branches', project } }
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
