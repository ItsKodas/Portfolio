import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseAgentRequest, checkStructure, MAX_REQUEST_BYTES, type ProjectRequest } from './protocol.ts'
import { parseRegistry } from './registry.ts'

function parsed(value: unknown) {
    return parseAgentRequest(JSON.stringify(value))
}

function refusalOf(value: unknown): string {
    const result = parsed(value)
    assert.equal(result.ok, false)
    return result.ok ? '' : `${result.code}: ${result.message}`
}

describe('parseAgentRequest', () => {
    it('parses every phase 1 verb', () => {
        assert.deepEqual(parsed({ verb: 'health' }), { ok: true, request: { verb: 'health' } })
        assert.deepEqual(parsed({ verb: 'status', project: 'acme' }), { ok: true, request: { verb: 'status', project: 'acme' } })
        assert.deepEqual(
            parsed({ verb: 'lifecycle', project: 'acme', args: { action: 'restart' } }),
            { ok: true, request: { verb: 'lifecycle', project: 'acme', args: { action: 'restart' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'logs', project: 'acme', args: { service: 'web', tail: 50, since: 1700000000.5, follow: true } }),
            { ok: true, request: { verb: 'logs', project: 'acme', args: { service: 'web', tail: 50, since: 1700000000.5, follow: true } } },
        )
    })

    it('defaults tail, since and follow for logs', () => {
        assert.deepEqual(
            parsed({ verb: 'logs', project: 'acme', args: { service: 'web' } }),
            { ok: true, request: { verb: 'logs', project: 'acme', args: { service: 'web', tail: 200, since: null, follow: false } } },
        )
    })

    it('refuses lines that are not JSON objects', () => {
        assert.deepEqual(parseAgentRequest('not json'), { ok: false, code: 'bad-request', message: 'request is not JSON' })
        assert.equal(refusalOf([1, 2]), 'bad-request: request must be a JSON object')
    })

    it('refuses an oversized request before parsing it', () => {
        const line = JSON.stringify({ verb: 'health', pad: 'x'.repeat(MAX_REQUEST_BYTES) })
        assert.deepEqual(parseAgentRequest(line), { ok: false, code: 'bad-request', message: 'request is too large' })
    })

    it('refuses verbs from later phases and anything unknown', () => {
        assert.equal(refusalOf({ verb: 'fs.write', project: 'acme' }), 'bad-request: unknown verb')
        assert.equal(refusalOf({ verb: 'exec', project: 'acme' }), 'bad-request: unknown verb')
    })

    // An unknown field is how a future caller would smuggle in a value the agent should derive itself,
    // such as a compose path.
    it('refuses unknown fields at every level', () => {
        assert.equal(refusalOf({ verb: 'health', project: 'acme' }), 'bad-request: health takes no other fields')
        assert.equal(refusalOf({ verb: 'status', project: 'acme', compose: '/etc/x.yml' }), 'bad-request: status takes only project')
        assert.equal(
            refusalOf({ verb: 'lifecycle', project: 'acme', args: { action: 'start', dir: '/' } }),
            'bad-request: lifecycle takes only args.action',
        )
        assert.equal(
            refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', container: 'abc' } }),
            'bad-request: logs takes only args.service, args.tail, args.since and args.follow',
        )
    })

    it('refuses malformed values', () => {
        assert.equal(refusalOf({ verb: 'status', project: '../acme' }), 'bad-request: project is malformed')
        assert.equal(refusalOf({ verb: 'lifecycle', project: 'acme', args: { action: 'down' } }), 'bad-request: action must be start, stop or restart')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'a/b' } }), 'bad-request: service is malformed')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', tail: 5001 } }), 'bad-request: tail must be a whole number from 0 to 5000')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', since: -1 } }), 'bad-request: since must be a non-negative number of seconds')
        assert.equal(refusalOf({ verb: 'logs', project: 'acme', args: { service: 'web', follow: 'yes' } }), 'bad-request: follow must be true or false')
    })
})

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services:
      web: { role: site }
      appdb: { role: database, engine: sqlite, file: data/app.db }
    capabilities: [logs]
  broken:
    client: cl_1
`)

describe('checkStructure', () => {
    const status = (project: string): ProjectRequest => ({ verb: 'status', project })
    const none = new Map<string, string>()

    it('passes a registered, valid project and returns its entry', () => {
        const result = checkStructure(registry, status('acme'), none)
        assert.equal(result.ok, true)
        assert.equal(result.ok && result.project.id, 'acme')
    })

    it('refuses an unregistered project', () => {
        assert.deepEqual(checkStructure(registry, status('ghost'), none), { ok: false, code: 'unknown-project', message: 'ghost is not registered' })
    })

    it('refuses a project the registry itself marked invalid', () => {
        const result = checkStructure(registry, status('broken'), none)
        assert.equal(result.ok, false)
        assert.equal(!result.ok && result.code, 'invalid-project')
    })

    it('refuses a project the storage guard marked invalid', () => {
        const result = checkStructure(registry, status('acme'), new Map([['acme', 'storage media overlaps a database mount']]))
        assert.deepEqual(result, { ok: false, code: 'invalid-project', message: 'acme is invalid: storage media overlaps a database mount' })
    })

    it('refuses a verb whose capability is switched off', () => {
        const result = checkStructure(registry, { verb: 'lifecycle', project: 'acme', args: { action: 'start' } }, none)
        assert.deepEqual(result, { ok: false, code: 'capability-disabled', message: 'lifecycle is not enabled for acme' })
    })

    it('refuses logs for an unknown service, a SQLite entry, or a prototype property name', () => {
        for (const service of ['ghost', 'appdb', 'constructor']) {
            const result = checkStructure(registry, { verb: 'logs', project: 'acme', args: { service, tail: 10, since: null, follow: false } }, none)
            assert.deepEqual(result, { ok: false, code: 'unknown-service', message: `${service} is not a registered service of acme` }, service)
        }
    })
})
