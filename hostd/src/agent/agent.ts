// The agent's verb handlers. Every project verb passes the structural check first, whatever api decided,
// and every value that reaches compose or Docker comes from the registry entry that check returned.

import {
    checkStructure, refuse,
    type AdoptPreview, type AgentReply, type AgentRequest, type BackupArgs, type ConfigureArgs,
    type ConfigureWritten, type DeployArgs, type DomainsRequest, type DomainsWritten, type EnvArgs,
    type HealthReply, type LifecycleAction,
    type LifecycleReply, type LogLine, type LogsArgs, type PortsArgs, type PortsReply, type ProjectStatus, type ProvisionAddEnvironmentArgs,
    type ProvisionCreateArgs, type ProvisionRemoveArgs, type Refusal, type ServiceStatus, type StatusesReply,
} from '../shared/protocol.ts'
import { environmentOf, ENVIRONMENT_FLAGS, type EnvironmentFlag, type EnvironmentName, type ProjectEntry, type Registry } from '../shared/registry.ts'
import { describeError } from '../shared/formats.ts'
import { deployKey, lastHealthyCommit, MAX_WATCH_BYTES, type DeployEvent } from '../shared/deploys.ts'
import { diskProblem, manualProblem } from '../shared/backups.ts'
import type { RegistryWriter } from '../shared/registry-write.ts'
import type { DiskUsage, SystemUsage } from '../shared/system.ts'
import { resolvePublished, runLifecycle, tail, type Runner } from './compose.ts'
import { composeNameOf, deployTrees, locationIn, repositoryIn, upArgv } from './deploy-compose.ts'
import type { DeployDeps } from './deploy.ts'
import type { DeployRunner } from './deploy-runner.ts'
import type { DeployStore } from './deploy-state.ts'
import { adopt, previewAdopt, removeVhost, restoreAdopted, setAliases, writeVhost, type DomainsDeps } from './domains.ts'
import type { FetchClient } from './fetch-client.ts'
import { buildServiceStatuses, groupByProject, pickPerService, type ContainerInspect, type ContainerSummary, type DockerApi } from './docker.ts'
import { createLogDecoder } from './logframes.ts'
import { listEnvFiles, readEnvFile, writeEnvFile, type EnvFs } from './env-files.ts'
import { createProject, addEnvironment, removeProject, type ProvisionDeps } from './provision.ts'
import { changePort } from './port-change.ts'
import { restorePortEnv, writePortEnv } from './port-env.ts'
import type { BackupRunner } from './backup-runner.ts'
import type { BackupStore } from './backup-state.ts'
import { repoPath, type Restic } from './restic.ts'
import { tokenFromVhost, vhostPath } from './vhost.ts'

export const MAX_FOLLOWS_PER_PROJECT = 4
export const FOLLOW_MAX_MS = 60 * 60_000
// A port change's recreate, shorter than a lifecycle action's: the change can run up twice (the move and
// the undo's move back) and then the rail, and all of it has to fit inside api's 150 second call to the
// agent, or the portal reports a timeout while the change is still running.
export const PORT_CHANGE_UP_TIMEOUT_MS = 60_000

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
    // Reloads the registry from disk after a write, so the next request answers from the entry that was
    // just written rather than one up to a poll old. Every other writer-using path does this already
    // (set-branch below, both provisioning paths in provision.ts), through deps of its own.
    refreshRegistry: () => Promise<void>
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
        // isRunning too, so a port change can refuse while a deploy's swap owns the same compose project
        runner: Pick<DeployRunner, 'start' | 'isRunning' | 'watch'>
        store: Pick<DeployStore, 'get' | 'resume'>
        deps: DeployDeps
    }
    // Absent until the production entrypoint wires the backup directory, the store and the runner: the
    // backup verb then refuses unavailable instead of crashing, exactly like deploys and provision do.
    backups?: {
        runner: Pick<BackupRunner, 'start' | 'isRunning'>
        store: Pick<BackupStore, 'get' | 'failures'>
        restic: Restic
        backupDir: string
        newRunId: () => string
        backupDisk: () => Promise<DiskUsage | null>
    }
    // Absent until the production entrypoint wires the Apache rail, the registry writer and the vhost
    // configuration: the domains verb then refuses unavailable instead of crashing, exactly like
    // provision and deploy do.
    domains?: DomainsDeps
    // How long ago the rail last got an answer, read fresh on every health request exactly like system
    // is. An age in milliseconds, never a timestamp: api compares it against a staleness threshold.
    // Required rather than optional, unlike domains itself: health must always answer with a railAge,
    // even one that stayed null because nothing ever configured the rail, so no caller can forget it.
    railAge: () => number | null
    // Absent exactly like provision and deploys until the production entrypoint wires the fetcher socket:
    // the branches verb then refuses unavailable instead of crashing. Separate from provision's and
    // deploys' own copies of the same FetchClient (they need it for a lot more than this one call), and
    // Pick<..., 'call'> rather than the class itself, so a test can hand this a plain object.
    fetcher?: Pick<FetchClient, 'call'>
}

