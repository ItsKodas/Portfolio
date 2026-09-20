// The storage guard. Checked against compose's own resolved configuration, so includes, extends and
// relative paths are all accounted for. Its central rule: a client must never be able to write a file
// that compose reads, because editing one and pressing start is root on the dedi.

import { posix } from 'node:path'
import { isWithin, overlaps } from '../shared/formats.ts'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import type { ResolvedCompose, ResolvedService } from './compose.ts'

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
    if (resolved.name !== project.id) {
        problems.push(`compose resolves the project name ${resolved.name}, not ${project.id}; set name: ${project.id} in the compose file, or rename the registry entry`)
    }

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

    // The overlap check just below can only ever fire against a service actually marked database: a
    // project provisioned automatically starts with every service guessed (compose.ts's resolveNewProject
    // guesses from the image, which is a starting point, not a guarantee), and a project enrolled by hand
    // can simply have the role wrong. Either way, storage with no database service at all to check it
    // against would otherwise pass this guard clean even though nothing has verified a database's own
    // directory is not what that storage entry actually points at.
    if (Object.keys(project.storage).length > 0 && !Object.values(project.services).some(entry => entry.role === 'database')) {
        problems.push('storage is configured but no service is marked role database; review the services before trusting the storage guard')
    }

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
