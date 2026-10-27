import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluateBootGate, bootGateIsRetryable, collectWarnings, cycleFailedWarning, resolveIntervalMs, writeStatus } from './health.ts'

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
        assert.deepEqual(
            evaluateBootGate({ ...healthy, cloudflareOk: false, cloudflareRejected: true }),
            ['Cloudflare rejected CF_API_TOKEN or CF_ZONE_ID'],
        )
    })

    it('distinguishes an unreachable API from a rejected credential', () => {
        assert.deepEqual(
            evaluateBootGate({ ...healthy, cloudflareOk: false, cloudflareRejected: false }),
            ['the Cloudflare API could not be reached'],
        )
    })
})

describe('bootGateIsRetryable', () => {
    // A crash-looping mailops on a dynamic IP means the A record goes stale, and after the next
    // rotation inbound mail stops. That is exactly the lost-mail outcome the two-tier rule exists to
    // prevent, so every environmental failure is worth waiting out.
    it('retries a blocked outbound port, which is routinely transient on a residential link', () => {
        assert.equal(bootGateIsRetryable({ ...healthy, outbound: { ok: false, error: 'timeout' } }), true)
    })

    it('retries an undeterminable public IP', () => {
        assert.equal(bootGateIsRetryable({ ...healthy, publicIp: null }), true)
    })

    it('retries an unreachable Cloudflare API', () => {
        assert.equal(bootGateIsRetryable({ ...healthy, cloudflareOk: false, cloudflareRejected: false }), true)
    })

    // Genuine misconfiguration. Retrying cannot fix a bad token, so say so immediately.
    it('does not retry a credential Cloudflare actively rejected', () => {
        assert.equal(bootGateIsRetryable({ ...healthy, cloudflareOk: false, cloudflareRejected: true }), false)
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

// quiet.now is 2026-09-18T12:00:00Z, so these expiries are a comfortable 74 days out.
const fresh = new Date('2026-12-01T00:00:00Z')
const older = new Date('2026-11-01T00:00:00Z')
const longAgo = new Date('2026-09-01T00:00:00Z')

describe('collectWarnings: certificate on the wire', () => {
    it('is quiet when mailserver serves the certificate on disk', () => {
        assert.deepEqual(collectWarnings({
            ...quiet, cert: { onDiskNotAfter: fresh, onDiskChangedAt: longAgo, servedNotAfter: fresh },
        }), [])
    })

    // The expiry-on-the-wire case: lego renewed into the shared volume and Postfix never reloaded, so the
    // file looks healthy while the old certificate runs out in front of every sender.
    it('warns when mailserver is still serving an older certificate than the one on disk', () => {
        const warnings = collectWarnings({
            ...quiet, cert: { onDiskNotAfter: fresh, onDiskChangedAt: longAgo, servedNotAfter: older },
        })
        assert.equal(warnings[0]?.check, 'cert-reload-needed')
        assert.match(warnings[0]!.detail, /serving a certificate expiring 2026-11-01/)
        assert.match(warnings[0]!.detail, /on disk expires 2026-12-01/)
        assert.match(warnings[0]!.detail, /docker compose restart mailserver/)
        assert.equal(warnings[0]!.advisory, undefined)
    })

    it('gives a renewal from moments ago time to be reloaded before calling it a mismatch', () => {
        const justNow = new Date(quiet.now.getTime() - 60_000)
        assert.deepEqual(collectWarnings({
            ...quiet, cert: { onDiskNotAfter: fresh, onDiskChangedAt: justNow, servedNotAfter: older },
        }), [])
    })

    it('stops giving that grace once the renewal is a few minutes old', () => {
        const tenMinutesAgo = new Date(quiet.now.getTime() - 10 * 60_000)
        const warnings = collectWarnings({
            ...quiet, cert: { onDiskNotAfter: fresh, onDiskChangedAt: tenMinutesAgo, servedNotAfter: older },
        })
        assert.equal(warnings[0]?.check, 'cert-reload-needed')
    })

    it('warns when the served certificate cannot be read, rather than assuming it matches', () => {
        const warnings = collectWarnings({
            ...quiet, cert: { onDiskNotAfter: fresh, onDiskChangedAt: longAgo, servedNotAfter: null, servedError: 'connect ECONNREFUSED' },
        })
        assert.deepEqual(warnings.map(w => w.check), ['cert-served-unknown'])
        assert.match(warnings[0]!.detail, /ECONNREFUSED/)
    })

    it('does not raise a reload warning before the first certificate exists', () => {
        assert.deepEqual(collectWarnings({ ...quiet, cert: { onDiskNotAfter: null, onDiskChangedAt: null } }), [])
    })
})

describe('collectWarnings: certificate expiry against the clock', () => {
    const daysFromNow = (days: number) => new Date(quiet.now.getTime() + days * 86_400_000)
    const matching = (notAfter: Date) => ({ onDiskNotAfter: notAfter, onDiskChangedAt: longAgo, servedNotAfter: notAfter })

    it('is quiet with more than three weeks left, where renewal has only just started trying', () => {
        assert.deepEqual(collectWarnings({ ...quiet, cert: matching(daysFromNow(25)) }), [])
    })

    // The case the acknowledged-expiry comparison could never see: every cycle agrees with itself, renewal
    // keeps failing between backoff attempts, and the certificate simply runs out.
    it('reports, without failing, a certificate that renewal should already have replaced', () => {
        const warnings = collectWarnings({ ...quiet, cert: matching(daysFromNow(15)) })
        assert.equal(warnings[0]?.check, 'cert-expiring')
        assert.equal(warnings[0]!.advisory, true)
        assert.match(warnings[0]!.detail, /in 15 days/)
    })

    it('fails once fewer than ten days are left', () => {
        const warnings = collectWarnings({ ...quiet, cert: matching(daysFromNow(9)) })
        assert.equal(warnings[0]?.check, 'cert-expiring')
        assert.equal(warnings[0]!.advisory, undefined)
    })

    it('fails on a certificate that has already expired', () => {
        const warnings = collectWarnings({ ...quiet, cert: matching(daysFromNow(-1)) })
        assert.equal(warnings[0]?.check, 'cert-expired')
        assert.equal(warnings[0]!.advisory, undefined)
    })

    it('judges the served certificate when it expires sooner than the one on disk', () => {
        const warnings = collectWarnings({
            ...quiet, cert: { onDiskNotAfter: daysFromNow(80), onDiskChangedAt: longAgo, servedNotAfter: daysFromNow(-2) },
        })
        const expired = warnings.find(w => w.check === 'cert-expired')
        assert.match(expired?.detail ?? '', /the certificate mailserver is serving/)
    })

    it('still checks the on-disk expiry when the served certificate cannot be read', () => {
        const warnings = collectWarnings({
            ...quiet, cert: { onDiskNotAfter: daysFromNow(-1), onDiskChangedAt: longAgo, servedNotAfter: null, servedError: 'timeout' },
        })
        assert.deepEqual(warnings.map(w => w.check), ['cert-served-unknown', 'cert-expired'])
        assert.match(warnings[1]!.detail, /the certificate on disk/)
    })
})

describe('writeStatus', () => {
    async function statusFor(warnings: Parameters<typeof writeStatus>[1]) {
        const dir = await mkdtemp(join(tmpdir(), 'status-'))
        try {
            await writeStatus(join(dir, 'status.json'), warnings, quiet.now)
            return JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as { ok: boolean, warnings: unknown[] }
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    }

    it('is ok with no warnings', async () => {
        assert.equal((await statusFor([])).ok, true)
    })

    it('stays ok when every warning is advisory, but still lists them', async () => {
        const status = await statusFor([{ check: 'cert-expiring', detail: 'soon', advisory: true }])
        assert.equal(status.ok, true)
        assert.equal(status.warnings.length, 1)
    })

    it('is not ok as soon as one warning is not advisory', async () => {
        const status = await statusFor([
            { check: 'cert-expiring', detail: 'soon', advisory: true },
            { check: 'cert-reload-needed', detail: 'stale' },
        ])
        assert.equal(status.ok, false)
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

describe('collectWarnings: inbound port 25', () => {
    it('warns when inbound 25 is unreachable from every outside node', () => {
        const warnings = collectWarnings({
            ...quiet,
            inbound: { reachable: false, inconclusive: false, detail: 'unreachable from all 4 nodes' },
        })
        assert.equal(warnings[0]?.check, 'inbound-unreachable')
    })

    it('is silent when inbound 25 is reachable', () => {
        assert.deepEqual(collectWarnings({ ...quiet, inbound: { reachable: true, inconclusive: false, detail: 'ok' } }), [])
    })

    it('does not read an inconclusive check as unreachable', () => {
        const warnings = collectWarnings({ ...quiet, inbound: { reachable: false, inconclusive: true, detail: 'pending' } })
        assert.deepEqual(warnings.filter(w => w.check === 'inbound-unreachable'), [])
    })

    it('says so once the check has been inconclusive three times running, so it cannot go quietly blind', () => {
        assert.equal(collectWarnings({ ...quiet, inboundInconclusiveStreak: 3 })[0]?.check, 'inbound-check-unavailable')
    })

    it('tolerates a couple of inconclusive checks without warning', () => {
        assert.deepEqual(collectWarnings({ ...quiet, inboundInconclusiveStreak: 2 }), [])
    })
})
