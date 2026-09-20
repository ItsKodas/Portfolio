// The agent's verb handlers. Every project verb passes the structural check first, whatever api decided,
// and every value that reaches compose or Docker comes from the registry entry that check returned.

import {
    checkStructure, refuse,
    type AgentReply, type AgentRequest, type EnvArgs, type HealthReply, type LifecycleAction, type LifecycleReply,
    type LogLine, type LogsArgs, type ProvisionAddEnvironmentArgs, type ProvisionCreateArgs, type ProvisionRemoveArgs,
    type Refusal, type ServiceStatus,
} from '../shared/protocol.ts'
import { environmentOf, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { runLifecycle, type Runner } from './compose.ts'
import { buildServiceStatuses, pickPerService, type ContainerInspect, type DockerApi } from './docker.ts'
import { createLogDecoder } from './logframes.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
import { createProject, addEnvironment, removeProject, type ProvisionDeps } from './provision.ts'

export const MAX_FOLLOWS_PER_PROJECT = 4
export const FOLLOW_MAX_MS = 60 * 60_000

export type AgentDeps = {
    registry: () => Registry
    guardInvalid: () => ReadonlyMap<string, string>
    warnings: () => string[]
    docker: DockerApi
    runner: Runner
    // Re-runs the storage guard for one project: its problem, or null when it passes.
    recheck: (project: ProjectEntry) => Promise<string | null>
    followMaxMs?: number
    // Absent until the production entrypoint wires a fetcher socket and a registry path to write:
    // provision and env then refuse unavailable instead of crashing.
    provision?: ProvisionDeps
    // Defaults to the real filesystem (env-files.ts's own default) when absent; only ever overridden in
    // tests, so env reads and writes never depend on a real /var/www while this suite runs.
    envFs?: EnvFs
}

export type Outcome =
    | { kind: 'reply', reply: AgentReply }
    | { kind: 'stream', lines: AsyncIterable<LogLine>, close: () => void }

const reply = (value: AgentReply): Outcome => ({ kind: 'reply', reply: value })

export class Agent {
    private readonly lifecycleBusy = new Set<string>()
    private readonly follows = new Map<string, number>()
    // Keyed <project>:<environment>, exactly like lifecycleBusy, so two writes to the same env file
    // never race through this process even though writeEnvFile's own temp-file dance is otherwise safe.
    private readonly envBusy = new Set<string>()
    // A single global lock, not one per id like lifecycleBusy: provisioning is a rare, operator-driven
    // action, and choosePort/domainTaken both read a registry snapshot that two overlapping creates for
    // DIFFERENT ids would race just as badly as two for the same one (both see the same free port, or the
    // same free domain, before either has written). Serialising every provisioning action against every
    // other one is the honest fix for that, not a lock keyed narrowly enough to miss it.
    private provisioningBusy = false

    constructor(private readonly deps: AgentDeps) {}

    followCount(project: string): number {
        return this.follows.get(project) ?? 0
    }

    async handle(request: AgentRequest): Promise<Outcome> {
        if (request.verb === 'health') return reply(this.health())
        if (!('project' in request)) {
            // The only request left without a project id is provision create: nothing is registered yet
            // for checkStructure to look up, so there is nothing structural to check before it runs.
            return reply(await this.provisionCreate(request.args))
        }
        const checked = checkStructure(this.deps.registry(), request, this.deps.guardInvalid())
        if (!checked.ok) return reply(checked)
        switch (request.verb) {
            case 'status':
                return reply({ ok: true, services: await this.status(checked.project) })
            case 'lifecycle':
                return reply(await this.lifecycle(checked.project, request.args.action))
            case 'logs':
                return this.logs(checked.project, request.args)
            case 'provision':
                return reply(await this.provisionExisting(checked.project, request.args))
            case 'env':
                return reply(await this.env(checked.project, request.args))
        }
    }

    private health(): HealthReply {
        const invalid = Object.fromEntries([...this.deps.registry().invalid, ...this.deps.guardInvalid()])
        return { ok: true, warnings: this.deps.warnings(), invalid }
    }

    private async status(project: ProjectEntry): Promise<ServiceStatus[]> {
        const chosen = pickPerService(await this.deps.docker.listProjectContainers(project.id))
        const inspected = new Map<string, ContainerInspect>()
        for (const [service, container] of chosen) {
            if (Object.hasOwn(project.services, service)) inspected.set(service, await this.deps.docker.inspect(container.Id))
        }
        return buildServiceStatuses(project, inspected)
    }

    private async provisionCreate(args: ProvisionCreateArgs): Promise<AgentReply> {
        if (!this.deps.provision) return refuse('unavailable', 'provisioning is not configured')
        if (this.provisioningBusy) return refuse('busy', 'another provisioning action is in progress')
        this.provisioningBusy = true
        try {
            return await createProject(args, this.deps.provision)
        } finally {
            this.provisioningBusy = false
        }
    }

    private async provisionExisting(project: ProjectEntry, args: ProvisionAddEnvironmentArgs | ProvisionRemoveArgs): Promise<AgentReply> {
        if (!this.deps.provision) return refuse('unavailable', 'provisioning is not configured')
        if (this.provisioningBusy) return refuse('busy', 'another provisioning action is in progress')
        this.provisioningBusy = true
        try {
            return args.action === 'add-environment'
                ? await addEnvironment(project, args, this.deps.provision)
                : await removeProject(project, args.environment, this.deps.provision)
        } finally {
            this.provisioningBusy = false
        }
    }

    private async env(project: ProjectEntry, args: EnvArgs): Promise<AgentReply> {
        // checkStructure has already confirmed this environment exists on the project.
        const environment = environmentOf(project, args.environment)!

        if (args.action === 'list') return { ok: true, files: await listEnvFiles(environment, this.deps.envFs) }

        if (args.action === 'read') {
            const result = await readEnvFile(environment, args.path, this.deps.envFs)
            return result.ok ? { ok: true, text: result.text } : refuse('bad-request', result.problem)
        }

        const key = `${project.id}:${environment.name}`
        if (this.envBusy.has(key)) return refuse('busy', `${project.id} already has an env write running for ${environment.name}`)
        this.envBusy.add(key)
        try {
            const result = await writeEnvFile(environment, args.path, args.text, this.deps.envFs)
            return result.ok ? { ok: true, output: `${args.path} was written` } : refuse('bad-request', result.problem)
        } finally {
            this.envBusy.delete(key)
        }
    }

    private async lifecycle(project: ProjectEntry, action: LifecycleAction): Promise<LifecycleReply | Refusal> {
        if (this.lifecycleBusy.has(project.id)) return refuse('busy', `${project.id} already has a lifecycle action running`)
        this.lifecycleBusy.add(project.id)
        try {
            // Start and restart read the compose file and its mounts, so the guard is re-run first: the
            // operator can edit a compose file without touching the registry. Stop reads no mounts, and a
            // project whose guard has just failed must still be stoppable.
            if (action !== 'stop') {
                const problem = await this.deps.recheck(project)
                if (problem) return refuse('invalid-project', problem)
            }
            const result = await runLifecycle(project, action, this.deps.runner)
            return result.ok ? { ok: true, output: result.output } : refuse('failed', result.message, result.output)
        } finally {
            this.lifecycleBusy.delete(project.id)
        }
    }

    private async logs(project: ProjectEntry, args: LogsArgs): Promise<Outcome> {
        // The slot is taken before any await, so two requests arriving together cannot both see a free one.
        if (args.follow) {
            if (this.followCount(project.id) >= MAX_FOLLOWS_PER_PROJECT) {
                return reply(refuse('busy', `${project.id} already has ${MAX_FOLLOWS_PER_PROJECT} log streams open`))
            }
            this.follows.set(project.id, this.followCount(project.id) + 1)
        }
        let released = false
        const release = () => {
            if (released || !args.follow) return
            released = true
            const remaining = this.followCount(project.id) - 1
            if (remaining > 0) this.follows.set(project.id, remaining)
            else this.follows.delete(project.id)
        }

        try {
            const container = pickPerService(await this.deps.docker.listProjectContainers(project.id)).get(args.service)
            if (!container) {
                release()
                return reply(refuse('unavailable', `${args.service} has no container; has ${project.id} been started?`))
            }
            const info = await this.deps.docker.inspect(container.Id)
            const source = await this.deps.docker.logs(container.Id, { tail: args.tail, since: args.since, follow: args.follow })
            const decoder = createLogDecoder(info.Config.Tty)

            let closing = false
            const close = () => {
                closing = true
                release()
                source.destroy()
            }
            // A follow stream is bounded, so an abandoned one cannot hold a slot and a socket forever. The
            // portal reconnects with since=<last timestamp>.
            const timer = args.follow ? setTimeout(close, this.deps.followMaxMs ?? FOLLOW_MAX_MS) : null
            timer?.unref()

            async function* lines(): AsyncGenerator<LogLine> {
                try {
                    for await (const chunk of source) yield* decoder.push(chunk as Buffer)
                    yield* decoder.flush()
                } catch (error) {
                    // Destroying the source on purpose surfaces as a premature close; that is the end we asked for.
                    if (!closing) throw error
                } finally {
                    if (timer) clearTimeout(timer)
                    release()
                }
            }
            return { kind: 'stream', lines: lines(), close }
        } catch (error) {
            release()
            throw error
        }
    }
}
