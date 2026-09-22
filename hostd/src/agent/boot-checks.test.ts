import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { siblingDirProblem } from './boot-checks.ts'

describe('siblingDirProblem', () => {
    it('allows sites-enabled and the adopted directory to sit at the same depth', () => {
        assert.equal(siblingDirProblem('/etc/apache2/sites-enabled', '/etc/apache2/hostd-adopted'), null)
    })

    it('allows them under a differently named, but still shared, parent', () => {
        assert.equal(siblingDirProblem('/srv/apache/sites-enabled', '/srv/apache/hostd-adopted'), null)
    })

    it('refuses when the adopted directory is nested deeper than sites-enabled, naming both', () => {
        const problem = siblingDirProblem('/etc/apache2/sites-enabled', '/etc/apache2/backups/hostd-adopted')
        assert.notEqual(problem, null)
        assert.match(problem!, /\/etc\/apache2\/sites-enabled/)
        assert.match(problem!, /\/etc\/apache2\/backups\/hostd-adopted/)
    })

    it('refuses when sites-enabled is nested deeper than the adopted directory, naming both', () => {
        const problem = siblingDirProblem('/etc/apache2/vhosts/sites-enabled', '/etc/apache2/hostd-adopted')
        assert.notEqual(problem, null)
        assert.match(problem!, /\/etc\/apache2\/vhosts\/sites-enabled/)
        assert.match(problem!, /\/etc\/apache2\/hostd-adopted/)
    })

    it('refuses when the two share no parent at all', () => {
        const problem = siblingDirProblem('/etc/apache2/sites-enabled', '/var/backups/hostd-adopted')
        assert.notEqual(problem, null)
        assert.match(problem!, /\/etc\/apache2\/sites-enabled/)
        assert.match(problem!, /\/var\/backups\/hostd-adopted/)
    })
})
