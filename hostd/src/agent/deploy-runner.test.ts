import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployRunner, type DeployRunnerDeps } from './deploy-runner.ts'
import { DeployStore, type DeployStateFs } from './deploy-state.ts'
import { parseRegistry, type EnvironmentEntry, type ProjectEntry } from '../shared/registry.ts'
import type { DeployRequest } from './deploy.ts'
import type { DeployRecord } from '../shared/deploys.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services:
      web: { role: site }
    capabilities: [deploy]
    environments:
      live:
        dir: /var/www/acme
        branch: main
        port: 5010
`)
const project = registry.projects.get('acme')!
const environment = project.environments.get('live')!

function memoryFs(): DeployStateFs {
    const files = new Map<string, string>()
    return {
        readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
        writeFile: async (path, text) => { files.set(path, text) },
        rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
        mkdir: async () => {},
    }
}

// Only the two dependencies the runner itself uses (the store and the log) are real here: the deploy it
// runs is the injected one below, so a test can hold one open and watch the locking.
function setup(outcome: DeployRecord['outcome'] = 'ok') {
    const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
    const runs: string[] = []
    const logs: string[] = []
    let release = () => {}
    let gate = new Promise<void>(resolve => { release = resolve })
    const deploy = async (_project: ProjectEntry, _environment: EnvironmentEntry, request: DeployRequest): Promise<DeployRecord> => {
        runs.push(request.trigger)
        await gate
        return {
            commit: 'abc1234', subject: null, actor: request.actor, trigger: request.trigger,
            startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1, outcome, reason: null, output: null,
        }
    }
    const deps = { store, log: (message: string) => logs.push(message), now: () => 1_000 } as unknown as DeployRunnerDeps
    const runner = new DeployRunner(deps, deploy)
    const finish = async () => {
        release()
        await runner.settle()
        gate = new Promise<void>(resolve => { release = resolve })
    }
    return { runner, store, runs, logs, finish }
}

describe('DeployRunner', () => {
    it('starts a deploy and answers at once, without waiting for it', async () => {
        const context = setup()
        const started = context.runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        // The reply is there before the deploy has even begun: that is the whole point of this class.
        assert.deepEqual(started, { ok: true, started: { environment: 'live', trigger: 'manual' } })
        assert.equal(context.runner.isRunning('acme:live'), true)
        await context.finish()
        assert.deepEqual(context.runs, ['manual'])
        assert.equal(context.runner.isRunning('acme:live'), false)
    })

    it('refuses a second deploy for the same environment while one is running', async () => {
        const context = setup()
        context.runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        const second = context.runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
        assert.equal(second.ok, false)
        assert.equal(second.ok === false ? second.code : '', 'busy')
        await context.finish()
    })

    it('records what the deploy did', async () => {
        const context = setup('rolled-back')
        context.runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
        await context.finish()
        assert.equal(context.store.get('acme:live').deploys[0]!.outcome, 'rolled-back')
        assert.equal(context.store.get('acme:live').consecutiveFailures, 1)
    })

    it('refuses to poll a paused environment, and lets a person deploy it anyway', async () => {
        const context = setup('failed')
        for (let i = 0; i < 3; i++) {
            context.runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
            await context.finish()
        }
        assert.equal(context.store.isPaused('acme:live'), true)
        const polled = context.runner.start(project, environment, { trigger: 'poll', actor: 'hostd' })
        assert.equal(polled.ok, false)
        assert.equal(polled.ok === false ? polled.code : '', 'unavailable')

        const manual = context.runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        assert.equal(manual.ok, true)
        await context.finish()
        // The manual deploy failed too, so it is paused again, but it did run.
        assert.equal(context.store.get('acme:live').deploys.length, 4)
        assert.ok(context.logs.some(line => line.includes('paused')))
    })

    it('releases the environment when the deploy itself throws, and still counts the failure', async () => {
        const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
        const deps = { store, log: () => {}, now: () => 1_000 } as unknown as DeployRunnerDeps
        const runner = new DeployRunner(deps, async () => { throw new Error('unexpected') })
        runner.start(project, environment, { trigger: 'manual', actor: 'admin' })
        await runner.settle()
        assert.equal(runner.isRunning('acme:live'), false)
        assert.equal(store.get('acme:live').deploys[0]!.outcome, 'failed')
        assert.equal(store.get('acme:live').deploys[0]!.reason, 'unexpected')
    })
})
