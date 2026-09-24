// Moving an environment to another port. Six steps, in this order, because each is only undoable while
// the ones after it have not happened: check the port, write it into .env, make sure compose publishes it,
// write the registry, recreate the containers (which rereads .env), and rewrite the vhost to proxy there.
// A failure puts back every step before it, so the site is never left listening on one port while Apache
// proxies to another. The recreate is a few seconds of downtime, which the portal says before it asks.

import { notPublishedProblem } from './provision.ts'
import { describeError } from '../shared/formats.ts'
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
    // Whether the vhost for this environment is a file hostd wrote itself. Only asked of an environment
    // with an address: one served by a hand-written file is refused, since nothing here can rewrite it.
    hasOwnVhost: (environment: EnvironmentEntry) => Promise<boolean>
}

export async function changePort(
    project: ProjectEntry, name: EnvironmentName, port: number, deps: PortChangeDeps,
): Promise<{ ok: true, output: string } | Refusal> {
    const environment = project.environments.get(name)
    if (!environment) return refuse('unknown-environment', `${project.id} has no ${name} environment`)
    const where = `${project.id} ${name}`
    const old = environment.port
    if (port === old) return { ok: true, output: `${where} already uses port ${port}` }

    // Before anything is written: a hand-written vhost goes on proxying to the old port, and the rewrite
    // below finds no file of hostd's to bring level, so the change would report success with the site
    // unreachable. The operator adopts the file first (a previewed decision of its own) or moves by hand.
    const address = environment.domain ?? environment.aliases[0] ?? null
    if (address !== null) {
        let owned: boolean
        try {
            owned = await deps.hasOwnVhost(environment)
        } catch (error) {
            return refuse('failed', `${where} could not be moved to port ${port}: whether hostd owns its vhost could not be read: ${describeError(error)}`)
        }
        if (!owned) {
            return refuse('bad-request', `${address} is served by a hand-written vhost; adopt it from the Domains tab first, or move the port by hand`)
        }
    }

    const verdict = await deps.checkPort(port, { project: project.id, environment: name })
    if (!verdict.ok) return refuse(verdict.code, verdict.problem)

    const written = await deps.setPortEnv(environment, project.portEnv, port)
    if (!written.ok) return refuse('failed', written.problem)
    // Each undo is best effort and says what it could not do, so the operator knows what to put right.
    // An undo that throws is reported the same way as one that answers a problem, so undoing never
    // throws out of here and leaves the rest of the undo unrun.
    const undone: string[] = []
    const attempt = async (what: string, step: () => Promise<string | null>) => {
        try {
            const problem = await step()
            if (problem !== null) undone.push(`${what}: ${problem}`)
        } catch (error) {
            undone.push(`${what}: ${describeError(error)}`)
        }
    }
    // What has happened so far, so an undo puts back exactly those steps and no others
    let registryWritten = false
    let recreated = false
    let vhostTouched = false
    const undo = async () => {
        await attempt('.env could not be put back', async () => {
            const restored = await deps.restorePortEnv(environment, written.previous)
            return restored.ok ? null : restored.problem
        })
        if (registryWritten) {
            await attempt(`the registry could not be put back to ${old}`, async () => {
                const restored = await deps.writePort(old)
                return restored.ok ? null : restored.problem
            })
        }
        if (recreated) {
            await attempt(`the containers could not be brought back up on ${old}`, async () => {
                const back = await deps.up(environment)
                return back.ok ? null : back.message
            })
        }
        if (vhostTouched) await attempt('the vhost could not be put back', () => deps.rewriteVhost())
    }
    const failed = (message: string) => refuse('failed', undone.length === 0 ? message : `${message} ${undone.join('. ')}.`)

    // Everything after the .env write, so that a step which throws (a Docker socket error, a runner
    // that could not spawn, a registry refresh that failed) is undone exactly like one that answers a
    // failure. Otherwise .env and the registry would be left on the new port with the site on the old.
    let running = false
    try {
        const published = await deps.published(environment)
        if (!published.ok) {
            await undo()
            return refuse('invalid-project', published.problem)
        }
        if (!published.ports.includes(port)) {
            await undo()
            return refuse('bad-request', notPublishedProblem(project.portEnv, port))
        }

        // Counted as written before the write, not after: writePort can write the registry and then throw
        // refreshing the agent's copy, and writing the old port back over an unchanged entry is harmless.
        // An answered refusal wrote nothing, so that path leaves the registry alone as before.
        registryWritten = true
        const registered = await deps.writePort(port)
        if (!registered.ok) {
            registryWritten = false
            await undo()
            return refuse('bad-request', registered.problem)
        }

        running = await deps.running(environment)
        if (running) {
            recreated = true
            const up = await deps.up(environment)
            if (!up.ok) {
                await undo()
                return failed(`${where} could not be recreated on port ${port}: ${up.message}. It was moved back to ${old}.`)
            }
        }

        vhostTouched = true
        const vhostProblem = await deps.rewriteVhost()
        if (vhostProblem !== null) {
            await undo()
            return failed(`the vhost for ${where} could not be rewritten: ${vhostProblem} It was moved back to ${old}.`)
        }
    } catch (error) {
        await undo()
        return failed(`${where} could not be moved to port ${port}: ${describeError(error)}. It was moved back to ${old}.`)
    }

    return {
        ok: true,
        output: running
            ? `${where} now uses port ${port}, and its containers were recreated on it`
            : `${where} now uses port ${port}. It was not running, so it takes the port when it next starts`,
    }
}
