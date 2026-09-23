// Which ports an environment may have. Two sources of truth, because either alone is wrong: the registry
// knows about environments that are not running, and the host itself knows about everything listening
// right now, hostd's own sites and every other service on the machine alike. The agent reads the second
// one (see host-ports.ts) and hands it in here as a plain set, so this file stays a pure rule that the
// create, the port change and the portal's live check all share.

import type { EnvironmentName, Registry } from './registry.ts'

export const PORT_RANGE = { from: 5000, to: 65535 }
export type PortRange = { from: number, to: number }

// The environment a port is being chosen FOR, when it already has one. Its own current port is not
// "taken": it is the port it is running on, so the host listing has it too, and saving a form without
// changing the port must not be refused for that.
export type OwnPort = { project: string, environment: EnvironmentName }

// What the agent's checkPort answers. unavailable is the host could not be read at all, which is never
// the same as "free": a caller refuses on it rather than guessing.
export type PortVerdict = { ok: true } | { ok: false, code: 'bad-request' | 'unavailable', problem: string }

function holderOf(registry: Registry, port: number, own?: OwnPort): string | null {
    for (const project of registry.projects.values()) {
        for (const environment of project.environments.values()) {
            if (environment.port !== port) continue
            if (own && project.id === own.project && environment.name === own.environment) continue
            return `${project.id} (${environment.name})`
        }
    }
    return null
}

function ownPort(registry: Registry, own?: OwnPort): number | null {
    if (!own) return null
    return registry.projects.get(own.project)?.environments.get(own.environment)?.port ?? null
}

export function portProblem(
    port: number, registry: Registry, listening: ReadonlySet<number>, own?: OwnPort, range: PortRange = PORT_RANGE,
): string | null {
    if (!Number.isInteger(port) || port < range.from || port > range.to) {
        return `port must be a whole number from ${range.from} to ${range.to}`
    }
    if (port === ownPort(registry, own)) return null
    const holder = holderOf(registry, port, own)
    if (holder) return `port ${port} is taken by ${holder}`
    if (listening.has(port)) return `port ${port} is in use on the host`
    return null
}

export function choosePort(registry: Registry, listening: ReadonlySet<number>, range: PortRange = PORT_RANGE) {
    for (let port = range.from; port <= range.to; port++) {
        if (portProblem(port, registry, listening, undefined, range) === null) return { ok: true as const, port }
    }
    return { ok: false as const, problem: `no free port ${range.from} to ${range.to}` }
}
