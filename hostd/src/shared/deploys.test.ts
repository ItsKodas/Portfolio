import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
    emptyDeploys, recordDeploy, lastHealthyCommit, deployKey, maintenanceKey,
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
