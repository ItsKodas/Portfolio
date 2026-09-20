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

    it('parses a provision create request, which carries no project', () => {
        const createArgs = { action: 'create', id: 'bakery', client: 'cl_2', name: 'Bakery', repo: 'git@github.com:x/bakery.git', branch: 'main', domain: 'bakery.com', certificate: 'letsencrypt' }
        assert.deepEqual(parsed({ verb: 'provision', args: createArgs }), { ok: true, request: { verb: 'provision', args: createArgs } })
    })

    it('parses provision add-environment and remove, which carry a project', () => {
        const addArgs = { action: 'add-environment', environment: 'test', branch: 'develop', domain: 'test.acme.com', certificate: null }
        assert.deepEqual(
            parsed({ verb: 'provision', project: 'acme', args: addArgs }),
            { ok: true, request: { verb: 'provision', project: 'acme', args: addArgs } },
        )
        assert.deepEqual(
            parsed({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: 'test' } }),
            { ok: true, request: { verb: 'provision', project: 'acme', args: { action: 'remove', environment: 'test' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: null } }),
            { ok: true, request: { verb: 'provision', project: 'acme', args: { action: 'remove', environment: null } } },
        )
    })

    it('refuses a provision create request that carries a project, and one with a malformed or missing field', () => {
        const createArgs = { action: 'create', id: 'bakery', client: 'cl_2', name: 'Bakery', repo: 'git@github.com:x/bakery.git', branch: 'main', domain: 'bakery.com', certificate: 'letsencrypt' }
        assert.equal(refusalOf({ verb: 'provision', project: 'acme', args: createArgs }), 'bad-request: provision create takes only args')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, id: 5 } }), 'bad-request: id is malformed')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, certificate: 'self-signed' } }), 'bad-request: certificate is malformed')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, extra: true } }), 'bad-request: create takes only id, client, name, repo, branch, domain and certificate')
    })

    it('refuses provision add-environment for anything other than test, and remove for an unknown environment', () => {
        assert.equal(
            refusalOf({ verb: 'provision', project: 'acme', args: { action: 'add-environment', environment: 'live', branch: 'main', domain: null, certificate: null } }),
            'bad-request: environment must be test',
        )
        assert.equal(
            refusalOf({ verb: 'provision', project: 'acme', args: { action: 'remove', environment: 'staging' } }),
            'bad-request: environment must be live, test or null',
        )
        assert.equal(refusalOf({ verb: 'provision', project: '../acme', args: { action: 'remove', environment: null } }), 'bad-request: project is malformed')
    })

    it('refuses an unknown provision action', () => {
        assert.equal(refusalOf({ verb: 'provision', args: { action: 'destroy' } }), 'bad-request: action must be create, add-environment or remove')
    })

    it('parses every env action, defaulting nothing', () => {
        assert.deepEqual(
            parsed({ verb: 'env', project: 'acme', args: { action: 'list', environment: 'live' } }),
            { ok: true, request: { verb: 'env', project: 'acme', args: { action: 'list', environment: 'live' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'env', project: 'acme', args: { action: 'read', environment: 'test', path: '.env' } }),
            { ok: true, request: { verb: 'env', project: 'acme', args: { action: 'read', environment: 'test', path: '.env' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'env', project: 'acme', args: { action: 'write', environment: 'live', path: '.env', text: 'A=1' } }),
            { ok: true, request: { verb: 'env', project: 'acme', args: { action: 'write', environment: 'live', path: '.env', text: 'A=1' } } },
        )
    })

    it('refuses malformed env requests', () => {
        assert.equal(refusalOf({ verb: 'env', project: 'acme', args: { action: 'list', environment: 'staging' } }), 'bad-request: environment must be live or test')
        assert.equal(refusalOf({ verb: 'env', project: 'acme', args: { action: 'read', environment: 'live' } }), 'bad-request: path is malformed')
        assert.equal(refusalOf({ verb: 'env', project: 'acme', args: { action: 'write', environment: 'live', path: '.env' } }), 'bad-request: text is malformed')
        assert.equal(refusalOf({ verb: 'env', project: 'acme', args: { action: 'list', environment: 'live', path: '.env' } }), 'bad-request: list takes only environment')
        assert.equal(refusalOf({ verb: 'env', project: 'acme', args: { action: 'delete', environment: 'live' } }), 'bad-request: action must be list, read or write')
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
    capabilities: [logs, env, provision]
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

    // Every other verb reads the compose file or its mounts; removing a project touches no files at all,
    // and a guard failure is exactly the kind of problem that makes an operator want to unregister it.
    it('passes provision remove for a project the storage guard marked invalid, unlike every other verb', () => {
        const guardInvalid = new Map([['acme', 'storage media overlaps a database mount']])
        const remove = checkStructure(registry, { verb: 'provision', project: 'acme', args: { action: 'remove', environment: null } }, guardInvalid)
        assert.equal(remove.ok, true)

        const addEnvironment = checkStructure(
            registry, { verb: 'provision', project: 'acme', args: { action: 'add-environment', environment: 'test', branch: 'main', domain: null, certificate: null } }, guardInvalid,
        )
        assert.deepEqual(addEnvironment, { ok: false, code: 'invalid-project', message: 'acme is invalid: storage media overlaps a database mount' })

        const status = checkStructure(registry, { verb: 'status', project: 'acme' }, guardInvalid)
        assert.deepEqual(status, { ok: false, code: 'invalid-project', message: 'acme is invalid: storage media overlaps a database mount' })
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

    it('passes an env request for an environment the project actually has', () => {
        const result = checkStructure(registry, { verb: 'env', project: 'acme', args: { action: 'list', environment: 'live' } }, none)
        assert.equal(result.ok, true)
    })

    it('refuses an env request for an environment the project does not have', () => {
        const result = checkStructure(registry, { verb: 'env', project: 'acme', args: { action: 'list', environment: 'test' } }, none)
        assert.deepEqual(result, { ok: false, code: 'unknown-environment', message: 'acme has no test environment' })
    })

    it('refuses provision and env when the capability is off', () => {
        const noProvisionOrEnv = parseRegistry(`
projects:
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5099
    services: { web: { role: site } }
`)
        const provisionResult = checkStructure(noProvisionOrEnv, { verb: 'provision', project: 'quiet', args: { action: 'remove', environment: null } }, none)
        assert.deepEqual(provisionResult, { ok: false, code: 'capability-disabled', message: 'provision is not enabled for quiet' })
        const envResult = checkStructure(noProvisionOrEnv, { verb: 'env', project: 'quiet', args: { action: 'list', environment: 'live' } }, none)
        assert.deepEqual(envResult, { ok: false, code: 'capability-disabled', message: 'env is not enabled for quiet' })
    })
})
