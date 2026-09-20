// Which port a new environment gets. Two sources of truth, because either alone is wrong: the registry
// knows about environments that are not running, and the host knows about everything else on the box.

import { createServer } from 'node:net'

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

export const listeningOnHost: PortCheck = port => new Promise(resolve => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(false)))
})

export async function choosePort(registry: Registry, inUse: PortCheck, range: PortRange = PORT_RANGE) {
    const taken = takenPorts(registry)
    for (let port = range.from; port <= range.to; port++) {
        if (taken.has(port)) continue
        if (await inUse(port)) continue
        return { ok: true as const, port }
    }
    return { ok: false as const, problem: `no free port ${range.from} to ${range.to}` }
}
