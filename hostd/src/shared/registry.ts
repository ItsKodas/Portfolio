// The operator's registry of client projects. Hand-edited, read by both processes, never written by
// either. A problem with one project marks only that project invalid; a problem with the file as a
// whole throws, so the caller can keep the last good version instead.

import { parse } from 'yaml'
import { posix } from 'node:path'
import {
    PROJECT_ID, CLIENT_ID, SERVICE_NAME, STORAGE_NAME, ENV_NAME, HOSTNAME, RESERVED_PROJECT_IDS,
    isRecord, relativePathProblem, overlaps,
} from './formats.ts'

export const CAPABILITIES = ['lifecycle', 'logs', 'files', 'backups', 'domains'] as const
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

export type ProjectEntry = {
    id: string
    client: string
    name: string
    dir: string
    compose: string[]
    composePaths: string[]
    upstream: { host: string, port: number }
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
const PROJECT_KEYS = new Set(['client', 'name', 'dir', 'compose', 'upstream', 'services', 'storage', 'capabilities', 'maxDomains', 'backups'])
const DIR = /^\/var\/www\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const UPSTREAM = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/

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
function parseCompose(raw: unknown, problems: string[]): string[] {
    if (raw === undefined) return DEFAULT_COMPOSE
    const list = Array.isArray(raw) ? raw : [raw]
    if (list.length === 0) {
        problems.push('compose must name at least one file')
        return []
    }
    if (list.length > MAX_COMPOSE_FILES) {
        problems.push(`compose may not name more than ${MAX_COMPOSE_FILES} files`)
        return []
    }
    const files: string[] = []
    for (const value of list) {
        const problem = typeof value === 'string' ? relativePathProblem(value) : 'path must be a string'
        if (problem) {
            problems.push(`compose: ${problem}`)
            continue
        }
        const file = value as string
        // The same file twice merges it over itself, which is a mistake rather than an intention.
        if (files.includes(file)) problems.push(`compose lists ${file} twice`)
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

type ParsedProject = { entry: ProjectEntry } | { problems: string[] }

function parseProject(id: string, raw: unknown): ParsedProject {
    if (!PROJECT_ID.test(id)) return { problems: [`id must match ${PROJECT_ID}`] }
    if (RESERVED_PROJECT_IDS.has(id)) return { problems: [`${id} is reserved for the operator's own stacks`] }
    if (!isRecord(raw)) return { problems: ['entry must be a mapping'] }

    const problems: string[] = []
    for (const key of Object.keys(raw)) if (!PROJECT_KEYS.has(key)) problems.push(`unknown key ${key}`)

    const client = typeof raw.client === 'string' && CLIENT_ID.test(raw.client) ? raw.client : null
    if (!client) problems.push(`client must match ${CLIENT_ID}`)
    const name = typeof raw.name === 'string' && raw.name.length >= 1 && raw.name.length <= 100 ? raw.name : null
    if (!name) problems.push('name must be 1 to 100 characters')
    const dir = typeof raw.dir === 'string' && DIR.test(raw.dir) && !raw.dir.endsWith('/..') && !raw.dir.endsWith('/.') ? raw.dir : null
    if (!dir) problems.push('dir must be /var/www/<one segment>')

    const compose = parseCompose(raw.compose, problems)

    const upstream = parseUpstream(raw.upstream, problems)
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

    if (problems.length > 0 || !client || !name || !dir || !upstream) return { problems }
    return {
        entry: {
            id, client, name, dir, compose,
            composePaths: compose.map(file => posix.join(dir, file)),
            upstream, services, storage, capabilities, maxDomains,
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
        const result = parseProject(id, raw)
        if ('problems' in result) invalid.set(id, result.problems.join('; '))
        else parsed.set(id, result.entry)
    }

    // Two entries over one directory would let one client's settings drive another client's site.
    const projects = new Map<string, ProjectEntry>()
    for (const [id, entry] of parsed) {
        const sharing = [...parsed.values()].filter(other => other.id !== id && other.dir === entry.dir).map(other => other.id)
        if (sharing.length > 0) invalid.set(id, `dir ${entry.dir} is also used by ${sharing.join(', ')}`)
        else projects.set(id, entry)
    }

    return { reserved, offsite: { keep: offsiteKeep }, projects, invalid }
}
