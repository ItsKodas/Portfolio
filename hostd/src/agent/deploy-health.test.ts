import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { unhealthyServices, waitForHealthy, HEALTH_TIMEOUT_MS } from './deploy-health.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.ts'
import type { ServiceStatus } from '../shared/protocol.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
`)
const project = registry.projects.get('acme')!

const status = (service: string, state: string, health: string | null): ServiceStatus =>
    ({ service, role: 'site', state, health, startedAt: null, restartCount: null, image: null })

describe('unhealthyServices', () => {
    it('is happy when every service is running and nothing reports a health status', () => {
        assert.deepEqual(unhealthyServices([status('web', 'running', null), status('db', 'running', null)]), [])
    })

    it('names a service that is not running', () => {
        assert.deepEqual(unhealthyServices([status('web', 'exited', null), status('db', 'running', null)]), ['web (exited)'])
    })

    it('names a service whose container reports unhealthy', () => {
        assert.deepEqual(unhealthyServices([status('web', 'running', 'unhealthy'), status('db', 'running', 'healthy')]), ['web (unhealthy)'])
    })

    it('waits on a container that is still starting', () => {
        assert.deepEqual(unhealthyServices([status('web', 'running', 'starting'), status('db', 'running', 'healthy')]), ['web (starting)'])
    })

    it('names a service with no container at all', () => {
        assert.deepEqual(unhealthyServices([status('web', 'missing', null), status('db', 'running', null)]), ['web (missing)'])
    })
})

type Frame = { state: string, health?: string }

function fakeDocker(frames: Frame[]) {
    let at = 0
    const docker: Partial<DockerApi> = {
        async listProjectContainers(): Promise<ContainerSummary[]> {
            return ['web', 'db'].map((service, index) => ({
                Id: `${'a'.repeat(12)}${index}`,
                State: 'running',
                Labels: { 'com.docker.compose.service': service },
            }))
        },
        async inspect(): Promise<ContainerInspect> {
            const frame = frames[Math.min(at, frames.length - 1)]!
            return {
                Id: 'a'.repeat(12),
                RestartCount: 0,
                Config: { Tty: false, Image: 'acme-web' },
                State: { Status: frame.state, StartedAt: '2026-09-21T00:00:00Z', ...(frame.health ? { Health: { Status: frame.health } } : {}) },
            }
        },
    }
    return { docker: docker as DockerApi, next: () => { at++ } }
}

describe('waitForHealthy', () => {
    it('passes as soon as everything is running', async () => {
        const { docker } = fakeDocker([{ state: 'running' }])
        let slept = 0
        const result = await waitForHealthy(project, 'acme', { docker, now: () => 0, sleep: async ms => { slept += ms } })
        assert.deepEqual(result, { ok: true })
        assert.equal(slept, 0)
    })

    it('waits for a container that starts unhealthy and becomes healthy', async () => {
        const { docker, next } = fakeDocker([{ state: 'running', health: 'starting' }, { state: 'running', health: 'healthy' }])
        const result = await waitForHealthy(project, 'acme', { docker, now: () => 0, sleep: async () => { next() } })
        assert.deepEqual(result, { ok: true })
    })

    it('gives up after the timeout and says which service was wrong', async () => {
        const { docker } = fakeDocker([{ state: 'running', health: 'unhealthy' }])
        let clock = 0
        const result = await waitForHealthy(project, 'acme', { docker, now: () => clock, sleep: async ms => { clock += ms } })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /web \(unhealthy\)/)
        assert.ok(clock >= HEALTH_TIMEOUT_MS)
    })

    it('treats a Docker read that throws as not healthy yet, and reports it if time runs out', async () => {
        const docker = {
            listProjectContainers: async () => { throw new Error('socket closed') },
            inspect: async () => { throw new Error('socket closed') },
        } as unknown as DockerApi
        let clock = 0
        const result = await waitForHealthy(project, 'acme', { docker, now: () => clock, sleep: async ms => { clock += ms } })
        assert.equal(result.ok, false)
        assert.match(result.ok === false ? result.problem : '', /socket closed/)
    })

    it('asks Docker for the compose project it was given, not the registry id', async () => {
        const asked: string[] = []
        const { docker } = fakeDocker([{ state: 'running' }])
        const spied: DockerApi = { ...docker, listProjectContainers: async name => { asked.push(name); return docker.listProjectContainers(name) } }
        await waitForHealthy(project, 'acme-test', { docker: spied, now: () => 0, sleep: async () => {} })
        assert.deepEqual(asked, ['acme-test'])
    })
})
