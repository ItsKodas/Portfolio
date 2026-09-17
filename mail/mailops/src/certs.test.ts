import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from './config.ts'
import { needsRenewal, backoffMs, legoArgs } from './certs.ts'

const config = loadConfig({
    MAIL_DOMAIN: 'dev.horizons.gg',
    FORWARD_TO: 'me@example.com',
    CF_API_TOKEN: 'token',
    CF_ZONE_ID: 'zone',
    DMARC_RUA: 'me@example.com',
})

const now = new Date('2026-09-18T00:00:00Z')

describe('needsRenewal', () => {
    it('renews when there is no certificate at all', () => {
        assert.equal(needsRenewal(null, now), true)
    })

    it('renews inside the window', () => {
        assert.equal(needsRenewal(new Date('2026-10-10T00:00:00Z'), now), true)
    })

    it('leaves a certificate alone outside the window', () => {
        assert.equal(needsRenewal(new Date('2026-12-01T00:00:00Z'), now), false)
    })

    it('renews an already expired certificate', () => {
        assert.equal(needsRenewal(new Date('2026-08-01T00:00:00Z'), now), true)
    })
})

describe('backoffMs', () => {
    it('returns zero for zero failures', () => {
        assert.equal(backoffMs(0), 0)
    })

    it('returns 1 minute for the first failure', () => {
        assert.equal(backoffMs(1), 60_000)
    })

    it('doubles with each failure', () => {
        assert.equal(backoffMs(2), 120_000)
        assert.equal(backoffMs(3), 240_000)
        assert.equal(backoffMs(4), 480_000)
    })

    it('saturates at the cap rather than growing without bound', () => {
        // Cap is 1 hour (3_600_000 ms)
        assert.equal(backoffMs(7), 3_600_000)
        assert.equal(backoffMs(10), 3_600_000)
    })
})

describe('legoArgs', () => {
    it('requests the mail hostname through the Cloudflare DNS challenge', () => {
        const args = legoArgs(config, '/mail-certs', 'run')
        assert.ok(args.includes('--dns'))
        assert.ok(args.includes('cloudflare'))
        assert.ok(args.includes('--domains'))
        assert.ok(args.includes('mail.dev.horizons.gg'))
    })

    it('uses the DMARC reporting address as the ACME account contact', () => {
        assert.ok(legoArgs(config, '/mail-certs', 'run').includes('me@example.com'))
    })

    it('writes into the certificate directory', () => {
        assert.ok(legoArgs(config, '/mail-certs', 'run').includes('/mail-certs'))
    })

    it('produces the run verb for initial issuance', () => {
        const args = legoArgs(config, '/mail-certs', 'run')
        assert.ok(args.includes('run'))
        assert.ok(!args.includes('renew'))
    })

    it('produces the renew verb for renewal', () => {
        const args = legoArgs(config, '/mail-certs', 'renew')
        assert.ok(args.includes('renew'))
        assert.ok(!args.includes('run'))
    })
})
