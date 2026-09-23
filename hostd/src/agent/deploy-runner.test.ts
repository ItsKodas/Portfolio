import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployRunner, type DeployRunnerDeps } from './deploy-runner.ts'
import { DeployStore, type DeployStateFs } from './deploy-state.ts'
import { parseRegistry, type EnvironmentEntry, type ProjectEntry } from '../shared/registry.ts'
import type { DeployDeps, DeployRequest } from './deploy.ts'
import type { Runner } from './compose.ts'
import type { DeployRecord } from '../shared/deploys.ts'

// Matches the private `Deploy` type DeployRunner's own constructor takes. Not exported from there, so
// the tests name the same shape rather than reaching into the module's internals for it.
type Deploy = (project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest, deps: DeployDeps) => Promise<DeployRecord>

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

// For the watch tests below: a DeployRunner whose deploy is whatever the test hands it, over a fake
// runner that plays back `runnerLines` to the onLine callback it is given before resolving.
function makeRunner(options: { deploy: Deploy, log?: (message: string) => void, runnerLines?: string[] }): DeployRunner {
    const runner: Runner = async (_command, _args, _timeoutMs, onLine) => {
        for (const line of options.runnerLines ?? []) onLine?.(line)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    }
    const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
    const deps = {
        store, runner, now: () => 1_000,
        log: options.log ?? (() => {}),
    } as unknown as DeployRunnerDeps
    return new DeployRunner(deps, options.deploy)
}

function okRecord(): DeployRecord {
    return {
        commit: 'abc1234', subject: null, actor: 'koda', trigger: 'manual',
        startedAt: '2026-09-23T05:00:00.000Z', durationMs: 9000, outcome: 'ok', reason: null, output: null,
    }
}

function failedRecord(reason: string): DeployRecord {
    return { ...okRecord(), outcome: 'failed', reason }
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

describe('DeployRunner watch', () => {
    // The narrative comes out of code that already exists: runDeploy calls deps.log at every phase, and
    // those calls are what a watcher reads. Nothing in runDeploy changes.
    it('tees every deps.log line from a deploy into the buffer as a step', async () => {
        const seen: string[] = []
        const runner = makeRunner({
            deploy: async (_project, _environment, _request, deps) => {
                deps.log('deploy acme live abc1234: building')
                return okRecord()
            },
        })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project, environment, { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        assert.ok(seen.includes('step:deploy acme live abc1234: building'), seen.join(' | '))
    })

    it('tees a command line from inside a deploy into the buffer as output', async () => {
        const seen: string[] = []
        const runner = makeRunner({
            deploy: async (_project, _environment, _request, deps) => {
                await deps.runner('docker', ['compose', 'build'], 1000)
                return okRecord()
            },
            runnerLines: ['#7 [4/9] RUN npm ci'],
        })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project, environment, { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        assert.ok(seen.includes('output:#7 [4/9] RUN npm ci'), seen.join(' | '))
    })

    it('ends the buffer with the outcome, so a watcher need not poll the history', async () => {
        const seen: string[] = []
        const runner = makeRunner({ deploy: async () => okRecord() })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project, environment, { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        const last = seen[seen.length - 1] ?? ''
        assert.ok(last.startsWith('end:'), last)
        assert.ok(last.includes('deployed'), last)
    })

    it('says why on the end event when a deploy fails', async () => {
        const seen: string[] = []
        const runner = makeRunner({ deploy: async () => failedRecord('build exited with code 1') })
        runner.watch.subscribe('acme:live', event => seen.push(`${event.kind}:${event.text}`))
        runner.start(project, environment, { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        const last = seen[seen.length - 1] ?? ''
        assert.ok(last.includes('build exited with code 1'), last)
    })

    // The agent's own log is not the portal's. A deploy still narrates itself to stdout exactly as before.
    it('still writes every line to the agent log as well', async () => {
        const logged: string[] = []
        const runner = makeRunner({
            log: line => logged.push(line),
            deploy: async (_project, _environment, _request, deps) => {
                deps.log('building')
                return okRecord()
            },
        })
        runner.start(project, environment, { trigger: 'manual', actor: 'koda' })
        await runner.settle()
        assert.ok(logged.includes('building'), logged.join(' | '))
    })
})
