import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRegistry, RegistryError, isComposeService, MAX_COMPOSE_FILES } from './registry.ts'

const valid = `
reserved: [horizons.gg]
offsite:
  keep: { daily: 14, weekly: 8, monthly: 6 }
projects:
  acme-bakery:
    client: cl_8f2k1
    name: Acme Bakery
    dir: /var/www/acme-bakery
    compose: docker-compose.yml
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      db: { role: database, engine: postgres }
    storage:
      media: { path: uploads, mode: rw }
      exports: { path: exports, mode: ro }
      config: { path: config, mode: hidden }
    capabilities: [lifecycle, logs, files, backups, domains]
    maxDomains: 3
    backups:
      maxKeep: { daily: 14, weekly: 8, monthly: 12 }
`

// A minimal valid project whose fields a test can override one at a time.
function project(overrides: Record<string, string> = {}): string {
    const fields: Record<string, string> = {
        client: 'cl_1',
        name: 'Site',
        dir: '/var/www/site',
        upstream: '127.0.0.1:5011',
        services: '{ web: { role: site } }',
        capabilities: '[lifecycle, logs]',
        ...overrides,
    }
    const body = Object.entries(fields).map(([key, value]) => `    ${key}: ${value}`).join('\n')
    return `projects:\n  site:\n${body}\n`
}

function failuresOf(text: string): string[] {
    try {
        parseRegistry(text)
    } catch (error) {
        assert.ok(error instanceof RegistryError)
        return error.failures
    }
    assert.fail('expected a RegistryError')
}

function invalidReason(text: string, id = 'site'): string | undefined {
    return parseRegistry(text).invalid.get(id)
}

describe('parseRegistry, a valid file', () => {
    it('parses every field of the documented example', () => {
        const registry = parseRegistry(valid)
        assert.deepEqual(registry.invalid, new Map())
        const entry = registry.projects.get('acme-bakery')
        assert.ok(entry)
        assert.equal(entry.client, 'cl_8f2k1')
        assert.deepEqual(entry.composePaths, ['/var/www/acme-bakery/docker-compose.yml'])
        assert.deepEqual(entry.upstream, { host: '127.0.0.1', port: 5010 })
        assert.deepEqual(entry.services.db, { role: 'database', engine: 'postgres', dump: {} })
        assert.deepEqual(entry.storage.media, { path: 'uploads', absolute: '/var/www/acme-bakery/uploads', mode: 'rw' })
        assert.deepEqual([...entry.capabilities].sort(), ['backups', 'domains', 'files', 'lifecycle', 'logs'])
        assert.deepEqual(entry.backups.maxKeep, { daily: 14, weekly: 8, monthly: 12 })
        assert.deepEqual(registry.offsite.keep, { daily: 14, weekly: 8, monthly: 6 })
    })

    it('applies defaults for everything optional', () => {
        const registry = parseRegistry(project())
        const entry = registry.projects.get('site')
        assert.ok(entry)
        assert.deepEqual(entry.compose, ['docker-compose.yml'])
        assert.deepEqual(entry.composePaths, ['/var/www/site/docker-compose.yml'])
        assert.deepEqual(entry.storage, {})
        assert.equal(entry.maxDomains, 3)
        assert.deepEqual(entry.backups.maxKeep, { daily: 14, weekly: 8, monthly: 12 })
        assert.deepEqual(registry.reserved, ['horizons.gg'])
        assert.deepEqual(registry.offsite.keep, { daily: 14, weekly: 8, monthly: 6 })
    })

    // A site whose host-specific settings live in an override is only described correctly when hostd
    // passes both files, in the operator's order: compose merges them left to right.
    it('accepts a list of compose files and keeps its order', () => {
        const registry = parseRegistry(project({ compose: '[docker-compose.yml, docker-compose.override.yml]' }))
        const entry = registry.projects.get('site')
        assert.ok(entry, JSON.stringify([...registry.invalid]))
        assert.deepEqual(entry.compose, ['docker-compose.yml', 'docker-compose.override.yml'])
        assert.deepEqual(entry.composePaths, [
            '/var/www/site/docker-compose.yml',
            '/var/www/site/docker-compose.override.yml',
        ])
    })

    it('reads a SQLite database as a file rather than a compose service', () => {
        const registry = parseRegistry(project({
            services: '{ web: { role: site }, appdb: { role: database, engine: sqlite, file: data/app.db } }',
        }))
        const appdb = registry.projects.get('site')?.services.appdb
        assert.deepEqual(appdb, { role: 'database', engine: 'sqlite', file: 'data/app.db' })
        assert.ok(appdb)
        assert.equal(isComposeService(appdb), false)
    })

    it('accepts dump variable overrides', () => {
        const registry = parseRegistry(project({
            services: '{ web: { role: site }, db: { role: database, engine: mysql, dump: { userEnv: DB_USER, passwordEnv: DB_PASS } } }',
        }))
        assert.deepEqual(registry.projects.get('site')?.services.db, {
            role: 'database', engine: 'mysql', dump: { userEnv: 'DB_USER', passwordEnv: 'DB_PASS' },
        })
    })
})