export type Outcome =
    | { kind: 'reply', reply: AgentReply }
    // LogLine is shaped for container logs, and its stream: 'stdout' | 'stderr' means nothing for a
    // deploy's phase line. server.ts writes one JSON object per line and does not care which this is.
    | { kind: 'stream', lines: AsyncIterable<LogLine | DeployEvent>, close: () => void }
    // A backup download: the same header line as a stream, then the body in length-prefixed frames ending
    // in a terminator server.ts writes only once this iterator has returned normally. Its own kind rather
    // than a stream of lines because a tar.gz through NDJSON would need base64, which inflates a
    // multi-gigabyte download by a third for nothing.
    | { kind: 'bytes', body: AsyncIterable<Buffer>, close: () => void }

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
    // Keyed <project>:<environment> while a port change runs, so the deploy verb refuses to run up on
    // the same compose project, or rewrite the registry entry, halfway through one.
    private readonly portChanging = new Set<string>()

    constructor(private readonly deps: AgentDeps) {}

    // Whether any environment of the project is moving to another port
    private portChangingIn(id: string): boolean {
        for (const key of this.portChanging) if (key.startsWith(`${id}:`)) return true
        return false
    }

    followCount(project: string): number {
        return this.follows.get(project) ?? 0
    }

    async handle(request: AgentRequest): Promise<Outcome> {
        if (request.verb === 'health') return reply(await this.health())
        if (request.verb === 'credentials') return reply(await this.credentials())
        if (request.verb === 'ports') return reply(await this.ports(request.args))
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
            case 'deploy-watch':
                return this.deployWatch(checked.project, request.args)
            case 'backup':
                return this.backup(checked.project, request.args)
            // domains re-checks the registry, the guard and the capability itself, from a freshly
            // reloaded registry rather than the checked snapshot above: see domains() for why.
            case 'domains':
                return reply(await this.domains(request))
            case 'configure':
                return reply(await this.configure(checked.project, request.args))
            case 'branches':
                return reply(await this.branches(checked.project))
            case 'port':
                return reply(await this.port(checked.project, request.args.environment, request.args.port))
        }
    }

    private async backup(project: ProjectEntry, args: BackupArgs): Promise<Outcome> {
        if (!this.deps.backups) return reply(refuse('unavailable', 'backups are not configured'))
        const { runner, store, restic, backupDir, newRunId } = this.deps.backups
        const repo = repoPath(backupDir, project.id)
        const state = store.get(project.id)

        if (args.action === 'list') {
            const listed = await restic.snapshots(repo)
            // A repository that does not exist yet is not an error: it is a project that has never been
            // backed up, and the portal draws an empty list for it.
            const snapshots = listed.ok ? listed.snapshots : []
            return reply({ ok: true, snapshots, runs: state.runs, running: runner.isRunning(project.id) })
        }

        if (args.action === 'get-run') {
            return reply({ ok: true, run: state.runs.find(run => run.run === args.run) ?? null, running: runner.isRunning(project.id) })
        }

        if (args.action === 'run') {
            // The design's run order refuses on a full disk before it refuses a sixth manual run, and the
            // runbook lists this under "When a backup is refused", so it is a synchronous refusal like the
            // manual cap and the cooldown beside it, not a run that starts and records a reason minutes
            // later. backup-run.ts still checks the same thing: the agent never lets its own caller stand
            // in for its own check, and a scheduled run reaches that one by a different path.
            const diskFull = await this.backupDiskProblem()
            if (diskFull) return reply(refuse('unavailable', diskFull))

            const listed = await restic.snapshots(repo)
            if (args.tag === 'manual') {
                // Checked here as well as in api: the agent never lets api's decision stand in for its own.
                const problem = manualProblem(listed.ok ? listed.snapshots : [], state.runs, Date.now())
                if (problem) return reply(refuse('bad-request', problem))
            }
            // The actor comes from api because the agent cannot tell a client's own backup from the
            // operator's, and the design's central decision for this phase is that owners act on their
            // own backups: without it every run a client takes is recorded as 'admin' in a history the
            // portal draws for them. It is a label for that history and NOTHING else. No decision above
            // or below this line reads it: the capability, the locks, the manual cap, the cooldown and
            // the disk are all enforced by the agent for itself, whatever api says the actor was, so a
            // compromised api can mislabel a record and change nothing else. A scheduled run is 'hostd'
            // regardless of what arrived, since only api's own tick starts one. deploys.ts records the
            // same limitation on its own actor field.
            return reply(runner.start(project, {
                tag: args.tag, actor: args.tag === 'scheduled' ? 'hostd' : (args.actor ?? 'admin'),
                run: newRunId(), keep: args.keep ?? null,
            }))
        }

        // delete and download both name a snapshot, and both look it up in this project's own repository
        // first: a hex id is not proof that it belongs to this client.
        const listed = await restic.snapshots(repo)
        if (!listed.ok) return reply(refuse('failed', listed.reason, listed.output))
        const snapshot = listed.snapshots.find(entry => entry.id === args.snapshot || entry.id.startsWith(args.snapshot))
        if (!snapshot) return reply(refuse('bad-request', `no backup ${args.snapshot} for ${project.id}`))

        if (args.action === 'delete') {
            const forgotten = await restic.forget(repo, snapshot.id)
            return reply(forgotten.ok ? { ok: true, output: `backup ${snapshot.id} deleted` } : refuse('failed', forgotten.reason, forgotten.output))
        }

        const handle = restic.dump(repo, snapshot.id)
        // restic's stdout reaching EOF is not proof the dump worked. A corrupt repository, a missing pack,
        // a wrong password or a snapshot forgotten while the dump was running all end the stream early and
        // exit non-zero, and every layer below here (server.ts, api's relay, the HTTP response) reads a
        // clean EOF as a complete archive. So the exit code is the last thing the body yields to, and a
        // non-zero one throws. Returning normally is what lets server.ts write the body terminator, and
        // that terminator is what api accepts as proof the archive is whole; a throw means no terminator,
        // api fails the download, and routes.ts destroys the response. That chain is what makes a
        // truncated dump arrive as a failed transfer rather than a short but perfectly valid tar.gz the
        // client keeps as their backup.
        async function* body(): AsyncGenerator<Buffer> {
            for await (const chunk of handle.stdout) yield chunk as Buffer
            const exit = await handle.exit
            if (exit.exitCode !== 0) {
                // The stderr tail names the repository path and restic's own complaint, never the password.
                throw new Error(`restic dump exited with code ${exit.exitCode}${exit.stderr ? `: ${exit.stderr}` : ''}`)
            }
        }
        return {
            kind: 'bytes',
            body: body(),
            close: () => {
                handle.stdout.destroy()
                // Consumed even when nobody read the body: an abandoned download would otherwise leave the
                // exit promise with no settler attached and the restic child unreaped.
                void handle.exit.then(() => {}, () => {})
            },
        }
    }

    // Why the backup disk will not take another run, or null when it will. Shared by health, which reports
    // it as a warning, and by the run branch, which refuses on it: a reading that throws degrades to a
    // problem rather than taking its caller down, and a disk that cannot be read at all is not a disk a
    // run may be started against.
    private async backupDiskProblem(): Promise<string | null> {
        if (!this.deps.backups) return null
        try {
            return diskProblem(await this.deps.backups.backupDisk())
        } catch (error) {
            return `the backup disk could not be read: ${describeError(error)}`
        }
    }

    // Public, unlike env/deploy/lifecycle, because writing a vhost is dangerous enough that nothing here
    // may act on a registry any staler than the moment this runs. It re-reads the registry, checks
    // structure and the capability itself against that fresh read, rather than trusting the checked
    // project handle() already produced from its own (merely per-connection) registry() snapshot.
    async domains(request: DomainsRequest): Promise<DomainsWritten | AdoptPreview | Refusal> {
        if (!this.deps.domains) return refuse('unavailable', 'domains is not configured')
        // Every action writes a vhost or the registry, which a port change on the project is doing too.
        // The whole project rather than the one environment, for simplicity: a change takes seconds.
        if (this.portChangingIn(request.project)) return refuse('busy', `${request.project} is moving an environment to another port`)
        const domains = this.deps.domains
        const registry = await domains.reloadRegistry()
        const checked = checkStructure(registry, request, this.deps.guardInvalid())
        if (!checked.ok) return checked
        // checkStructure only enforces environment presence for env and deploy; domains checks it here
        // instead, against the project entry the fresh reload just produced.
        const environment = environmentOf(checked.project, request.args.environment)
        if (!environment) return refuse('unknown-environment', `${checked.project.id} has no ${request.args.environment} environment`)

        switch (request.args.action) {
            case 'write':
                return writeVhost(domains, checked.project, environment, request.args.token)
            case 'remove':
                return removeVhost(domains, checked.project, environment)
            case 'preview':
                return previewAdopt(domains, checked.project, environment, request.args.token)
            case 'adopt':
                return adopt(domains, checked.project, environment, request.args.token, request.args.disable)
            case 'restore':
                return restoreAdopted(domains, checked.project, environment, request.args.restore)
            case 'set-aliases':
                return setAliases(domains, checked.project, environment, request.args.aliases, request.args.token)
        }
    }

    // The repo and the credential both come from the registry entry checkStructure just returned, never
    // from the request: a caller names a project and that is all it is trusted with. Fills the portal's
    // Settings form, so a project with nothing to list from is refused by name rather than asked of the
    // fetcher for nothing.
    private async branches(project: ProjectEntry): Promise<AgentReply> {
        if (!project.repo) return refuse('bad-request', `${project.id} has no repo to list branches from`)
        if (!this.deps.fetcher) return refuse('unavailable', 'the fetcher is not configured')
        const result = await this.deps.fetcher.call({ verb: 'branches', repo: project.repo, credential: project.credential })
        // Collapsed to bad-request or failed exactly as the deploy verb's own commits case collapses the
        // fetcher's reply: bad-request is the fetcher itself refusing the shape of the request (which
        // means a bug here, not something the caller did), and everything else reads as failed.
        if (!result.ok) return refuse(result.code === 'bad-request' ? 'bad-request' : 'failed', result.message)
        return { ok: true, branches: result.branches ?? [] }
    }

    // Names only, straight from the fetcher, which is the only process that knows which tokens it was
    // given. No project: this is a fact about the machine, and api's policy is what makes it the
    // operator's alone.
    private async credentials(): Promise<AgentReply> {
        if (!this.deps.fetcher) return refuse('unavailable', 'the fetcher is not configured')
        const result = await this.deps.fetcher.call({ verb: 'credentials' })
        if (!result.ok) return refuse(result.code === 'bad-request' ? 'bad-request' : 'failed', result.message)
        return { ok: true, credentials: result.credentials ?? [] }
    }

    // The portal's live check. Not under the provisioning lock: it changes nothing, and a create that
    // is running would otherwise make the form say "busy" while the operator is typing. A port that is
    // not free is an answer, not a refusal; only a host that could not be read is refused.
    private async ports(args: PortsArgs): Promise<PortsReply | Refusal> {
        if (!this.deps.provision) return refuse('unavailable', 'provisioning is not configured')
        const suggested = await this.deps.provision.choosePort()
        if (!suggested.ok) return refuse('unavailable', suggested.problem)
        if (args.port === null) return { ok: true, suggested: suggested.port, problem: null }
        const verdict = await this.deps.provision.checkPort(args.port, args.own ?? undefined)
        if (verdict.ok) return { ok: true, suggested: suggested.port, problem: null }
        if (verdict.code === 'unavailable') return refuse('unavailable', verdict.problem)
        return { ok: true, suggested: suggested.port, problem: verdict.problem }
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
            // it; after it, it is beside the tree. Both are asked about rather than assumed, and what is
            // asked is whether the repository is there, not whether the directory that holds it is: see
            // repositoryIn, and ensureRepo, which can leave that directory behind with nothing in it.
            const dir = (await deps.fs.exists(repositoryIn(trees))) ? trees.repo : environment.dir
            const log = await deps.fetcher.call({ verb: 'log', dir, branch: environment.branch, limit: args.limit })
            if (!log.ok) return refuse(log.code === 'bad-request' ? 'bad-request' : 'failed', log.message)
            return { ok: true, commits: log.commits ?? [] }
        }

        // Every action from here on runs up or writes the registry, which a port change in progress on
        // this environment is doing too
        if (this.portChanging.has(key)) return refuse('busy', `${project.id} ${environment.name} is moving to another port`)

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

    private deployWatch(project: ProjectEntry, args: { environment: EnvironmentName }): Outcome {
        const deploys = this.deps.deploys
        if (!deploys) return reply(refuse('unavailable', 'deploys are not wired up on this agent'))
        const environment = environmentOf(project, args.environment)
        if (!environment) return reply(refuse('unknown-environment', `${project.id} has no ${args.environment} environment`))

        const key = deployKey(project.id, args.environment)
        const watch = deploys.runner.watch
        // Everything printed before this watcher arrived, then everything after, with no gap between them:
        // there is no await between the replay and the subscribe, so nothing can be printed in between for
        // either of them to miss.
        const queue: DeployEvent[] = watch.replay(key)
        let queued = queue.reduce((total, event) => total + Buffer.byteLength(event.text), 0)
        const take = (): DeployEvent | undefined => {
            const next = queue.shift()
            if (next) queued -= Buffer.byteLength(next.text)
            return next
        }
        let closed = false
        let wake: (() => void) | null = null
        const unsubscribe = watch.subscribe(key, event => {
            queue.push(event)
            queued += Buffer.byteLength(event.text)
            // The same drop-oldest discipline, and the same bound, as the ring this queue drains from.
            // Without it the ring bounds only what an unattached watcher replays: once attached, a consumer
            // that has stopped reading (api suspends its generator at waitForDrain while the socket backs
            // up) would hold the whole of a chatty build here instead, which is the case the bound exists
            // for. A live column is read from the bottom, so the newest is what survives.
            while (queued > MAX_WATCH_BYTES && queue.length > 1) take()
            wake?.()
        })
        const close = () => {
            closed = true
            unsubscribe()
            wake?.()
        }
        async function* lines(): AsyncGenerator<DeployEvent> {
            try {
                for (;;) {
                    while (queue.length > 0) {
                        const next = take()
                        if (next) yield next
                    }
                    if (closed) return
                    await new Promise<void>(resolve => { wake = resolve })
                    wake = null
                }
            } finally {
                unsubscribe()
            }
        }
        return { kind: 'stream', lines: lines(), close }
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
        // It writes the registry entry and may rewrite the vhost a port change is rewriting too
        if (this.portChangingIn(project.id)) return refuse('busy', `${project.id} is moving an environment to another port`)
        // Which environments are having an address REPLACED rather than given one for the first time.
        // Read before the writes below, because they are what makes the old value unreadable, and it is
        // the old value that decides whether Apache has a file to rewrite afterwards.
        //
        // A change used to be refused here outright. It is allowed now: the portal puts the four things
        // it does (the old name stops resolving, every hostname is unverified again, aliases redirect
        // somewhere new, the vhost is rewritten) in front of the operator behind a typed confirmation,
        // so the decision is made where it can be explained rather than in a refusal nobody can act on
        // without an SSH session. Setting the same address twice changes nothing and is not counted.
        // An environment that does not exist is not checked here: the writer answers that in its own
        // words below, the same way set-branch leaves it to do.
        const replacing: EnvironmentName[] = []
        for (const [name, domain] of Object.entries(args.domains ?? {})) {
            const existing = environmentOf(project, name)?.domain
            if (existing && existing !== domain) replacing.push(name as EnvironmentName)
        }
        // And which are having a render-only switch flipped (WebSockets, Flexible SSL), read for the same
        // reason: the vhost has to follow the registry, and only the old value says whether this call
        // changes anything.
        const flips: Array<{ name: EnvironmentName, flag: EnvironmentFlag, enabled: boolean }> = []
        for (const flag of ENVIRONMENT_FLAGS) {
            for (const [name, enabled] of Object.entries(args[flag] ?? {})) {
                const existing = environmentOf(project, name)
                if (existing && existing[flag] !== enabled) flips.push({ name: name as EnvironmentName, flag, enabled })
            }
        }
        const switching = flips.map(flip => flip.name)

        // Validated where it is SET, not only where it is used: a name the fetcher does not hold would
        // otherwise sit in the registry until the next deploy discovered it. A null is clearing the key
        // and needs nothing checked, so the fetcher is not asked at all.
        if (args.credential) {
            const held = await this.credentials()
            if (!('credentials' in held)) return held
            if (!held.credentials.includes(args.credential)) {
                return refuse('bad-request', `no credential named ${args.credential}`)
            }
        }

        const written = await this.deps.writer.write({
            kind: 'configure',
            id: project.id,
            ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities }),
            ...(args.repo === undefined ? {} : { repo: args.repo }),
            ...(args.credential === undefined ? {} : { credential: args.credential }),
            ...(args.branches === undefined ? {} : { branches: args.branches }),
        })
        // The writer's problem is the registry validator's own words about what the operator asked for, so
        // it is bad-request rather than failed, exactly as the set-branch case above answers the same
        // refusal from the same writer. failed would reach the portal as a 502 and be audited as hostd
        // having failed, for a repo URL the validator simply would not take.
        if (!written.ok) return refuse('bad-request', written.problem)

        // A write of its own per domain, rather than a field on the configure change: an address is set
        // rarely and rewrites Apache when it moves, so folding it into the change that carries
        // capabilities, repo and branches would put it on the path of every routine capability save.
        //
        // Giving an environment its FIRST address does nothing beyond recording it. The hand-written
        // file still serving the site is displaced by adopting it, which is one reload rather than two
        // files claiming the same name.
        for (const [name, domain] of Object.entries(args.domains ?? {})) {
            const set = await this.deps.writer.write({
                kind: 'set-domain', id: project.id, environment: name as EnvironmentName, domain,
            })
            if (!set.ok) return refuse('bad-request', set.problem)
        }
        for (const { name, flag, enabled } of flips) {
            const set = await this.deps.writer.write({ kind: 'set-flag', id: project.id, environment: name, flag, enabled })
            if (!set.ok) return refuse('bad-request', set.problem)
        }
        // The registry store only reloads on its own ten second timer, so without this the next request
        // answers from the entry this write has already replaced: the capability just granted would still
        // look absent. set-branch and both provisioning paths refresh for the same reason.
        await this.deps.refreshRegistry()

        // Replacing an address, on the other hand, has to reach Apache: the old hostname is still in the
        // file hostd wrote, and a vhost naming a hostname the registry no longer claims is the one state
        // nothing else in hostd knows how to correct. After the registry write, never before, for the
        // reason setAliases writes the registry first.
        const problems: string[] = []
        const rewritten: ConfigureWritten[] = []
        // Once per environment, even when one save moves its address and flips a switch or two: the
        // rewrite renders from the registry as it now is, so a single pass carries both.
        for (const name of new Set([...replacing, ...switching])) {
            const result = await this.rewriteMovedVhost(project.id, name)
            if (result.problem !== null) problems.push(result.problem)
            else if (result.written !== null) rewritten.push(result.written)
        }
        // The registry has already changed by the time any of this ran, so a failed rewrite is not
        // "nothing happened": the two are now out of step and the operator has to be told which way.
        if (problems.length > 0) {
            return refuse(
                'failed',
                `${project.id}'s registry entry was updated, but the Apache configuration behind it was not:`
                + ` ${problems.join(' ')} The two no longer agree until this is put right.`,
            )
        }
        // No log call here: the Agent class never logs its own verbs (lifecycle, env and deploy above do
        // not either). server.ts's handleConnection logs every reply generically, including this one, via
        // its own describe()/log() after handle() returns.
        //
        // written carries what Apache is now serving, because api keeps the verification state and has no
        // other way to learn it: without this, the moved hostname would reach the store through
        // reconcile, as an unmanaged record with no token, which says hostd serves that name by hand. It
        // does not, and the operator would be left with a row they cannot even re-check.
        return {
            ok: true,
            written: rewritten,
            output: rewritten.length === 0
                ? `${project.id}'s registry entry was updated`
                : `${project.id}'s registry entry was updated and its Apache configuration was rewritten`,
        }
    }

    // Under the provisioning lock, because the port check reads the same registry snapshot a create does:
    // a create and a port change racing could otherwise both take one free port.
    private async port(project: ProjectEntry, environment: EnvironmentName, port: number): Promise<AgentReply> {
        const provision = this.deps.provision
        if (!provision) return refuse('unavailable', 'provisioning is not configured')
        if (this.provisioningBusy) return refuse('busy', 'another provisioning action is in progress')
        // Nor alongside anything else that touches this environment's containers or .env: a deploy's swap
        // runs up on the same compose project, a lifecycle action would read a half-changed .env, and an
        // env write would be lost when an undo puts back the whole .env it read. Every check and every
        // slot taken before the first await, so nothing can slip in between the two.
        if (this.deps.deploys?.runner.isRunning(deployKey(project.id, environment))) {
            return refuse('busy', `${project.id} ${environment} has a deploy running`)
        }
        if (this.lifecycleBusy.has(project.id)) return refuse('busy', `${project.id} already has a lifecycle action running`)
        const envKey = `${project.id}:${environment}`
        if (this.envBusy.has(envKey)) return refuse('busy', `${project.id} already has an env write running for ${environment}`)
        this.provisioningBusy = true
        this.envBusy.add(envKey)
        // Held, not just checked, so a lifecycle action or a deploy arriving mid-change is refused too
        this.lifecycleBusy.add(project.id)
        this.portChanging.add(envKey)
        try {
            return await changePort(project, environment, port, {
                checkPort: provision.checkPort,
                setPortEnv: (entry, key, value) => writePortEnv(entry, key, value, this.deps.envFs),
                restorePortEnv: (entry, previous) => restorePortEnv(entry, previous, this.deps.envFs),
                published: entry => resolvePublished({ dir: entry.dir, composePaths: entry.composePaths, composeName: entry.composeName }, this.deps.runner),
                writePort: async value => {
                    const written = await this.deps.writer.write({ kind: 'set-port', id: project.id, environment, port: value })
                    if (!written.ok) return written
                    await this.deps.refreshRegistry()
                    return { ok: true }
                },
                running: async entry => (await this.deps.docker.listProjectContainers(composeNameOf(entry)))
                    .some(container => container.State === 'running'),
                // The same up a deploy's swap runs, in the environment's own folder: compose recreates
                // exactly the containers whose ports changed, and never builds or pulls.
                up: async entry => {
                    const result = await this.deps.runner('docker', upArgv(locationIn(entry, entry.dir), composeNameOf(entry)), PORT_CHANGE_UP_TIMEOUT_MS)
                    if (result.timedOut) return { ok: false, message: 'up timed out' }
                    if (result.exitCode !== 0) return { ok: false, message: `up exited with code ${result.exitCode}: ${tail(result.stderr.trim(), 300)}` }
                    return { ok: true }
                },
                rewriteVhost: async () => (await this.rewriteMovedVhost(project.id, environment)).problem,
                hasOwnVhost: () => this.ownsVhost(project.id, environment),
            })
        } finally {
            this.provisioningBusy = false
            this.envBusy.delete(envKey)
            this.lifecycleBusy.delete(project.id)
            this.portChanging.delete(envKey)
        }
    }

    // Whether hostd wrote the vhost for this environment, read off the same file rewriteMovedVhost reads.
    // With no rail wired up hostd has never written one, so an environment with an address is served by
    // hand. A read that throws is left to the caller, which refuses rather than guessing.
    private async ownsVhost(id: string, name: EnvironmentName): Promise<boolean> {
        if (!this.deps.domains) return false
        return (await this.deps.domains.readFile(vhostPath(this.deps.domains.config.includeDir, id, name))) !== null
    }

    // The vhost behind an address that has just moved. hostd only owns a file it wrote itself, so the
    // absence of one means this environment is still served by hand and there is nothing here to rewrite:
    // the operator displaces that file by adopting the site, which is a separate, previewed decision. The
    // absence is read exactly as domains.ts reads it, off readFile answering null.
    //
    // Answers a problem rather than throwing one: the caller has already written the registry, and a rail
    // that never answers (which throws, after 30 seconds) must be reported as a disagreement rather than
    // crash the reply.
    private async rewriteMovedVhost(id: string, name: EnvironmentName): Promise<{ written: ConfigureWritten | null, problem: string | null }> {
        // Nothing wired the rail up, so hostd has never written a vhost for anything and there is no file
        // of its own to bring level. removeVhosts reads an absent domains dep the same way.
        if (!this.deps.domains) return { written: null, problem: null }
        const domains = this.deps.domains

        const path = vhostPath(domains.config.includeDir, id, name)
        let previous: string | null
        try {
            previous = await domains.readFile(path)
        } catch (error) {
            return { written: null, problem: `${path} could not be read: ${describeError(error)}.` }
        }
        if (previous === null) return { written: null, problem: null }

        // The token the file already carries, not a new one. Every hostname of the environment proves
        // itself against the one value in this file, so minting another would fail the aliases that were
        // answering perfectly well a moment ago, which reads as a DNS fault and gets debugged in the
        // wrong place. api mints tokens; nothing in the agent can, so a file this cannot read one out of
        // is left exactly as it is rather than rewritten with a value invented here.
        const token = tokenFromVhost(previous)
        if (token === null) {
            return { written: null, problem: `no verification token could be read out of ${path}, so it was left alone.` }
        }

        // Re-read rather than trusting the write, exactly as setAliases does: parseRegistry is what
        // enforces reserved names, the allowed carve-out and cross-project uniqueness, and a hostname the
        // wire grammar took can still fail those. The vhost is rendered from what came back, never from
        // the request.
        let registry: Registry
        try {
            registry = await domains.reloadRegistry()
        } catch (error) {
            return { written: null, problem: `the registry could not be re-read: ${describeError(error)}.` }
        }
        const entry = registry.projects.get(id)
        const environment = entry === undefined ? null : environmentOf(entry, name)
        if (!entry || !environment) {
            return { written: null, problem: `${id} ${name} did not survive the change, so its configuration was left alone.` }
        }

        try {
            const result = await writeVhost(domains, entry, environment, token)
            // The environment is carried alongside the hostnames and the path writeVhost answers with,
            // because one configure can move several and api records them per environment.
            return result.ok
                ? { written: { environment: name, ...result.written }, problem: null }
                : { written: null, problem: result.message }
        } catch (error) {
            return { written: null, problem: `${path} could not be rewritten: ${describeError(error)}.` }
        }
    }

    private async health(): Promise<HealthReply> {
        const invalid = Object.fromEntries([...this.deps.registry().invalid, ...this.deps.guardInvalid()])
        // system is figures for the portal to draw, kept apart from warnings on purpose: nothing it
        // reports, however alarming the number, may make this process unhealthy. railAge is the same
        // idea: a stale rail is worth surfacing (Task 14 does), but it is not this process's own health.
        const warnings = this.deps.warnings()
        if (this.deps.backups) {
            // Two signals the design defers to the backups phase. Warnings, not failures: a full backup
            // disk and a failed scheduled run are the operator's to act on, and neither means hostd itself
            // is unhealthy.
            // health is what the operator reads when something is already wrong, so a disk reading that
            // cannot be taken must degrade to a warning rather than take the whole reply down with it.
            const problem = await this.backupDiskProblem()
            if (problem) warnings.push(problem)
            warnings.push(...this.deps.backups.store.failures())
        }
        return { ok: true, warnings, invalid, system: await this.deps.system(), railAge: this.deps.railAge() }
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
            if (args.action === 'add-environment') return await addEnvironment(project, args, this.deps.provision, this.deps.envFs)
            const reply = await removeProject(project, args.environment, this.deps.provision)
            if (!reply.ok) return reply
            const note = await this.removeVhosts(project, args.environment)
            if (note === '') return reply
            return { ok: true, output: `${'output' in reply ? reply.output : ''}${note}` }
        } finally {
            this.provisioningBusy = false
        }
    }

    // Removing an environment has to take its vhost with it. Left behind, the file goes on claiming
    // that environment's hostnames and goes on proxying to a port choosePort is free to hand to another
    // project, which is one client's visitors reaching another client's application.
    //
    // After the registry write and never before, for the reason setAliases writes the registry first:
    // the registry is the record of what a site may serve, and the vhost is a rendering of it. The entry
    // is therefore already gone when this runs, so a failure here is reported in the output rather than
    // returned as one, and a rail that never answers (which throws, after 30 seconds) must not turn a
    // removal that did happen into an error the operator would retry.
    private async removeVhosts(project: ProjectEntry, environment: EnvironmentName | null): Promise<string> {
        // No capability means hostd never wrote a vhost for this project, and asking the rail to remove
        // a file that was never there would cost an Apache reload per removal for nothing.
        if (!this.deps.domains || !project.capabilities.has('domains')) return ''
        const domains = this.deps.domains
        const problems: string[] = []
        for (const entry of project.environments.values()) {
            if (environment !== null && entry.name !== environment) continue
            try {
                const result = await removeVhost(domains, project, entry)
                if (!result.ok) problems.push(result.message)
            } catch (error) {
                problems.push(`the vhost for ${project.id} ${entry.name} could not be removed: ${describeError(error)}`)
            }
        }
        return problems.length === 0 ? '' : ` ${problems.join(' ')}`
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
