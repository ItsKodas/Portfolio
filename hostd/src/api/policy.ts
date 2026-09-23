// api's policy: does this actor own this project, and is the capability on. The agent repeats the
// capability check itself; ownership exists only here, because only here is the actor known.

import type { Capability, ProjectEntry, Registry } from '../shared/registry.ts'
import type { Actor } from './auth.ts'

// 'deploy' is deploying, rolling back and switching branch, which only the admin may do. 'deploy-read'
// is the deploy history and the commit list, which a client may read for their own site: both need the
// project's deploy capability, and the split lives here because only api knows who is asking.
//
// 'backup' and 'backup-read' both let the owning client act on and read their own backups. Unlike deploy,
// which is admin-only, a client's backups belong to them: they keep them until they delete them, and choose
// the schedule. The split exists so the audit log distinguishes reading from acting, not to gate one behind admin.
//
// 'domains' and 'domains-read' split the same way and for the same reason. Adding, removing, adopting
// and re-checking a hostname all change what Apache serves, so they are the operator's; reading the
// list is how a client watches their own DNS land, so that half is theirs. Re-checking is in the admin
// half rather than the read one because it writes the record it checks.
//
// 'remove' is deleting a whole project, split from 'provision' so it needs no capability: see its entry
// below.
export type PolicyVerb =
    | 'status' | 'lifecycle' | 'logs' | 'audit' | 'provision' | 'remove' | 'env' | 'deploy' | 'deploy-read'
    | 'backup' | 'backup-read'
    | 'domains' | 'domains-read' | 'configure'

// Deliberately its own table rather than protocol.ts's VERB_CAPABILITY: that one is keyed by the agent's
// verbs, and this one has two entries for the same verb, which is what the split above needs.
const POLICY_CAPABILITY: Record<PolicyVerb, Capability | null> = {
    status: null,
    audit: null,
    lifecycle: 'lifecycle',
    logs: 'logs',
    provision: 'provision',
    // Null for the reason configure is: the portal can create a site with no provision capability, so
    // gating its removal on one would leave every site it made undeletable until the operator ticked a box
    // first. What guards it is ADMIN_ONLY, and the project's name typed back (routes.ts).
    remove: null,
    env: 'env',
    deploy: 'deploy',
    'deploy-read': 'deploy',
    backup: 'backups',
    'backup-read': 'backups',
    domains: 'domains',
    'domains-read': 'domains',
    // Null on purpose: gating the verb that edits capabilities on a capability would mean a project with
    // none could never be given any, which is exactly the project that most needs it. What guards
    // configure instead is ADMIN_ONLY below, not a capability. See VERB_CAPABILITY in protocol.ts, which
    // is null here for the same reason, on the agent's own side of the boundary.
    configure: null,
}

// What only the admin may ever do, whatever the registry says and whoever owns the project.
const ADMIN_ONLY: PolicyVerb[] = ['provision', 'remove', 'env', 'deploy', 'domains', 'configure']
export type Decision =
    | { ok: true, project: ProjectEntry }
    | { ok: false, status: 403 | 404 | 409, code: 'not-found' | 'capability-disabled' | 'invalid-project', message: string }

export function authorize(registry: Registry, actor: Actor, projectId: string, verb: PolicyVerb): Decision {
    const invalid = registry.invalid.get(projectId)
    // An invalid entry has no owner that can be trusted, so only the operator learns it exists.
    if (invalid !== undefined && actor.kind === 'admin') {
        return { ok: false, status: 409, code: 'invalid-project', message: `${projectId} is invalid: ${invalid}` }
    }
    // Provisioning and env editing are admin-only, full stop. This has to be its own check ahead of
    // ownership: a client who owns the project, even one where the registry happens to list the
    // provision or env capability, must see exactly the same 404 as for a project that is not theirs,
    // so neither ownership nor a stray capability entry can ever grant either one.
    if (ADMIN_ONLY.includes(verb) && actor.kind !== 'admin') {
        return { ok: false, status: 404, code: 'not-found', message: `no project ${projectId}` }
    }
    const project = registry.projects.get(projectId)
    // Someone else's project and a missing one get the same answer, so a client cannot probe for ids.
    if (!project || (actor.kind === 'client' && actor.client !== project.client)) {
        return { ok: false, status: 404, code: 'not-found', message: `no project ${projectId}` }
    }
    const capability = POLICY_CAPABILITY[verb]
    if (capability && !project.capabilities.has(capability)) {
        return { ok: false, status: 403, code: 'capability-disabled', message: `${capability} is not enabled for ${projectId}` }
    }
    return { ok: true, project }
}

export function visibleProjects(registry: Registry, actor: Actor): ProjectEntry[] {
    return [...registry.projects.values()].filter(project => actor.kind === 'admin' || project.client === actor.client)
}
