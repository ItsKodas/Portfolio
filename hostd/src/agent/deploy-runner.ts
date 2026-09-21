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

export type DeployRunnerDeps = DeployDeps & { store: DeployStore }
export type DeployStartedReply = { ok: true, started: { environment: EnvironmentName, trigger: DeployTrigger } }
type Deploy = (project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps) => Promise<DeployRecord>

export class DeployRunner {
    private readonly running = new Map<string, Promise<void>>()

    // `deploy` is injected only so the tests can hold a deploy open and watch the locking; everything
    // else passes the real one.
    constructor(private readonly deps: DeployRunnerDeps, private readonly deploy: Deploy = runDeploy) {}

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
        try {
            if (request.trigger !== 'poll') await this.deps.store.resume(key)
            let record: DeployRecord
            try {
                record = await this.deploy(project, environment, request, this.deps)
            } catch (error) {
                // runDeploy returns its failures rather than throwing, so this is the unforeseen kind. It
                // still has to be recorded, or a deploy that crashes would never count towards the pause.
                record = {
                    commit: request.commit ?? '', subject: null, actor: request.actor, trigger: request.trigger,
                    startedAt: new Date(this.deps.now()).toISOString(), durationMs: 0,
                    outcome: 'failed', reason: describeError(error), output: null,
                }
            }
            await this.deps.store.record(key, record)
            if (this.deps.store.isPaused(key)) {
                this.deps.log(`deploy ${key}: paused after repeated failures; deploy it by hand to resume`)
            }
        } finally {
            this.running.delete(key)
        }
    }
}
