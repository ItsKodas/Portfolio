import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { guardProblems } from './guard.ts'
import type { ResolvedCompose } from './compose.ts'
import { parseRegistry, type ProjectEntry } from '../shared/registry.ts'

function entry(extra = '', compose = 'docker-compose.yml'): ProjectEntry {
    const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    compose: ${compose}
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
      appdb: { role: database, engine: sqlite, file: sqlite/app.db }
    storage:
      media: { path: uploads, mode: rw }
${extra}`)
    const project = registry.projects.get('acme')
    assert.ok(project, JSON.stringify([...registry.invalid]))
    return project
}

const bind = (source: string) => ({ type: 'bind', source, target: '/x' })

function resolved(overrides: Partial<ResolvedCompose['services']> = {}, name = 'acme'): ResolvedCompose {
    return {
        name,
        services: {
            web: { volumes: [bind('/var/www/acme/uploads'), { type: 'volume', source: 'cache' }], build: { context: '/var/www/acme', dockerfile: 'Dockerfile' } },
            db: { volumes: [bind('/var/www/acme/db')], env_file: [{ path: '/var/www/acme/db.env' }] },
            ...overrides,
        } as ResolvedCompose['services'],
    }
}

describe('guardProblems', () => {
    it('passes a project whose storage is a site bind mount and nothing compose reads', () => {
        assert.deepEqual(guardProblems(entry(), resolved()), [])
    })

    // A start with a different project name would create a second copy of the site beside the running one.
    it('refuses a project whose compose name differs from the registry id', () => {
        assert.deepEqual(guardProblems(entry(), resolved({}, 'acme-old')), [
            'compose resolves the project name acme-old, not acme; set name: acme in the compose file, or rename the registry entry',
        ])
    })

    it('refuses a registered service that is not in the compose file, but not a SQLite entry', () => {
        const { db: _db, ...withoutDb } = resolved().services
        assert.deepEqual(guardProblems(entry(), { name: 'acme', services: withoutDb }), ['service db is not in the compose file'])
    })

    it('refuses storage that is not bind-mounted into a site service', () => {
        const problems = guardProblems(entry(), resolved({ web: { volumes: [] } }))
        assert.deepEqual(problems, ['storage media (/var/www/acme/uploads) is not bind-mounted into a site service'])
    })

    // Must-exist test 2 (spec, Testing strategy): the storage guard.
    describe('must-exist: storage that would expose a database or anything compose reads', () => {
        it('refuses storage mounted into a database service as well', () => {
            const problems = guardProblems(entry(), resolved({ db: { volumes: [bind('/var/www/acme/uploads')] } }))
            assert.deepEqual(problems, ['storage media overlaps a database service\'s mount'])
        })

        it('refuses storage inside a database mount', () => {
            const problems = guardProblems(entry(), resolved({ db: { volumes: [bind('/var/www/acme')] } }))
            assert.ok(problems.includes('storage media overlaps a database service\'s mount'), problems.join('\n'))
        })

        it('refuses storage that contains the compose file', () => {
            const problems = guardProblems(
                entry('', 'uploads/docker-compose.yml'),
                resolved(),
            )
            assert.deepEqual(problems, ['storage media contains /var/www/acme/uploads/docker-compose.yml, which compose reads'])
        })

        it('refuses storage that contains an env_file, in either of compose\'s spellings', () => {
            for (const envFile of ['/var/www/acme/uploads/.env.web', { path: '/var/www/acme/uploads/.env.web' }]) {
                const problems = guardProblems(entry(), resolved({
                    web: { volumes: [bind('/var/www/acme/uploads')], env_file: [envFile] },
                }))
                assert.deepEqual(problems, ['storage media contains /var/www/acme/uploads/.env.web, which compose reads'], JSON.stringify(envFile))
            }
        })

        it('refuses storage that contains a build context or a Dockerfile', () => {
            assert.deepEqual(
                guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads')], build: { context: '/var/www/acme/uploads/app' } } })),
                ['storage media contains /var/www/acme/uploads/app, which compose reads'],
            )
            assert.deepEqual(
                guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads')], build: { context: '/var/www/acme', dockerfile: 'uploads/Dockerfile' } } })),
                ['storage media contains /var/www/acme/uploads/Dockerfile, which compose reads'],
            )
        })
    })

    // The deliberate difference from the spec, recorded above: storage inside a build context is allowed.
    it('allows storage inside a build context, the usual build: . layout', () => {
        assert.deepEqual(guardProblems(entry(), resolved()), [])
    })

    it('ignores a build context that is a URL rather than a path', () => {
        const problems = guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads')], build: 'https://github.com/example/app.git' } }))
        assert.deepEqual(problems, [])
    })

    it('treats a trailing slash on a bind source as the same directory', () => {
        assert.deepEqual(guardProblems(entry(), resolved({ web: { volumes: [bind('/var/www/acme/uploads/')] } })), [])
    })
})
