// How a deploy is noticed: every 2 minutes per environment, ask GitHub for the tip of the tracked
// branch and compare it with what the registry says is deployed. No webhook, deliberately (see the
// design): nothing new is exposed to the internet, it works the same for every repo, and it survives the
// dedi's dynamic IP. The cost is that a deploy can start up to 2 minutes after a push.

import { describeError } from '../shared/formats.ts'
import { deployKey } from '../shared/deploys.ts'
import type { EnvironmentEntry, ProjectEntry, Registry } from '../shared/registry.ts'
import type { Refusal } from '../shared/protocol.ts'
import type { DeployRequest } from './deploy.ts'
import type { DeployStore } from './deploy-state.ts'
import type { DeployStartedReply } from './deploy-runner.ts'

export const POLL_EVERY_MS = 120_000

export type PollerDeps = {
    registry: () => Registry
    store: DeployStore
    runner: {
        isRunning(key: string): boolean
        start(project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest): DeployStartedReply | Refusal
    }
    tip(project: ProjectEntry, environment: EnvironmentEntry): Promise<{ ok: true, commit: string } | { ok: false, problem: string }>
    now: () => number
    log(message: string): void
}

export class DeployPoller {
    private readonly checkedAt = new Map<string, number>()

    constructor(private readonly deps: PollerDeps) {}

    // Returns the keys it started a deploy for, which is what the agent's main loop logs. Never throws:
    // one unreachable remote must not stop the other environments being checked.
    async tick(): Promise<string[]> {
        const started: string[] = []
        for (const project of this.deps.registry().projects.values()) {
            if (!project.repo || !project.capabilities.has('deploy')) continue
            for (const environment of project.environments.values()) {
                if (!environment.branch) continue
                const key = deployKey(project.id, environment.name)
                if (this.deps.runner.isRunning(key)) continue
                // Checked before the fetch, not after: a paused environment must cost nothing at all,
                // which is the whole point of pausing it.
                if (this.deps.store.isPaused(key)) continue
                const last = this.checkedAt.get(key)
                if (last !== undefined && this.deps.now() - last < POLL_EVERY_MS) continue
                this.checkedAt.set(key, this.deps.now())

                let tip: { ok: true, commit: string } | { ok: false, problem: string }
                try {
                    tip = await this.deps.tip(project, environment)
                } catch (error) {
                    tip = { ok: false, problem: describeError(error) }
                }
                if (!tip.ok) {
                    // Nothing was deployed, so nothing is recorded: a remote that is briefly unreachable
                    // must not spend one of the three failures that pause an environment.
                    this.deps.log(`poll ${key}: could not read the branch tip: ${tip.problem}`)
                    continue
                }
                // The registry's `deployed` may be abbreviated (the operator can write one by hand), so
                // it is compared as a prefix of the full hash the fetcher returns rather than for
                // equality, which would redeploy the same commit for ever.
                if (environment.deployed && tip.commit.startsWith(environment.deployed)) continue

                const reply = this.deps.runner.start(project, environment, { trigger: 'poll', actor: 'hostd', commit: tip.commit })
                if (reply.ok) {
                    this.deps.log(`poll ${key}: ${environment.branch} moved to ${tip.commit.slice(0, 7)}, deploying`)
                    started.push(key)
                } else {
                    this.deps.log(`poll ${key}: not deploying, ${reply.message}`)
                }
            }
        }
        return started
    }
}
