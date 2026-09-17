import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBootGate, collectWarnings, cycleFailedWarning, resolveIntervalMs } from './health.ts'

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
    reconcile: { created: [], updated: [], unchanged: ['A mail.dev.horizons.gg'], conflicts: [], loops: [] },
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

    it('warns when a record is being rewritten forever without converging', () => {
        const warnings = collectWarnings({
            ...quiet,
            reconcile: { ...quiet.reconcile, loops: ['TXT mail._domainkey.dev.horizons.gg'] },
        })
        assert.equal(warnings[0]?.check, 'dns-write-loop')
        assert.match(warnings[0]!.detail, /mail\._domainkey\.dev\.horizons\.gg/)
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

    it('warns that renewal is failing without losing every other check that cycle', () => {
        const warnings = collectWarnings({
            ...quiet,
            certError: 'lego exited 1',
            reconcile: { ...quiet.reconcile, conflicts: ['TXT dev.horizons.gg'] },
            spamhaus: { listed: true, inconclusive: false, codes: ['127.0.0.4'], meanings: ['XBL: exploited or compromised host'] },
            now: new Date('2026-09-20T12:00:00Z'),
        })
        const checks = warnings.map(w => w.check)
        assert.ok(checks.includes('cert-renewal'))
        assert.ok(checks.includes('dns-conflict'), 'a cert failure must not hide the DNS conflict list')
        assert.ok(checks.includes('spamhaus'), 'a cert failure must not hide the Spamhaus state')
        assert.ok(checks.includes('inbound-stale'), 'a cert failure must not hide the inbound staleness check')
    })

    // The expiry-on-the-wire case: mailops renewed into the shared volume, mailserver runs
    // SSL_TYPE=manual and did not notice, and nothing restarted it. status.json must not say ok.
    it('warns that a renewed certificate has not been picked up', () => {
        const warnings = collectWarnings({
            ...quiet,
            cert: { onDiskNotAfter: new Date('2026-12-01T00:00:00Z'), acknowledgedNotAfter: new Date('2026-10-01T00:00:00Z') },
        })
        assert.equal(warnings[0]?.check, 'cert-reload-needed')
        assert.match(warnings[0]!.detail, /2026-12-01/)
        assert.match(warnings[0]!.detail, /restart mailserver/)
    })

    it('warns when no certificate has ever been acknowledged', () => {
        const warnings = collectWarnings({
            ...quiet,
            cert: { onDiskNotAfter: new Date('2026-12-01T00:00:00Z'), acknowledgedNotAfter: null },
        })
        assert.equal(warnings[0]?.check, 'cert-reload-needed')
        assert.match(warnings[0]!.detail, /never been restarted/)
    })

    it('is quiet once the acknowledged certificate matches the one on disk', () => {
        assert.deepEqual(collectWarnings({
            ...quiet,
            cert: { onDiskNotAfter: new Date('2026-12-01T00:00:00Z'), acknowledgedNotAfter: new Date('2026-12-01T00:00:00Z') },
        }), [])
    })

    it('does not raise a reload warning before the first certificate exists', () => {
        assert.deepEqual(collectWarnings({ ...quiet, cert: { onDiskNotAfter: null, acknowledgedNotAfter: null } }), [])
    })

    it('warns when the mail log cannot be read at all', () => {
        const warnings = collectWarnings({ ...quiet, logError: 'cannot open /mail-logs/mial.log: ENOTDIR' })
        assert.equal(warnings[0]?.check, 'log-unreadable')
        assert.match(warnings[0]!.detail, /inbound staleness/)
    })

    it('stays silent when the log simply has nothing in it yet', () => {
        assert.deepEqual(collectWarnings({ ...quiet, lastInbound: null, logError: null }), [])
    })

    it('warns when no inbound mail has arrived for longer than the staleness window', () => {
        const warnings = collectWarnings({ ...quiet, now: new Date('2026-09-20T12:00:00Z') })
        assert.equal(warnings[0]?.check, 'inbound-stale')
    })

    it('does not warn when inbound mail has never arrived, because a new stack has no history', () => {
        assert.deepEqual(collectWarnings({ ...quiet, lastInbound: null }), [])
    })
})

describe('cycleFailedWarning', () => {
    it('turns a thrown Error into a cycle-failed warning carrying its message', () => {
        assert.deepEqual(cycleFailedWarning(new Error('ETIMEDOUT')), { check: 'cycle-failed', detail: 'ETIMEDOUT' })
    })

    it('stringifies a non-Error throw rather than losing it', () => {
        assert.deepEqual(cycleFailedWarning('boom'), { check: 'cycle-failed', detail: 'boom' })
    })
})

describe('resolveIntervalMs', () => {
    it('defaults quietly when the value is unset, because that is not a typo', () => {
        assert.deepEqual(resolveIntervalMs(undefined), { ms: 60_000, invalid: false })
    })

    it('parses a valid numeric string', () => {
        assert.deepEqual(resolveIntervalMs('30000'), { ms: 30_000, invalid: false })
    })

    it('falls back and flags invalid when the value is not a number', () => {
        assert.deepEqual(resolveIntervalMs('60s'), { ms: 60_000, invalid: true })
    })

    it('falls back and flags invalid when the value is zero or negative', () => {
        assert.deepEqual(resolveIntervalMs('0'), { ms: 60_000, invalid: true })
        assert.deepEqual(resolveIntervalMs('-500'), { ms: 60_000, invalid: true })
    })

    it('honors a custom fallback', () => {
        assert.deepEqual(resolveIntervalMs('NaN', 15_000), { ms: 15_000, invalid: true })
    })
})
