// A minimal Docker Engine API client over the Unix socket: ping, list, inspect and logs, and nothing
// else. Lifecycle goes through the compose CLI, so this client never creates, starts or execs anything.

import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import type { Readable } from 'node:stream'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import type { ServiceStatus } from '../shared/protocol.ts'

export const DOCKER_SOCKET = '/var/run/docker.sock'
export const DOCKER_TIMEOUT_MS = 15_000
const CONTAINER_ID = /^[a-f0-9]{12,64}$/
// What Docker reports as the start time of a container that has never started.
const NEVER = '0001-01-01T00:00:00Z'

export type ContainerSummary = { Id: string, State: string, Labels?: Record<string, string> }
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
    inspect(id: string): Promise<ContainerInspect>
    logs(id: string, options: LogsOptions): Promise<Readable>
}

type RequestFn = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest

export function containersPath(project: string): string {
    const filters = JSON.stringify({ label: [`com.docker.compose.project=${project}`] })
    return `/containers/json?all=1&filters=${encodeURIComponent(filters)}`
}

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
    function open(path: string, timeoutMs: number | null): Promise<IncomingMessage> {
        return new Promise((resolve, reject) => {
            const req = request({ socketPath, path, method: 'GET' }, resolve)
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
        async inspect(id) {
            return json<ContainerInspect>(`/containers/${checkedId(id)}/json`)
        },
        // No timeout: a followed stream is legitimately idle for long stretches. The agent bounds its life.
        async logs(id, options) {
            const response = await open(logsPath(id, options), null)
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
