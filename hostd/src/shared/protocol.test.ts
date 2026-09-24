import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    parseAgentRequest, checkStructure, parseDomainsArgs, parseConfigureArgs, VERB_CAPABILITY, MAX_REQUEST_BYTES, MAX_COMMITS, DEFAULT_COMMITS, SNAPSHOT_ID,
    type ProjectRequest,
} from './protocol.ts'
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

    it('parses statuses, and deduplicates the list it is given', () => {
        assert.deepEqual(parsed({ verb: 'statuses', projects: [] }), { ok: true, request: { verb: 'statuses', projects: [] } })
        assert.deepEqual(
            parsed({ verb: 'statuses', projects: ['acme', 'quiet', 'acme'] }),
            { ok: true, request: { verb: 'statuses', projects: ['acme', 'quiet'] } },
        )
    })

    it('refuses a statuses list that is malformed, oversized or carries a bad id', () => {
        assert.equal(refusalOf({ verb: 'statuses' }), 'bad-request: projects must be a list')
        assert.equal(refusalOf({ verb: 'statuses', projects: 'acme' }), 'bad-request: projects must be a list')
        assert.equal(refusalOf({ verb: 'statuses', projects: ['acme'], tail: 1 }), 'bad-request: statuses takes only projects')
        assert.equal(refusalOf({ verb: 'statuses', projects: ['../etc'] }), 'bad-request: a project id is malformed')
        assert.equal(refusalOf({ verb: 'statuses', projects: [7] }), 'bad-request: a project id is malformed')
        assert.equal(
            refusalOf({ verb: 'statuses', projects: Array.from({ length: 201 }, (_, index) => `p${index}`) }),
            'bad-request: statuses takes at most 200 projects',
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

    // What the portal's New site form sends beyond the original eight, and a create with no client at all.
    it('parses a provision create request with no client, a dir, compose files, capabilities and switches', () => {
        const createArgs = {
            action: 'create', id: 'bakery', name: 'Bakery', repo: 'git@github.com:x/bakery.git', branch: 'main', domain: null, certificate: null,
            dir: 'bakery_site', compose: ['docker-compose.yml', 'deploy/prod.yml'], capabilities: ['lifecycle', 'deploy'], websockets: true, flexibleSsl: false,
        }
        assert.deepEqual(parsed({ verb: 'provision', args: createArgs }), { ok: true, request: { verb: 'provision', args: createArgs } })
    })

    it('refuses a malformed dir, compose list, capability or switch on a create', () => {
        const createArgs = { action: 'create', id: 'bakery', name: 'Bakery', repo: 'git@github.com:x/bakery.git', branch: 'main', domain: null, certificate: null }
        const dirRule = 'bad-request: dir must be one folder name: lowercase letters, digits, hyphens and underscores'
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, dir: '../etc' } }), dirRule)
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, dir: 'a/b' } }), dirRule)
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, dir: 'Bakery' } }), dirRule)
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: [] } }), 'bad-request: compose must name 1 to 7 files')
        const eight = Array.from({ length: 8 }, (_, index) => `c${index}.yml`)
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: eight } }), 'bad-request: compose must name 1 to 7 files')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: ['docker-compose.yml', 'deploy/hostd.ports.yml'] } }),
            'bad-request: hostd.ports.yml is the file hostd writes; name your own compose files')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: ['../x.yml'] } }), 'bad-request: compose file ../x.yml: path contains ..')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: ['/etc/x.yml'] } }), 'bad-request: compose file /etc/x.yml: path must be relative')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, compose: ['a.yml', 'a.yml'] } }), 'bad-request: compose names a file twice')
        assert.equal(
            refusalOf({ verb: 'provision', args: { ...createArgs, capabilities: ['root'] } }),
            'bad-request: capabilities must be drawn from lifecycle, logs, files, backups, domains, provision, env, deploy',
        )
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, websockets: 'yes' } }), 'bad-request: websockets must be true or false')
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, client: 'no spaces' } }), 'bad-request: client is malformed')
    })

    // credential is optional, unlike repo: a project created without one uses the default token.
    it('parses a provision create request carrying a credential, and refuses a malformed one', () => {
        const createArgs = { action: 'create', id: 'bakery', client: 'cl_2', name: 'Bakery', repo: 'git@github.com:x/bakery.git', credential: 'acme', branch: 'main', domain: 'bakery.com', certificate: 'letsencrypt' }
        assert.deepEqual(parsed({ verb: 'provision', args: createArgs }), { ok: true, request: { verb: 'provision', args: createArgs } })
        assert.equal(
            refusalOf({ verb: 'provision', args: { ...createArgs, credential: 'Acme-1' } }),
            'bad-request: credential must be 1 to 32 lowercase letters, digits or underscores',
        )
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
        assert.equal(refusalOf({ verb: 'provision', args: { ...createArgs, extra: true } }), 'bad-request: create takes only id, client, name, repo, credential, branch, domain, certificate, dir, compose, capabilities, websockets, flexibleSsl, port')
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

    describe('create port', () => {
        const base = { action: 'create', id: 'bakery', name: 'Bakery', repo: 'git@github.com:a/b.git', branch: 'main', domain: null, certificate: null }

        it('carries a port through', () => {
            const parsed = parseAgentRequest(JSON.stringify({ verb: 'provision', args: { ...base, port: 5012 } }))
            assert.equal(parsed.ok, true)
            assert.equal(parsed.ok && parsed.request.verb === 'provision' ? (parsed.request.args as { port?: number }).port : null, 5012)
        })

        it('refuses a port outside 5000 to 65535 or one that is not a whole number', () => {
            for (const port of [80, 70000, 5012.5, '5012']) {
                const parsed = parseAgentRequest(JSON.stringify({ verb: 'provision', args: { ...base, port } }))
                assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'port must be a whole number from 5000 to 65535' })
            }
        })
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

    it('parses every deploy action', () => {
        assert.deepEqual(
            parsed({ verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'live' } }),
            { ok: true, request: { verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'live' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'deploy', project: 'acme', args: { action: 'rollback', environment: 'test' } }),
            { ok: true, request: { verb: 'deploy', project: 'acme', args: { action: 'rollback', environment: 'test' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'deploy', project: 'acme', args: { action: 'set-branch', environment: 'live', branch: 'develop' } }),
            { ok: true, request: { verb: 'deploy', project: 'acme', args: { action: 'set-branch', environment: 'live', branch: 'develop' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'deploy', project: 'acme', args: { action: 'history', environment: 'live' } }),
            { ok: true, request: { verb: 'deploy', project: 'acme', args: { action: 'history', environment: 'live' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'deploy', project: 'acme', args: { action: 'commits', environment: 'live', limit: 10 } }),
            { ok: true, request: { verb: 'deploy', project: 'acme', args: { action: 'commits', environment: 'live', limit: 10 } } },
        )
    })

    it('defaults the commit limit rather than making the caller name one', () => {
        assert.deepEqual(
            parsed({ verb: 'deploy', project: 'acme', args: { action: 'commits', environment: 'live' } }),
            { ok: true, request: { verb: 'deploy', project: 'acme', args: { action: 'commits', environment: 'live', limit: DEFAULT_COMMITS } } },
        )
    })

    it('refuses malformed deploy requests', () => {
        assert.equal(refusalOf({ verb: 'deploy', project: 'acme', args: { action: 'destroy', environment: 'live' } }), 'bad-request: action must be deploy, rollback, set-branch, history or commits')
        assert.equal(refusalOf({ verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'staging' } }), 'bad-request: environment must be live or test')
        assert.equal(refusalOf({ verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'live', force: true } }), 'bad-request: deploy takes only environment')
        assert.equal(refusalOf({ verb: 'deploy', project: 'acme', args: { action: 'set-branch', environment: 'live', branch: 'a branch' } }), 'bad-request: branch must be a plain branch name')
        assert.equal(refusalOf({ verb: 'deploy', project: 'acme', args: { action: 'set-branch', environment: 'live', branch: 'main..other' } }), 'bad-request: branch must be a plain branch name')
        assert.equal(refusalOf({ verb: 'deploy', project: 'acme', args: { action: 'commits', environment: 'live', limit: 100000 } }), `bad-request: limit must be a whole number from 1 to ${MAX_COMMITS}`)
        assert.equal(refusalOf({ verb: 'deploy', project: 'acme', args: { action: 'history' } }), 'bad-request: environment must be live or test')
    })

    it('parses a configure request carrying all four fields', () => {
        assert.deepEqual(
            parsed({ verb: 'configure', project: 'acme', args: { capabilities: ['lifecycle', 'logs'], repo: null, branches: { live: 'main', test: null }, domains: { live: 'acme.com' } } }),
            { ok: true, request: { verb: 'configure', project: 'acme', args: { capabilities: ['lifecycle', 'logs'], repo: null, branches: { live: 'main', test: null }, domains: { live: 'acme.com' } } } },
        )
    })

    // One spelling reaches the registry whichever way it was typed, so nothing downstream has to compare
    // two forms of the same name.
    it('normalises a domain the way every other hostname hostd takes is normalised', () => {
        assert.deepEqual(
            parsed({ verb: 'configure', project: 'acme', args: { domains: { live: 'ACME.com.' } } }),
            { ok: true, request: { verb: 'configure', project: 'acme', args: { domains: { live: 'acme.com' } } } },
        )
    })

    // Null clears a branch; it must not clear a domain. An environment with no address at all serves
    // nothing, and getting back to one is a vhost rewrite rather than a form submission.
    it('refuses a domain that is not a hostname, a null one, and one on an environment it does not know', () => {
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { domains: { live: 'not a host' } } }), 'bad-request: live domain must be a hostname')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { domains: { live: 'https://acme.com/shop' } } }), 'bad-request: live domain must be a hostname')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { domains: { live: '203.0.113.7' } } }), 'bad-request: live domain must be a hostname')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { domains: { live: null } } }), 'bad-request: live domain must be a hostname')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { domains: { staging: 'acme.com' } } }), 'bad-request: staging is not an environment')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { domains: 'acme.com' } }), 'bad-request: domains is malformed')
    })

    it('parses a configure request carrying only some fields, since absent means leave alone', () => {
        assert.deepEqual(
            parsed({ verb: 'configure', project: 'acme', args: { repo: 'git@github.com:x/acme.git' } }),
            { ok: true, request: { verb: 'configure', project: 'acme', args: { repo: 'git@github.com:x/acme.git' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'configure', project: 'acme', args: {} }),
            { ok: true, request: { verb: 'configure', project: 'acme', args: {} } },
        )
    })

    it('refuses malformed configure requests', () => {
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { capabilities: ['teleport'] } }), 'bad-request: capabilities must be a list of known capabilities')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { branches: { live: 'a branch' } } }), 'bad-request: live branch must be null or a plain branch name')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { branches: { staging: 'main' } } }), 'bad-request: staging is not an environment')
        assert.equal(refusalOf({ verb: 'configure', project: 'acme', args: { capabilities: [], extra: true } }), 'bad-request: configure takes only capabilities, repo, credential, branches, domains, websockets and flexibleSsl')
    })

    it('parses a branches request', () => {
        assert.deepEqual(parsed({ verb: 'branches', project: 'acme' }), { ok: true, request: { verb: 'branches', project: 'acme' } })
    })

    it('refuses a branches request with a malformed project or an extra field', () => {
        assert.equal(refusalOf({ verb: 'branches', project: 'Not An Id' }), 'bad-request: project is malformed')
        assert.equal(refusalOf({ verb: 'branches', project: 'acme', extra: true }), 'bad-request: branches takes only project')
    })
})

