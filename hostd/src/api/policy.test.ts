import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authorize, visibleProjects } from './policy.ts'
import { parseRegistry } from '../shared/registry.ts'
import type { Actor } from './auth.ts'

const registry = parseRegistry(`
projects:
  acme:
    client: cl_1
    name: Acme
    dir: /var/www/acme
    upstream: 127.0.0.1:5010
    services: { web: { role: site } }
    capabilities: [lifecycle, logs, provision, env]
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
  other:
    client: cl_2
    name: Other
    dir: /var/www/other
    upstream: 127.0.0.1:5012
    services: { web: { role: site } }
    capabilities: [lifecycle, logs]
  broken:
    client: cl_1
`)

const admin: Actor = { kind: 'admin' }
const owner: Actor = { kind: 'client', client: 'cl_1' }
const stranger: Actor = { kind: 'client', client: 'cl_2' }

describe('authorize', () => {
    it('lets the owner and the admin use an enabled capability', () => {
        for (const actor of [owner, admin]) {
            const decision = authorize(registry, actor, 'acme', 'lifecycle')
            assert.equal(decision.ok && decision.project.id, 'acme')
        }
    })

    // The same answer for "not yours" and "does not exist", so ids cannot be probed.
    it('answers 404 for someone else\'s project and for a missing one alike', () => {
        const notFound = { ok: false, status: 404, code: 'not-found', message: 'no project acme' }
        assert.deepEqual(authorize(registry, stranger, 'acme', 'status'), notFound)
        assert.deepEqual(authorize(registry, owner, 'ghost', 'status'), { ...notFound, message: 'no project ghost' })
    })

    it('answers 403 for a switched-off capability, even for the admin', () => {
        for (const actor of [owner, admin]) {
            assert.deepEqual(authorize(registry, actor, 'quiet', 'logs'), {
                ok: false, status: 403, code: 'capability-disabled', message: 'logs is not enabled for quiet',
            })
        }
    })

    it('needs no capability for status or the audit trail', () => {
        assert.equal(authorize(registry, owner, 'quiet', 'status').ok, true)
        assert.equal(authorize(registry, owner, 'quiet', 'audit').ok, true)
    })

    it('tells only the admin that an invalid entry exists', () => {
        const forAdmin = authorize(registry, admin, 'broken', 'status')
        assert.equal(!forAdmin.ok && forAdmin.status, 409)
        assert.equal(!forAdmin.ok && forAdmin.code, 'invalid-project')
        assert.deepEqual(authorize(registry, owner, 'broken', 'status'), { ok: false, status: 404, code: 'not-found', message: 'no project broken' })
    })
})

describe('authorize: provision and env are admin-only', () => {
    it('lets only admin provision or touch env files, whatever the project says', () => {
        assert.equal(authorize(registry, owner, 'acme', 'provision').ok, false)
        assert.equal(authorize(registry, owner, 'acme', 'env').ok, false)
        assert.equal(authorize(registry, admin, 'acme', 'provision').ok, true)
    })

    it('gives a client the same 404 for provision as for a project that is not theirs', () => {
        const forStranger = authorize(registry, stranger, 'acme', 'status')
        const forOwnerProvision = authorize(registry, owner, 'acme', 'provision')
        assert.deepEqual(forOwnerProvision, forStranger)
        assert.deepEqual(authorize(registry, owner, 'acme', 'env'), forStranger)
    })

    it('still requires the capability for admin', () => {
        assert.deepEqual(authorize(registry, admin, 'quiet', 'provision'), {
            ok: false, status: 403, code: 'capability-disabled', message: 'provision is not enabled for quiet',
        })
        assert.deepEqual(authorize(registry, admin, 'quiet', 'env'), {
            ok: false, status: 403, code: 'capability-disabled', message: 'env is not enabled for quiet',
        })
    })
})

describe('visibleProjects', () => {
    it('shows a client only their own projects and the admin everything', () => {
        assert.deepEqual(visibleProjects(registry, owner).map(p => p.id), ['acme', 'quiet'])
        assert.deepEqual(visibleProjects(registry, stranger).map(p => p.id), ['other'])
        assert.deepEqual(visibleProjects(registry, admin).map(p => p.id), ['acme', 'quiet', 'other'])
    })
})
