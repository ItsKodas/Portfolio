import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { newRecord, type DomainRecord } from './domain-state.ts'
import { nextCheckAt, dueNow, afterCheck, FAST_EVERY_MS, SLOW_EVERY_MS, ACTIVE_EVERY_MS } from './verifier.ts'

const START = Date.parse('2026-09-21T00:00:00.000Z')
const at = (ms: number) => new Date(ms).toISOString()

const pending = (over: Partial<DomainRecord> = {}): DomainRecord => ({
    ...newRecord('acme', 'live', 'acme.com', true, at(START)),
    state: 'pending',
    token: 'abc123',
    ...over,
})

describe('nextCheckAt', () => {
    it('never schedules an unmanaged record, because nothing is serving it yet', () => {
        assert.equal(nextCheckAt(pending({ state: 'unmanaged' })), null)
    })

    it('checks a pending record every minute for the first hour', () => {
        const record = pending({ checkedAt: at(START + 10 * 60_000) })
        assert.equal(nextCheckAt(record), START + 10 * 60_000 + FAST_EVERY_MS)
    })

    it('slows to every fifteen minutes after the first hour', () => {
        const record = pending({ checkedAt: at(START + 2 * 60 * 60_000) })
        assert.equal(nextCheckAt(record), START + 2 * 60 * 60_000 + SLOW_EVERY_MS)
    })

    it('checks an active record once a day', () => {
        const record = pending({ state: 'active', checkedAt: at(START + 5_000) })
        assert.equal(nextCheckAt(record), START + 5_000 + ACTIVE_EVERY_MS)
    })

    it('stops scheduling a failed record, which only a manual retry revives', () => {
        assert.equal(nextCheckAt(pending({ state: 'failed', checkedAt: at(START) })), null)
    })

    it('keeps checking a broken record, because a site that came back should say so by itself', () => {
        assert.notEqual(nextCheckAt(pending({ state: 'broken', checkedAt: at(START) })), null)
    })

    it('is due immediately when it has never been checked', () => {
        assert.equal(nextCheckAt(pending({ checkedAt: null })), Date.parse(pending().firstSeenAt))
    })
})

describe('dueNow', () => {
    it('returns only the records whose time has come', () => {
        const soon = pending({ hostname: 'soon.acme.com', checkedAt: at(START) })
        const later = pending({ hostname: 'later.acme.com', state: 'active', checkedAt: at(START) })
        const due = dueNow([soon, later], START + FAST_EVERY_MS + 1)
        assert.deepEqual(due.map(record => record.hostname), ['soon.acme.com'])
    })
})

describe('afterCheck', () => {
    it('turns a pending record active when the check passes', () => {
        const record = afterCheck(pending(), { ok: true }, at(START))
        assert.equal(record.state, 'active')
        assert.equal(record.error, null)
        assert.equal(record.attempts, 0)
    })

    it('counts an attempt and keeps a young record pending', () => {
        const record = afterCheck(pending(), { ok: false, reason: 'ENOTFOUND', client: 'No record exists yet.' }, at(START + 60_000))
        assert.equal(record.state, 'pending')
        assert.equal(record.attempts, 1)
        assert.match(record.error ?? '', /No record exists yet/)
    })

    it('gives up after 72 hours', () => {
        const record = afterCheck(pending(), { ok: false, reason: 'ENOTFOUND', client: 'x' }, at(START + 73 * 60 * 60_000))
        assert.equal(record.state, 'failed')
    })

    it('turns an active record broken rather than pending, so the vhost is never pulled', () => {
        const record = afterCheck(pending({ state: 'active' }), { ok: false, reason: 'x', client: 'y' }, at(START + 1000))
        assert.equal(record.state, 'broken')
    })

    it('turns a broken record active again the moment it answers', () => {
        const record = afterCheck(pending({ state: 'broken' }), { ok: true }, at(START + 1000))
        assert.equal(record.state, 'active')
    })

    it('never gives up on a broken record, however long it has been broken', () => {
        const record = afterCheck(pending({ state: 'broken' }), { ok: false, reason: 'x', client: 'y' }, at(START + 500 * 60 * 60_000))
        assert.equal(record.state, 'broken')
    })
})
