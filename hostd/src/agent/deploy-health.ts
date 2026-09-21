// Is this environment actually serving? The design asks for "every service running, and the site
// answering on its port". The agent runs with network_mode: none, so it has no network namespace to make
// that request from, and the fetcher (which has one) is on a bridge network that cannot reach a port
// published on the host's loopback address. So this is Docker's own view instead: every registered
// compose service has a running container, and any container that declares a healthcheck reports
// healthy. A repo that wants the stronger check declares one, and RUNBOOK.md says so.

import { describeError } from '../shared/formats.ts'
import type { ProjectEntry } from '../shared/registry.ts'
import type { ServiceStatus } from '../shared/protocol.ts'
import { buildServiceStatuses, pickPerService, type ContainerInspect, type DockerApi } from './docker.ts'

export const HEALTH_TIMEOUT_MS = 60_000
export const HEALTH_INTERVAL_MS = 2_000

// The statuses are already only the project's registered compose services (buildServiceStatuses is what
// produces them), and a service with no container at all arrives here as state 'missing', which is the
// case this has to catch after a swap that started nothing.
//
// 'starting' counts as not healthy yet, deliberately: a container whose healthcheck has not passed once
// is exactly what the wait is for.
export function unhealthyServices(statuses: ServiceStatus[]): string[] {
    const wrong: string[] = []
    for (const status of statuses) {
        if (status.state !== 'running') wrong.push(`${status.service} (${status.state})`)
        else if (status.health !== null && status.health !== 'healthy') wrong.push(`${status.service} (${status.health})`)
    }
    return wrong
}

export type HealthDeps = { docker: DockerApi, now: () => number, sleep: (ms: number) => Promise<void> }

export async function waitForHealthy(
    project: ProjectEntry, composeName: string, deps: HealthDeps,
): Promise<{ ok: true } | { ok: false, problem: string }> {
    const started = deps.now()
    let problem = 'no container was found'
    for (;;) {
        try {
            const chosen = pickPerService(await deps.docker.listProjectContainers(composeName))
            const inspected = new Map<string, ContainerInspect>()
            for (const [service, container] of chosen) {
                if (Object.hasOwn(project.services, service)) inspected.set(service, await deps.docker.inspect(container.Id))
            }
            const wrong = unhealthyServices(buildServiceStatuses(project, inspected))
            if (wrong.length === 0) return { ok: true }
            problem = `not healthy after ${Math.round(HEALTH_TIMEOUT_MS / 1000)} seconds: ${wrong.join(', ')}`
        } catch (error) {
            // A Docker read that fails is not a healthy site, but it is also not proof of an unhealthy
            // one: keep waiting, and report this if the time runs out with nothing better to say.
            problem = `the Docker API could not be read: ${describeError(error)}`
        }
        if (deps.now() - started >= HEALTH_TIMEOUT_MS) return { ok: false, problem }
        await deps.sleep(HEALTH_INTERVAL_MS)
    }
}
