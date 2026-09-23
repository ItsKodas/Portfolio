// Starts a deploy and answers immediately. A deploy is minutes of building; api's own call timeout is
// 150 seconds, so a verb that waited for one would always time out. The reply says the deploy started,
// and the deploy history (which the portal polls anyway) is where the outcome shows up.
//
// One deploy per environment at a time, as the design says. Two different environments may deploy at
// once: they share nothing but the machine.

import { describeError } from '../shared/formats.ts'
import { deployKey, type DeployRecord, type DeployTrigger } from '../shared/deploys.ts'
import { refuse, type Refusal } from '../shared/protocol.ts'
import type { EnvironmentEntry, EnvironmentName, ProjectEntry } from '../shared/registry.ts'
import { runDeploy, type DeployDeps, type DeployRequest } from './deploy.ts'
import type { DeployStore } from './deploy-state.ts'
import { DeployWatch } from './deploy-watch.ts'

export type DeployRunnerDeps = DeployDeps & { store: DeployStore }
export type DeployStartedReply = { ok: true, started: { environment: EnvironmentName, trigger: DeployTrigger } }
type Deploy = (project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps) => Promise<DeployRecord>

export class DeployRunner {
    private readonly running = new Map<string, Promise<void>>()
    // Beside `running`, and for the same reason: this class is what knows a deploy is happening.
    readonly watch: DeployWatch

    // `deploy` is injected only so the tests can hold a deploy open and watch the locking; everything
    // else passes the real one.
    constructor(private readonly deps: DeployRunnerDeps, private readonly deploy: Deploy = runDeploy) {
        this.watch = new DeployWatch(deps.now)
    }

    isRunning(key: string): boolean {
        return this.running.has(key)
    }

    start(project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest): DeployStartedReply | Refusal {
        const key = deployKey(project.id, environment.name)
        // Taken before any await, so two requests arriving together cannot both see a free slot.
        if (this.running.has(key)) return refuse('busy', `${project.id} ${environment.name} already has a deploy running`)
        // A person asking is what resumes a paused environment; the poller is what must stay stopped.
        if (request.trigger === 'poll' && this.deps.store.isPaused(key)) {
            return refuse('unavailable', `${project.id} ${environment.name} is paused after repeated failures; deploy it by hand to resume`)
        }

        this.running.set(key, this.run(key, project, environment, request))
        return { ok: true, started: { environment: environment.name, trigger: request.trigger } }
    }

    // For the tests, and for a clean shutdown: nothing in production awaits a deploy.
    async settle(): Promise<void> {
        await Promise.all([...this.running.values()])
    }

    private async run(key: string, project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest): Promise<void> {
        const startedAt = new Date(this.deps.now()).toISOString()
        this.watch.begin(key, startedAt)
        // runDeploy needs no knowledge of any of this. It already narrates itself through deps.log at
        // every phase, and it already reaches every command through deps.runner, so wrapping those two
        // here is the whole of how a deploy becomes watchable.
        const deps: DeployDeps = {
            ...this.deps,
            log: line => { this.deps.log(line); this.watch.step(key, line) },
            runner: (command, args, timeoutMs, onLine) => this.deps.runner(command, args, timeoutMs, line => {
                this.watch.output(key, line)
                onLine?.(line)
            }),
        }
        try {
            let record: DeployRecord
            try {
                // resume sits inside the same try as the deploy itself: begin() has already fired
                // unconditionally above, so anything between here and a record existing, resume failing
                // included, must still close the stream the same way a throwing deploy does.
                if (request.trigger !== 'poll') await this.deps.store.resume(key)
                record = await this.deploy(project, environment, request, deps)
            } catch (error) {
                // runDeploy returns its failures rather than throwing, so this is the unforeseen kind. It
                // still has to be recorded, or a deploy that crashes would never count towards the pause.
                record = {
                    commit: request.commit ?? '', subject: null, actor: request.actor, trigger: request.trigger,
                    startedAt: new Date(this.deps.now()).toISOString(), durationMs: 0,
                    outcome: 'failed', reason: describeError(error), output: null,
                }
            }
            this.watch.end(key, endText(record))
            await this.deps.store.record(key, record)
            if (this.deps.store.isPaused(key)) {
                this.deps.log(`deploy ${key}: paused after repeated failures; deploy it by hand to resume`)
            }
        } finally {
            this.running.delete(key)
        }
    }
}

// What a watcher sees last. The outcome and the duration always, the reason when there is one, so the
// panel can stop without asking the history what happened.
function endText(record: DeployRecord): string {
    const seconds = `${Math.round(record.durationMs / 1000)}s`
    const outcome = record.outcome === 'ok' ? 'deployed' : record.outcome
    return record.reason ? `${outcome} in ${seconds}: ${record.reason}` : `${outcome} in ${seconds}`
}
