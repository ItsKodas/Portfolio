// The operator's registry of client projects. Hand-edited day to day, and read by every process; the
// agent is also a writer now, but only for provisioning, and only through registry-write.ts's own narrow,
// validated path. A problem with one project marks only that project invalid; a problem with the file as
// a whole throws, so the caller can keep the last good version instead.

import { parse } from 'yaml'
import { posix } from 'node:path'
import {
    PROJECT_ID, CLIENT_ID, SERVICE_NAME, STORAGE_NAME, ENV_NAME, HOSTNAME, RESERVED_PROJECT_IDS,
    isRecord, relativePathProblem, overlaps,
} from './formats.ts'

export const CAPABILITIES = ['lifecycle', 'logs', 'files', 'backups', 'domains', 'provision', 'env'] as const
export type Capability = typeof CAPABILITIES[number]
export const ENGINES = ['postgres', 'mysql', 'mariadb', 'mongodb', 'sqlite', 'redis', 'generic'] as const
export type Engine = typeof ENGINES[number]
export const STORAGE_MODES = ['rw', 'ro', 'hidden'] as const
export type StorageMode = typeof STORAGE_MODES[number]
export type Keep = { daily: number, weekly: number, monthly: number }

export type SiteService = { role: 'site' }
export type DatabaseService = { role: 'database', engine: Exclude<Engine, 'sqlite'>, dump: { userEnv?: string, passwordEnv?: string } }
export type SqliteDatabase = { role: 'database', engine: 'sqlite', file: string }
export type ServiceEntry = SiteService | DatabaseService | SqliteDatabase
export type StorageEntry = { path: string, absolute: string, mode: StorageMode }

export const ENVIRONMENTS = ['live', 'test'] as const
export type EnvironmentName = typeof ENVIRONMENTS[number]

export const CERTIFICATE_MODES = ['letsencrypt', 'cloudflare-origin'] as const
export type CertificateMode = typeof CERTIFICATE_MODES[number]

export type EnvironmentEntry = {
    name: EnvironmentName
    dir: string
    composePaths: string[]
    branch: string | null
    domain: string | null
    port: number
    certificate: CertificateMode | null
    deployed: string | null
}

// A git ref or branch name that cannot be read as an option or a path traversal. Git itself also
// forbids two dots anywhere (".." is range syntax, so "main..other" would resolve as a second,
// unrelated revision rather than a single branch) and a name ending in .lock or a bare trailing dot.
export const GIT_REF = /^(?!.*\.\.)(?!.*\.lock$)(?!.*\.$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/
export const GIT_COMMIT = /^[0-9a-f]{7,40}$/
// ssh (git@host:owner/repo.git) or https (https://host/owner/repo.git)
export const GIT_REPO = /^(git@[A-Za-z0-9.-]+:[A-Za-z0-9._\/-]+\.git|https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._\/-]+(\.git)?)$/

export const DEFAULT_LIMITS = { memory: '1g', cpus: '1' }
export const DEFAULT_PORT_ENV = 'WEB_PORT'

export type ProjectEntry = {
    id: string
    client: string
    name: string
    repo: string | null
    dir: string
    compose: string[]
    composePaths: string[]
    upstream: { host: string, port: number }
    portEnv: string
    limits: { memory: string | null, cpus: string | null }
    environments: Map<EnvironmentName, EnvironmentEntry>
    services: Record<string, ServiceEntry>
    storage: Record<string, StorageEntry>
    capabilities: Set<Capability>
    maxDomains: number
    backups: { maxKeep: Keep }
}

export type Registry = {
    reserved: string[]
    offsite: { keep: Keep }
    projects: Map<string, ProjectEntry>
    invalid: Map<string, string>
}

export class RegistryError extends Error {
    constructor(readonly failures: string[]) {
        super(`Invalid registry:\n  ${failures.join('\n  ')}`)
        this.name = 'RegistryError'
    }
}

// SQLite lives in a file the site container opens, not in a compose service of its own.
export function isComposeService(entry: ServiceEntry): boolean {
    return !(entry.role === 'database' && entry.engine === 'sqlite')
}

// Compose merges -f files left to right, so the registry's order is the operator's order. The cap keeps
// the argv bounded: a base file and a handful of overrides is every real shape of this.
export const MAX_COMPOSE_FILES = 8
const DEFAULT_COMPOSE = ['docker-compose.yml']

