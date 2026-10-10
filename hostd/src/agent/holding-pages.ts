// Keeps every environment's holding page saying why that site is down. Apache cannot tell a deploy from a
// stopped container from a crash loop: all it sees is a 503, and it answers every one with the same file.
// So the agent, which can tell, rewrites that file whenever the answer changes, and the page a visitor
// meets is never more than one loop behind what Docker says.
//
// Written for every environment with a domain, whether or not its vhost points here yet: a page nobody
// serves costs a file, and one that is missing when a vhost starts serving it costs the visitor Apache's
// own bare error.

import { posix } from 'node:path'
import { maintenanceKey } from '../shared/deploys.ts'
import { describeError } from '../shared/formats.ts'
import { environmentOf, hostnamesOf, type EnvironmentEntry, type EnvironmentName, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { groupByProject, pickPerService, type ContainerSummary } from './docker.ts'
import { renderHoldingPage, type HoldingState } from './holding-page.ts'

export type HoldingPagesDeps = {
    registry(): Registry
    // One listing of every container, the same call the status read makes, so a sweep over every site
    // costs one request to Docker however many sites there are
    listContainers(): Promise<ContainerSummary[]>
    // Whether a deploy's maintenance flag is up for this <id>-<env>
    flagUp(key: string): Promise<boolean>
    // Write then rename, so Apache never serves half a page
    writeFile(path: string, text: string): Promise<void>
    pageDir: string
    now(): number
}

// Where an environment's own page lives, which the vhost names as its holding page. Under sites/ so the
// shared fallback, index.html, can never be overwritten by a project whose id happens to be "index".
export function holdingPagePath(pageDir: string, id: string, environment: EnvironmentName): string {
    return posix.join(pageDir, 'sites', `${maintenanceKey(id, environment)}.html`)
}

// The page every vhost rendered before per-site pages existed still points at, until it is re-rendered
export function fallbackPagePath(pageDir: string): string {
    return posix.join(pageDir, 'index.html')
}

// The exit codes `docker stop` leaves behind: 0 for a process that exits cleanly on SIGTERM, 143 for one
// killed by it, and 137 for one that ignored it and was SIGKILLed after the timeout (a Node server
// running as PID 1 does exactly that, every time). Anything else is the process dying on its own.
const STOPPED_EXIT_CODES = new Set([0, 137, 143])

function exitCodeOf(container: ContainerSummary): number | null {
    const found = /^Exited \((\d+)\)/.exec(container.Status ?? '')
    return found ? Number(found[1]) : null
}

// Why the site is down, from what hostd can see without asking the site anything. A deploy's flag wins
// over whatever the containers are doing, because mid-swap they are down on purpose. A container that is
// restarting is in a crash loop (Docker only says "restarting" while it waits out the back-off between
// attempts), and one that exited with a code docker stop does not leave died and was not brought back.
// A running container is not something this can explain, so it gets the plain "back shortly".
export function holdingStateOf(flagUp: boolean, site: ContainerSummary | undefined): HoldingState {
    if (flagUp) return 'upgrading'
    if (!site) return 'stopped'
    switch (site.State) {
        case 'restarting':
        case 'dead':
            return 'crashed'
        case 'exited': {
            const code = exitCodeOf(site)
            return code === null || STOPPED_EXIT_CODES.has(code) ? 'stopped' : 'crashed'
        }
        case 'created':
        case 'paused':
            return 'stopped'
        default:
            return 'unavailable'
    }
}

function siteServiceOf(project: ProjectEntry): string | null {
    return Object.entries(project.services).find(([, entry]) => entry.role === 'site')?.[0] ?? null
}

export class HoldingPages {
    // What was last written to each path, so an unchanged page is not rewritten every ten seconds
    private readonly written = new Map<string, string>()
    // When each environment was first seen in its current state, which the page shows as "Since"
    private readonly seen = new Map<string, { state: HoldingState, since: string }>()

    constructor(private readonly deps: HoldingPagesDeps) {}

    // Every environment with a domain, plus the shared fallback. Answers the problems rather than throwing
    // them, because this runs on the agent's main loop and one unwritable page must not stop the rest.
    async sweep(): Promise<string[]> {
        const problems: string[] = []
        const fallback = renderHoldingPage({ name: null, hostname: null, environment: null, state: 'unavailable', since: null, contact: null })
        await this.write(fallbackPagePath(this.deps.pageDir), fallback).catch(error => problems.push(describeError(error)))

        let grouped: Map<string, ContainerSummary[]>
        try {
            grouped = groupByProject(await this.deps.listContainers())
        } catch (error) {
            return [...problems, `the holding pages could not be brought up to date: Docker did not list its containers: ${describeError(error)}`]
        }
        for (const project of this.deps.registry().projects.values()) {
            for (const environment of project.environments.values()) {
                if (environment.domain === null) continue
                await this.render(project, environment, grouped, null).catch(error => problems.push(describeError(error)))
            }
        }
        return problems
    }

    // One environment's page, now rather than on the next sweep: a deploy about to raise its flag passes
    // 'upgrading', so the page already says so by the time Apache starts serving it; a vhost about to name
    // the page for the first time passes nothing, so the page exists before Apache looks for it.
    async refresh(id: string, name: EnvironmentName, state: HoldingState | null = null): Promise<void> {
        const project = this.deps.registry().projects.get(id)
        const environment = project ? environmentOf(project, name) : null
        if (!project || !environment || environment.domain === null) return
        const grouped = state === null ? groupByProject(await this.deps.listContainers()) : new Map<string, ContainerSummary[]>()
        await this.render(project, environment, grouped, state)
    }

    // The same, for a caller that only holds the <id>-<env> key a maintenance flag is named by. Found by
    // matching rather than splitting it, because a project id may itself contain a dash.
    async refreshKey(key: string, state: HoldingState): Promise<void> {
        for (const project of this.deps.registry().projects.values()) {
            for (const environment of project.environments.values()) {
                if (maintenanceKey(project.id, environment.name) === key) return this.refresh(project.id, environment.name, state)
            }
        }
    }

    private async render(
        project: ProjectEntry, environment: EnvironmentEntry, grouped: Map<string, ContainerSummary[]>, forced: HoldingState | null,
    ): Promise<void> {
        const key = maintenanceKey(project.id, environment.name)
        let state = forced
        if (state === null) {
            const service = siteServiceOf(project)
            const site = service === null ? undefined : pickPerService(grouped.get(environment.composeName) ?? []).get(service)
            state = holdingStateOf(await this.deps.flagUp(key), site)
        }

        const previous = this.seen.get(key)
        const since = previous?.state === state ? previous.since : new Date(this.deps.now()).toISOString()
        this.seen.set(key, { state, since })

        const text = renderHoldingPage({
            name: project.name,
            hostname: hostnamesOf(environment)[0] ?? null,
            environment: environment.name,
            state,
            // A running site has no "since" worth showing: the page only appears once it stops answering,
            // and the time hostd last saw it running would read as the time it went down
            since: state === 'unavailable' ? null : since,
            contact: project.contact,
        })
        await this.write(holdingPagePath(this.deps.pageDir, project.id, environment.name), text)
    }

    private async write(path: string, text: string): Promise<void> {
        if (this.written.get(path) === text) return
        await this.deps.writeFile(path, text)
        this.written.set(path, text)
    }
}
