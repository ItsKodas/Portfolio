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

describe('authorize: deploying is admin-only, reading a deploy is not', () => {
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
  quiet:
    client: cl_1
    name: Quiet
    dir: /var/www/quiet
    upstream: 127.0.0.1:5011
    services: { web: { role: site } }
`)

    it('lets only the admin deploy, roll back or switch branch', () => {
        assert.equal(authorize(deployable, admin, 'acme', 'deploy').ok, true)
        // A client owning the project, with the capability on, still gets the same 404 as a stranger.
        assert.deepEqual(authorize(deployable, owner, 'acme', 'deploy'), authorize(deployable, stranger, 'acme', 'status'))
    })

    it('lets the owner read the deploy history and the commit list', () => {
        assert.equal(authorize(deployable, owner, 'acme', 'deploy-read').ok, true)
        assert.equal(authorize(deployable, admin, 'acme', 'deploy-read').ok, true)
        assert.deepEqual(authorize(deployable, stranger, 'acme', 'deploy-read'), {
            ok: false, status: 404, code: 'not-found', message: 'no project acme',
        })
    })

    it('refuses both when the deploy capability is off', () => {
        for (const verb of ['deploy', 'deploy-read'] as const) {
            assert.deepEqual(authorize(deployable, admin, 'quiet', verb), {
                ok: false, status: 403, code: 'capability-disabled', message: 'deploy is not enabled for quiet',
            })
        }
        assert.deepEqual(authorize(deployable, owner, 'quiet', 'deploy-read'), {
            ok: false, status: 403, code: 'capability-disabled', message: 'deploy is not enabled for quiet',
        })
    })
})

describe('authorize: configure is admin-only', () => {
    it('refuses a client the configure verb outright, whatever the registry says', () => {
        const decision = authorize(registry, owner, 'acme', 'configure')
        assert.equal(decision.ok, false)
        assert.equal(!decision.ok && decision.status, 404)
    })

    it('lets the admin configure a project with no capabilities at all', () => {
        // The point of the null capability: a project with nothing enabled is exactly the one that needs it
        const decision = authorize(registry, admin, 'quiet', 'configure')
        assert.equal(decision.ok, true)
    })
})

describe('visibleProjects', () => {
    it('shows a client only their own projects and the admin everything', () => {
        assert.deepEqual(visibleProjects(registry, owner).map(p => p.id), ['acme', 'quiet'])
        assert.deepEqual(visibleProjects(registry, stranger).map(p => p.id), ['other'])
        assert.deepEqual(visibleProjects(registry, admin).map(p => p.id), ['acme', 'quiet', 'other'])
    })
})
