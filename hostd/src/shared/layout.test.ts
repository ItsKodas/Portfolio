import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { FETCH_DIR, isFlatDir, isNestedDir, nestedDir, nestedEnvOf, siteOf } from './layout.ts'
import { ENVIRONMENTS } from './registry.ts'

describe('layout', () => {
    it('tells a flat dir from a nested one', () => {
        assert.equal(isFlatDir('/var/www/acme'), true)
        assert.equal(isNestedDir('/var/www/acme'), false)
        assert.equal(isNestedDir('/var/www/acme/live'), true)
        assert.equal(isNestedDir('/var/www/acme/test'), true)
        assert.equal(isFlatDir('/var/www/acme/live'), false)
    })

    it('refuses anything that is neither', () => {
        for (const dir of ['/var/www/acme/uat1', '/var/www/acme/git', '/var/www/acme/live/x', '/var/www/../etc', '/var/www/.hidden', '/etc/acme', '/var/www/acme/', '/var/www/acme/prev/live']) {
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
        for (const dir of ['/var/www/b', '/var/www/b.git', '/var/www/b.next', '/var/www/b-test', '/var/www/b/git', '/var/www/b/live', '/var/www/b/test', '/var/www/b/next/live', '/var/www/b/prev/test']) {
            assert.equal(FETCH_DIR.test(dir), true, dir)
        }
        for (const dir of ['/var/www/b/uat1', '/var/www/b/next', '/var/www/b/git/x', '/var/www/b/next/live/x', '/var/www/b/../etc', '/var/www/b//live', '/etc/b']) {
            assert.equal(FETCH_DIR.test(dir), false, dir)
        }
    })

    it('knows every environment the registry does', () => {
        for (const env of ENVIRONMENTS) assert.equal(isNestedDir(`/var/www/acme/${env}`), true, env)
    })
})