describe('parseRegistry, problems with the whole file', () => {
    it('rejects YAML that does not parse', () => {
        assert.match(failuresOf('projects: [unclosed')[0] ?? '', /^not valid YAML/)
    })

    it('rejects a document that is not a mapping', () => {
        assert.deepEqual(failuresOf('- a\n- b\n'), ['the registry must be a mapping with a projects key'])
    })

    it('rejects an unknown top-level key, which is almost always a typo', () => {
        assert.deepEqual(failuresOf('projets: {}\nprojects: {}\n'), ['unknown top-level key projets'])
    })

    it('rejects a missing projects mapping', () => {
        assert.deepEqual(failuresOf('reserved: [horizons.gg]\n'), ['projects must be a mapping'])
    })

    it('rejects a malformed reserved list', () => {
        assert.deepEqual(failuresOf('reserved: [Horizons.GG]\nprojects: {}\n'), ['reserved must be a list of lowercase hostnames'])
    })

    it('rejects bad offsite retention', () => {
        assert.deepEqual(
            failuresOf('offsite: { keep: { daily: -1 } }\nprojects: {}\n'),
            ['offsite.keep.daily must be a whole number from 0 to 1000'],
        )
    })
})

describe('parseRegistry, problems with one project', () => {
    it('marks only the broken project invalid and keeps the rest', () => {
        const text = `${valid}  broken:\n    client: cl_2\n`
        const registry = parseRegistry(text)
        assert.ok(registry.projects.has('acme-bakery'))
        assert.equal(registry.projects.has('broken'), false)
        assert.ok(registry.invalid.get('broken'))
    })

    it('refuses a reserved id', () => {
        const text = project().replace('  site:', '  mail:')
        assert.equal(invalidReason(text, 'mail'), 'mail is reserved for the operator\'s own stacks')
    })

    it('refuses a malformed id', () => {
        const text = project().replace('  site:', '  Site_1:')
        assert.match(invalidReason(text, 'Site_1') ?? '', /^id must match/)
    })

    it('refuses an unknown key', () => {
        assert.match(invalidReason(project({ capabilites: '[logs]' })) ?? '', /unknown key capabilites/)
    })

    it('refuses a dir outside /var/www or more than one segment deep', () => {
        for (const dir of ['/srv/site', '/var/www', '/var/www/a/b', '/var/www/../etc']) {
            assert.match(invalidReason(project({ dir })) ?? '', /dir must be \/var\/www\/<one segment>/, dir)
        }
    })

    it('refuses a compose path that climbs out of dir', () => {
        assert.match(invalidReason(project({ compose: '../other/docker-compose.yml' })) ?? '', /compose: path contains \.\./)
        assert.match(invalidReason(project({ compose: '[docker-compose.yml, ../other/override.yml]' })) ?? '', /compose: path contains \.\./)
    })

    it('refuses a compose list that is empty, repeats a file or is longer than the cap', () => {
        assert.match(invalidReason(project({ compose: '[]' })) ?? '', /compose must name at least one file/)
        assert.match(invalidReason(project({ compose: '[docker-compose.yml, docker-compose.yml]' })) ?? '', /compose lists docker-compose\.yml twice/)
        const many = Array.from({ length: MAX_COMPOSE_FILES + 1 }, (_, i) => `f${i}.yml`).join(', ')
        assert.match(invalidReason(project({ compose: `[${many}]` })) ?? '', /compose may not name more than 8 files/)
    })

    it('refuses a compose entry that is not a string', () => {
        assert.match(invalidReason(project({ compose: '[docker-compose.yml, 7]' })) ?? '', /compose: path must be a string/)
    })

    it('refuses a malformed upstream', () => {
        for (const upstream of ['5010', 'example.com:5010', '127.0.0.1:0', '127.0.0.1:70000']) {
            assert.match(invalidReason(project({ upstream })) ?? '', /upstream must be/, upstream)
        }
    })

    it('requires at least one site service', () => {
        assert.match(
            invalidReason(project({ services: '{ db: { role: database, engine: postgres } }' })) ?? '',
            /at least one service must have role site/,
        )
    })

    it('refuses an unknown engine and a SQLite entry without a file', () => {
        assert.match(
            invalidReason(project({ services: '{ web: { role: site }, db: { role: database, engine: oracle } }' })) ?? '',
            /services\.db\.engine must be one of/,
        )
        assert.match(
            invalidReason(project({ services: '{ web: { role: site }, db: { role: database, engine: sqlite } }' })) ?? '',
            /services\.db\.file/,
        )
    })

    it('refuses storage with a bad path or mode', () => {
        assert.match(invalidReason(project({ storage: '{ media: { path: ../x, mode: rw } }' })) ?? '', /storage\.media\.path: path contains \.\./)
        assert.match(invalidReason(project({ storage: '{ media: { path: uploads, mode: write } }' })) ?? '', /storage\.media\.mode must be/)
    })

    it('refuses storage entries that overlap each other, so ro cannot be reached through rw', () => {
        assert.match(
            invalidReason(project({ storage: '{ media: { path: uploads, mode: rw }, thumbs: { path: uploads/thumbs, mode: ro } }' })) ?? '',
            /storage media and thumbs overlap/,
        )
    })

    it('refuses storage that overlaps a SQLite database file', () => {
        assert.match(
            invalidReason(project({
                services: '{ web: { role: site }, appdb: { role: database, engine: sqlite, file: data/app.db } }',
                storage: '{ data: { path: data, mode: rw } }',
            })) ?? '',
            /storage data overlaps the SQLite file data\/app\.db/,
        )
    })

    it('refuses unknown or repeated capabilities', () => {
        assert.match(invalidReason(project({ capabilities: '[logs, shell]' })) ?? '', /unknown capability shell/)
        assert.match(invalidReason(project({ capabilities: '[logs, logs]' })) ?? '', /capability logs is listed twice/)
    })

    it('refuses maxDomains outside 1 to 20', () => {
        assert.match(invalidReason(project({ maxDomains: '0' })) ?? '', /maxDomains must be a whole number from 1 to 20/)
    })

    it('marks both projects invalid when they share a dir', () => {
        const text = `${project()}  other:\n    client: cl_2\n    name: Other\n    dir: /var/www/site\n    upstream: 127.0.0.1:5012\n    services: { web: { role: site } }\n`
        const registry = parseRegistry(text)
        assert.match(registry.invalid.get('site') ?? '', /dir \/var\/www\/site is also used by other/)
        assert.match(registry.invalid.get('other') ?? '', /dir \/var\/www\/site is also used by site/)
        assert.equal(registry.projects.size, 0)
    })

    it('parses a service literally named constructor, resolving to the parsed entry rather than Object.prototype.constructor', () => {
        const registry = parseRegistry(project({
            services: '{ web: { role: site }, constructor: { role: database, engine: postgres } }',
        }))
        const entry = registry.projects.get('site')
        assert.ok(entry)
        // A service named constructor must be an own key: an object literal's inherited constructor is
        // not an own property, so this also proves the parsed value replaced it rather than being lost.
        assert.equal(Object.hasOwn(entry.services, 'constructor'), true)
        const constructorService = entry.services['constructor']
        assert.deepEqual(constructorService, { role: 'database', engine: 'postgres', dump: {} })
        // The lookup must resolve to the parsed service, never to the inherited Function.
        assert.notEqual(constructorService, Object.prototype.constructor)
        assert.ok(constructorService)
        assert.equal(isComposeService(constructorService), true)
        // A name that was never registered still falls through to nothing of ours, not a prototype method.
        assert.equal(Object.hasOwn(entry.services, 'toString'), false)
    })
})
