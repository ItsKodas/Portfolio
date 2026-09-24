import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { DeployPoller, POLL_EVERY_MS } from './deploy-poller.ts'
import { DeployStore, type DeployStateFs } from './deploy-state.ts'
import { parseRegistry, type EnvironmentEntry, type ProjectEntry } from '../shared/registry.ts'
import type { DeployRequest } from './deploy.ts'
import type { DeployRecord } from '../shared/deploys.ts'
import { DeployRunner, type DeployRunnerDeps } from './deploy-runner.ts'

const TIP = '3f7c1a2b5d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a'
const OTHER = 'f00dcafedeadbeef0000111122223333444455556'

const REGISTRY_YAML = `
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
        deployed: ${TIP.slice(0, 7)}
      test:
        dir: /var/www/acme-test
        branch: develop
        port: 5110
  manual:
    client: cl_2
    name: Manual
    dir: /var/www/manual
    upstream: 127.0.0.1:5020
    services:
      web: { role: site }
    capabilities: [lifecycle]
`

const failure = (): DeployRecord => ({
    commit: 'abc1234', subject: null, actor: 'hostd', trigger: 'poll',
    startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1, outcome: 'failed', reason: null, output: null,
})

function memoryFs(): DeployStateFs {
    const files = new Map<string, string>()
    return {
        readFile: async path => files.get(path) ?? Promise.reject(new Error('missing')),
        writeFile: async (path, text) => { files.set(path, text) },
        rename: async (from, to) => { files.set(to, files.get(from)!); files.delete(from) },
        mkdir: async () => {},
    }
}

function setup(options: { tips?: Record<string, string>, tipProblem?: string, tipThrows?: string, registryYaml?: string } = {}) {
    const registry = parseRegistry(options.registryYaml ?? REGISTRY_YAML)
    const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
    const started: Array<{ key: string, request: DeployRequest }> = []
    const asked: string[] = []
    const running = new Set<string>()
    const logs: string[] = []
    let clock = 0

    const poller = new DeployPoller({
        registry: () => registry,
        store,
        runner: {
            isRunning: (key: string) => running.has(key),
            start: (project: ProjectEntry, environment: EnvironmentEntry, request: DeployRequest) => {
                started.push({ key: `${project.id}:${environment.name}`, request })
                return { ok: true as const, started: { environment: environment.name, trigger: request.trigger } }
            },
        },
        tip: async (project, environment) => {
            asked.push(`${project.id}:${environment.name}`)
            if (options.tipThrows) throw new Error(options.tipThrows)
            if (options.tipProblem) return { ok: false as const, problem: options.tipProblem }
            return { ok: true as const, commit: options.tips?.[`${project.id}:${environment.name}`] ?? TIP }
        },
        now: () => clock,
        log: message => logs.push(message),
    })
    return { poller, store, started, asked, running, logs, advance: (ms: number) => { clock += ms } }
}

describe('DeployPoller', () => {
    it('deploys an environment whose branch has moved', async () => {
        const context = setup({ tips: { 'acme:live': OTHER } })
        const keys = await context.poller.tick()
        assert.ok(keys.includes('acme:live'))
        const start = context.started.find(entry => entry.key === 'acme:live')!
        assert.equal(start.request.trigger, 'poll')
        assert.equal(start.request.commit, OTHER)
        assert.equal(start.request.actor, 'hostd')
    })

    it('leaves an environment alone when the tip is the abbreviated commit already deployed', async () => {
        const context = setup()
        await context.poller.tick()
        assert.equal(context.started.some(start => start.key === 'acme:live'), false)
    })

    it('deploys an environment that has never deployed', async () => {
        const context = setup()
        const keys = await context.poller.tick()
        assert.ok(keys.includes('acme:test'))
    })

    it('never polls a project without the deploy capability', async () => {
        const context = setup()
        await context.poller.tick()
        assert.equal(context.asked.some(key => key.startsWith('manual:')), false)
    })

    it('waits two minutes before checking the same environment again', async () => {
        const context = setup()
        await context.poller.tick()
        const first = context.asked.length
        await context.poller.tick()
        assert.equal(context.asked.length, first)
        context.advance(POLL_EVERY_MS)
        await context.poller.tick()
        assert.ok(context.asked.length > first)
    })

    it('skips an environment that is already deploying', async () => {
        const context = setup()
        context.running.add('acme:test')
        const keys = await context.poller.tick()
        assert.equal(keys.includes('acme:test'), false)
        assert.equal(context.asked.includes('acme:test'), false)
    })

    it('skips a paused environment without so much as a fetch', async () => {
        const context = setup()
        for (let i = 0; i < 3; i++) await context.store.record('acme:test', failure())
        assert.equal(context.store.isPaused('acme:test'), true)
        const keys = await context.poller.tick()
        assert.equal(keys.includes('acme:test'), false)
        assert.equal(context.asked.includes('acme:test'), false)
    })

    it('logs a fetch that failed and does not count it as a deploy failure', async () => {
        const context = setup({ tipProblem: 'could not read from remote repository' })
        const keys = await context.poller.tick()
        assert.deepEqual(keys, [])
        assert.equal(context.store.get('acme:live').consecutiveFailures, 0)
        assert.ok(context.logs.some(line => line.includes('could not read from remote repository')))
    })

    it('treats a fetch that throws the same way, rather than taking the whole tick down with it', async () => {
        const context = setup({ tipThrows: 'the fetcher did not answer within 330 seconds' })
        const keys = await context.poller.tick()
        assert.deepEqual(keys, [])
        assert.ok(context.logs.some(line => line.includes('did not answer')))
    })
})