describe('configure credential', () => {
    it('takes a name', () => {
        assert.deepEqual(parseConfigureArgs({ credential: 'acme' }), { credential: 'acme' })
    })

    // null is how the Settings form says "back to the default token", so it must survive the parse
    // rather than being dropped as absent: absent means "leave it alone".
    it('keeps a null, which clears the key, apart from an absent one, which leaves it alone', () => {
        assert.deepEqual(parseConfigureArgs({ credential: null }), { credential: null })
        assert.deepEqual(parseConfigureArgs({}), {})
    })

    it('accepts websockets per environment, and only as true or false', () => {
        assert.deepEqual(parseConfigureArgs({ websockets: { live: true } }), { websockets: { live: true } })
        assert.equal('ok' in parseConfigureArgs({ websockets: { live: 'yes' } }), true)
        assert.equal('ok' in parseConfigureArgs({ websockets: { staging: true } }), true)
    })

    it('refuses a malformed name', () => {
        const parsed = parseConfigureArgs({ credential: 'Acme-1' })
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credential must be 1 to 32 lowercase letters, digits or underscores' })
    })
})

describe('the credentials verb', () => {
    it('is parsed with no project, like health', () => {
        assert.deepEqual(parseAgentRequest(JSON.stringify({ verb: 'credentials' })), { ok: true, request: { verb: 'credentials' } })
    })

    it('takes nothing else', () => {
        const parsed = parseAgentRequest(JSON.stringify({ verb: 'credentials', project: 'acme' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credentials takes no other keys' })
    })
})

describe('ports', () => {
    it('parses a check with and without a port and an own environment', () => {
        assert.deepEqual(parseAgentRequest('{"verb":"ports","args":{"port":null,"own":null}}'), { ok: true, request: { verb: 'ports', args: { port: null, own: null } } })
        assert.deepEqual(
            parseAgentRequest('{"verb":"ports","args":{"port":5012,"own":{"project":"acme","environment":"live"}}}'),
            { ok: true, request: { verb: 'ports', args: { port: 5012, own: { project: 'acme', environment: 'live' } } } },
        )
    })

    it('refuses anything else', () => {
        for (const line of [
            '{"verb":"ports"}',
            '{"verb":"ports","args":{"port":"5012","own":null}}',
            '{"verb":"ports","args":{"port":null,"own":{"project":"acme","environment":"prod"}}}',
            '{"verb":"ports","args":{"port":null,"own":null,"extra":1}}',
        ]) assert.equal(parseAgentRequest(line).ok, false)
    })
})

describe('parseDomainsArgs', () => {
    const ok = (args: unknown) => {
        const parsed = parseDomainsArgs(args)
        assert.equal(parsed.ok, true, JSON.stringify(parsed))
        return parsed
    }

    it('accepts a write with an environment and a token', () => {
        const parsed = ok({ action: 'write', environment: 'live', token: 'abc123' })
        assert.deepEqual(parsed.ok && parsed.args, { action: 'write', environment: 'live', token: 'abc123' })
    })

    it('accepts a remove, a preview and an adopt', () => {
        ok({ action: 'remove', environment: 'test' })
        ok({ action: 'preview', environment: 'live', token: 'abc123' })
        ok({ action: 'adopt', environment: 'live', token: 'abc123', disable: ['/etc/apache2/sites-enabled/acme.conf'] })
    })

    // A preview with no token would render a file that can never match what adopt actually writes,
    // since api passes the very same token to both: a preview that always differs from the real thing
    // teaches whoever reads it to expect and skim past a diff in exactly the security-relevant lines.
    it('refuses a preview without a token', () => {
        assert.equal(parseDomainsArgs({ action: 'preview', environment: 'live' }).ok, false)
    })

    it('refuses an unknown action', () => {
        assert.equal(parseDomainsArgs({ action: 'rewrite', environment: 'live' }).ok, false)
    })

    it('refuses an unknown environment', () => {
        assert.equal(parseDomainsArgs({ action: 'remove', environment: 'staging' }).ok, false)
    })

    it('refuses an extra field, because the agent is root and ignores nothing', () => {
        assert.equal(parseDomainsArgs({ action: 'remove', environment: 'live', force: true }).ok, false)
    })

    it('refuses a token that is not plain hex, so nothing shaped like a path reaches a Location', () => {
        for (const bad of ['../x', 'a b', '', 'Z'.repeat(32)]) {
            assert.equal(parseDomainsArgs({ action: 'write', environment: 'live', token: bad }).ok, false, bad)
        }
    })

    // An environment nothing currently serves has nothing to move aside, and adopt is the only route to
    // a vhost hostd owns, so refusing an empty list would leave such a site with no way to get one.
    it('accepts an adopt that disables nothing', () => {
        const parsed = ok({ action: 'adopt', environment: 'live', token: 'abc123', disable: [] })
        assert.deepEqual(parsed.ok && parsed.args, { action: 'adopt', environment: 'live', token: 'abc123', disable: [] })
    })

    it('still refuses a bad path inside a list that is not empty', () => {
        for (const bad of ['/etc/passwd', '/etc/apache2/sites-enabled/../../passwd', '/etc/apache2/sites-enabled/.hidden']) {
            const parsed = parseDomainsArgs({
                action: 'adopt', environment: 'live', token: 'abc123',
                disable: ['/etc/apache2/sites-enabled/acme.conf', bad],
            })
            assert.equal(parsed.ok, false, bad)
        }
    })

    it('refuses a disable that is not a list at all', () => {
        assert.equal(parseDomainsArgs({ action: 'adopt', environment: 'live', token: 'abc123', disable: '/etc/apache2/sites-enabled/acme.conf' }).ok, false)
    })

    it('refuses a disable entry that is not inside sites-enabled', () => {
        const parsed = parseDomainsArgs({ action: 'adopt', environment: 'live', token: 'abc123', disable: ['/etc/passwd'] })
        assert.equal(parsed.ok, false)
    })

    it('refuses a disable entry that climbs out with dot segments', () => {
        const parsed = parseDomainsArgs({
            action: 'adopt', environment: 'live', token: 'abc123',
            disable: ['/etc/apache2/sites-enabled/../../passwd'],
        })
        assert.equal(parsed.ok, false)
    })

    it('accepts set-aliases with a list and a token', () => {
        const parsed = ok({ action: 'set-aliases', environment: 'live', aliases: ['www.acme.com'], token: 'abc123' })
        assert.deepEqual(parsed.ok && parsed.args.action === 'set-aliases' && parsed.args.aliases, ['www.acme.com'])
    })

    it('accepts an empty alias list, which is how the last one is removed', () => {
        ok({ action: 'set-aliases', environment: 'live', aliases: [], token: 'abc123' })
    })

    it('refuses an alias that is not a hostname, before it can reach a ServerAlias', () => {
        for (const bad of ['localhost', 'not a host', '../etc', 'https://acme.com']) {
            const parsed = parseDomainsArgs({ action: 'set-aliases', environment: 'live', aliases: [bad], token: 'abc123' })
            assert.equal(parsed.ok, false, bad)
        }
    })

    it('normalises the aliases it accepts, so one spelling reaches the registry', () => {
        const parsed = ok({ action: 'set-aliases', environment: 'live', aliases: ['WWW.Acme.com'], token: 'abc123' })
        assert.deepEqual(parsed.ok && parsed.args.action === 'set-aliases' && parsed.args.aliases, ['www.acme.com'])
    })

    it('refuses a list longer than any project could allow, before the registry is read', () => {
        const many = Array.from({ length: 21 }, (_, i) => `a${i}.acme.com`)
        assert.equal(parseDomainsArgs({ action: 'set-aliases', environment: 'live', aliases: many, token: 'abc123' }).ok, false)
    })
})

describe('the backup verb', () => {
    it('needs the backups capability', () => {
        assert.equal(VERB_CAPABILITY.backup, 'backups')
    })

    it('accepts the five actions', () => {
        for (const args of [
            { action: 'run', tag: 'manual' },
            { action: 'list' },
            { action: 'get-run', run: 'a1b2c3d4' },
            { action: 'delete', snapshot: 'deadbeef' },
            { action: 'download', snapshot: 'deadbeef' },
        ]) {
            const result = parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args }))
            assert.equal(result.ok, true, `${args.action} should parse`)
        }
    })

    it('carries the run tag and an optional keep through', () => {
        assert.deepEqual(
            parsed({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'scheduled' } }),
            { ok: true, request: { verb: 'backup', project: 'acme', args: { action: 'run', tag: 'scheduled' } } },
        )
        assert.deepEqual(
            parsed({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', keep: { daily: 7, weekly: 4, monthly: 3 } } }),
            { ok: true, request: { verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', keep: { daily: 7, weekly: 4, monthly: 3 } } } },
        )
    })

    it('carries an actor of client or admin through, and refuses anything else', () => {
        assert.deepEqual(
            parsed({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', actor: 'client' } }),
            { ok: true, request: { verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', actor: 'client' } } },
        )
        // 'hostd' is not a word a request may use: the agent applies it itself to a scheduled run, so a
        // caller cannot have its own run recorded as one hostd started.
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', actor: 'hostd' } }), 'bad-request: actor must be one of client, admin')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', actor: 7 } }), 'bad-request: actor must be one of client, admin')
    })

    it('refuses a snapshot id that is not hex', () => {
        for (const snapshot of ['../../etc/passwd', 'deadbeef; rm -rf /', '', 'g'.repeat(8)]) {
            const result = parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args: { action: 'delete', snapshot } }))
            assert.equal(result.ok, false, `${snapshot} should be refused`)
        }
        assert.equal(SNAPSHOT_ID.test('deadbeefcafe1234'), true)
    })

    it('refuses a run id that is not hex', () => {
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'get-run', run: '../etc' } }), 'bad-request: get-run needs a run id')
    })

    it('refuses an unknown tag and an unknown action', () => {
        assert.equal(parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'hourly' } })).ok, false)
        assert.equal(parseAgentRequest(JSON.stringify({ verb: 'backup', project: 'acme', args: { action: 'restore' } })).ok, false)
    })

    it('refuses a malformed keep and unknown keys per action', () => {
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', keep: { daily: 7, weekly: 4 } } }), 'bad-request: keep must hold whole daily, weekly and monthly counts')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', keep: { daily: -1, weekly: 4, monthly: 3 } } }), 'bad-request: keep must hold whole daily, weekly and monthly counts')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'list', extra: true } }), 'bad-request: list takes only action')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'run', tag: 'manual', extra: true } }), 'bad-request: run takes only action, tag, keep and actor')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'get-run', run: 'a1b2c3d4', extra: true } }), 'bad-request: get-run takes only action and run')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'delete', snapshot: 'deadbeef', extra: true } }), 'bad-request: delete takes only action and snapshot')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: { action: 'download', snapshot: 'deadbeef', extra: true } }), 'bad-request: download takes only action and snapshot')
        assert.equal(refusalOf({ verb: 'backup', project: 'acme', args: 'nope' }), 'bad-request: backup needs args')
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
    // Matches api's 'remove' policy verb: a whole project can be removed without provision, one
    // environment of it cannot.
    it('passes removing a whole project without the provision capability, but not removing one environment', () => {
        const bare = parseRegistry(`
projects:
  bare:
    client: cl_1
    name: Bare
    dir: /var/www/bare
    upstream: 127.0.0.1:5020
    services: { web: { role: site } }
`)
        assert.equal(checkStructure(bare, { verb: 'provision', project: 'bare', args: { action: 'remove', environment: null } }, none).ok, true)
        assert.deepEqual(
            checkStructure(bare, { verb: 'provision', project: 'bare', args: { action: 'remove', environment: 'test' } }, none),
            { ok: false, code: 'capability-disabled', message: 'provision is not enabled for bare' },
        )
    })

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
        const provisionResult = checkStructure(noProvisionOrEnv, { verb: 'provision', project: 'quiet', args: { action: 'remove', environment: 'test' } }, none)
        assert.deepEqual(provisionResult, { ok: false, code: 'capability-disabled', message: 'provision is not enabled for quiet' })
        const envResult = checkStructure(noProvisionOrEnv, { verb: 'env', project: 'quiet', args: { action: 'list', environment: 'live' } }, none)
        assert.deepEqual(envResult, { ok: false, code: 'capability-disabled', message: 'env is not enabled for quiet' })
    })

    it('gates the deploy verb on the deploy capability, and on the environment existing', () => {
        assert.equal(VERB_CAPABILITY.deploy, 'deploy')
        const disabled = checkStructure(registry, { verb: 'deploy', project: 'acme', args: { action: 'history', environment: 'live' } }, none)
        assert.deepEqual(disabled, { ok: false, code: 'capability-disabled', message: 'deploy is not enabled for acme' })

        const deployable = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    repo: git@github.com:ItsKodas/acme.git
    services: { web: { role: site } }
    capabilities: [deploy]
    environments:
      live: { dir: /var/www/acme, branch: main, port: 5010 }
`)
        const live = checkStructure(deployable, { verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'live' } }, none)
        assert.equal(live.ok, true)
        const test = checkStructure(deployable, { verb: 'deploy', project: 'acme', args: { action: 'deploy', environment: 'test' } }, none)
        assert.deepEqual(test, { ok: false, code: 'unknown-environment', message: 'acme has no test environment' })
    })

    // Null, exactly like configure: gating the list on a capability would leave the dropdown empty on
    // exactly the site an operator is setting deploys up on, which is the one place this list matters.
    it('gates branches on no capability at all', () => {
        assert.equal(VERB_CAPABILITY.branches, null)
        const result = checkStructure(registry, { verb: 'branches', project: 'acme' }, none)
        assert.equal(result.ok, true)
    })
})

describe('port', () => {
    it('parses a port change for one environment', () => {
        assert.deepEqual(
            parseAgentRequest('{"verb":"port","project":"acme","args":{"environment":"live","port":5012}}'),
            { ok: true, request: { verb: 'port', project: 'acme', args: { environment: 'live', port: 5012 } } },
        )
    })

    it('refuses a port outside the range, and an unknown environment', () => {
        assert.equal(parseAgentRequest('{"verb":"port","project":"acme","args":{"environment":"live","port":80}}').ok, false)
        assert.equal(parseAgentRequest('{"verb":"port","project":"acme","args":{"environment":"prod","port":5012}}').ok, false)
    })
})

describe('deploy-watch', () => {
    it('reads a watch for one environment', () => {
        const result = parseAgentRequest(JSON.stringify({ verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } }))
        assert.deepEqual(result, { ok: true, request: { verb: 'deploy-watch', project: 'acme', args: { environment: 'live' } } })
    })

    it('refuses a malformed project, a bad environment and an extra field', () => {
        assert.equal(refusalOf({ verb: 'deploy-watch', project: '../acme', args: { environment: 'live' } }), 'bad-request: project is malformed')
        assert.equal(refusalOf({ verb: 'deploy-watch', project: 'acme', args: { environment: 'staging' } }), 'bad-request: environment must be live or test')
        assert.equal(refusalOf({ verb: 'deploy-watch', project: 'acme', args: { environment: 'live', follow: true } }), 'bad-request: deploy-watch takes only environment')
    })
})