const DEFAULT_OFFSITE_KEEP: Keep = { daily: 14, weekly: 8, monthly: 6 }
const DEFAULT_MAX_KEEP: Keep = { daily: 14, weekly: 8, monthly: 12 }
const DEFAULT_RESERVED = ['horizons.gg']
const TOP_KEYS = new Set(['reserved', 'offsite', 'projects'])
const PROJECT_KEYS = new Set([
    'client', 'name', 'dir', 'compose', 'upstream', 'services', 'storage', 'capabilities', 'maxDomains', 'backups',
    'repo', 'portEnv', 'limits', 'environments',
])
const ENVIRONMENT_KEYS = new Set(['dir', 'compose', 'branch', 'domain', 'port', 'certificate', 'deployed'])
const DIR = /^\/var\/www\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const UPSTREAM = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/
const MEMORY_LIMIT = /^[0-9]+(b|k|m|g)$/i
const CPU_LIMIT = /^[0-9]+(\.[0-9]+)?$/

function wholeNumber(value: unknown, min: number, max: number): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key))
}

function parseKeep(raw: unknown, fallback: Keep, where: string, problems: string[]): Keep {
    if (raw === undefined) return fallback
    if (!isRecord(raw)) {
        problems.push(`${where} must be a mapping`)
        return fallback
    }
    const keep = { ...fallback }
    for (const [key, value] of Object.entries(raw)) {
        if (key !== 'daily' && key !== 'weekly' && key !== 'monthly') {
            problems.push(`${where}.${key} is not a known key`)
            continue
        }
        const count = wholeNumber(value, 0, 1000)
        if (count === null) problems.push(`${where}.${key} must be a whole number from 0 to 1000`)
        else keep[key] = count
    }
    return keep
}

function parseUpstream(raw: unknown, problems: string[]): { host: string, port: number } | null {
    const match = typeof raw === 'string' ? raw.match(UPSTREAM) : null
    const port = match ? Number(match[2]) : 0
    if (!match || !match[1] || port < 1 || port > 65535) {
        problems.push('upstream must be <IPv4 address or localhost>:<port 1 to 65535>')
        return null
    }
    return { host: match[1], port }
}

// One file or several. A site whose host-specific settings live in an override is only described
// correctly when every file compose merges is named here: passing an explicit -f stops compose picking
// up docker-compose.override.yml by itself, so an unnamed override is an override hostd cannot see.
// Shared by the project-level compose key and each environment's own compose key (prefix says which).
function parseCompose(raw: unknown, problems: string[], prefix = 'compose'): string[] {
    if (raw === undefined) return DEFAULT_COMPOSE
    const list = Array.isArray(raw) ? raw : [raw]
    if (list.length === 0) {
        problems.push(`${prefix} must name at least one file`)
        return []
    }
    if (list.length > MAX_COMPOSE_FILES) {
        problems.push(`${prefix} may not name more than ${MAX_COMPOSE_FILES} files`)
        return []
    }
    const files: string[] = []
    for (const value of list) {
        const problem = typeof value === 'string' ? relativePathProblem(value) : 'path must be a string'
        if (problem) {
            problems.push(`${prefix}: ${problem}`)
            continue
        }
        const file = value as string
        // The same file twice merges it over itself, which is a mistake rather than an intention.
        if (files.includes(file)) problems.push(`${prefix} lists ${file} twice`)
        else files.push(file)
    }
    return files
}

