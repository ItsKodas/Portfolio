// The storage guard. Checked against compose's own resolved configuration, so includes, extends and
// relative paths are all accounted for. Its central rule: a client must never be able to write a file
// that compose reads, because editing one and pressing start is root on the dedi.

import { posix } from 'node:path'
import { isWithin, overlaps } from '../shared/formats.ts'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import { composeNameProblem, type ResolvedCompose, type ResolvedService } from './compose.ts'

function withoutTrailingSlashPath(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

// Every host directory this service bind-mounts, whatever its mode. Unlike bindSources below, which the
// storage guard uses to find the site's declared storage, this is for confining mounts: a bind source that
// is not inside the environment's own tree or one of its registered storage paths is a mount of somebody
// else's files (or the host root, or the docker socket), which a client's repo must never be able to add.
function serviceBindSources(service: ResolvedService): string[] {
    return (service.volumes ?? [])
        .filter(volume => volume.type === 'bind' && typeof volume.source === 'string')
        .map(volume => withoutTrailingSlashPath(volume.source as string))
}

function networkNamesOf(service: ResolvedService): string[] {
    const networks = service.networks
    if (Array.isArray(networks)) return networks
    if (networks && typeof networks === 'object') return Object.keys(networks)
    return []
}

// The container-escape policy. A client's repo owns its compose file and a deploy brings it up with the
// host Docker daemon, so without this a pushed compose could mount the host root or the docker socket, run
// privileged, share the host's network, pid or ipc namespaces, add capabilities or devices, loosen its
// seccomp or AppArmor profile, or join an external network that reaches hostd's own api. Any of those is
// root on the dedi or a reach into another tenant. Bind sources are confined to the environment's own tree
// and its registered storage; the flags are refused outright.
export function composeSafetyProblems(resolved: ResolvedCompose, allowedBindRoots: string[]): string[] {
    const problems: string[] = []
    const roots = allowedBindRoots.map(withoutTrailingSlashPath)
    const externalNetworks = new Set(
        Object.entries(resolved.networks ?? {})
            .filter(([, network]) => network?.external)
            .map(([name]) => name),
    )

    for (const [name, service] of Object.entries(resolved.services)) {
        const at = (problem: string) => problems.push(`service ${name} ${problem}`)

        if (service.privileged) at('is privileged')
        const mode = service.network_mode
        if (mode && (mode === 'host' || mode.startsWith('host:') || mode.startsWith('container:'))) {
            at(`uses network_mode ${mode}`)
        }
        if (service.pid === 'host' || service.pid?.startsWith('container:')) at(`shares the host or another container's pid namespace (${service.pid})`)
        if (service.ipc === 'host' || service.ipc?.startsWith('container:')) at(`shares the host or another container's ipc namespace (${service.ipc})`)
        if (service.userns_mode === 'host') at('uses userns_mode host')
        if ((service.cap_add ?? []).length > 0) at(`adds capabilities (${(service.cap_add ?? []).join(', ')})`)
        if ((service.devices ?? []).length > 0) at('maps host devices')
        for (const option of service.security_opt ?? []) {
            if (option.includes('unconfined') || option.includes('label:disable')) at(`loosens its security profile (${option})`)
        }

        for (const source of serviceBindSources(service)) {
            if (!roots.some(root => isWithin(root, source))) at(`bind-mounts ${source}, which is outside its own files`)
        }

        for (const network of networkNamesOf(service)) {
            if (externalNetworks.has(network)) at(`joins the external network ${network}`)
        }
    }
    return problems
}

function withoutTrailingSlash(path: string): string {
    return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

function bindSources(service: ResolvedService): string[] {
    return (service.volumes ?? [])
        .filter(volume => volume.type === 'bind' && typeof volume.source === 'string')
        .map(volume => withoutTrailingSlash(volume.source as string))
}

// Everything compose reads for this service: env files, the build context and the Dockerfile. Contexts
// that are URLs (a git repository) are not on this disk, so they cannot be written by a client.
function readsOf(service: ResolvedService): string[] {
    const reads: string[] = []
    for (const envFile of service.env_file ?? []) {
        const path = typeof envFile === 'string' ? envFile : envFile.path
        if (typeof path === 'string') reads.push(path)
    }
    const build = typeof service.build === 'string' ? { context: service.build } : service.build
    if (build?.context?.startsWith('/')) {
        const context = withoutTrailingSlash(build.context)
        reads.push(context)
        if (build.dockerfile) reads.push(build.dockerfile.startsWith('/') ? build.dockerfile : posix.join(context, build.dockerfile))
    }
    return reads
}

export function guardProblems(project: ProjectEntry, resolved: ResolvedCompose): string[] {
    const problems: string[] = []
    const nameProblem = composeNameProblem(resolved.name, project.id)
    if (nameProblem) problems.push(nameProblem)

    const siteSources: string[] = []
    const databaseSources: string[] = []
    for (const [name, entry] of Object.entries(project.services)) {
        if (!isComposeService(entry)) continue
        const service = Object.hasOwn(resolved.services, name) ? resolved.services[name] : undefined
        if (!service) {
            problems.push(`service ${name} is not in the compose file`)
            continue
        }
        if (entry.role === 'site') siteSources.push(...bindSources(service))
        else databaseSources.push(...bindSources(service))
    }

    // The container-escape policy, against the project's own tree and its registered storage. The deploy
    // pipeline runs the same check against the candidate tree before it builds, so a dangerous push is
    // refused before it is brought up; this catch is for a live compose edited in place by hand.
    const bindRoots = [project.dir, ...Object.values(project.storage).map(storage => storage.absolute)]
    problems.push(...composeSafetyProblems(resolved, bindRoots))

    const reads = [...project.composePaths, posix.join(project.dir, '.env')]
    for (const service of Object.values(resolved.services)) reads.push(...readsOf(service))

    for (const [name, storage] of Object.entries(project.storage)) {
        if (!siteSources.includes(storage.absolute)) {
            problems.push(`storage ${name} (${storage.absolute}) is not bind-mounted into a site service`)
        }
        if (databaseSources.some(source => overlaps(source, storage.absolute))) {
            problems.push(`storage ${name} overlaps a database service's mount`)
        }
        for (const read of reads) {
            if (isWithin(storage.absolute, read)) problems.push(`storage ${name} contains ${read}, which compose reads`)
        }
    }
    return problems
}

// Advice for the operator, never a reason to refuse anything: unlike guardProblems, this never reaches
// GuardTracker's invalid map, so it can never make checkStructure refuse status, logs, lifecycle or env
// for a project that is otherwise working fine. That distinction matters here specifically: the overlap
// rule above (`storage ... overlaps a database service's mount`) can only ever fire against a service
// actually marked database, so a project with no service marked database at all (a fresh guess from
// compose.ts's resolveNewProject got it wrong, or a hand enrollment simply has it wrong, or the project
// genuinely has no database) passes that rule with nothing to compare against, not because it is safe but
// because nothing has checked. Making that a hard invalidation instead of a warning would have taken a
// working, already-deployed site offline the moment an unrelated registry edit put it through the guard
// again, with no way to clear it for a project that really has no database.
export function guardAdvisories(project: ProjectEntry): string[] {
    const advisories: string[] = []
    if (Object.keys(project.storage).length > 0 && !Object.values(project.services).some(entry => entry.role === 'database')) {
        advisories.push(
            `project ${project.id} declares storage but no service with role database; if one of its ` +
            'services is a database, correct its role so the storage guard can protect it',
        )
    }
    return advisories
}
