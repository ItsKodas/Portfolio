import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseFetchRequest } from './fetch-protocol.ts'

const refusalOf = (value: unknown) => {
    const result = parseFetchRequest(JSON.stringify(value))
    return result.ok === true ? null : result.message
}

describe('parseFetchRequest', () => {
    it('reads a clone', () => {
        const result = parseFetchRequest(JSON.stringify({ verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main' }))
        assert.deepEqual(result, { ok: true, request: { verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main', credential: null } })
    })

    it('refuses an unknown verb and unknown fields', () => {
        assert.equal(refusalOf({ verb: 'push', dir: '/var/www/b' }), 'unknown verb')
        assert.equal(refusalOf({ verb: 'fetch', dir: '/var/www/b', remote: 'evil' }), 'fetch takes only dir, branch and credential')
    })

    it('refuses anything outside /var/www, and any traversal', () => {
        assert.match(refusalOf({ verb: 'fetch', dir: '/etc' })!, /dir/)
        assert.match(refusalOf({ verb: 'fetch', dir: '/var/www/../etc' })!, /dir/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b', worktree: '/etc/x', commit: 'a1b2c3d' })!, /worktree/)
    })

    it('reads a repair, which names two trees and nothing else', () => {
        const result = parseFetchRequest(JSON.stringify({ verb: 'repair', dir: '/var/www/b.git', worktree: '/var/www/b' }))
        assert.deepEqual(result, { ok: true, request: { verb: 'repair', dir: '/var/www/b.git', worktree: '/var/www/b' } })
    })

    it('holds a repair to the same bounds as every other path: under /var/www, and no extra fields', () => {
        assert.match(refusalOf({ verb: 'repair', dir: '/etc', worktree: '/var/www/b' })!, /dir/)
        assert.match(refusalOf({ verb: 'repair', dir: '/var/www/b.git', worktree: '/var/www/../etc' })!, /worktree/)
        assert.match(refusalOf({ verb: 'repair', dir: '/var/www/b.git' })!, /worktree/)
        assert.equal(refusalOf({ verb: 'repair', dir: '/var/www/b.git', worktree: '/var/www/b', force: true }),
            'repair takes only dir and worktree')
    })

    it('refuses a branch, commit or repo that could be read as an option', () => {
        assert.match(refusalOf({ verb: 'clone', repo: '--upload-pack=evil', dir: '/var/www/b', branch: 'main' })!, /repo/)
        assert.match(refusalOf({ verb: 'log', dir: '/var/www/b', branch: '--all', limit: 10 })!, /branch/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b', worktree: '/var/www/b.next', commit: 'HEAD;rm -rf /' })!, /commit/)
    })

    it('reads a fetch with no branch, as the ordinary case', () => {
        const result = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b.git' }))
        assert.deepEqual(result, { ok: true, request: { verb: 'fetch', dir: '/var/www/b.git', branch: null, credential: null } })
    })

    it('reads a fetch with a branch, which is what makes a branch switch fetchable at all', () => {
        const result = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b.git', branch: 'develop' }))
        assert.deepEqual(result, { ok: true, request: { verb: 'fetch', dir: '/var/www/b.git', branch: 'develop', credential: null } })
    })

    it('refuses a fetch branch that could be read as an option', () => {
        assert.match(refusalOf({ verb: 'fetch', dir: '/var/www/b.git', branch: '--upload-pack=sh' })!, /branch/)
    })

    it('bounds the log limit', () => {
        assert.match(refusalOf({ verb: 'log', dir: '/var/www/b', branch: 'main', limit: 100000 })!, /limit/)
    })

    it('refuses a branch containing .., which git would read as a revision range, naming the branch', () => {
        assert.match(refusalOf({ verb: 'log', dir: '/var/www/b', branch: 'main..other', limit: 10 })!, /main\.\.other/)
        assert.match(refusalOf({ verb: 'tip', dir: '/var/www/b', branch: 'main..other' })!, /main\.\.other/)
    })

    it('still accepts branch names with slashes and dots', () => {
        assert.equal(refusalOf({ verb: 'log', dir: '/var/www/b', branch: 'feature/thing', limit: 10 }), null)
        assert.equal(refusalOf({ verb: 'tip', dir: '/var/www/b', branch: 'release-1.2.3' }), null)
    })

    it('reads a branches request, which needs only the repo and no dir: there may be nothing on disk yet', () => {
        const result = parseFetchRequest(JSON.stringify({ verb: 'branches', repo: 'git@github.com:a/b.git' }))
        assert.deepEqual(result, { ok: true, request: { verb: 'branches', repo: 'git@github.com:a/b.git', credential: null } })
    })

    it('validates a branches repo exactly as clone does', () => {
        assert.match(refusalOf({ verb: 'branches', repo: '--upload-pack=evil' })!, /repo/)
        assert.equal(refusalOf({ verb: 'branches', repo: 'https://github.com/a/b.git' }), null)
    })

    it('refuses a branches request carrying an unknown field', () => {
        assert.equal(refusalOf({ verb: 'branches', repo: 'git@github.com:a/b.git', dir: '/var/www/b' }), 'branches takes only repo and credential')
    })

    it('accepts a nested site repository, environment, and next or prev copy', () => {
        const fetched = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b/git', branch: 'main' }))
        assert.equal(fetched.ok, true)
        const checkout = parseFetchRequest(JSON.stringify({ verb: 'checkout', dir: '/var/www/b/git', worktree: '/var/www/b/next/live', commit: 'a1b2c3d' }))
        assert.equal(checkout.ok, true)
        const repair = parseFetchRequest(JSON.stringify({ verb: 'repair', dir: '/var/www/b/git', worktree: '/var/www/b/prev/test' }))
        assert.equal(repair.ok, true)
    })

    it('accepts any environment name as a nested worktree, not only live and test', () => {
        for (const worktree of ['/var/www/b/uat1', '/var/www/b/next/uat1', '/var/www/b/prev/staging']) {
            const checkout = parseFetchRequest(JSON.stringify({ verb: 'checkout', dir: '/var/www/b/git', worktree, commit: 'a1b2c3d' }))
            assert.equal(checkout.ok, true, worktree)
        }
    })

    it('refuses anything deeper or wider than a nested site', () => {
        assert.match(refusalOf({ verb: 'fetch', dir: '/var/www/b/git/.git' })!, /dir/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b/git', worktree: '/var/www/b/uat-1', commit: 'a1b2c3d' })!, /worktree/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b/git', worktree: '/var/www/b/next/git', commit: 'a1b2c3d' })!, /worktree/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b/git', worktree: '/var/www/b/next/Uat1', commit: 'a1b2c3d' })!, /worktree/)
        assert.match(refusalOf({ verb: 'repair', dir: '/var/www/b/git', worktree: '/var/www/b/next' })!, /worktree/)
    })
})

describe('credential on the verbs that reach GitHub', () => {
    it('carries a name on a clone', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main', credential: 'acme' } })
    })

    it('carries a name on a fetch', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b', branch: 'main', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'fetch', dir: '/var/www/b', branch: 'main', credential: 'acme' } })
    })

    it('carries a name on a branch listing, which reads the remote directly', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'branches', repo: 'git@github.com:a/b.git', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'branches', repo: 'git@github.com:a/b.git', credential: 'acme' } })
    })

    // Absent means the default token, which is every project that has no credential key.
    it('reads an absent credential as null rather than refusing', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b', branch: null }))
        assert.deepEqual(parsed, { ok: true, request: { verb: 'fetch', dir: '/var/www/b', branch: null, credential: null } })
    })

    it('refuses a malformed name, naming it, before it can reach a file path', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'fetch', dir: '/var/www/b', branch: 'main', credential: '../../etc/x' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credential ../../etc/x is malformed' })
    })

    it('refuses a credential on a local-only verb, which has no remote to authenticate to', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'tip', dir: '/var/www/b', branch: 'main', credential: 'acme' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'tip takes only dir and branch' })
    })
})

describe('the credentials verb', () => {
    it('takes nothing but the verb', () => {
        assert.deepEqual(parseFetchRequest(JSON.stringify({ verb: 'credentials' })), { ok: true, request: { verb: 'credentials' } })
    })

    it('refuses anything alongside it', () => {
        const parsed = parseFetchRequest(JSON.stringify({ verb: 'credentials', repo: 'git@github.com:a/b.git' }))
        assert.deepEqual(parsed, { ok: false, code: 'bad-request', message: 'credentials takes no other keys' })
    })
})