function parseService(name: string, raw: unknown, problems: string[]): ServiceEntry | null {
    const where = `services.${name}`
    if (!SERVICE_NAME.test(name)) {
        problems.push(`service name ${name} is malformed`)
        return null
    }
    if (!isRecord(raw)) {
        problems.push(`${where} must be a mapping`)
        return null
    }
    if (raw.role === 'site') {
        if (!onlyKeys(raw, ['role'])) problems.push(`${where} with role site takes no other keys`)
        return { role: 'site' }
    }
    if (raw.role !== 'database') {
        problems.push(`${where}.role must be site or database`)
        return null
    }
    if (typeof raw.engine !== 'string' || !(ENGINES as readonly string[]).includes(raw.engine)) {
        problems.push(`${where}.engine must be one of ${ENGINES.join(', ')}`)
        return null
    }
    if (raw.engine === 'sqlite') {
        if (!onlyKeys(raw, ['role', 'engine', 'file'])) problems.push(`${where} with engine sqlite takes only role, engine and file`)
        const problem = typeof raw.file === 'string' ? relativePathProblem(raw.file) : 'file is required'
        if (problem) {
            problems.push(`${where}.file: ${problem}`)
            return null
        }
        return { role: 'database', engine: 'sqlite', file: raw.file as string }
    }
    if (!onlyKeys(raw, ['role', 'engine', 'dump'])) problems.push(`${where} takes only role, engine and dump`)
    const dump: { userEnv?: string, passwordEnv?: string } = {}
    if (raw.dump !== undefined) {
        if (!isRecord(raw.dump) || !onlyKeys(raw.dump, ['userEnv', 'passwordEnv'])) {
            problems.push(`${where}.dump may only contain userEnv and passwordEnv`)
        } else {
            for (const key of ['userEnv', 'passwordEnv'] as const) {
                const value = raw.dump[key]
                if (value === undefined) continue
                if (typeof value !== 'string' || !ENV_NAME.test(value)) problems.push(`${where}.dump.${key} must be an environment variable name`)
                else dump[key] = value
            }
        }
    }
    return { role: 'database', engine: raw.engine as Exclude<Engine, 'sqlite'>, dump }
}

function parseServices(raw: unknown, problems: string[]): Record<string, ServiceEntry> {
    const services: Record<string, ServiceEntry> = {}
    if (!isRecord(raw) || Object.keys(raw).length === 0) {
        problems.push('services must be a non-empty mapping')
        return services
    }
    for (const [name, value] of Object.entries(raw)) {
        const entry = parseService(name, value, problems)
        if (entry) services[name] = entry
    }
    if (!Object.values(services).some(entry => entry.role === 'site')) problems.push('at least one service must have role site')
    return services
}

function parseStorage(raw: unknown, dir: string, services: Record<string, ServiceEntry>, problems: string[]): Record<string, StorageEntry> {
    const storage: Record<string, StorageEntry> = {}
    if (raw === undefined) return storage
    if (!isRecord(raw)) {
        problems.push('storage must be a mapping')
        return storage
    }
    for (const [name, value] of Object.entries(raw)) {
        const where = `storage.${name}`
        if (!STORAGE_NAME.test(name)) {
            problems.push(`storage name ${name} is malformed`)
            continue
        }
        if (!isRecord(value) || !onlyKeys(value, ['path', 'mode'])) {
            problems.push(`${where} must be a mapping of path and mode`)
            continue
        }
        const pathProblem = typeof value.path === 'string' ? relativePathProblem(value.path) : 'path is required'
        if (pathProblem) {
            problems.push(`${where}.path: ${pathProblem}`)
            continue
        }
        if (typeof value.mode !== 'string' || !(STORAGE_MODES as readonly string[]).includes(value.mode)) {
            problems.push(`${where}.mode must be one of ${STORAGE_MODES.join(', ')}`)
            continue
        }
        const path = value.path as string
        storage[name] = { path, absolute: posix.join(dir, path), mode: value.mode as StorageMode }
    }

    const entries = Object.entries(storage)
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [a, first] = entries[i]!
            const [b, second] = entries[j]!
            if (overlaps(first.absolute, second.absolute)) problems.push(`storage ${a} and ${b} overlap`)
        }
    }
    for (const [name, entry] of entries) {
        for (const service of Object.values(services)) {
            if (service.role === 'database' && service.engine === 'sqlite' && overlaps(entry.absolute, posix.join(dir, service.file))) {
                problems.push(`storage ${name} overlaps the SQLite file ${service.file}`)
            }
        }
    }
    return storage
}

function parseCapabilities(raw: unknown, problems: string[]): Set<Capability> {
    const capabilities = new Set<Capability>()
    if (raw === undefined) return capabilities
    if (!Array.isArray(raw)) {
        problems.push('capabilities must be a list')
        return capabilities
    }
    for (const value of raw) {
        if (typeof value !== 'string' || !(CAPABILITIES as readonly string[]).includes(value)) {
            problems.push(`unknown capability ${String(value)}`)
            continue
        }
        if (capabilities.has(value as Capability)) problems.push(`capability ${value} is listed twice`)
        capabilities.add(value as Capability)
    }
    return capabilities
}

function parseRepo(raw: unknown, problems: string[]): string | null {
    if (raw === undefined) return null
    if (typeof raw === 'string' && GIT_REPO.test(raw)) return raw
    problems.push('repo must be an ssh or https git URL')
    return null
}

