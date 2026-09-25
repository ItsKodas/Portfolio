import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { declaredServices, environmentServices, missingSiteProblem } from './environment-services.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { Runner } from './compose.ts'

const project = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      mongo: { role: database, engine: mongodb }
      files: { role: database, engine: sqlite, file: data/app.db }
`).projects.get('acme')!

const location = { dir: '/var/www/acme/uat1', composePaths: ['/var/www/acme/uat1/docker-compose.yml'], composeName: 'acme-uat1' }

function runnerAnswering(result: Partial<Awaited<ReturnType<Runner>>>): { runner: Runner, calls: string[][] } {
    const calls: string[][] = []
    const runner: Runner = async (_command, args) => {
        calls.push(args)
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result }
    }
    return { runner, calls }
}

describe('declaredServices', () => {
    it('keeps the registered services the compose file declares and drops the rest', () => {
        const services = declaredServices(project, { name: 'acme-uat1', services: { web: {}, worker: {} } })
        assert.deepEqual(Object.keys(services), ['web', 'files'])
    })

    // sqlite is a file the site opens, not a compose service, so no compose file ever declares it
    it('keeps a sqlite database whatever the compose file says', () => {
        assert.ok(Object.hasOwn(declaredServices(project, { name: 'acme-uat1', services: {} }), 'files'))
    })
})

describe('missingSiteProblem', () => {
    it('is null while a site service is declared', () => {
        assert.equal(missingSiteProblem(project, { web: { role: 'site' } }), null)
    })

    it("names the registry's site services when none is declared", () => {
        assert.equal(
            missingSiteProblem(project, { mongo: { role: 'database', engine: 'mongodb', dump: {} } }),
            "none of the registry's site services (web) is in this environment's compose file",
        )
    })
})

describe('environmentServices', () => {
    it("reads the environment's own compose config", async () => {
        const { runner, calls } = runnerAnswering({ stdout: JSON.stringify({ name: 'acme-uat1', services: { web: {} } }) })
        const result = await environmentServices(project, location, runner)
        assert.deepEqual(result, { ok: true, services: { web: { role: 'site' }, files: project.services.files } })
        assert.deepEqual(calls[0]!.slice(0, 5), ['compose', '--project-name', 'acme-uat1', '--project-directory', '/var/www/acme/uat1'])
        assert.ok(calls[0]!.includes('config'))
    })

    it('says so when the compose config cannot be read', async () => {
        const { runner } = runnerAnswering({ exitCode: 1, stderr: 'no such file' })
        const result = await environmentServices(project, location, runner)
        assert.deepEqual(result, { ok: false, problem: "the environment's compose file could not be read: docker compose config failed: no such file" })
    })
})
