import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { FETCH_DIR, isFlatDir, isNestedDir, nestedDir, nestedEnvOf, siteOf } from './layout.ts'
import { isEnvironmentName } from './formats.ts'

describe('layout', () => {
    it('tells a flat dir from a nested one', () => {
        assert.equal(isFlatDir('/var/www/acme'), true)
        assert.equal(isNestedDir('/var/www/acme'), false)
        assert.equal(isNestedDir('/var/www/acme/live'), true)
        assert.equal(isNestedDir('/var/www/acme/test'), true)
        assert.equal(isFlatDir('/var/www/acme/live'), false)
    })

    it('nests any environment name, not only live and test', () => {
        for (const env of ['uat1', 'staging', 'a'.repeat(16)]) {
            assert.equal(isNestedDir(`/var/www/acme/${env}`), true, env)
            assert.equal(nestedEnvOf(`/var/www/acme/${env}`), env)
            assert.equal(siteOf(`/var/www/acme/${env}`), '/var/www/acme')
        }
    })

    it('refuses anything that is neither', () => {
        for (const dir of ['/var/www/acme/git', '/var/www/acme/next', '/var/www/acme/prev', '/var/www/acme/uat-1', '/var/www/acme/Uat1', `/var/www/acme/${'a'.repeat(17)}`, '/var/www/acme/live/x', '/var/www/../etc', '/var/www/.hidden', '/etc/acme', '/var/www/acme/', '/var/www/acme/prev/live']) {
            assert.equal(isFlatDir(dir) || isNestedDir(dir), false, dir)
        }
    })

    it('finds the site root and environment', () => {
        assert.equal(siteOf('/var/www/acme/test'), '/var/www/acme')
        assert.equal(siteOf('/var/www/acme'), '/var/www/acme')
        assert.equal(nestedEnvOf('/var/www/acme/test'), 'test')
        assert.equal(nestedEnvOf('/var/www/acme'), null)
        assert.equal(nestedDir('/var/www/acme', 'live'), '/var/www/acme/live')
    })

    it('lets the fetcher reach exactly the shapes a deploy uses', () => {
        for (const dir of ['/var/www/b', '/var/www/b.git', '/var/www/b.next', '/var/www/b-test', '/var/www/b/git', '/var/www/b/live', '/var/www/b/test', '/var/www/b/next/live', '/var/www/b/prev/test', '/var/www/b/uat1', '/var/www/b/next/uat1', '/var/www/b/prev/staging']) {
            assert.equal(FETCH_DIR.test(dir), true, dir)
        }
        for (const dir of ['/var/www/b/uat-1', '/var/www/b/next/uat-1', '/var/www/b/next/git', '/var/www/b/prev/next', '/var/www/b/next/Uat1', '/var/www/b/next', '/var/www/b/git/x', '/var/www/b/next/live/x', '/var/www/b/../etc', '/var/www/b//live', '/etc/b']) {
            assert.equal(FETCH_DIR.test(dir), false, dir)
        }
    })

    it('agrees with isEnvironmentName about the environment position', () => {
        for (const env of ['live', 'test', 'uat1', 'git', 'next', 'prev', 'uat-1', 'UAT', 'a'.repeat(16), 'a'.repeat(17)]) {
            assert.equal(isNestedDir(`/var/www/acme/${env}`), isEnvironmentName(env), env)
            assert.equal(FETCH_DIR.test(`/var/www/acme/next/${env}`), isEnvironmentName(env), env)
        }
    })
})