function parsePortEnv(raw: unknown, problems: string[]): string {
    if (raw === undefined) return DEFAULT_PORT_ENV
    if (typeof raw === 'string' && ENV_NAME.test(raw)) return raw
    problems.push('portEnv must be an environment variable name')
    return DEFAULT_PORT_ENV
}

function parseLimits(raw: unknown, problems: string[]): { memory: string | null, cpus: string | null } {
    const limits = { ...DEFAULT_LIMITS }
    if (raw === undefined) return limits
    if (!isRecord(raw) || !onlyKeys(raw, ['memory', 'cpus'])) {
        problems.push('limits may only contain memory and cpus')
        return limits
    }
    if (raw.memory !== undefined) {
        if (typeof raw.memory === 'string' && MEMORY_LIMIT.test(raw.memory)) limits.memory = raw.memory
        else problems.push('limits.memory must be a number followed by b, k, m or g')
    }
    if (raw.cpus !== undefined) {
        if (typeof raw.cpus === 'string' && CPU_LIMIT.test(raw.cpus)) limits.cpus = raw.cpus
        else problems.push('limits.cpus must be a number')
    }
    return limits
}

// Same shape as today's project dir: exactly one segment below /var/www, and not . or .. at the end.
function parseEnvironmentDir(raw: unknown): string | null {
    return typeof raw === 'string' && DIR.test(raw) && !raw.endsWith('/..') && !raw.endsWith('/.') ? raw : null
}

function isReserved(domain: string, reserved: string[]): boolean {
    return reserved.some(host => domain === host || domain.endsWith(`.${host}`))
}

function parseEnvironment(name: EnvironmentName, raw: unknown, reserved: string[], problems: string[]): EnvironmentEntry | null {
    const where = `environments.${name}`
    if (!isRecord(raw)) {
        problems.push(`${where} must be a mapping`)
        return null
    }
    for (const key of Object.keys(raw)) if (!ENVIRONMENT_KEYS.has(key)) problems.push(`${where}.${key} is not a known key`)

    const dir = parseEnvironmentDir(raw.dir)
    if (!dir) problems.push(`${where}.dir must be /var/www/<one segment>`)

    const compose = parseCompose(raw.compose, problems, `${where}.compose`)

    let branch: string | null = null
    if (raw.branch !== undefined) {
        if (typeof raw.branch === 'string' && GIT_REF.test(raw.branch)) branch = raw.branch
        else problems.push(`${where}.branch must be a plain branch name`)
    }

    let domain: string | null = null
    if (raw.domain !== undefined) {
        if (typeof raw.domain !== 'string' || !HOSTNAME.test(raw.domain)) problems.push(`${where}.domain must be a lowercase hostname`)
        else if (isReserved(raw.domain, reserved)) problems.push(`${where}.domain must not be at or below a reserved domain`)
        else domain = raw.domain
    }

    const port = wholeNumber(raw.port, 1, 65535)
    if (port === null) problems.push(`${where}.port must be a whole number from 1 to 65535`)

    let certificate: CertificateMode | null = null
    if (raw.certificate !== undefined) {
        if (typeof raw.certificate === 'string' && (CERTIFICATE_MODES as readonly string[]).includes(raw.certificate)) {
            certificate = raw.certificate as CertificateMode
        } else problems.push(`${where}.certificate must be one of ${CERTIFICATE_MODES.join(', ')}`)
    }

    let deployed: string | null = null
    if (raw.deployed !== undefined) {
        if (typeof raw.deployed === 'string' && GIT_COMMIT.test(raw.deployed)) deployed = raw.deployed
        else problems.push(`${where}.deployed must be a commit hash`)
    }

    if (!dir || port === null) return null
    return { name, dir, composePaths: compose.map(file => posix.join(dir, file)), branch, domain, port, certificate, deployed }
}

// When environments is absent, the caller synthesises a single live entry from the project-level
// dir, compose and upstream fields instead of calling this.
function parseEnvironments(raw: unknown, reserved: string[], problems: string[]): Map<EnvironmentName, EnvironmentEntry> {
    const environments = new Map<EnvironmentName, EnvironmentEntry>()
    if (!isRecord(raw)) {
        problems.push('environments must be a mapping')
        return environments
    }
    if (raw.live === undefined) problems.push('environments must include live')
    for (const key of Object.keys(raw)) if (!(ENVIRONMENTS as readonly string[]).includes(key)) problems.push(`environments.${key} is not a known environment`)

    for (const name of ENVIRONMENTS) {
        if (raw[name] === undefined) continue
        const entry = parseEnvironment(name, raw[name], reserved, problems)
        if (entry) environments.set(name, entry)
    }

    const live = environments.get('live')
    const test = environments.get('test')
    if (live && test) {
        if (live.dir === test.dir) problems.push(`environments live and test share dir ${live.dir}`)
        if (live.port === test.port) problems.push(`environments live and test share port ${live.port}`)
    }
    return environments
}

