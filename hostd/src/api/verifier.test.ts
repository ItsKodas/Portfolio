import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { newRecord, domainKey, type DomainRecord } from './domain-state.ts'
import {
    nextCheckAt, dueNow, afterCheck, Verifier,
    FAST_EVERY_MS, SLOW_EVERY_MS, ACTIVE_EVERY_MS, CHECK_INTERVAL_MS,
    type RecordStore, type VerifyTarget,
} from './verifier.ts'
import { TOKEN_HEADER } from './verify.ts'

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

// A minimal in-memory stand-in for DomainStore. Verifier depends on RecordStore, the narrower structural
// type it actually needs, precisely so a fake like this can be handed to it without a filesystem.
class FakeStore implements RecordStore {
    private records: Map<string, DomainRecord>
    puts: DomainRecord[] = []

    constructor(records: DomainRecord[]) {
        this.records = new Map(records.map(record => [domainKey(record.project, record.environment, record.hostname), record]))
    }

    get(key: string): DomainRecord | undefined {
        return this.records.get(key)
    }

    all(): DomainRecord[] {
        return [...this.records.values()]
    }

    async put(record: DomainRecord): Promise<void> {
        this.records.set(domainKey(record.project, record.environment, record.hostname), record)
        this.puts.push(record)
    }
}

// A fetch stand-in that always answers with a matching token, unless the hostname is in `fail`, in which
// case it throws the way a real DNS or TLS failure would (which verifyHostname is built to catch and
// translate, never to let escape). Records every hostname it was asked about.
function fakeFetch(fail: string[] = []): { fetch: typeof fetch, calls: string[] } {
    const calls: string[] = []
    const impl = (async (input: unknown) => {
        const url = String(input)
        const hostname = new URL(url).hostname
        calls.push(hostname)
        if (fail.includes(hostname)) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
        const token = url.split('/').pop()
        return new Response(null, { status: 204, headers: { [TOKEN_HEADER]: token ?? '' } })
    }) as typeof fetch
    return { fetch: impl, calls }
}

const target: (record: DomainRecord) => VerifyTarget = () => ({ scheme: 'https', proxied: true })

describe('Verifier', () => {
    it('tick checks only the records dueNow returns, and writes the result back', async () => {
        const due = pending({ hostname: 'due.acme.com', checkedAt: at(START) })
        const notDue = pending({ hostname: 'notdue.acme.com', state: 'active', checkedAt: at(START) })
        const store = new FakeStore([due, notDue])
        const { fetch, calls } = fakeFetch()
        const now = START + FAST_EVERY_MS + 1
        const verifier = new Verifier(store, fetch, target, () => {}, () => now)

        await verifier.tick()

        assert.deepEqual(calls, ['due.acme.com'])
        assert.equal(store.puts.length, 1)
        assert.equal(store.puts[0]?.hostname, 'due.acme.com')
        assert.equal(store.puts[0]?.state, 'active')
    })

    it('one bad record does not stop the loop', async () => {
        // A thrown error from `target` stands in for an unexpected bug in the check pipeline itself,
        // as opposed to a network failure: verifyHostname is deliberately built to swallow those (that
        // is what translateFailure is for), so a fetch rejection would never reach tick's per-record
        // catch. This does, and that catch is exactly what this test is proving exists and works.
        const bad = pending({ hostname: 'bad.acme.com', checkedAt: at(START) })
        const good = pending({ hostname: 'good.acme.com', checkedAt: at(START) })
        const store = new FakeStore([bad, good])
        const { fetch, calls } = fakeFetch()
        const now = START + FAST_EVERY_MS + 1
        const flaky: (record: DomainRecord) => VerifyTarget = record => {
            if (record.hostname === 'bad.acme.com') throw new Error('boom')
            return { scheme: 'https', proxied: true }
        }
        const messages: string[] = []
        const verifier = new Verifier(store, fetch, flaky, message => messages.push(message), () => now)

        await verifier.tick()

        assert.deepEqual(calls, ['good.acme.com'])
        assert.equal(store.puts.length, 1)
        assert.equal(store.puts[0]?.hostname, 'good.acme.com')
        assert.equal(store.puts[0]?.state, 'active')
        assert.match(messages.join('\n'), /bad\.acme\.com/)
    })

    it('stop() actually disarms', async () => {
        const due = pending({ hostname: 'due.acme.com', checkedAt: at(START) })
        const store = new FakeStore([due])
        const { fetch, calls } = fakeFetch()
        const verifier = new Verifier(store, fetch, target, () => {}, () => START + FAST_EVERY_MS + 1)

        mock.timers.enable({ apis: ['setInterval'] })
        try {
            verifier.start()
            mock.timers.tick(CHECK_INTERVAL_MS)
            // Let the async work the interval kicked off (fetch, then store.put) actually settle; only
            // setInterval is mocked, so a real microtask/macrotask flush is enough.
            await new Promise(resolve => setTimeout(resolve, 0))
            assert.equal(calls.length, 1)

            verifier.stop()
            mock.timers.tick(CHECK_INTERVAL_MS)
            await new Promise(resolve => setTimeout(resolve, 0))
            assert.equal(calls.length, 1)
        } finally {
            mock.timers.reset()
        }
    })

    it('checkNow on a failed record performs a real check', async () => {
        // Old enough that, without the firstSeenAt reset, the very first check after revival would read
        // an age already past GIVE_UP_AFTER_MS and fail it right back.
        const old = at(START - 200 * 60 * 60_000)
        const failed = pending({ hostname: 'retry.acme.com', state: 'failed', firstSeenAt: old, checkedAt: at(START - 60_000) })
        const store = new FakeStore([failed])
        const { fetch, calls } = fakeFetch(['retry.acme.com']) // still unreachable; the retry itself fails
        const verifier = new Verifier(store, fetch, target, () => {}, () => START)

        await verifier.checkNow(domainKey(failed.project, failed.environment, failed.hostname))

        assert.deepEqual(calls, ['retry.acme.com']) // proves it actually called the verifier
        assert.equal(store.puts.length, 1)
        const updated = store.puts[0]
        assert.equal(updated?.state, 'pending') // revived, and a fresh failure keeps it pending rather than failing it right back
        assert.equal(updated?.firstSeenAt, new Date(START).toISOString())
        assert.equal(updated?.attempts, 1)
    })
})
