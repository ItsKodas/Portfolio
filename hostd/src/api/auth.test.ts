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
})