type ParsedProject = { entry: ProjectEntry } | { problems: string[] }

function parseProject(id: string, raw: unknown, reserved: string[]): ParsedProject {
    if (!PROJECT_ID.test(id)) return { problems: [`id must match ${PROJECT_ID}`] }
    if (RESERVED_PROJECT_IDS.has(id)) return { problems: [`${id} is reserved for the operator's own stacks`] }
    if (!isRecord(raw)) return { problems: ['entry must be a mapping'] }

    const problems: string[] = []
    for (const key of Object.keys(raw)) if (!PROJECT_KEYS.has(key)) problems.push(`unknown key ${key}`)

    const client = typeof raw.client === 'string' && CLIENT_ID.test(raw.client) ? raw.client : null
    if (!client) problems.push(`client must match ${CLIENT_ID}`)
    const name = typeof raw.name === 'string' && raw.name.length >= 1 && raw.name.length <= 100 ? raw.name : null
    if (!name) problems.push('name must be 1 to 100 characters')

    const repo = parseRepo(raw.repo, problems)
    const portEnv = parsePortEnv(raw.portEnv, problems)
    const limits = parseLimits(raw.limits, problems)

    const usesEnvironments = raw.environments !== undefined
    if (usesEnvironments && (raw.dir !== undefined || raw.compose !== undefined || raw.upstream !== undefined)) {
        problems.push('dir and environments cannot both be given')
    }

    let environments: Map<EnvironmentName, EnvironmentEntry>
    let upstream: { host: string, port: number } | null
    if (usesEnvironments) {
        environments = parseEnvironments(raw.environments, reserved, problems)
        // There is no per-environment host field (yet), so the live environment is always reached
        // through the loopback address. This is the one place upstream.host is not carried from input.
        const liveForUpstream = environments.get('live')
        upstream = liveForUpstream ? { host: '127.0.0.1', port: liveForUpstream.port } : null
    } else {
        const dir = typeof raw.dir === 'string' && DIR.test(raw.dir) && !raw.dir.endsWith('/..') && !raw.dir.endsWith('/.') ? raw.dir : null
        if (!dir) problems.push('dir must be /var/www/<one segment>')

        const compose = parseCompose(raw.compose, problems)

        // Carried through untouched: a legacy entry's upstream host (localhost or an IPv4 address) must
        // keep meaning exactly what it means today, not be silently rewritten to 127.0.0.1.
        upstream = parseUpstream(raw.upstream, problems)
        environments = new Map<EnvironmentName, EnvironmentEntry>()
        if (dir && upstream) {
            environments.set('live', {
                name: 'live', dir, composePaths: compose.map(file => posix.join(dir, file)),
                branch: null, domain: null, port: upstream.port, certificate: null, deployed: null,
            })
        }
    }

    if (!repo && [...environments.values()].some(env => env.branch !== null)) problems.push('branch needs repo')

    const live = environments.get('live')
    const dir = live?.dir ?? null
    // The project-level compose key mirrors the live environment's, the same way dir and upstream already
    // do, so a single-environment (live only) entry keeps meaning what it always meant.
    const compose = live ? live.composePaths.map(path => posix.relative(live.dir, path)) : DEFAULT_COMPOSE
    const composePaths = live?.composePaths ?? null

    const services = parseServices(raw.services, problems)
    const storage = parseStorage(raw.storage, dir ?? '/nonexistent', services, problems)
    const capabilities = parseCapabilities(raw.capabilities, problems)

    let maxDomains = 3
    if (raw.maxDomains !== undefined) {
        const value = wholeNumber(raw.maxDomains, 1, 20)
        if (value === null) problems.push('maxDomains must be a whole number from 1 to 20')
        else maxDomains = value
    }

    let maxKeep = DEFAULT_MAX_KEEP
    if (raw.backups !== undefined) {
        if (!isRecord(raw.backups) || !onlyKeys(raw.backups, ['maxKeep'])) problems.push('backups may only contain maxKeep')
        else maxKeep = parseKeep(raw.backups.maxKeep, DEFAULT_MAX_KEEP, 'backups.maxKeep', problems)
    }

    if (problems.length > 0 || !client || !name || !dir || !upstream || !composePaths) return { problems }
    return {
        entry: {
            id, client, name, repo, dir, compose, composePaths, upstream, portEnv, limits, environments,
            services, storage, capabilities, maxDomains,
            backups: { maxKeep },
        },
    }
}

