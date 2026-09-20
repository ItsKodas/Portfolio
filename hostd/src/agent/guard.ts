// The storage guard. Checked against compose's own resolved configuration, so includes, extends and
// relative paths are all accounted for. Its central rule: a client must never be able to write a file
// that compose reads, because editing one and pressing start is root on the dedi.

import { posix } from 'node:path'
import { isWithin, overlaps } from '../shared/formats.ts'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import { composeNameProblem, type ResolvedCompose, type ResolvedService } from './compose.ts'

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

    const reads = [project.composePath, posix.join(project.dir, '.env')]
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
