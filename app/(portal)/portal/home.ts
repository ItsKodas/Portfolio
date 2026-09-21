// Everything the portal home shows, gathered in one place with every effect injected, so what the page
// does when hostd is unreachable is a test rather than something discovered in production. Deliberately
// no 'server-only' import: this is plain logic and its test runs it directly.

import type { Project, ServiceStatus } from '@/server/hostd/projects'
import { fillStatuses } from '@/server/hostd/statuses'

type Ok<T> = { ok: true, value: T }
type Bad = { ok: false, code?: string, message?: string, problems?: string[] }

export type HomeDeps = {
    who: () => Promise<{ caller: { actor: string, user: string }, clientId: string | null } | null>
    config: () => Ok<{ url: string, token: string }> | { ok: false, problems: string[] }
    listProjects: (config: { url: string, token: string }, caller: { actor: string, user: string }) => Promise<Ok<Project[]> | Bad>
    // One project's containers. Only used when the listing came back with nothing to say about them,
    // which is what an older hostd answers however it is asked. See server/hostd/statuses.ts.
    getProject: (config: { url: string, token: string }, caller: { actor: string, user: string }, id: string) => Promise<Ok<ServiceStatus[]> | Bad>
    getHealth: (config: { url: string, token: string }, caller: { actor: string, user: string }) => Promise<Ok<unknown> | Bad>
}

export type HomeView =
    | { kind: 'anonymous' }
    | { kind: 'admin', sites: Project[], health: unknown, trouble: string | null }
    | { kind: 'client', sites: Project[], trouble: string | null }

function why(result: Bad): string {
    if (result.problems?.length) return result.problems.join('; ')
    return result.message ?? result.code ?? 'hostd did not answer'
}

export async function gatherHome(deps: HomeDeps): Promise<HomeView> {
    const who = await deps.who()
    if (!who) return { kind: 'anonymous' }

    const isAdmin = who.clientId === null

    const config = deps.config()
    if (!config.ok) {
        // A missing setting stops the sites, not the page. The operator is told which setting; a client is
        // told nothing about our infrastructure, because it is not theirs to debug.
        const trouble = why(config)
        return isAdmin
            ? { kind: 'admin', sites: [], health: null, trouble }
            : { kind: 'client', sites: [], trouble: 'This is temporarily unavailable.' }
    }

    const projects = await deps.listProjects(config.value, who.caller)
    const sites = projects.ok
        ? await fillStatuses(projects.value, id => deps.getProject(config.value, who.caller, id))
        : []
    const trouble = projects.ok ? null : (isAdmin ? why(projects) : 'This is temporarily unavailable.')

    if (!isAdmin) return { kind: 'client', sites, trouble }

    // The machine is the operator's alone: hostd answers a client with admin-only, so asking would only
    // produce a refusal to throw away.
    const health = await deps.getHealth(config.value, who.caller)
    return { kind: 'admin', sites, health: health.ok ? health.value : null, trouble }
}