export function parseRegistry(text: string): Registry {
    let doc: unknown
    try {
        doc = parse(text)
    } catch (error) {
        throw new RegistryError([`not valid YAML: ${error instanceof Error ? error.message : String(error)}`])
    }
    if (!isRecord(doc)) throw new RegistryError(['the registry must be a mapping with a projects key'])

    const failures: string[] = []
    for (const key of Object.keys(doc)) if (!TOP_KEYS.has(key)) failures.push(`unknown top-level key ${key}`)

    let reserved = DEFAULT_RESERVED
    if (doc.reserved !== undefined) {
        const list = doc.reserved
        if (!Array.isArray(list) || !list.every(host => typeof host === 'string' && HOSTNAME.test(host))) {
            failures.push('reserved must be a list of lowercase hostnames')
        } else {
            reserved = list as string[]
        }
    }

    let offsiteKeep = DEFAULT_OFFSITE_KEEP
    if (doc.offsite !== undefined) {
        if (!isRecord(doc.offsite) || !onlyKeys(doc.offsite, ['keep'])) failures.push('offsite may only contain keep')
        else offsiteKeep = parseKeep(doc.offsite.keep, DEFAULT_OFFSITE_KEEP, 'offsite.keep', failures)
    }

    if (!isRecord(doc.projects)) failures.push('projects must be a mapping')
    if (failures.length > 0) throw new RegistryError(failures)

    const parsed = new Map<string, ProjectEntry>()
    const invalid = new Map<string, string>()
    for (const [id, raw] of Object.entries(doc.projects as Record<string, unknown>)) {
        const result = parseProject(id, raw, reserved)
        if ('problems' in result) invalid.set(id, result.problems.join('; '))
        else parsed.set(id, result.entry)
    }

    // Two entries over one directory would let one client's settings drive another client's site. Two
    // entries over one port would let one client's domain proxy to another client's container. Two
    // entries over one domain would let either one serve the other's traffic. Every environment counts,
    // not just the live one, and each message names whichever value actually collided rather than always
    // the project's live one. This is what makes the invariant hold even if a lock elsewhere does not:
    // a hand-edited registry, or two provisioning writes that both raced past a lock, still cannot produce
    // a file hostd will load with either collision in it.
    const projects = new Map<string, ProjectEntry>()
    for (const [id, entry] of parsed) {
        const messages: string[] = []
        for (const env of entry.environments.values()) {
            const sharingDir = [...parsed.values()]
                .filter(other => other.id !== id && [...other.environments.values()].some(otherEnv => otherEnv.dir === env.dir))
                .map(other => other.id)
            if (sharingDir.length > 0) messages.push(`dir ${env.dir} is also used by ${sharingDir.join(', ')}`)

            const sharingPort = [...parsed.values()]
                .filter(other => other.id !== id && [...other.environments.values()].some(otherEnv => otherEnv.port === env.port))
                .map(other => other.id)
            if (sharingPort.length > 0) messages.push(`port ${env.port} is also used by ${sharingPort.join(', ')}`)

            if (env.domain !== null) {
                const sharingDomain = [...parsed.values()]
                    .filter(other => other.id !== id && [...other.environments.values()].some(otherEnv => otherEnv.domain === env.domain))
                    .map(other => other.id)
                if (sharingDomain.length > 0) messages.push(`domain ${env.domain} is also used by ${sharingDomain.join(', ')}`)
            }
        }
        if (messages.length > 0) invalid.set(id, messages.join('; '))
        else projects.set(id, entry)
    }

    return { reserved, offsite: { keep: offsiteKeep }, projects, invalid }
}

export function environmentOf(project: ProjectEntry, name: string): EnvironmentEntry | null {
    return (ENVIRONMENTS as readonly string[]).includes(name)
        ? project.environments.get(name as EnvironmentName) ?? null
        : null
}
