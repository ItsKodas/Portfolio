// Moving an environment to another port. Six steps, in this order, because each is only undoable while
// the ones after it have not happened: check the port, write it into .env, make sure compose publishes it,
// write the registry, recreate the containers (which rereads .env), and rewrite the vhost to proxy there.
// A failure puts back every step before it, so the site is never left listening on one port while Apache
// proxies to another. The recreate is a few seconds of downtime, which the portal says before it asks.

import { notPublishedProblem } from './provision.ts'
import { refuse, type Refusal } from '../shared/protocol.ts'
import type { OwnPort, PortVerdict } from '../shared/ports.ts'
import type { EnvironmentEntry, EnvironmentName, ProjectEntry } from '../shared/registry.ts'

export type PortChangeDeps = {
    checkPort: (port: number, own: OwnPort) => Promise<PortVerdict>
    setPortEnv: (environment: EnvironmentEntry, key: string, port: number) => Promise<{ ok: true, previous: string | null } | { ok: false, problem: string }>
    restorePortEnv: (environment: EnvironmentEntry, previous: string | null) => Promise<{ ok: true } | { ok: false, problem: string }>
    published: (environment: EnvironmentEntry) => Promise<{ ok: true, ports: number[] } | { ok: false, problem: string }>
    // Writes the registry and refreshes the agent's copy of it, so the vhost rewrite reads the new port
    writePort: (port: number) => Promise<{ ok: true } | { ok: false, problem: string }>
    running: (environment: EnvironmentEntry) => Promise<boolean>
    up: (environment: EnvironmentEntry) => Promise<{ ok: true } | { ok: false, message: string }>
    // A problem, or null when the vhost is rewritten or there is no hostd vhost to rewrite
    rewriteVhost: () => Promise<string | null>
}

export async function changePort(
    project: ProjectEntry, name: EnvironmentName, port: number, deps: PortChangeDeps,
): Promise<{ ok: true, output: string } | Refusal> {
    const environment = project.environments.get(name)
    if (!environment) return refuse('unknown-environment', `${project.id} has no ${name} environment`)
    const where = `${project.id} ${name}`
    const old = environment.port
    if (port === old) return { ok: true, output: `${where} already uses port ${port}` }

    const verdict = await deps.checkPort(port, { project: project.id, environment: name })
    if (!verdict.ok) return refuse(verdict.code, verdict.problem)

    const written = await deps.setPortEnv(environment, project.portEnv, port)
    if (!written.ok) return refuse('failed', written.problem)
    // Each undo is best effort and says what it could not do, so the operator knows what to put right
    const undone: string[] = []
    const restoreEnv = async () => {
        const restored = await deps.restorePortEnv(environment, written.previous)
        if (!restored.ok) undone.push(`.env could not be put back: ${restored.problem}`)
    }
    const restoreRegistry = async () => {
        const restored = await deps.writePort(old)
        if (!restored.ok) undone.push(`the registry could not be put back to ${old}: ${restored.problem}`)
    }
    const failed = (message: string) => refuse('failed', undone.length === 0 ? message : `${message} ${undone.join('. ')}.`)

    const published = await deps.published(environment)
    if (!published.ok) {
        await restoreEnv()
        return refuse('invalid-project', published.problem)
    }
    if (!published.ports.includes(port)) {
        await restoreEnv()
        return refuse('bad-request', notPublishedProblem(project.portEnv, port))
    }

    const registered = await deps.writePort(port)
    if (!registered.ok) {
        await restoreEnv()
        return refuse('bad-request', registered.problem)
    }

    const running = await deps.running(environment)
    if (running) {
        const up = await deps.up(environment)
        if (!up.ok) {
            await restoreEnv()
            await restoreRegistry()
            const back = await deps.up(environment)
            if (!back.ok) undone.push(`the containers could not be brought back up on ${old}: ${back.message}`)
            return failed(`${where} could not be recreated on port ${port}: ${up.message}. It was moved back to ${old}.`)
        }
    }

    const vhostProblem = await deps.rewriteVhost()
    if (vhostProblem !== null) {
        await restoreEnv()
        await restoreRegistry()
        if (running) {
            const back = await deps.up(environment)
            if (!back.ok) undone.push(`the containers could not be brought back up on ${old}: ${back.message}`)
        }
        const again = await deps.rewriteVhost()
        if (again !== null) undone.push(`the vhost could not be put back: ${again}`)
        return failed(`the vhost for ${where} could not be rewritten: ${vhostProblem} It was moved back to ${old}.`)
    }

    return {
        ok: true,
        output: running
            ? `${where} now uses port ${port}, and its containers were recreated on it`
            : `${where} now uses port ${port}. It was not running, so it takes the port when it next starts`,
    }
}
