import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { authenticate, tokensMatch, parseActor, actorLabel } from './auth.ts'

const TOKEN = 't'.repeat(64)
const headers = (overrides: Record<string, string | undefined> = {}) => ({
    authorization: `Bearer ${TOKEN}`,
    'x-hostd-actor': 'client:cl_1',
    'x-hostd-user': 'user_42',
    ...overrides,
})

describe('tokensMatch', () => {
    it('matches only the exact token, whatever the lengths', () => {
        assert.equal(tokensMatch(TOKEN, TOKEN), true)
        assert.equal(tokensMatch(TOKEN.slice(1), TOKEN), false)
        assert.equal(tokensMatch('', TOKEN), false)
        assert.equal(tokensMatch(`${TOKEN}x`, TOKEN), false)
    })
})

describe('parseActor', () => {
    it('reads admin and client actors', () => {
        assert.deepEqual(parseActor('admin'), { kind: 'admin' })
        assert.deepEqual(parseActor('client:cl_1'), { kind: 'client', client: 'cl_1' })
    })

    it('refuses anything else', () => {
        for (const raw of [undefined, '', 'Admin', 'client:', 'client:a:b', 'client:a b', 'root']) {
            assert.equal(parseActor(raw), null, String(raw))
        }
    })

    it('labels actors the way the audit log shows them', () => {
        assert.equal(actorLabel({ kind: 'admin' }), 'admin')
        assert.equal(actorLabel({ kind: 'client', client: 'cl_1' }), 'client:cl_1')
    })
})

describe('authenticate', () => {
    it('accepts a correct token with well-formed headers', () => {
        assert.deepEqual(authenticate(headers(), TOKEN), { ok: true, caller: { actor: { kind: 'client', client: 'cl_1' }, user: 'user_42' } })
    })

    it('refuses a missing or wrong token with 401, recording what was claimed', () => {
        for (const authorization of [undefined, 'Bearer wrong', TOKEN, `Basic ${TOKEN}`]) {
            const result = authenticate(headers({ authorization }), TOKEN)
            assert.equal(result.ok, false)
            assert.equal(!result.ok && result.status, 401)
            assert.equal(!result.ok && result.label, 'unauthenticated (claimed client:cl_1)')
        }
    })

    it('refuses a malformed actor with 400', () => {
        const result = authenticate(headers({ 'x-hostd-actor': 'client:../x' }), TOKEN)
        assert.deepEqual(result, {
            ok: false, status: 400, code: 'bad-request', message: 'X-Hostd-Actor must be admin or client:<id>',
            label: 'invalid (client:../x)', user: 'user_42',
        })
    })

    it('refuses a missing or malformed user with 400', () => {
        for (const user of [undefined, 'has space']) {
            const result = authenticate(headers({ 'x-hostd-user': user }), TOKEN)
            assert.equal(!result.ok && result.message, 'X-Hostd-User is missing or malformed')
        }
    })

    // The portal names the sites a client has been given; hostd keeps that list beside the actor.
    it('reads the sites the portal gave a client', () => {
        const result = authenticate(headers({ 'x-hostd-sites': 'acme,other' }), TOKEN)
        assert.ok(result.ok)
        assert.deepEqual(result.ok && result.caller.actor, { kind: 'client', client: 'cl_1', sites: new Set(['acme', 'other']) })
    })

    it('reads an empty list as a client with access to nothing', () => {
        const result = authenticate(headers({ 'x-hostd-sites': '' }), TOKEN)
        assert.deepEqual(result.ok && result.caller.actor, { kind: 'client', client: 'cl_1', sites: new Set() })
    })

    it('ignores the list for the operator, who reaches everything', () => {
        const result = authenticate(headers({ 'x-hostd-actor': 'admin', 'x-hostd-sites': 'acme' }), TOKEN)
        assert.deepEqual(result.ok && result.caller.actor, { kind: 'admin' })
    })

    it('refuses a malformed list with 400 rather than reading part of it', () => {
        for (const sites of ['acme,', 'acme,../x', 'ACME', ',']) {
            const result = authenticate(headers({ 'x-hostd-sites': sites }), TOKEN)
            assert.equal(!result.ok && result.status, 400, sites)
            assert.equal(!result.ok && result.message, 'X-Hostd-Sites must be a comma separated list of project ids')
        }
    })

    // The sites whose env files the portal gave a client, read beside their sites the same way
    it('reads the env sites the portal gave a client', () => {
        const result = authenticate(headers({ 'x-hostd-sites': 'acme,other', 'x-hostd-env-sites': 'acme' }), TOKEN)
        assert.deepEqual(result.ok && result.caller.actor, {
            kind: 'client', client: 'cl_1', sites: new Set(['acme', 'other']), envSites: new Set(['acme']),
        })
    })

    it('refuses a malformed env list with 400', () => {
        const result = authenticate(headers({ 'x-hostd-sites': 'acme', 'x-hostd-env-sites': 'acme,' }), TOKEN)
        assert.equal(!result.ok && result.status, 400)
        assert.equal(!result.ok && result.message, 'X-Hostd-Env-Sites must be a comma separated list of project ids')
    })
    it('reads the restore sites the portal gave a client, with or without env sites', () => {
        const only = authenticate(headers({ 'x-hostd-sites': 'acme,other', 'x-hostd-restore-sites': 'other' }), TOKEN)
        assert.deepEqual(only.ok && only.caller.actor, {
            kind: 'client', client: 'cl_1', sites: new Set(['acme', 'other']), restoreSites: new Set(['other']),
        })
        const both = authenticate(headers({ 'x-hostd-sites': 'acme', 'x-hostd-env-sites': 'acme', 'x-hostd-restore-sites': 'acme' }), TOKEN)
        assert.deepEqual(both.ok && both.caller.actor, {
            kind: 'client', client: 'cl_1', sites: new Set(['acme']), envSites: new Set(['acme']), restoreSites: new Set(['acme']),
        })
    })

    it('refuses a malformed restore list with 400', () => {
        const result = authenticate(headers({ 'x-hostd-sites': 'acme', 'x-hostd-restore-sites': 'ACME' }), TOKEN)
        assert.equal(!result.ok && result.status, 400)
        assert.equal(!result.ok && result.message, 'X-Hostd-Restore-Sites must be a comma separated list of project ids')
    })
})
