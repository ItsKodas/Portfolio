import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    detailsOf, emptyDeploys, recordDeploy, withoutTrailers, lastHealthyCommit, deployKey, maintenanceKey,
    MAX_DEPLOY_RECORDS, PAUSE_AFTER_FAILURES, MAX_WATCH_BYTES, type DeployOutcome, type DeployRecord,
} from './deploys.ts'

const record = (commit: string, outcome: DeployOutcome): DeployRecord => ({
    commit, subject: null, actor: 'hostd', trigger: 'poll',
    startedAt: '2026-09-21T00:00:00.000Z', durationMs: 1000, outcome, reason: null, output: null,
})

describe('deploy history', () => {
    it('keys an environment by project and name', () => {
        assert.equal(deployKey('acme', 'test'), 'acme:test')
    })

    it('names the maintenance flag the way the vhost looks for it, with no colon in the filename', () => {
        assert.equal(maintenanceKey('acme', 'test'), 'acme-test')
    })

    it('puts the newest record first and keeps the cap', () => {
        let state = emptyDeploys()
        for (let i = 0; i < MAX_DEPLOY_RECORDS + 5; i++) state = recordDeploy(state, record(`commit${i}`, 'ok'))
        assert.equal(state.deploys.length, MAX_DEPLOY_RECORDS)
        assert.equal(state.deploys[0]!.commit, `commit${MAX_DEPLOY_RECORDS + 4}`)
    })

    it('counts consecutive failures and pauses on the third', () => {
        let state = emptyDeploys()
        state = recordDeploy(state, record('a', 'failed'))
        state = recordDeploy(state, record('b', 'rolled-back'))
        assert.equal(state.consecutiveFailures, 2)
        assert.equal(state.paused, false)
        state = recordDeploy(state, record('c', 'failed'))
        assert.equal(state.consecutiveFailures, PAUSE_AFTER_FAILURES)
        assert.equal(state.paused, true)
    })

    it('clears the count on a deploy that worked', () => {
        let state = emptyDeploys()
        state = recordDeploy(state, record('a', 'failed'))
        state = recordDeploy(state, record('b', 'ok'))
        assert.equal(state.consecutiveFailures, 0)
        assert.equal(state.paused, false)
    })

    it('finds the last commit recorded healthy, skipping the one running now', () => {
        let state = emptyDeploys()
        state = recordDeploy(state, record('old', 'ok'))
        state = recordDeploy(state, record('broken', 'failed'))
        state = recordDeploy(state, record('current', 'ok'))
        assert.equal(lastHealthyCommit(state, 'current'), 'old')
        assert.equal(lastHealthyCommit(state, null), 'current')
    })

    it('has no healthy commit to return when nothing has ever worked', () => {
        const state = recordDeploy(emptyDeploys(), record('a', 'failed'))
        assert.equal(lastHealthyCommit(state, null), null)
    })
})

describe('deploy watch bounds', () => {
    // Its own number rather than OUTPUT_TAIL_BYTES: that one bounds the tail of one command stored in a
    // record, this bounds a whole deploy's narrative and output held in memory. Different reasons, so
    // they must not drift together.
    it('bounds a watched deploy well above a single record tail', () => {
        assert.ok(MAX_WATCH_BYTES >= 64 * 1024, String(MAX_WATCH_BYTES))
    })
})

describe('what a deploy changed', () => {
    const merge = { commit: 'aaa1111', merge: true, subject: 'Merge pull request #7 from acme/booking', body: 'Fix the booking form' }
    const inner = { commit: 'bbb2222', merge: false, subject: 'Check the date', body: 'It took any date.\n\nSigned-off-by: K <k@k>' }

    it('is the merge message and the commits it brought in, without their trailers', () => {
        assert.deepEqual(detailsOf('aaa1111', [inner, merge]), {
            body: 'Fix the booking form',
            changes: [{ subject: 'Check the date', body: 'It took any date.' }],
        })
    })

    it('is only the commit\'s own body for an ordinary commit', () => {
        assert.deepEqual(detailsOf('bbb2222', [inner]), { body: 'It took any date.', changes: [] })
    })

    it('finds a commit recorded in full among a log of full shas, and a short one by its prefix', () => {
        const full = { ...inner, commit: 'bbb2222' + '0'.repeat(33) }
        assert.notEqual(detailsOf('bbb2222', [full]), null)
        assert.notEqual(detailsOf(full.commit, [full]), null)
    })

    it('is nothing when the log does not hold the commit at all', () => {
        assert.equal(detailsOf('ccc3333', [inner]), null)
        assert.equal(detailsOf('', [inner]), null)
    })

    it('leaves out merges of the base branch that rode along', () => {
        const back = { commit: 'ddd4444', merge: true, subject: 'Merge branch main into booking', body: '' }
        assert.deepEqual(detailsOf('aaa1111', [merge, back, inner])!.changes.map(change => change.subject), ['Check the date'])
    })
})

describe('trailers', () => {
    it('drops a final paragraph of Key: value lines', () => {
        assert.equal(withoutTrailers('Did a thing.\n\nCo-Authored-By: A <a@a>\nClaude-Session: https://x'), 'Did a thing.')
    })

    it('keeps a final paragraph that is prose, even with a colon in it', () => {
        assert.equal(withoutTrailers('Did a thing.\n\nNote: this also fixes the footer, which was off.\nAnd more.'),
            'Did a thing.\n\nNote: this also fixes the footer, which was off.\nAnd more.')
    })

    it('is empty for a body that was only trailers', () => {
        assert.equal(withoutTrailers('Signed-off-by: K <k@k>'), '')
    })
})
