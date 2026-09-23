// A minimal Docker Engine API client over the Unix socket: ping, list, inspect, logs and exec.
// Lifecycle otherwise goes through the compose CLI: this client never creates, starts or stops a
// container, and exec is used only to run a fixed command inside an already-running one (a database dump).

import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import type { Readable } from 'node:stream'
import { isComposeService, type ProjectEntry } from '../shared/registry.ts'
import type { ServiceStatus } from '../shared/protocol.ts'
import { FrameDecoder } from './logframes.ts'

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

// How much stderr is kept from a failed exec. Enough to explain a failure, small enough that a command
// screaming into stderr cannot exhaust memory.
const MAX_EXEC_STDERR = 4096
export type ExecResult = { exitCode: number | null, stderr: string }

export type DockerApi = {
    ping(): Promise<boolean>
    listProjectContainers(project: string): Promise<ContainerSummary[]>
    listAllContainers(): Promise<ContainerSummary[]>
    inspect(id: string): Promise<ContainerInspect>
    logs(id: string, options: LogsOptions): Promise<Readable>
    // Runs argv in an already-running container and hands stdout to the caller chunk by chunk. stdout is
    // never buffered here: it becomes a database dump, which can be larger than this process's memory.
    exec(id: string, argv: string[], onStdout: (chunk: Buffer) => Promise<void> | void): Promise<ExecResult>
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

    // Same header-wait-only timeout as open(): see the comment above open() for why. Exec's start call in
    // particular must not be killed mid-stream, since a dump of a large database is legitimately slow.
    function openPost(path: string, body: unknown, timeoutMs: number | null, clearTimeoutOnHeaders = false): Promise<IncomingMessage> {
        const payload = Buffer.from(JSON.stringify(body))
        return new Promise((resolve, reject) => {
            const options: RequestOptions = {
                socketPath, path, method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
            }
            const req = request(options, response => {
                if (clearTimeoutOnHeaders) req.setTimeout(0)
                resolve(response)
            })
            req.on('error', reject)
            if (timeoutMs !== null) req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker API timed out on ${endpoint(path)}`)))
            req.end(payload)
        })
    }

    async function postJson<T>(path: string, body: unknown): Promise<T> {
        const response = await openPost(path, body, DOCKER_TIMEOUT_MS)
        response.setEncoding('utf8')
        let text = ''
        for await (const chunk of response) text += chunk
        if (response.statusCode !== 200 && response.statusCode !== 201) {
            throw new Error(`Docker API ${endpoint(path)} answered ${response.statusCode}: ${text.slice(0, 200)}`)
        }
        return JSON.parse(text) as T
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
        async exec(id, argv, onStdout) {
            const checked = checkedId(id)
            const created = await postJson<{ Id: string }>(`/containers/${checked}/exec`, {
                AttachStdout: true, AttachStderr: true, AttachStdin: false, Tty: false, Cmd: argv,
            })
            const execId = checkedId(created.Id)
            // Tty is false above, so the output is multiplexed and the frame decoder that reads logs reads
            // this too. The header wait is bounded; the body is not, because a dump of a large database is
            // legitimately slow and must not be killed for taking its time.
            const stream = await openPost(`/exec/${execId}/start`, { Detach: false, Tty: false }, DOCKER_TIMEOUT_MS, true)
            if (stream.statusCode !== 200) {
                stream.resume()
                throw new Error(`Docker API exec start answered ${stream.statusCode}`)
            }
            const decoder = new FrameDecoder()
            let stderr = ''
            for await (const chunk of stream) {
                for (const frame of decoder.push(chunk as Buffer)) {
                    if (frame.stream === 'stdout') await onStdout(frame.data)
                    else if (stderr.length < MAX_EXEC_STDERR) stderr += frame.data.toString('utf8')
                }
            }
            const inspected = await json<{ ExitCode: number | null }>(`/exec/${execId}/json`)
            return { exitCode: inspected.ExitCode, stderr: stderr.slice(0, MAX_EXEC_STDERR).trim() }
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
