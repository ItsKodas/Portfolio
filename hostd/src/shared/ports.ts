// Which port a new environment gets. Two sources of truth, because either alone is wrong: the registry
// knows about environments that are not running, and Docker's own published ports (see docker.ts's
// publishedHostPorts) know about a container the registry has not caught up to yet. There is no third
// source, a raw probe of the host's loopback interface, because the agent runs with network_mode: none:
// it has no network namespace of its own to probe with, so binding 127.0.0.1:<port> from inside it would
// only ever see its own empty namespace and report every port free. The Docker API view cannot see a
// port some other, non-Docker process on the host has bound, but nothing on this box binds one outside
// Docker.

import type { Registry } from './registry.ts'

export const PORT_RANGE = { from: 5000, to: 5999 }
export type PortRange = { from: number, to: number }
export type PortCheck = (port: number) => Promise<boolean>

export function takenPorts(registry: Registry): Set<number> {
    const taken = new Set<number>()
    for (const project of registry.projects.values()) {
        for (const environment of project.environments.values()) taken.add(environment.port)
    }
    return taken
}

export async function choosePort(registry: Registry, inUse: PortCheck, range: PortRange = PORT_RANGE) {
    const taken = takenPorts(registry)
    for (let port = range.from; port <= range.to; port++) {
        if (taken.has(port)) continue
        if (await inUse(port)) continue
        return { ok: true as const, port }
    }
    return { ok: false as const, problem: `no free port ${range.from} to ${range.to}` }
}
