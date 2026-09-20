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
        assert.deepEqual(result, { ok: true, request: { verb: 'clone', repo: 'git@github.com:a/b.git', dir: '/var/www/b', branch: 'main' } })
    })

    it('refuses an unknown verb and unknown fields', () => {
        assert.equal(refusalOf({ verb: 'push', dir: '/var/www/b' }), 'unknown verb')
        assert.equal(refusalOf({ verb: 'fetch', dir: '/var/www/b', remote: 'evil' }), 'fetch takes only dir')
    })

    it('refuses anything outside /var/www, and any traversal', () => {
        assert.match(refusalOf({ verb: 'fetch', dir: '/etc' })!, /dir/)
        assert.match(refusalOf({ verb: 'fetch', dir: '/var/www/../etc' })!, /dir/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b', worktree: '/etc/x', commit: 'a1b2c3d' })!, /worktree/)
    })

    it('refuses a branch, commit or repo that could be read as an option', () => {
        assert.match(refusalOf({ verb: 'clone', repo: '--upload-pack=evil', dir: '/var/www/b', branch: 'main' })!, /repo/)
        assert.match(refusalOf({ verb: 'log', dir: '/var/www/b', branch: '--all', limit: 10 })!, /branch/)
        assert.match(refusalOf({ verb: 'checkout', dir: '/var/www/b', worktree: '/var/www/b.next', commit: 'HEAD;rm -rf /' })!, /commit/)
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
})
