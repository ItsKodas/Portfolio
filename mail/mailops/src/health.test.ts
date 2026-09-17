import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBootGate, collectWarnings } from './health.ts'

const healthy = {
    outbound: { ok: true, banner: '220 mx.google.com ESMTP' },
    publicIp: '124.177.8.46',
    cloudflareOk: true,
}

describe('evaluateBootGate', () => {
    it('passes when everything the stack needs before accepting mail is present', () => {
        assert.deepEqual(evaluateBootGate(healthy), [])
    })

    it('fails, by name, when outbound 25 is blocked', () => {
        const failures = evaluateBootGate({ ...healthy, outbound: { ok: false, error: 'timeout' } })
        assert.deepEqual(failures, ['outbound port 25 is unreachable: timeout'])
    })

    it('fails when the public IP cannot be determined', () => {
        assert.deepEqual(evaluateBootGate({ ...healthy, publicIp: null }), ['public IP could not be determined'])
    })

    it('fails when Cloudflare rejects the credentials', () => {
        assert.deepEqual(evaluateBootGate({ ...healthy, cloudflareOk: false }), ['Cloudflare rejected CF_API_TOKEN or CF_ZONE_ID'])
    })
})

const quiet = {
    reconcile: { created: [], updated: [], unchanged: ['A mail.dev.horizons.gg'], conflicts: [] },
    spamhaus: { listed: false, inconclusive: false, codes: [], meanings: [] },
    lastInbound: new Date('2026-09-18T10:00:00Z'),
    now: new Date('2026-09-18T12:00:00Z'),
}

describe('collectWarnings', () => {
    it('is silent when everything is as it should be', () => {
        assert.deepEqual(collectWarnings(quiet), [])
    })

    it('warns about a DNS conflict, which means a record is not being maintained', () => {
        const warnings = collectWarnings({ ...quiet, reconcile: { ...quiet.reconcile, conflicts: ['A mail.dev.horizons.gg'] } })
        assert.equal(warnings[0]?.check, 'dns-conflict')
    })

    it('warns about a Spamhaus listing, which is how an inherited IP announces itself', () => {
        const warnings = collectWarnings({
            ...quiet,
            spamhaus: { listed: true, inconclusive: false, codes: ['127.0.0.4'], meanings: ['XBL: exploited or compromised host'] },
        })
        assert.equal(warnings[0]?.check, 'spamhaus')
        assert.match(warnings[0]!.detail, /XBL/)
    })

    it('does not warn on an inconclusive Spamhaus answer', () => {
        const warnings = collectWarnings({
            ...quiet,
            spamhaus: { listed: false, inconclusive: true, codes: [], meanings: ['query refused'] },
        })
        assert.deepEqual(warnings.filter(w => w.check === 'spamhaus'), [])
    })

    it('warns when no inbound mail has arrived for longer than the staleness window', () => {
        const warnings = collectWarnings({ ...quiet, now: new Date('2026-09-20T12:00:00Z') })
        assert.equal(warnings[0]?.check, 'inbound-stale')
    })

    it('does not warn when inbound mail has never arrived, because a new stack has no history', () => {
        assert.deepEqual(collectWarnings({ ...quiet, lastInbound: null }), [])
    })
})
