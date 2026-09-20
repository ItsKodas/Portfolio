// A minimal Docker Engine API client over the Unix socket: ping, list, inspect and logs, and nothing
// else. Lifecycle goes through the compose CLI, so this client never creates, starts or execs anything.

import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import type { Readable } from 'node:stream'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import type { ServiceStatus } from '../shared/protocol.ts'
import type { PortCheck } from '../shared/ports.ts'

export const DOCKER_SOCKET = '/var/run/docker.sock'
export const DOCKER_TIMEOUT_MS = 15_000
const CONTAINER_ID = /^[a-f0-9]{12,64}$/
// What Docker reports as the start time of a container that has never started.
const NEVER = '0001-01-01T00:00:00Z'

export type PortBinding = { IP?: string, PrivatePort: number, PublicPort?: number, Type: string }
export type ContainerSummary = { Id: string, State: string, Labels?: Record<string, string>, Ports?: PortBinding[] }
export type ContainerInspect = {
    Id: string
    RestartCount: number
    Config: { Tty: boolean, Image: string }
    State: { Status: string, StartedAt: string, Health?: { Status: string } }
}
export type LogsOptions = { tail: number, since: number | null, follow: boolean }

export type DockerApi = {
    ping(): Promise<boolean>
    listProjectContainers(project: string): Promise<ContainerSummary[]>
    listAllContainers(): Promise<ContainerSummary[]>
    inspect(id: string): Promise<ContainerInspect>
    logs(id: string, options: LogsOptions): Promise<Readable>
}

type RequestFn = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest

export function containersPath(project: string): string {
    const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`] })
    return `/containers/json?all=1&filters=${encodeURIComponent(filters)}`
}

export const ALL_CONTAINERS_PATH = '/containers/json?all=1'

// Container ids come from Docker itself, but they are still checked before going into a URL path.
export function checkedId(id: string): string {
    if (!CONTAINER_ID.test(id)) throw new Error(`refusing malformed container id ${JSON.stringify(id.slice(0, 80))}`)
    return id
}

export function logsPath(id: string, options: LogsOptions): string {
    const query = new URLSearchParams({
        stdout: '1',
        stderr: '1',
        timestamps: '1',
        tail: String(options.tail),
        follow: options.follow ? '1' : '0',
    })
    if (options.since !== null) query.set('since', String(options.since))
    return `/containers/${checkedId(id)}/logs?${query}`
}

const endpoint = (path: string) => path.split('?')[0]

export function createDockerApi(socketPath = DOCKER_SOCKET, request: RequestFn = httpRequest): DockerApi {
    // clearTimeoutOnHeaders bounds only the wait for response headers: once they arrive the timeout is
    // cleared, so a body that is legitimately idle afterwards (a followed log stream) is never killed for
    // inactivity. Without it the timeout, if any, stays armed for the whole exchange (json's body read too).
    function open(path: string, timeoutMs: number | null, clearTimeoutOnHeaders = false): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
            const req = request({ socketPath, path, method: 'GET' }, response => {
                if (clearTimeoutOnHeaders) req.setTimeout(0)
                resolve(response)
            })
            req.on('error', reject)
            if (timeoutMs !== null) req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API timed out on ${endpoint(path)}`)))
            req.end()
        })
    }

    async function json<T>(path: string): Promise<T> {
        const response = await open(path, DOCKER_TIMEOUT_MS)
        response.setEncoding('utf8')
        let body = ''
        for await (const chunk of response) body += chunk
        if (response.statusCode !== 200) throw new Error(`Docker API ${endpoint(path)} answered ${response.statusCode}: ${body.slice(0, 200)}`)
        return JSON.parse(body) as T
    }

    return {
        async ping() {
            try {
                const response = await open('/_ping', DOCKER_TIMEOUT_MS)
                response.resume()
                return response.statusCode === 200
            } catch {
                return false
            }
        },
        listProjectContainers: project => json<ContainerSummary[]>(containersPath(project)),
        listAllContainers: () => json<ContainerSummary[]>(ALL_CONTAINERS_PATH),
        async inspect(id) {
            return json<ContainerInspect>(`/containers/${checkedId(id)}/json`)
        },
        // The header wait is bounded (a wedged daemon that accepts the connection and never answers must
        // not hold the agent's follow slot forever); the body stream itself is not, since a followed
        // stream is legitimately idle for long stretches. The agent bounds its life separately.
        async logs(id, options) {
            const response = await open(logsPath(id, options), DOCKER_TIMEOUT_MS, true)
            if (response.statusCode !== 200) {
                response.resume()
                throw new Error(`Docker API logs answered ${response.statusCode}`)
            }
            return response
        },
    }
}

