// api's policy: does this actor own this project, and is the capability on. The agent repeats the
// capability check itself; ownership exists only here, because only here is the actor known.

import type { ProjectEntry, Registry } from '../shared/registry.ts'
import { VERB_CAPABILITY } from '../shared/protocol.ts'
import type { Actor } from './auth.ts'

export type PolicyVerb = 'status' | 'lifecycle' | 'logs' | 'audit'
export type Decision =
    | { ok: true, project: ProjectEntry }
    | { ok: false, status: 403 | 404 | 409, code: 'not-found' | 'capability-disabled' | 'invalid-project', message: string }

export function authorize(registry: Registry, actor: Actor, projectId: string, verb: PolicyVerb): Decision {
    const invalid = registry.invalid.get(projectId)
    // An invalid entry has no owner that can be trusted, so only the operator learns it exists.
    if (invalid !== undefined && actor.kind === 'admin') {
        return { ok: false, status: 409, code: 'invalid-project', message: `${projectId} is invalid: ${invalid}` }
    }
    const project = registry.projects.get(projectId)
    // Someone else's project and a missing one get the same answer, so a client cannot probe for ids.
    if (!project || (actor.kind === 'client' && actor.client !== project.client)) {
        return { ok: false, status: 404, code: 'not-found', message: `no project ${projectId}` }
    }
    const capability = verb === 'audit' ? null : VERB_CAPABILITY[verb]
    if (capability && !project.capabilities.has(capability)) {
        return { ok: false, status: 403, code: 'capability-disabled', message: `${capability} is not enabled for ${projectId}` }
    }
    return { ok: true, project }
}

export function visibleProjects(registry: Registry, actor: Actor): ProjectEntry[] {
    return [...registry.projects.values()].filter(project => actor.kind === 'admin' || project.client === actor.client)
}
