// Everything one site's page shows, gathered in one place with every effect injected, the same way
// app/(portal)/portal/home.ts does it for the dashboard. Deliberately no 'server-only' import: this is
// plain logic and its test runs it directly.
//
// The order below is the point of the module. A client's ownership is settled before hostd is asked
// anything, and the project is found by looking through the listing hostd already scoped to this caller,
// so neither step can be used to learn that somebody else's project exists.

import { forClient } from '@/server/hostd/errors'
import type { Environment, Project, ServiceStatus } from '@/server/hostd/projects'
import { fillStatuses } from '@/server/hostd/statuses'

type Ok<T> = { ok: true, value: T }
type Bad = { ok: false, code?: string, message?: string, problems?: string[] }

type Caller = { actor: string, user: string }
type Config = { url: string, token: string }

export type SiteDeps = {
    who: () => Promise<{ caller: Caller, clientId: string | null } | null>
    config: () => Ok<Config> | { ok: false, problems: string[] }
    listProjects: (config: Config, caller: Caller) => Promise<Ok<Project[]> | Bad>
    // The services hostd reports for this one project. Not a Project: GET /projects/:id answers
    // StatusReply, which carries no name, valid or capabilities (see server/hostd/projects.ts).
    getProject: (config: Config, caller: Caller, id: string) => Promise<Ok<ServiceStatus[]> | Bad>
    owns: (clientId: string, projectId: string) => Promise<boolean>
}

export type SiteView =
    | { kind: 'anonymous' }
    | { kind: 'forbidden' }
    | { kind: 'missing' }
    | {
        kind: 'site'
        id: string
        name: string
        isAdmin: boolean
        capabilities: string[]
        // What this project has: live alone, or live and test. hostd answers them from its registry on
        // every listing (hostd/src/api/routes.ts, environmentsFor), so the page no longer has to assume
        // there is exactly one and call it live.
        environments: Environment[]
        // Answered for the operator alone, absent rather than null for a client; folded to null here since
        // a client never reaches the Settings panel this feeds.
        repo: string | null
        // Whether the registry entry itself was actually read, which the Settings panel has to know before
        // it draws anything: rendering the form over capabilities nobody read would show eight unticked
        // boxes over a site that may have every one of them on, and its Save button would mean "take
        // everything away". 'unread' is the two early returns below, where hostd was never reached or the
        // listing itself failed: nothing about the project is known. 'invalid' is an entry hostd's own
        // registry could not parse (configure would be refused the same way every other verb is). 'valid'
        // is an entry read normally. Note this is not the same question as view.trouble, which stays set
        // when only the container read failed on an entry that was read fine.
        registryEntry: 'unread' | 'invalid' | 'valid'
        // hostd's reason an entry is invalid, carried alongside registryEntry so the panel can show it
        reason: string | null
        services: ServiceStatus[]
        // Every site this caller may see, for the nav the dashboard draws. It is hostd's own listing,
        // which is already scoped to the caller, so this is never wider than what they could see there.
        sites: Project[]
        // hostd's own words for the operator, a fixed sentence for a client, null when nothing is wrong
        trouble: string | null
    }

function why(result: Bad): string {
    if (result.problems?.length) return result.problems.join('; ')
    return result.message ?? result.code ?? 'hostd did not answer'
}

// hostd names paths, project ids and services in its messages, which is right for the operator and wrong
// for a client. forClient is the one place that decision lives, so it is used rather than repeated.
function troubleFor(isAdmin: boolean, result: Bad): string {
    return isAdmin ? why(result) : forClient(result.code ?? 'unavailable')
}

export async function gatherSite(deps: SiteDeps, id: string): Promise<SiteView> {
    const who = await deps.who()
    if (!who) return { kind: 'anonymous' }

    const isAdmin = who.clientId === null

    // First line, not the only one: hostd checks ownership too. This one is what stops the portal asking
    // hostd about a project on behalf of someone with no business naming it.
    if (who.clientId && !(await deps.owns(who.clientId, id))) return { kind: 'forbidden' }

    const config = deps.config()
    if (!config.ok) {
        // A missing setting stops the readings, not the page. There is nothing left to look the project
        // up in, so the id stands in for the name until hostd can be asked again.
        return {
            kind: 'site',
            id,
            name: id,
            isAdmin,
            capabilities: [],
            environments: [],
            repo: null,
            registryEntry: 'unread',
            reason: null,
            services: [],
            sites: [],
            trouble: troubleFor(isAdmin, config),
        }
    }

    const projects = await deps.listProjects(config.value, who.caller)
    // The listing is already scoped to what this caller may see, so an id that is not in it is either not
    // theirs or not there, and both have to read the same from outside.
    if (!projects.ok) {
        return {
            kind: 'site',
            id,
            name: id,
            isAdmin,
            capabilities: [],
            environments: [],
            repo: null,
            registryEntry: 'unread',
            reason: null,
            services: [],
            sites: [],
            trouble: troubleFor(isAdmin, projects),
        }
    }

    const project = projects.value.find(entry => entry.id === id)
    if (!project) return { kind: 'missing' }

    // Asked for separately, and allowed to fail on its own: a site whose containers hostd could not read
    // still has a page, with the reason on it.
    const status = await deps.getProject(config.value, who.caller, id)

    // The nav draws a dot per site from the listing, and a listing that says nothing about any of them
    // leaves every dot but this one grey. The answer just read stands in for this project rather than
    // being asked for a second time.
    const sites = await fillStatuses(projects.value, wanted =>
        wanted === id ? Promise.resolve(status) : deps.getProject(config.value, who.caller, wanted))

    return {
        kind: 'site',
        id: project.id,
        // Absent for a registry entry hostd itself could not parse, which is answered with an id and a
        // reason and nothing else
        name: project.name ?? project.id,
        isAdmin,
        capabilities: project.capabilities ?? [],
        environments: project.environments ?? [],
        repo: project.repo ?? null,
        registryEntry: project.valid ? 'valid' : 'invalid',
        reason: project.reason ?? null,
        services: status.ok ? status.value : [],
        sites,
        trouble: status.ok ? null : troubleFor(isAdmin, status),
    }
}