// Compose labels every container with its service. With several for one service (scaled, or a leftover
// from an old run), the running one is the one the client means.
export function pickPerService(containers: ContainerSummary[]): Map<string, ContainerSummary> {
    const chosen = new Map<string, ContainerSummary>()
    for (const container of containers) {
        const service = container.Labels?.['com.docker.compose.service']
        if (!service) continue
        const current = chosen.get(service)
        if (!current || (current.State !== 'running' && container.State === 'running')) chosen.set(service, container)
    }
    return chosen
}

// One listing of every container, split by the compose project each belongs to. This is what lets a
// status read covering N projects cost one call to the Docker API rather than N: containersPath filters
// server-side for one project at a time, which is right for a single project's page and wrong for a
// dashboard listing every site. Containers with no compose project label are not ours and are dropped.
export function groupByProject(containers: ContainerSummary[]): Map<string, ContainerSummary[]> {
    const grouped = new Map<string, ContainerSummary[]>()
    for (const container of containers) {
        const project = container.Labels?.['com.docker.compose.project']
        if (!project) continue
        const existing = grouped.get(project)
        if (existing) existing.push(container)
        else grouped.set(project, [container])
    }
    return grouped
}

// Every port any currently running container has published to the host, regardless of which interface it
// is bound to (127.0.0.1, a specific public address, or every interface via 0.0.0.0): a new container
// binding 127.0.0.1:<port> would collide with a same-numbered publish on any of them, since an
// all-interfaces bind already claims the loopback address too. A stopped container reports no Ports at
// all (Docker only shows a bind while it is actually listening), so this cannot see a port that belongs
// to a stopped hostd environment; takenPorts (ports.ts), reading the registry itself rather than Docker,
// is what covers that case regardless of whether the environment happens to be running. This is the only
// view of host ports available to the agent: it runs with network_mode: none, so it has no network
// namespace of its own to probe the loopback interface directly (see ports.ts's header). It also cannot
// see a port some other, non-Docker process on the host has bound, or one published by a container on a
// different Docker host reached via DOCKER_HOST, though this deployment never sets one and binds nothing
// outside Docker.
export function publishedHostPorts(containers: ContainerSummary[]): Set<number> {
    const ports = new Set<number>()
    for (const container of containers) {
        for (const port of container.Ports ?? []) {
            if (typeof port.PublicPort === 'number') ports.add(port.PublicPort)
        }
    }
    return ports
}

// A PortCheck (ports.ts) built from one snapshot of every container's published ports, fetched at most
// once per instance and cached from then on: choosePort calls this once per port in the whole range it
// scans, and this must not turn that into one Docker API call per port considered. Call this again (a
// fresh instance) for each choosePort invocation, so a later provisioning action sees a fresh snapshot.
export function dockerPortCheck(docker: DockerApi): PortCheck {
    let ports: Promise<Set<number>> | null = null
    return async port => {
        ports ??= docker.listAllContainers().then(publishedHostPorts)
        return (await ports).has(port)
    }
}

export function buildServiceStatuses(project: ProjectEntry, inspected: ReadonlyMap<string, ContainerInspect>): ServiceStatus[] {
    const statuses: ServiceStatus[] = []
    for (const [service, entry] of Object.entries(project.services)) {
        if (!isComposeService(entry)) continue
        const info = inspected.get(service)
        if (!info) {
            statuses.push({ service, role: entry.role, state: 'missing', health: null, startedAt: null, restartCount: null, image: null })
            continue
        }
        statuses.push({
            service,
            role: entry.role,
            state: info.State.Status,
            health: info.State.Health?.Status ?? null,
            startedAt: info.State.StartedAt === NEVER ? null : info.State.StartedAt,
            restartCount: info.RestartCount,
            image: info.Config.Image,
        })
    }
    return statuses
}