describe('a poll during a delete or restore', () => {
    it('starts no deploy of an environment the agent has blocked', async () => {
        const registry = parseRegistry(REGISTRY_YAML)
        const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
        const deployed: string[] = []
        const runner = new DeployRunner(
            { store, registry: () => registry, log: () => {}, now: () => 0 } as unknown as DeployRunnerDeps,
            async (project, environment, request) => {
                deployed.push(`${project.id}:${environment.name}`)
                return { ...failure(), outcome: 'ok', trigger: request.trigger }
            },
        )
        const logs: string[] = []
        const poller = new DeployPoller({
            registry: () => registry, store, runner,
            tip: async () => ({ ok: true as const, commit: OTHER }),
            now: () => 0,
            log: message => logs.push(message),
        })
        const unblock = runner.block('acme:live')
        const started = await poller.tick()
        await runner.settle()
        unblock()
        assert.ok(!started.includes('acme:live'))
        assert.ok(!deployed.includes('acme:live'))
        assert.ok(logs.some(line => line.includes('acme:live') && line.includes('being deleted or restored')))
    })
})

describe('an environment deleted while its tip is being read', () => {
    const WITHOUT_TEST = REGISTRY_YAML.replace(/      test:\n(        .*\n)+/, '')

    function racing(after: string) {
        let current = parseRegistry(REGISTRY_YAML)
        const store = new DeployStore('/var/lib/hostd/deploys.json', memoryFs())
        const started: string[] = []
        const logs: string[] = []
        const poller = new DeployPoller({
            registry: () => current,
            store,
            runner: {
                isRunning: () => false,
                start: (project: ProjectEntry, environment: EnvironmentEntry) => {
                    started.push(`${project.id}:${environment.name}`)
                    return { ok: true as const, started: { environment: environment.name, trigger: 'poll' as const } }
                },
            },
            tip: async (_project, environment) => {
                // The delete finishes while the fetcher is answering, so the registry the tick read is stale
                if (environment.name === 'test') current = parseRegistry(after)
                return { ok: true as const, commit: OTHER }
            },
            now: () => 0,
            log: message => logs.push(message),
        })
        return { poller, started, logs }
    }

    it('is not deployed', async () => {
        const context = racing(WITHOUT_TEST)
        const keys = await context.poller.tick()
        assert.ok(!keys.includes('acme:test'))
        assert.ok(!context.started.includes('acme:test'))
        assert.ok(context.logs.some(line => line.includes('acme:test') && line.includes('no longer')))
    })

    it('is not deployed when its dir changed meanwhile', async () => {
        const context = racing(REGISTRY_YAML.replace('/var/www/acme-test', '/var/www/acme-other'))
        await context.poller.tick()
        assert.ok(!context.started.includes('acme:test'))
    })

    it('still deploys the environments that remain', async () => {
        const context = racing(WITHOUT_TEST)
        await context.poller.tick()
        assert.ok(context.started.includes('acme:live'))
    })
})
