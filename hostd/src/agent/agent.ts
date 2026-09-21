// The agent's verb handlers. Every project verb passes the structural check first, whatever api decided,
// and every value that reaches compose or Docker comes from the registry entry that check returned.

import {
    checkStructure, refuse,
    type AgentReply, type AgentRequest, type ConfigureArgs, type DeployArgs, type EnvArgs, type HealthReply,
    type LifecycleAction, type LifecycleReply, type LogLine, type LogsArgs, type ProjectStatus,
    type ProvisionAddEnvironmentArgs, type ProvisionCreateArgs, type ProvisionRemoveArgs, type Refusal,
    type ServiceStatus, type StatusesReply,
} from '../shared/protocol.ts'
import { environmentOf, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { describeError } from '../shared/formats.ts'
import { deployKey, lastHealthyCommit } from '../shared/deploys.ts'
import type { RegistryWriter } from '../shared/registry-write.ts'
import type { SystemUsage } from '../shared/system.ts'
import { runLifecycle, type Runner } from './compose.ts'
import { deployTrees } from './deploy-compose.ts'
import type { DeployDeps } from './deploy.ts'
import type { DeployRunner } from './deploy-runner.ts'
import type { DeployStore } from './deploy-state.ts'
import { buildServiceStatuses, groupByProject, pickPerService, type ContainerInspect, type ContainerSummary, type DockerApi } from './docker.ts'
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
    // The machine's own figures for health: memory, CPU load and the system disk. Injected whole, so the
    // agent never names a path or touches node:os itself, and the tests never read the real machine.
    system: () => Promise<SystemUsage>
    // Re-runs the storage guard for one project: its problem, or null when it passes.
    recheck: (project: ProjectEntry) => Promise<string | null>
    // The one writer that edits the registry, shared with provision and deploy below. Unlike those two,
    // configure needs nothing from the fetcher socket, so it is never gated behind 'unavailable': whatever
    // wires this agent up always has a registry path to write to. Pick<..., 'write'>, not the class itself,
    // so a test can stand in for it with a plain object instead of a real RegistryWriter.
    writer: Pick<RegistryWriter, 'write'>
    followMaxMs?: number
    // Absent until the production entrypoint wires a fetcher socket and a registry path to write:
    // provision and env then refuse unavailable instead of crashing.
    provision?: ProvisionDeps
    // Defaults to the real filesystem (env-files.ts's own default) when absent; only ever overridden in
    // tests, so env reads and writes never depend on a real /var/www while this suite runs.
    envFs?: EnvFs
    // Absent until the production entrypoint wires the deploy store, runner and poller: the deploy verb
    // then refuses unavailable instead of crashing, exactly like provision does. Structural types, not
    // the classes themselves, so the tests can hand this a recorder.
    deploys?: {
        runner: Pick<DeployRunner, 'start'>
        store: Pick<DeployStore, 'get' | 'resume'>
        deps: DeployDeps
    }
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
        if (request.verb === 'health') return reply(await this.health())
        // Its own branch before the check below: statuses names many projects, so it checks each one for
        // itself and reports the refusals among the results instead of refusing the whole request.
        if (request.verb === 'statuses') return reply(await this.statuses(request.projects))
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
            case 'deploy':
                return reply(await this.deploy(checked.project, request.args))
            case 'configure':
                return reply(await this.configure(checked.project, request.args))
        }
    }

    private async deploy(project: ProjectEntry, args: DeployArgs): Promise<AgentReply> {
        if (!this.deps.deploys) return refuse('unavailable', 'deploys are not configured')
        const { runner, store, deps } = this.deps.deploys
        // checkStructure has already confirmed this environment exists on the project.
        const environment = environmentOf(project, args.environment)!
        const key = deployKey(project.id, environment.name)

        if (args.action === 'history') {
            const state = store.get(key)
            return {
                ok: true, environment: environment.name, branch: environment.branch, deployed: environment.deployed,
                paused: state.paused, consecutiveFailures: state.consecutiveFailures, deploys: state.deploys,
            }
        }

        if (args.action === 'commits') {
            if (!environment.branch) return refuse('bad-request', `${project.id} ${environment.name} has no branch to list`)
            const trees = deployTrees(environment.dir)
            // Before the first deploy the repository is still inside the tree, where provisioning cloned
            // it; after it, it is beside the tree. Both are asked about rather than assumed.
            const dir = (await deps.fs.exists(trees.repo)) ? trees.repo : environment.dir
            const log = await deps.fetcher.call({ verb: 'log', dir, branch: environment.branch, limit: args.limit })
            if (!log.ok) return refuse(log.code === 'bad-request' ? 'bad-request' : 'failed', log.message)
            return { ok: true, commits: log.commits ?? [] }
        }

        if (args.action === 'rollback') {
            const target = lastHealthyCommit(store.get(key), environment.deployed)
            if (!target) return refuse('bad-request', `${project.id} ${environment.name} has no earlier healthy deploy to go back to`)
            return runner.start(project, environment, { trigger: 'rollback', actor: 'admin', commit: target })
        }

        if (args.action === 'set-branch') {
            const written = await deps.writer.write({ kind: 'set-branch', id: project.id, environment: environment.name, branch: args.branch })
            if (!written.ok) return refuse('bad-request', written.problem)
            await deps.refreshRegistry()
            // Re-read, so the deploy below tracks the branch just written rather than the one this
            // request arrived holding.
            const refreshed = deps.registry().projects.get(project.id)
            const moved = refreshed ? environmentOf(refreshed, environment.name) : null
            if (!refreshed || !moved) return { ok: true, output: `${environment.name} now tracks ${args.branch}` }
            return runner.start(refreshed, moved, { trigger: 'branch', actor: 'admin' })
        }

        return runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
    }

    // No capability gate, no per-field validation beyond what parseAgentRequest already did on the way
    // in: the registry writer (via applyChange's re-parse with parseRegistry) is the one place that
    // decides what a capability, a repo and a branch may be, so nothing here duplicates that.
    //
    // Reply shape: AgentReply has no bare { ok: true } member, and adding one is a trap (it has no field
    // of its own to distinguish it, so every existing `'x' in reply` narrowing elsewhere in the test suite
    // widens to include it and stops compiling). { ok: true, output } is the shape the codebase already
    // uses for "nothing else to carry" (see env()'s write case and provision.ts's removeProject above).
    private async configure(project: ProjectEntry, args: ConfigureArgs): Promise<AgentReply> {
        const written = await this.deps.writer.write({
            kind: 'configure',
            id: project.id,
            ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities }),
            ...(args.repo === undefined ? {} : { repo: args.repo }),
            ...(args.branches === undefined ? {} : { branches: args.branches }),
        })
        // The writer's problem is the registry validator's own words, which is what the operator needs.
        if (!written.ok) return refuse('failed', written.problem)
        // No log call here: the Agent class never logs its own verbs (lifecycle, env and deploy above do
        // not either). server.ts's handleConnection logs every reply generically, including this one, via
        // its own describe()/log() after handle() returns.
        return { ok: true, output: `${project.id}'s registry entry was updated` }
    }

    private async health(): Promise<HealthReply> {
        const invalid = Object.fromEntries([...this.deps.registry().invalid, ...this.deps.guardInvalid()])
        // system is figures for the portal to draw, kept apart from warnings on purpose: nothing it
        // reports, however alarming the number, may make this process unhealthy.
        return { ok: true, warnings: this.deps.warnings(), invalid, system: await this.deps.system() }
    }

    private async status(project: ProjectEntry): Promise<ServiceStatus[]> {
        return this.statusOf(project, await this.deps.docker.listProjectContainers(project.id))
    }

    // The containers are passed in rather than fetched, so one listing can serve many projects.
    private async statusOf(project: ProjectEntry, containers: ContainerSummary[]): Promise<ServiceStatus[]> {
        const chosen = pickPerService(containers)
        const inspected = new Map<string, ContainerInspect>()
        for (const [service, container] of chosen) {
            if (Object.hasOwn(project.services, service)) inspected.set(service, await this.deps.docker.inspect(container.Id))
        }
        return buildServiceStatuses(project, inspected)
    }

    // Status for several projects at once. Failures are collected per project, never thrown and never
    // allowed to take the batch down with them: the dashboard that asks for this draws every site it can.
    private async statuses(ids: string[]): Promise<StatusesReply> {
        const registry = this.deps.registry()
        const guardInvalid = this.deps.guardInvalid()
        const results = new Map<string, ProjectStatus>()
        const wanted = new Map<string, ProjectEntry>()

        for (const id of ids) {
            // The same structural check every single-project status runs, so an unregistered, invalid or
            // capability-less project is refused here with exactly the wording GET /projects/:id gives.
            const checked = checkStructure(registry, { verb: 'status', project: id }, guardInvalid)
            if (checked.ok) wanted.set(id, checked.project)
            else results.set(id, { project: id, ok: false, code: checked.code, message: checked.message })
        }

        if (wanted.size > 0) {
            let grouped: Map<string, ContainerSummary[]>
            try {
                grouped = groupByProject(await this.deps.docker.listAllContainers())
            } catch (error) {
                const message = `the Docker API could not be read: ${describeError(error)}`
                for (const id of wanted.keys()) results.set(id, { project: id, ok: false, code: 'failed', message })
                grouped = new Map()
            }
            for (const [id, project] of wanted) {
                if (results.has(id)) continue
                try {
                    results.set(id, { project: id, ok: true, services: await this.statusOf(project, grouped.get(id) ?? []) })
                } catch (error) {
                    // One container that disappeared between the listing and its inspect must not cost
                    // the other projects their status.
                    results.set(id, { project: id, ok: false, code: 'failed', message: `the Docker API could not be read: ${describeError(error)}` })
                }
            }
        }

        return { ok: true, projects: ids.flatMap(id => { const found = results.get(id); return found ? [found] : [] }) }
    }

    private async provisionCreate(args: ProvisionCreateArgs): Promise<AgentReply> {
        if (!this.deps.provision) return refuse('unavailable', 'provisioning is not configured')
        if (this.provisioningBusy) return refuse('busy', 'another provisioning action is in progress')
        this.provisioningBusy = true
        try {
            return await createProject(args, this.deps.provision, this.deps.envFs)
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
                ? await addEnvironment(project, args, this.deps.provision, this.deps.envFs)
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
